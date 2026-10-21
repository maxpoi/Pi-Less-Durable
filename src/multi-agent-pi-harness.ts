import {
  MultiAgentPiCompactionPolicy,
  MultiAgentPiSettingsManager,
  TargetedLoopExtensionRegistry,
  defaultAgentLoopLogger,
  setupCompactionStripExtension,
  type AgentLoopLogger,
  type ExecutionEnvFactory,
  type ExtensionFactory,
  type ExtensionLoopContext,
  type ModelRuntime,
  type MultiAgentPiConfig,
} from "#core";
import { resolveMultiAgentPiHarnessConfigDirectory, type MultiAgentPiHarnessConfigError } from "./config/config-path.js";
import { MultiAgentPiConfigStore } from "./config/config-store.js";
import {
  MultiAgentPiSession,
  PRIMARY_AGENT_LOOP_ID,
  createMultiAgentPiSession,
  type CreateMultiAgentPiSessionOptions,
  type SessionId,
} from "./session/multi-agent-pi-session.js";

export type MultiAgentPiHarnessState = "created" | "opening" | "open" | "reloading" | "closing" | "closed";

export interface MultiAgentPiHarnessOptions {
  readonly configDir?: string;
  /** Host-owned model/provider/auth runtime. MultiAgentPiHarness borrows but never closes it. */
  readonly modelRuntime: ModelRuntime;
  /** Optional diagnostic sink shared by every admitted Session. */
  readonly logger?: AgentLoopLogger;
  /** Consumer-owned Pi environment factory, resolved afresh for each use by every AgentLoop. */
  readonly env?: ExecutionEnvFactory<SessionId>;
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

export class MultiAgentPiHarness {
  readonly #configStore: MultiAgentPiConfigStore;
  readonly #modelRuntime: ModelRuntime;
  readonly #logger: AgentLoopLogger;
  readonly #env: ExecutionEnvFactory<SessionId> | undefined;
  readonly #extensionRegistry = new TargetedLoopExtensionRegistry();
  #configDiagnostics: readonly MultiAgentPiHarnessConfigError[] = [];
  readonly #settingsManager: MultiAgentPiSettingsManager;
  readonly #sessions = new Map<SessionId, MultiAgentPiSession>();
  #state: MultiAgentPiHarnessState = "created";
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: MultiAgentPiHarnessOptions) {
    const configDir = resolveMultiAgentPiHarnessConfigDirectory(options.configDir);
    this.#configStore = new MultiAgentPiConfigStore(configDir);
    this.#modelRuntime = options.modelRuntime;
    this.#settingsManager = new MultiAgentPiSettingsManager(
      this.#configStore,
      new MultiAgentPiCompactionPolicy(
        modelRef => this.#modelRuntime.getModel(modelRef.provider, modelRef.id),
      ),
    );
    this.#logger = options.logger ?? defaultAgentLoopLogger;
    this.#env = options.env;
    this.#extensionRegistry.register(
      undefined,
      "all",
      pi => setupCompactionStripExtension(pi, this.#logger),
    );
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
    if (this.#state === "created" || this.#state === "opening" || this.#state === "closed") {
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

  /**
   * Reload only when every targeted Session is idle.
   *
   * Event-bus integration contract for the later Bridge layer: before checking
   * isBusy, Harness must make its bus queue all incoming room, periodic, and
   * background-agent messages so no new prompt can reach a Session or AgentLoop.
   * Each queued item must retain its original Session/loop target, complete
   * payload, and caller promise. Whether reload succeeds or fails, wait until
   * reload settles and Harness returns to open, then reopen the bus and flush in
   * arrival order. Resolve or reject each original promise from its dispatched
   * result so no steering or follow-up work is discarded or retargeted.
   */
  reload(options: ReloadMultiAgentPiHarnessOptions = {}): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(new Error(`Cannot reload MultiAgentPiHarness while it is ${this.#state}`));
    }
    if (options.loopId !== undefined && options.sessionId === undefined) {
      return Promise.reject(new Error("Targeted AgentLoop reload requires a sessionId"));
    }

    const sessions = [...this.#sessions.values()];
    let targetedSession: MultiAgentPiSession | undefined;
    try {
      targetedSession = options.sessionId === undefined
        ? undefined
        : this.#requireSession(options.sessionId);
      const sessionsToReload = targetedSession === undefined ? sessions : [targetedSession];
      const busySession = sessionsToReload.find(session => session.isBusy);
      if (busySession !== undefined) {
        throw new Error(`Cannot reload MultiAgentPiHarness while Session "${busySession.id}" is busy`);
      }
      if (targetedSession === undefined) {
        const configuration = this.#configStore.initialize();
        this.#configDiagnostics = configuration.diagnostics;
      }
    } catch (error) {
      return Promise.reject(error);
    }

    this.#state = "reloading";
    return this.#reloadRuntime(sessions, targetedSession, options.loopId);
  }

  /** Declare a Pi extension for every Session's canonical `main` loop; existing loops adopt it on reload. */
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

  /** Create an empty Session; the host explicitly creates, designates, and selects its canonical `main` loop. */
  async createSession(options: CreateMultiAgentPiSessionOptions = {}): Promise<MultiAgentPiSession> {
    if (this.#state !== "open") {
      throw new Error(`Cannot create a MultiAgentPiSession while the harness is ${this.#state}`);
    }

    let session = createMultiAgentPiSession(options);
    while (this.#sessions.has(session.id)) {
      if (options.id !== undefined) {
        throw new Error(`Session "${session.id}" is already registered`);
      }
      session = createMultiAgentPiSession(options);
    }
    this.addSession(session);
    return session;
  }

  /** Transfer a host-created MultiAgentPiSession into this Harness lifecycle; close it through the Harness. */
  addSession(session: MultiAgentPiSession): void {
    if (this.#state !== "open") {
      throw new Error(`Cannot add a Session while the harness is ${this.#state}`);
    }
    if (!(session instanceof MultiAgentPiSession)) {
      throw new Error("MultiAgentPiHarness only accepts MultiAgentPiSession instances");
    }
    if (session.getState() !== "open") {
      throw new Error(`Cannot add Session "${session.id}" while it is ${session.getState()}`);
    }
    if (this.#sessions.has(session.id)) {
      throw new Error(`Session "${session.id}" is already registered`);
    }
    const runtime = {
      configDir: this.configDir,
      modelRuntime: this.#modelRuntime,
      settings: this.#settingsManager,
      logger: this.#logger,
      ...(this.#env === undefined ? {} : { env: this.#env }),
      extensionRegistry: this.#extensionRegistry,
      onClosed: (closedSession: MultiAgentPiSession) => {
        if (this.#sessions.get(closedSession.id) === closedSession) {
          this.#sessions.delete(closedSession.id);
        }
      },
    };
    session.initialize(runtime);
    this.#sessions.set(session.id, session);
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
    if (this.#state !== "open") {
      throw new Error(`Cannot close a Session while the harness is ${this.#state}`);
    }
    const session = this.#sessions.get(id);
    if (!session) return;
    try {
      await session.close();
    } finally {
      if (this.#sessions.get(id) === session && session.getState() === "closed") {
        this.#sessions.delete(id);
      }
    }
  }

  async #reloadRuntime(
    sessions: readonly MultiAgentPiSession[],
    targetedSession: MultiAgentPiSession | undefined,
    loopId: string | undefined,
  ): Promise<void> {
    try {
      if (targetedSession !== undefined) {
        await targetedSession.reload(loopId);
        return;
      }

      await this.#settingsManager.reload();
      const errors: unknown[] = [];
      for (const session of sessions) {
        try {
          await session.reload();
        } catch (error) {
          errors.push(error);
        }
      }
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
      await this.#settingsManager.reload();
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
    if (this.#state === "reloading") {
      return Promise.reject(new Error("Cannot close MultiAgentPiHarness while it is reloading"));
    }
    const reloadingSession = [...this.#sessions.values()]
      .find(session => session.isReloading);
    if (reloadingSession !== undefined) {
      return Promise.reject(
        new Error(`Cannot close MultiAgentPiHarness while Session "${reloadingSession.id}" is reloading`),
      );
    }

    this.#state = "closing";
    // Session.close() synchronously transitions to closed while Harness keeps
    // ownership until each returned teardown promise settles.
    const sessionClosures = [...this.#sessions.values()].map(session => session.close());
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
    this.#state = "closed";

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "One or more MultiAgentPiSessions failed to close cleanly");
    }
  }
}
