import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
  LoadExtensionsResult,
  RegisteredTool,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { RoomId } from "./room/room-types.js";

export type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Identity and working directory supplied whenever a host resolves an agent environment. */
export interface ExecutionEnvTarget {
  readonly roomId: RoomId;
  readonly agentId: string;
  readonly cwd: string;
}

/** Host-owned durable environment factory, resolved afresh for every tool execution. */
export type ExecutionEnvFactory = (
  target: ExecutionEnvTarget,
  context: Context,
) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;

export interface ExecutionEnvUse {
  readonly env: ExecutionEnv;
  readonly context: Context;
}

/** The active wrapped tool invocation. */
export interface AgentExecutionContext {
  readonly target: ExecutionEnvTarget;
  readonly context: Context;
  readonly env?: ExecutionEnv;
}

interface AgentToolExecutionBoundary {
  readonly target: ExecutionEnvTarget;
  readonly resolveEnv?: ExecutionEnvFactory;
}

interface AgentExecutionScope {
  readonly execution: AgentExecutionContext;
  active: boolean;
}

const agentExecutionScope = new AsyncLocalStorage<AgentExecutionScope>();

/** Return the active wrapped tool invocation, if called from a Harness-loaded tool. */
export function getCurrentAgentExecution(): AgentExecutionContext | undefined {
  const scope = agentExecutionScope.getStore();
  return scope?.active ? scope.execution : undefined;
}

/** Bridge Pi Coding Agent's AbortSignal tool boundary to Pi Durable's Context boundary. */
export function executionEnvContext(signal?: AbortSignal): Context {
  return signal === undefined
    ? BACKGROUND_CONTEXT
    : withAbortSignal(signal, BACKGROUND_CONTEXT);
}

/** Read the environment resolved immediately before the active tool invocation. */
export async function resolveCurrentAgentExecutionEnv(
  _signal?: AbortSignal,
): Promise<ExecutionEnvUse | undefined> {
  const execution = getCurrentAgentExecution();
  if (!execution) {
    throw new Error("Execution environment access requires an active Harness-loaded tool");
  }
  return execution.env === undefined
    ? undefined
    : { env: execution.env, context: execution.context };
}

/** Read the active tool's environment or fail as an ordinary tool error. */
export async function requireCurrentAgentExecutionEnv(
  signal?: AbortSignal,
): Promise<ExecutionEnvUse> {
  const use = await resolveCurrentAgentExecutionEnv(signal);
  if (use === undefined) throw new Error("No execution environment is configured");
  return use;
}

/** Wrap every loaded Pi tool at the resource boundary with per-invocation environment resolution. */
export function wrapExtensionToolsWithExecutionEnv(
  result: LoadExtensionsResult,
  boundary: AgentToolExecutionBoundary,
): LoadExtensionsResult {
  for (const extension of result.extensions) {
    extension.tools = new ExecutionEnvToolMap(extension.tools, boundary);
  }
  return result;
}

class ExecutionEnvToolMap extends Map<string, RegisteredTool> {
  readonly #boundary: AgentToolExecutionBoundary;

  constructor(
    tools: ReadonlyMap<string, RegisteredTool>,
    boundary: AgentToolExecutionBoundary,
  ) {
    super();
    this.#boundary = boundary;
    for (const [name, tool] of tools) this.set(name, tool);
  }

  override set(name: string, registeredTool: RegisteredTool): this {
    return super.set(name, {
      ...registeredTool,
      definition: wrapToolDefinitionWithExecutionEnv(
        registeredTool.definition,
        this.#boundary,
      ),
    });
  }
}

function wrapToolDefinitionWithExecutionEnv(
  definition: ToolDefinition<any, any, any>,
  boundary: AgentToolExecutionBoundary,
): ToolDefinition<any, any, any> {
  return {
    ...definition,
    execute: async (toolCallId, params, signal, onUpdate, context) => {
      const durableContext = executionEnvContext(signal);
      const env = await boundary.resolveEnv?.(boundary.target, durableContext);
      const scope: AgentExecutionScope = {
        execution: {
          target: boundary.target,
          context: durableContext,
          ...(env === undefined ? {} : { env }),
        },
        active: true,
      };
      return agentExecutionScope.run(scope, async () => {
        try {
          return await definition.execute(toolCallId, params, signal, onUpdate, context);
        } finally {
          scope.active = false;
        }
      });
    },
  };
}
