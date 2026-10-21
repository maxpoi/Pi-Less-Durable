import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  Session as CoreSession,
  assertAgentLoopId,
  type AgentLoop,
  type AgentLoopLogger,
  type Api,
  type ExecutionEnvFactory,
  type ExtensionAPI,
  type Model,
  type ModelRuntime,
  type MultiAgentPiSettingsManager,
  type SessionOptions as CoreSessionOptions,
  type TargetedLoopExtensionRegistry,
} from "#core";
import { createAgentLoop as createOwnedAgentLoop } from "../agent-loop/create-agent-loop.js";
import { createSessionInfra, type SessionInfra } from "./session-infra.js";
import type { Session, SessionId } from "./session-types.js";

export type {
  MultiAgentPiSessionState,
  Session,
  SessionId,
  SessionPromptOptions,
  SessionState,
} from "./session-types.js";

export const PRIMARY_AGENT_LOOP_ID = "main";

export interface CreateAgentLoopOptions {
  readonly id?: string;
  readonly loopTag?: string;
  readonly model?: Model<Api>;
  readonly configurePrompt: (pi: ExtensionAPI) => Promise<void> | void;
}

/** Consumer-owned identity and workspace for an initially unbound Session. */
export interface CreateMultiAgentPiSessionOptions {
  readonly id?: string;
  /** Execution working directory passed to Pi and environment resolution. */
  readonly cwd?: string;
  /** Session/loop data directory. Harness config provides the default after admission. */
  readonly sessionDir?: string;
}

interface MultiAgentPiSessionRuntime {
  readonly configDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly settings: MultiAgentPiSettingsManager;
  readonly logger: AgentLoopLogger;
  readonly env?: ExecutionEnvFactory<SessionId>;
  readonly extensionRegistry: TargetedLoopExtensionRegistry;
  readonly onClosed: (session: MultiAgentPiSession) => void;
}

type MultiAgentPiCoreSessionOptions = CoreSessionOptions<
  AgentLoop,
  CreateAgentLoopOptions,
  SessionId
>;

interface MultiAgentPiSessionConstruction {
  readonly cwd: string;
  readonly sessionDir: string | undefined;
  readonly defaultSessionDirectoryName: string;
}

export class MultiAgentPiSession
  extends CoreSession<AgentLoop, CreateAgentLoopOptions, SessionId>
  implements Session {
  readonly #cwd: string;
  readonly #sessionDir: string | undefined;
  readonly #defaultSessionDirectoryName: string;
  #runtime: MultiAgentPiSessionRuntime | undefined;
  #infra: SessionInfra | undefined;

  private constructor(
    options: MultiAgentPiCoreSessionOptions,
    construction: MultiAgentPiSessionConstruction,
  ) {
    super(options);
    this.#cwd = construction.cwd;
    this.#sessionDir = construction.sessionDir;
    this.#defaultSessionDirectoryName = construction.defaultSessionDirectoryName;
  }

  static create(options: CreateMultiAgentPiSessionOptions = {}): MultiAgentPiSession {
    const id = createSessionId(options.id);
    const defaultSessionDirectoryName = options.id === undefined
      ? id
      : Buffer.from(id, "utf8").toString("base64url");
    let session!: MultiAgentPiSession;

    session = new MultiAgentPiSession(
      {
        id,
        loopManager: {
          getId: loopOptions => {
            const loopId = loopOptions.id?.trim() ?? randomUUID();
            assertAgentLoopId(loopId);
            return loopId;
          },
          createLoop: (loopOptions, loopId) => session.#createLoop(loopOptions, loopId),
          onAfterLoopCreate: (loop, loopOptions) =>
            session.#configureCreatedLoop(loop, loopOptions),
        },
        onClose: () => session.#runtime?.onClosed(session),
      },
      {
        cwd: resolve(options.cwd ?? process.cwd()),
        sessionDir: options.sessionDir,
        defaultSessionDirectoryName,
      },
    );
    return session;
  }

  /** Receive the runtime owned and provided by Harness.addSession(). */
  initialize(runtime: MultiAgentPiSessionRuntime): void {
    if (this.#runtime !== undefined) {
      throw new Error(`MultiAgentPiSession "${this.id}" is already initialized by a Harness`);
    }

    const sessionDir = this.#sessionDir === undefined
      ? resolve(runtime.configDir, "sessions", this.#defaultSessionDirectoryName)
      : resolve(this.#sessionDir);
    const infra = createSessionInfra({
      id: this.id,
      modelRuntime: runtime.modelRuntime,
      settings: runtime.settings,
      ...(runtime.env === undefined ? {} : { env: runtime.env }),
      paths: {
        cwd: this.#cwd,
        sessionDir,
        configDir: runtime.configDir,
      },
    });

    this.bindExtensionRegistry(runtime.extensionRegistry);
    this.#infra = infra;
    this.#runtime = runtime;
  }

  override setPrimary(id: string): AgentLoop {
    if (id !== PRIMARY_AGENT_LOOP_ID) {
      throw new Error(
        `MultiAgentPiSession primary AgentLoop must use id "${PRIMARY_AGENT_LOOP_ID}", got "${id}"`,
      );
    }
    return super.setPrimary(id);
  }

  #requireRuntime(): {
    readonly runtime: MultiAgentPiSessionRuntime;
    readonly infra: SessionInfra;
  } {
    if (this.#runtime === undefined || this.#infra === undefined) {
      throw new Error(
        `MultiAgentPiSession "${this.id}" must be added to a Harness before creating AgentLoops`,
      );
    }
    return { runtime: this.#runtime, infra: this.#infra };
  }

  #getDefaultModel(): Model<Api> {
    const runtime = this.#requireRuntime().infra;
    return (this.primary?.session.model as Model<Api> | undefined) ?? runtime.models.getModel();
  }

  #createLoop(loopOptions: CreateAgentLoopOptions, loopId: string): Promise<AgentLoop> {
    const runtime = this.#requireRuntime();
    return createOwnedAgentLoop(
      runtime.infra,
      {
        ...loopOptions,
        id: loopId,
        loopDir: loopId === PRIMARY_AGENT_LOOP_ID
          ? runtime.infra.paths.sessionDir
          : join(runtime.infra.paths.sessionDir, "loops", loopId),
        model: loopOptions.model ?? this.#getDefaultModel(),
        logger: runtime.runtime.logger,
      },
      runtime.runtime.extensionRegistry,
    );
  }

  #configureCreatedLoop(loop: AgentLoop, loopOptions: CreateAgentLoopOptions): Promise<void> | undefined {
    return loopOptions.model === undefined ? loop.setModel(this.#getDefaultModel()) : undefined;
  }
}

export function createSessionId(id?: string): SessionId {
  if (id === undefined) return randomUUID() as SessionId;
  const normalized = id.trim();
  if (!normalized) throw new Error("MultiAgentPiSession id must not be empty");
  return normalized as SessionId;
}

/** Create an empty Session; Harness admission binds shared runtime dependencies before loops are created. */
export function createMultiAgentPiSession(
  options: CreateMultiAgentPiSessionOptions = {},
): MultiAgentPiSession {
  return MultiAgentPiSession.create(options);
}
