import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Identity and working directory supplied whenever a host resolves an AgentLoop environment. */
export interface ExecutionEnvTarget<TSessionId extends string = string> {
  readonly sessionId: TSessionId;
  readonly loopId: string;
  readonly cwd: string;
}

/** Host-owned Pi environment factory. It is called again for every environment use. */
export type ExecutionEnvFactory<TSessionId extends string = string> = (
  target: ExecutionEnvTarget<TSessionId>,
  context: Context,
) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;

/** One AgentLoop's target-bound view of a host-owned environment factory. */
export type AgentLoopExecutionEnv = (
  context: Context,
) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;

/** Resolved environment paired with the cancellation context required by its operations. */
export interface ExecutionEnvUse {
  readonly env: ExecutionEnv;
  readonly context: Context;
}

export function bindExecutionEnv<TSessionId extends string>(
  factory: ExecutionEnvFactory<TSessionId>,
  target: ExecutionEnvTarget<TSessionId>,
): AgentLoopExecutionEnv {
  const boundTarget = Object.freeze({ ...target });
  return context => factory(boundTarget, context);
}

/** Bridge Pi Coding Agent's AbortSignal tool boundary to Pi Durable's Context boundary. */
export function executionEnvContext(signal?: AbortSignal): Context {
  return signal === undefined
    ? BACKGROUND_CONTEXT
    : withAbortSignal(signal, BACKGROUND_CONTEXT);
}
