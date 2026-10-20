import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  Session,
  assertAgentLoopId,
  type AgentLoop,
  type AgentLoopLogger,
  type Api,
  type ExtensionAPI,
  type Model,
  type TargetedLoopExtensionRegistry,
} from "#core";
import { createAgentLoop as createOwnedAgentLoop } from "../agent-loop/create-agent-loop.js";
import type { SessionInfra } from "./session-infra.js";
import type { SessionId } from "./session-types.js";

export type { MultiAgentPiSessionState, SessionId } from "./session-types.js";

export const PRIMARY_AGENT_LOOP_ID = "main";

export interface CreateAgentLoopOptions {
  readonly id?: string;
  readonly loopTag?: string;
  readonly model?: Model<Api>;
  readonly configurePrompt: (pi: ExtensionAPI) => Promise<void> | void;
}

export type MultiAgentPiSession = Session<AgentLoop, CreateAgentLoopOptions, SessionId>;

type SessionClosedHandler = (session: MultiAgentPiSession) => void;

export interface CreateMultiAgentPiSessionOptions {
  readonly infra: SessionInfra;
  readonly logger: AgentLoopLogger;
  readonly extensionRegistry: TargetedLoopExtensionRegistry;
  readonly onClosed: SessionClosedHandler;
}

export function createSessionId(): SessionId {
  return randomUUID() as SessionId;
}

/** Construct the concrete Core Session used by MultiAgentPiHarness. */
export function createMultiAgentPiSession(options: CreateMultiAgentPiSessionOptions): MultiAgentPiSession {
  const { infra, logger, extensionRegistry } = options;
  let session!: MultiAgentPiSession;
  const getDefaultModel = (): Model<Api> =>
    (session.primary?.session.model as Model<Api> | undefined) ?? infra.models.getModel();
  session = new Session({
    id: infra.id,
    loopManager: {
      getId: loopOptions => {
        const id = loopOptions.id?.trim() ?? randomUUID();
        assertAgentLoopId(id);
        return id;
      },
      createLoop: (loopOptions, id) => createOwnedAgentLoop(
        infra,
        {
          ...loopOptions,
          id,
          loopDir: id === PRIMARY_AGENT_LOOP_ID
            ? infra.paths.sessionDir
            : join(infra.paths.sessionDir, "loops", id),
          model: loopOptions.model ?? getDefaultModel(),
          logger,
        },
        extensionRegistry,
      ),
      onAfterLoopCreate: (loop, loopOptions) =>
        loopOptions.model === undefined ? loop.setModel(getDefaultModel()) : undefined,
    },
    extensionRegistry,
    onClose: closedSession => options.onClosed(closedSession),
  });
  return session;
}
