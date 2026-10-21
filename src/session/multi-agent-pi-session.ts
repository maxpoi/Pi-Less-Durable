import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  Session as CoreSession,
  type AgentLoop,
  type AgentLoopLogger,
  type ExecutionEnvFactory,
  type ModelRuntime,
  type MultiAgentPiSettingsManager,
  type SessionOptions as CoreSessionOptions,
  type TargetedLoopExtensionRegistry,
} from "#core";
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

type MultiAgentPiCoreSessionOptions = CoreSessionOptions<AgentLoop, SessionId>;

interface MultiAgentPiSessionConstruction {
  readonly cwd: string;
  readonly sessionDir: string | undefined;
  readonly defaultSessionDirectoryName: string;
}

export class MultiAgentPiSession
  extends CoreSession<AgentLoop, SessionId>
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
    this.#infra = createSessionInfra({
      id: this.id,
      modelRuntime: runtime.modelRuntime,
      settings: runtime.settings,
      logger: runtime.logger,
      extensionRegistry: runtime.extensionRegistry,
      ...(runtime.env === undefined ? {} : { env: runtime.env }),
      paths: {
        cwd: this.#cwd,
        sessionDir,
        configDir: runtime.configDir,
      },
    });

    this.bindExtensionRegistry(runtime.extensionRegistry);
    this.#runtime = runtime;
  }

  /** Shared immutable dependencies for constructing runtimes registered with this Session. */
  get infra(): SessionInfra {
    if (this.#infra === undefined) {
      throw new Error(
        `MultiAgentPiSession "${this.id}" must be added to a Harness before its infrastructure is available`,
      );
    }
    return this.#infra;
  }

  override register(loop: AgentLoop): void {
    void this.infra;
    super.register(loop);
  }

  override setPrimary(id: string): AgentLoop {
    if (id !== PRIMARY_AGENT_LOOP_ID) {
      throw new Error(
        `MultiAgentPiSession primary AgentLoop must use id "${PRIMARY_AGENT_LOOP_ID}", got "${id}"`,
      );
    }
    return super.setPrimary(id);
  }
}

export function createSessionId(id?: string): SessionId {
  if (id === undefined) return randomUUID() as SessionId;
  const normalized = id.trim();
  if (!normalized) throw new Error("MultiAgentPiSession id must not be empty");
  return normalized as SessionId;
}

/** Create an empty Session; Harness admission binds shared runtime dependencies. */
export function createMultiAgentPiSession(
  options: CreateMultiAgentPiSessionOptions = {},
): MultiAgentPiSession {
  return MultiAgentPiSession.create(options);
}
