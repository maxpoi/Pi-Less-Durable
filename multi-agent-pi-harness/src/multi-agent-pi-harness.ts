import type {
  ExtensionAPI,
  ExtensionFactory,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import {
  MultiAgentPiCompactionPolicy,
  MultiAgentPiSettingsManager,
  TargetedLoopExtensionRegistry,
  defaultAgentLoopLogger,
  type AgentLoopLogger,
  type ExecutionEnvFactory,
  type ExtensionLoopContext,
  type MultiAgentPiConfig,
} from "multi-agent-pi";
import { resolveMultiAgentPiHarnessConfigDirectory, type MultiAgentPiHarnessConfigError } from "./config/config-path.js";
import { MultiAgentPiConfigStore } from "./config/config-store.js";
import { createSessionInfra } from "./session/session-infra.js";
import {
  PRIMARY_AGENT_LOOP_ID,
  createMultiAgentPiSession,
  createSessionId,
  type MultiAgentPiSession,
  type SessionId,
} from "./session/multi-agent-pi-session.js";

export type MultiAgentPiHarnessState = "created" | "opening" | "open" | "reloading" | "closing" | "closed";

export interface MultiAgentPiHarnessOptions {
  readonly configDir?: string;
  /** Host-owned model/provider/auth runtime. MultiAgentPiHarness borrows but never closes it. */
  readonly modelRuntime: ModelRuntime;
  /** Optional diagnostic override used by every AgentLoop. Defaults to the core console logger. */
  readonly logger?: AgentLoopLogger;
  /** Consumer-owned Pi environment factory, resolved afresh for each use by every AgentLoop. */
  readonly env?: ExecutionEnvFactory<SessionId>;
}

export interface CreateMultiAgentPiSessionOptions {
  /** Execution working directory passed to Pi. Defaults to the host process cwd. */
  readonly cwd?: string;
  readonly sessionDir?: string;
  /** Install the host's complete prompt policy through Pi's native extension API. */
  readonly configurePrompt: (pi: ExtensionAPI) => Promise<void> | void;
}

export interface ReloadMultiAgentPiHarnessOptions {
  readonly sessionId?: SessionId;
  readonly loopId?: string;
}

export type MultiAgentPiHarnessExtensionTarget =
  | "all"
  | {
      readonly sessionId: SessionId;
      readonly loopIds: "all" | readonly string[];
    }
  | ((context: ExtensionLoopContext) => boolean);

function throwSessionCreationFailure(
  sessionId: SessionId,
  creationError: unknown,
  cleanupError: unknown,
): never {
  const cleanupErrors = cleanupError instanceof AggregateError
    ? cleanupError.errors
    : [cleanupError];
  const distinctErrors = [...new Set<unknown>([creationError, ...cleanupErrors])];
  if (distinctErrors.length === 1) throw distinctErrors[0];
  throw new AggregateError(
    distinctErrors,
    `Failed to create and clean up MultiAgentPiSession "${sessionId}"`,
  );
}

export class MultiAgentPiHarness {
  readonly #configStore: MultiAgentPiConfigStore;
  readonly #modelRuntime: ModelRuntime;
  readonly #logger: AgentLoopLogger;
  readonly #env: ExecutionEnvFactory<SessionId> | undefined;
  readonly #extensionRegistry = new TargetedLoopExtensionRegistry();
  #configDiagnostics: readonly MultiAgentPiHarnessConfigError[] = [];
  #settingsManager: MultiAgentPiSettingsManager | undefined;
  readonly #sessions = new Map<SessionId, MultiAgentPiSession>();
  readonly #pendingSessions = new Map<SessionId, MultiAgentPiSession>();
  #state: MultiAgentPiHarnessState = "created";
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: MultiAgentPiHarnessOptions) {
    const configDir = resolveMultiAgentPiHarnessConfigDirectory(options.configDir);
    this.#configStore = new MultiAgentPiConfigStore(configDir);
    this.#modelRuntime = options.modelRuntime;
    this.#logger = options.logger ?? defaultAgentLoopLogger;
    this.#env = options.env;
  }

  get configDir(): string {
    return this.#configStore.configDir;
  }

  get state(): MultiAgentPiHarnessState {
    return this.#state;
  }

  get configDiagnostics(): readonly MultiAgentPiHarnessConfigError[] {
    return this.#configDiagnostics;
  }

  get config(): Readonly<MultiAgentPiConfig> {
    if (this.#state !== "open") {
      throw new Error(`MultiAgentPiHarness config is unavailable while it is ${this.#state}`);
    }
    return this.#configStore.loadConfig();
  }

  get settings(): MultiAgentPiSettingsManager {
    if (this.#settingsManager === undefined) {
      throw new Error("MultiAgentPiHarness settings are unavailable before open() or after close()");
    }
    return this.#settingsManager;
  }

  open(): Promise<void> {
    if (this.#state === "open") {
      return Promise.resolve();
    }
    if (this.#state === "opening") {
      return this.#openPromise!;
    }
    if (this.#state === "reloading" || this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(new Error(`Cannot open MultiAgentPiHarness while it is ${this.#state}`));
    }

    this.#state = "opening";
    this.#openPromise = this.#openRuntime();
    return this.#openPromise;
  }

  reload(options: ReloadMultiAgentPiHarnessOptions = {}): Promise<void> {
    if (this.#state !== "open" || this.#settingsManager === undefined) {
      return Promise.reject(new Error(`Cannot reload MultiAgentPiHarness while it is ${this.#state}`));
    }
    if (options.loopId !== undefined && options.sessionId === undefined) {
      return Promise.reject(new Error("Targeted AgentLoop reload requires a sessionId"));
    }

    let sessions: MultiAgentPiSession[];
    try {
      if (this.#pendingSessions.size > 0) {
        throw new Error("Cannot reload MultiAgentPiHarness while MultiAgentPiSession creation is pending");
      }
      sessions = options.sessionId === undefined
        ? [...this.#sessions.values()]
        : [this.#requireSession(options.sessionId)];
      for (const session of sessions) session.assertReloadable(options.loopId);
      const configuration = this.#configStore.initialize();
      this.#configDiagnostics = configuration.diagnostics;
    } catch (error) {
      return Promise.reject(error);
    }

    this.#state = "reloading";
    const settingsManager = this.#settingsManager;
    let startSettingsReload!: () => void;
    let rejectSettingsReload!: (error: unknown) => void;
    const settingsGate = new Promise<void>((resolve, reject) => {
      startSettingsReload = resolve;
      rejectSettingsReload = reject;
    });
    const settingsReload = settingsGate.then(() => settingsManager.reload());
    const sessionReloads: Promise<void>[] = [];
    let previousSessionReload = Promise.resolve();
    try {
      for (const session of sessions) {
        const prerequisite = Promise.all([
          settingsReload,
          previousSessionReload.catch(() => {}),
        ]).then(() => undefined);
        const sessionReload = session.reloadAfter(prerequisite, options.loopId);
        sessionReloads.push(sessionReload);
        previousSessionReload = sessionReload;
      }
    } catch (error) {
      rejectSettingsReload(error);
      return this.#settleReload(settingsReload, sessionReloads);
    }
    startSettingsReload();
    return this.#settleReload(settingsReload, sessionReloads);
  }

  /** Declare a Pi extension for every Session's primary loop; existing loops adopt it on reload. */
  registerExtension(extension: ExtensionFactory): void {
    this.#assertExtensionRegistrationAllowed();
    this.#extensionRegistry.register(
      undefined,
      context => context.loopId === PRIMARY_AGENT_LOOP_ID,
      extension,
    );
  }

  /** Declare an explicit process/session/loop target; `all` means every loop in scope. */
  registerLoopExtension(target: MultiAgentPiHarnessExtensionTarget, extension: ExtensionFactory): void {
    this.#assertExtensionRegistrationAllowed();
    this.#extensionRegistry.register(undefined, target, extension);
  }

  async createSession(options: CreateMultiAgentPiSessionOptions): Promise<MultiAgentPiSession> {
    if (this.#state !== "open") {
      throw new Error(`Cannot create a MultiAgentPiSession while the harness is ${this.#state}`);
    }
    if (typeof options?.configurePrompt !== "function") {
      throw new Error("MultiAgentPiHarness requires the host to configure its prompt policy");
    }

    let id = createSessionId();
    while (this.#sessions.has(id) || this.#pendingSessions.has(id)) {
      id = createSessionId();
    }

    const settings = this.#settingsManager;
    if (settings === undefined) {
      throw new Error("Cannot create a MultiAgentPiSession before settings are initialized");
    }

    const sessionDir = resolve(options.sessionDir ?? join(this.configDir, "sessions", id));
    const infra = createSessionInfra({
      id,
      modelRuntime: this.#modelRuntime,
      settings,
      ...(this.#env === undefined ? {} : { env: this.#env }),
      paths: {
        cwd: resolve(options.cwd ?? process.cwd()),
        sessionDir,
        configDir: this.configDir,
      },
    });
    const session = createMultiAgentPiSession({
      infra,
      logger: this.#logger,
      extensionRegistry: this.#extensionRegistry,
      onClosed: closedSession => {
        if (this.#sessions.get(closedSession.id) === closedSession) {
          this.#sessions.delete(closedSession.id);
        }
        if (this.#pendingSessions.get(closedSession.id) === closedSession) {
          this.#pendingSessions.delete(closedSession.id);
        }
      },
    });
    this.#pendingSessions.set(id, session);
    try {
      const main = await session.create({
        id: PRIMARY_AGENT_LOOP_ID,
        loopTag: PRIMARY_AGENT_LOOP_ID,
        configurePrompt: options.configurePrompt,
      });
      session.setPrimary(main.id);
      session.select(main.id);
      this.#pendingSessions.delete(id);
      this.#sessions.set(id, session);
      return session;
    } catch (error) {
      try {
        await session.close();
      } catch (cleanupError) {
        throwSessionCreationFailure(id, error, cleanupError);
      }
      throw error;
    }
  }

  #assertExtensionRegistrationAllowed(): void {
    if (this.#state === "reloading" || this.#state === "closing" || this.#state === "closed") {
      throw new Error(`Cannot register an extension while MultiAgentPiHarness is ${this.#state}`);
    }
  }

  getSession(id: SessionId): MultiAgentPiSession | undefined {
    return this.#sessions.get(id);
  }

  #requireSession(id: SessionId): MultiAgentPiSession {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`MultiAgentPiSession "${id}" not found`);
    return session;
  }

  listSessions(): readonly MultiAgentPiSession[] {
    return Object.freeze([...this.#sessions.values()]);
  }

  async closeSession(id: SessionId): Promise<void> {
    await this.#sessions.get(id)?.close();
  }

  async #settleReload(
    settingsReload: Promise<void>,
    sessionReloads: readonly Promise<void>[],
  ): Promise<void> {
    try {
      const [settingsResult, sessionResults] = await Promise.all([
        settingsReload.then(
          () => ({ status: "fulfilled" as const }),
          reason => ({ status: "rejected" as const, reason }),
        ),
        Promise.allSettled(sessionReloads),
      ]);
      if (settingsResult.status === "rejected") throw settingsResult.reason;

      const errors = sessionResults.flatMap(result =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "One or more MultiAgentPiSessions failed to reload cleanly");
      }
    } finally {
      if (this.#state === "reloading") this.#state = "open";
    }
  }

  async #openRuntime(): Promise<void> {
    try {
      const configuration = this.#configStore.initialize();
      this.#configDiagnostics = configuration.diagnostics;
      this.#settingsManager = new MultiAgentPiSettingsManager(
        this.#configStore,
        new MultiAgentPiCompactionPolicy(
          modelRef => this.#modelRuntime.getModel(modelRef.provider, modelRef.id),
        ),
      );
      if (this.#state === "opening") {
        this.#state = "open";
      }
    } catch (error) {
      if (this.#state === "opening") {
        this.#state = "created";
        this.#openPromise = undefined;
      }
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }

    this.#state = "closing";
    // Session.close() synchronously transitions to closed and unregisters both
    // published and still-initializing sessions before returning settlement.
    const ownedSessions = new Set([
      ...this.#sessions.values(),
      ...this.#pendingSessions.values(),
    ]);
    const sessionClosures = [...ownedSessions].map(session => session.close());
    this.#closePromise = this.#closeRuntime(sessionClosures);
    return this.#closePromise;
  }

  async #closeRuntime(sessionClosures: readonly Promise<void>[]): Promise<void> {
    try {
      await this.#openPromise;
    } catch {
      // Opening failure is already reported to the open() caller. Closing must
      // still settle the lifecycle and release any partially initialized state.
    }
    const errors: unknown[] = [];
    const closeResults = await Promise.allSettled(sessionClosures);
    for (const result of closeResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }

    this.#sessions.clear();
    this.#pendingSessions.clear();
    this.#settingsManager = undefined;
    this.#state = "closed";

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "One or more MultiAgentPiSessions failed to close cleanly");
    }
  }
}
