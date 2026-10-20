import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord";
import { type Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { modelsAreEqual, type Api, type ImageContent, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, CompactionResult, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  executionEnvContext,
  type AgentLoopExecutionEnv,
  type ExecutionEnv,
  type ExecutionEnvUse,
} from "../execution-environment.js";
import { defaultAgentLoopLogger } from "./logger.js";
import {
  accountAgentEvent,
  createAgentLoopRunState,
  type AgentEventAccounting,
  type AgentLoopRunState,
} from "./run-state.js";
import {
  clearAgentLoopWaitingHeartbeat,
  createAgentLoopEventHandlerState,
  handleAgentLoopEvent,
  logAgentLoopEventDiagnostics,
  resetAgentLoopEventHandlerState,
} from "./event-handler.js";
import {
  autoCompactIfNeeded,
  stripProcessedImages,
  waitForCompactionBeforePrompt,
  waitForRetrySettle,
} from "./post-run.js";
import type {
  AgentLoopCompactionPolicy,
  AgentLoopEventHook,
  AgentLoopExecutionContext,
  AgentLoopLifecycle,
  AgentLoopLifecycleKind,
  AgentLoopLogContext,
  AgentLoopLogger,
  AgentLoopModelChangeOptions,
  AgentLoopOptions,
  AgentLoopOutput,
  AgentLoopResult,
  AgentLoopRuntime,
  AgentLoopState,
  AgentLoopUsageStore,
} from "./types.js";

export function formatAgentLoopLogTag(
  sessionName: string | undefined,
  sessionId: string,
  loopTag: string,
): string {
  return `${sessionName?.trim() || sessionId}:${loopTag}`;
}

function formatEventFailureDetail(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}

type AgentLoopFailureTag =
  | "built-in-event-handler"
  | "custom-event-hook"
  | "event-diagnostics"
  | "event-accounting"
  | "abort-interrupted-request"
  | "output"
  | "usage-store";

type ActiveAgentLoopLifecycle = {
  kind: AgentLoopLifecycleKind;
  promise: Promise<unknown> | null;
};

const agentLoopExecutionContext = new AsyncLocalStorage<AgentLoopExecutionContext>();

export function getCurrentAgentLoopExecution(): AgentLoopExecutionContext | undefined {
  return agentLoopExecutionContext.getStore();
}

/** Resolve the active loop's host-owned Pi environment for this use. */
export async function resolveCurrentAgentLoopExecutionEnv(
  signal?: AbortSignal,
): Promise<ExecutionEnvUse | undefined> {
  const execution = getCurrentAgentLoopExecution();
  if (!execution) {
    throw new Error("Execution environment resolution requires an active AgentLoop");
  }
  const context = executionEnvContext(signal);
  const env = await execution.loop.resolveExecutionEnv(context);
  return env === undefined ? undefined : { env, context };
}

/** Resolve the active loop's environment or fail as an ordinary tool error. */
export async function requireCurrentAgentLoopExecutionEnv(
  signal?: AbortSignal,
): Promise<ExecutionEnvUse> {
  const use = await resolveCurrentAgentLoopExecutionEnv(signal);
  if (use === undefined) throw new Error("No execution environment is configured");
  return use;
}

export function assertAgentLoopId(id: string): void {
  if (!id.trim()) throw new Error("AgentLoop id must not be empty");
}

/** Complete transport-neutral AgentLoop implementation over one native Pi runtime. */
export class AgentLoop {
  readonly id: string;
  readonly loopDir: string;

  protected _state: AgentLoopState = "idle";
  protected _runState: AgentLoopRunState;
  protected _output: AgentLoopOutput | null = null;
  protected _activeLifecycle: ActiveAgentLoopLifecycle | null = null;

  readonly #runtime: AgentLoopRuntime;
  readonly #logger: AgentLoopLogger;
  readonly #sessionId: string;
  #sessionName: string | undefined;
  readonly #compactionPolicy: AgentLoopCompactionPolicy | undefined;
  readonly #usageStore: AgentLoopUsageStore | undefined;
  readonly #lifecycleHooks: AgentLoopLifecycle | undefined;
  readonly #env: AgentLoopExecutionEnv | undefined;
  readonly #loopTag: string;
  readonly #onEvent: AgentLoopEventHook | undefined;

  #unsubscribe: (() => void) | null = null;
  #pauseRequested = false;
  #result: AgentLoopResult | null = null;
  #previousTurnAborted = false;
  #eventHandlerState = createAgentLoopEventHandlerState();
  #eventQueue: Promise<void> = Promise.resolve();
  #destroyPromise: Promise<void> | null = null;

  constructor(options: AgentLoopOptions) {
    assertAgentLoopId(options.id);
    this.id = options.id;
    this.loopDir = options.loopDir;
    this.#runtime = options.runtime;
    this.#logger = options.logger ?? defaultAgentLoopLogger;
    this.#sessionId = options.sessionId ?? options.runtime.sessionManager.getSessionId();
    this.#sessionName = options.sessionName?.trim() || undefined;
    this.#compactionPolicy = options.compactionPolicy;
    this.#usageStore = options.usageStore;
    this.#lifecycleHooks = options.lifecycleHooks;
    this.#env = options.env;
    this.#loopTag = options.loopTag || `loop:${options.id}`;
    this.#onEvent = options.onEvent;
    this._runState = createAgentLoopRunState();
  }

  get state(): AgentLoopState { return this._state; }
  get activeLifecycleKind(): AgentLoopLifecycleKind | null { return this._activeLifecycle?.kind ?? null; }
  get isBusy(): boolean { return this._activeLifecycle !== null; }
  get runState(): AgentLoopRunState { return this._runState; }
  get isAttached(): boolean { return this._output !== null; }
  get loopTag(): string { return this.#loopTag; }
  get logTag(): string { return formatAgentLoopLogTag(this.#sessionName, this.#sessionId, this.loopTag); }
  get messages(): AgentMessage[] { return this.#runtime.sessionManager.buildSessionProjection().messages; }
  get result(): AgentLoopResult | null { return this.#result; }
  get session(): AgentSession { return this.#runtime.session; }
  get sessionManager(): SessionManager { return this.#runtime.sessionManager; }
  get agent(): Agent { return this.#runtime.agent; }

  setSessionName(sessionName: string | undefined): void {
    this.#sessionName = sessionName?.trim() || undefined;
  }

  attach(output: AgentLoopOutput): void { this._output = output; }
  detach(): void { this._output = null; }

  /** Resolve a host-owned Pi environment afresh for one direct use. */
  async resolveExecutionEnv(context: Context): Promise<ExecutionEnv | undefined> {
    return this.#env?.(context);
  }

  async reload(): Promise<string[]> {
    return this.reloadExtensions();
  }

  reloadAfter(prerequisite: Promise<void>): Promise<string[]> {
    return this.#reloadExtensions(prerequisite);
  }

  async reloadExtensions(): Promise<string[]> {
    return this.#reloadExtensions();
  }

  #reloadExtensions(prerequisite?: Promise<void>): Promise<string[]> {
    if (this._state === "destroyed") {
      throw new Error(`Cannot reload extensions for destroyed loop "${this.id}"`);
    }
    return this.#startLifecycle("reload", async () => {
      if (prerequisite) await prerequisite;
      await this.#lifecycleHooks?.onBeforeReloadStart?.();
      await this.#runtime.session.reload();
      const errors = this.#runtime.session.resourceLoader.getExtensions().errors
        .map(error => `${error.path}: ${error.error}`);
      await this.#lifecycleHooks?.onReloadEnd?.();
      return errors;
    });
  }

  setActiveToolsByName(toolNames: readonly string[]): void {
    this.#runtime.session.setActiveToolsByName([...toolNames]);
  }

  async setModel(model: Model<Api>, options?: AgentLoopModelChangeOptions): Promise<void> {
    if (modelsAreEqual(this.#runtime.session.model, model) && options?.persist !== true) {
      // Pi uses direct replacement when registry metadata changed without a
      // semantic provider/model switch.
      this.#runtime.agent.state.model = model as any;
      return;
    }
    await this.#runtime.session.setModel(model, options);
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    if (this._state === "destroyed") {
      throw new Error(`Cannot compact destroyed loop "${this.id}"`);
    }
    return this.#startLifecycle("compact", async () => {
      this.#subscribeEvents();
      try {
        return await this.#runtime.session.compact(customInstructions);
      } finally {
        await this.#settleEventQueue();
      }
    });
  }

  async prompt(message: string, images: readonly ImageContent[] = []): Promise<AgentLoopResult> {
    if (this._activeLifecycle !== null) {
      throw new Error(`Cannot prompt loop "${this.id}" while ${this._activeLifecycle.kind} is active`);
    }
    if (this._state !== "idle" && this._state !== "completed" && this._state !== "aborted") {
      throw new Error(`Cannot prompt loop "${this.id}" in state "${this._state}"`);
    }
    const promptImages = images.map(image => ({
      type: image.type,
      data: image.data,
      mimeType: image.mimeType,
    }));
    this._state = "running";

    return this.#startLifecycle("prompt", async () => {
      this.#subscribeEvents();
      this._runState = createAgentLoopRunState();
      resetAgentLoopEventHandlerState(this.#eventHandlerState, this.messages.length);
      await waitForCompactionBeforePrompt(this.#runtime.session, this.#logger, this.logTag);
      if (this.#isAborted()) {
        await this.#finishPromptRun();
        return this.#finalize();
      }

      const promptMessage = this.#withUserStopReminder(message);
      try {
        await this.#promptSession(promptMessage, promptImages);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (this._state !== "aborted") this._runState.stopReason = "error";
        this._runState.lastError = errorMessage;
        this.#logger.warning(`[${this.logTag}] Error during prompt`, errorMessage);
      }
      await this.#finishPromptRun();
      return this.#finalize();
    });
  }

  async resume(): Promise<AgentLoopResult> {
    if (this._activeLifecycle !== null) {
      throw new Error(`Cannot resume loop "${this.id}" while ${this._activeLifecycle.kind} is active`);
    }
    if (this._state !== "paused") {
      throw new Error(`Cannot resume loop "${this.id}" in state "${this._state}"`);
    }
    this._state = "running";
    this.#pauseRequested = false;

    return this.#startLifecycle("resume", async () => {
      this.#subscribeEvents();
      this._runState = createAgentLoopRunState();
      resetAgentLoopEventHandlerState(this.#eventHandlerState, this.messages.length);

      this.#logger.info(`[${this.logTag}] Resuming...`);
      try {
        await this.#promptSession("[SYSTEM: Resume your work. Continue from where you left off.]");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (this._state !== "aborted") this._runState.stopReason = "error";
        this._runState.lastError = errorMessage;
        this.#logger.warning(`[${this.logTag}] Error during resume`, errorMessage);
      }
      await this.#finishPromptRun();
      return this.#finalize();
    });
  }

  pause(): void {
    if (this._state !== "running") return;
    this.#pauseRequested = true;
    this.#logger.info(`[${this.logTag}] Pause requested — aborting current run`);
    void this.#runtime.session.abort();
  }

  abort(): void {
    if (this._activeLifecycle?.kind === "compact") {
      void this.#runtime.session.abort();
      this.#logger.info(`[${this.logTag}] Compaction abort requested`);
      return;
    }

    if (this.#abortRuntime()) this.#completeAbort();
  }

  stop(): "prompt" | "compaction" | "none" {
    if (this._activeLifecycle?.kind === "compact") {
      this.abort();
      return "compaction";
    }

    if (this.#runtime.session.isCompacting) {
      if (!this.#abortRuntime()) {
        void this.#runtime.session.abort();
        this.#logger.info(`[${this.logTag}] Compaction abort requested`);
        return "compaction";
      }
      this.#completeAbort();
      return "prompt";
    }

    if (!this.#abortRuntime()) return "none";
    this.#previousTurnAborted = true;
    this.#completeAbort();
    return "prompt";
  }

  async waitForIdle(): Promise<void> {
    const lifecyclePromise = this._activeLifecycle?.promise;
    if (lifecyclePromise) await lifecyclePromise.catch(() => undefined);
    await this.#runtime.session.waitForIdle();
  }

  /** Awaiting this from the loop's own active execution, including its hooks or tools, will deadlock. */
  destroy(): Promise<void> {
    if (this.#destroyPromise === null) this.#destroyPromise = this.#destroyRuntime();
    return this.#destroyPromise;
  }

  #startLifecycle<T>(kind: AgentLoopLifecycleKind, operation: () => Promise<T>): Promise<T> {
    if (this._activeLifecycle !== null) {
      throw new Error(`Cannot start ${kind} on loop "${this.id}" while ${this._activeLifecycle.kind} is active`);
    }

    const lifecycle: ActiveAgentLoopLifecycle = { kind, promise: null };
    this._activeLifecycle = lifecycle;
    let operationPromise: Promise<T>;
    try {
      operationPromise = this.#runInExecutionContext(operation);
    } catch (error) {
      this._activeLifecycle = null;
      throw error;
    }
    const lifecyclePromise = operationPromise.finally(() => {
      if (this._activeLifecycle === lifecycle) this._activeLifecycle = null;
    });
    lifecycle.promise = lifecyclePromise;
    return lifecyclePromise;
  }

  #runInExecutionContext<T>(operation: () => T): T {
    return agentLoopExecutionContext.run({ loopId: this.id, loop: this }, operation);
  }

  #abortRuntime(): boolean {
    if (this._state !== "running" && this._state !== "paused") return false;
    this._state = "aborted";
    this._runState.stopReason = "aborted";
    const output = this._output;
    if (output) {
      try {
        output.abortLifecycle();
      } catch (error) {
        this.#recordEventFailure("output", error);
      }
    }
    void this.#runtime.session.abort();
    return true;
  }

  #completeAbort(): void {
    clearAgentLoopWaitingHeartbeat(this.#eventHandlerState);
    this.#logger.info(`[${this.logTag}] Aborted`);
  }

  #promptSession(message: string, images: ImageContent[] = []): Promise<void> {
    return this.#runtime.session.prompt(
      message,
      images.length > 0 ? { images } : undefined,
    );
  }

  #withUserStopReminder(message: string): string {
    if (!this.#previousTurnAborted) return message;
    this.#previousTurnAborted = false;
    this.#logger.info(`[${this.logTag}] Previous turn was aborted — added user-stop reminder to user message`);
    return `[SYSTEM: You were stopped by the user while you were working on user's previous prompt. Following is user's new prompt.]\n\n${message}`;
  }

  async #postTerminalErrorIfNeeded(): Promise<void> {
    if (this._runState.stopReason !== "error") return;
    const message = this._runState.lastError;
    const output = this._output;
    if (!message || !output) return;
    await this.#runEventOperation(
      "output",
      () => output.handleTerminalError({ message }),
    );
  }

  #subscribeEvents(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#runtime.session.subscribe(event => {
      this.#eventQueue = this.#eventQueue.then(
        () => this.#runInExecutionContext(() => this.#processEvent(event)),
      );
    });
  }

  async #processEvent(event: AgentSessionEvent): Promise<void> {
    // Event order is intentional:
    // run-state update -> maintenance/semantic logs -> progress diagnostics
    // -> optional output -> usage persistence -> application observer.

    // Apply event-derived execution state before any downstream consumer.
    let accounting: AgentEventAccounting = {};
    await this.#runEventOperation("event-accounting", () => {
      accounting = accountAgentEvent(event, this._runState);
    });
    // A late natural stop and an explicit abort are both acceptable until lifecycle settlement.
    // if (this._state === "aborted") this._runState.stopReason = "aborted";

    /*
     * Pi prompt preflight performs asynchronous work before a native run becomes active:
     *
     *   await input handlers
     *   await authentication check
     *   await automatic compaction check
     *   await before_agent_start handlers
     *   await image normalization
     *
     * A stop or pause during those awaits calls session.abort() while Pi still appears idle. That
     * abort is not sticky, so preflight can subsequently start native agent or compaction work. Re-check
     * Pi's public activity state here and await a second abort. This cannot recursively process
     * final events because the AgentLoop subscription serializes them behind the current event:
     *
     *   processEvent(agent_start)
     *     await session.abort()
     *       emit message_end  → queued
     *       emit agent_end    → queued
     *       settle session
     *     abort returns
     *   processEvent(agent_start) finishes
     *   processEvent(message_end) runs
     *   processEvent(agent_end) runs
     */
    const hasPendingPrompt = this._activeLifecycle?.kind === "prompt"
      || this._activeLifecycle?.kind === "resume";
    const abortedRequest = this.#isAborted() && hasPendingPrompt;
    const interruptedRequest = abortedRequest || (this.#pauseRequested && hasPendingPrompt);
    const session = this.#runtime.session;
    const nativeWorkActive = session.isStreaming || session.isCompacting;
    if (interruptedRequest && nativeWorkActive) {
      await this.#runEventOperation(
        "abort-interrupted-request",
        async () => {
          await session.abort();
          this.#logger.info(`[${this.logTag}] Aborted native work for interrupted request`);
        },
      );
    }

    // Perform maintenance and emit semantic logs such as tool results, model details, and responses.
    await this.#runEventOperation(
      "built-in-event-handler",
      () => this.#handleGenericEvent(event, accounting),
    );

    // Emit baseline lifecycle/progress diagnostics using the updated counters and timings.
    await this.#runEventOperation("event-diagnostics", () => {
      logAgentLoopEventDiagnostics(event, {
        state: this.#eventHandlerState,
        logger: this.#logger,
        logTag: this.logTag,
        runState: this._runState,
        accounting,
      });
    });

    // Presentation is optional and cannot fail the execution.
    const output = this._output;
    if (output && !abortedRequest) {
      await this.#runEventOperation(
        "output",
        () => output.handleEvent(event),
      );
    }

    // Persist the accounting snapshot without mutating execution state.
    await this.#runEventOperation(
      "usage-store",
      () => this.#recordUsageFromEvent(event, accounting),
    );

    // Application observation runs last and follows Pi's non-fatal extension-event semantics.
    const onEvent = this.#onEvent;
    if (onEvent) {
      await this.#runEventOperation(
        "custom-event-hook",
        () => onEvent(event),
      );
    }
  }

  async #runEventOperation(
    tag: AgentLoopFailureTag,
    operation: () => unknown | Promise<unknown>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.#recordEventFailure(tag, error);
    }
  }

  #recordEventFailure(tag: AgentLoopFailureTag, error: unknown): void {
    const warning = `[${this.logTag}] Agent event ${tag} warning failure`;
    const detail = formatEventFailureDetail(error);
    try {
      this.#logger.warning(warning, detail);
    } catch (loggingError) {
      try {
        defaultAgentLoopLogger.warning(warning, detail);
        defaultAgentLoopLogger.warning(
          `[${this.logTag}] Agent event warning logger failed`,
          formatEventFailureDetail(loggingError),
        );
      } catch {
        // Event processing must continue when no diagnostic sink remains available.
      }
    }
  }

  async #settleEventQueue(): Promise<void> {
    while (true) {
      const pending = this.#eventQueue;
      await pending;
      if (pending === this.#eventQueue) break;
    }
    if (this.#isAborted()) this._runState.stopReason = "aborted";
  }

  #sessionLabel(): string {
    return this.#sessionName || this.#sessionId;
  }

  #logContext(): AgentLoopLogContext {
    return {
      scopeId: this.#sessionId,
      scopeName: this.#sessionLabel(),
      tag: this.loopTag,
    };
  }

  #isAborted(): boolean {
    return this._state === "aborted";
  }

  #handleGenericEvent(event: AgentSessionEvent, accounting: AgentEventAccounting): void {
    handleAgentLoopEvent(event, this.#eventHandlerState, {
      accounting,
      agent: this.#runtime.agent,
      sessionManager: this.#runtime.sessionManager,
      logger: this.#logger,
      logContext: this.#logContext(),
      logTag: this.logTag,
      reportFailure: error => this.#recordEventFailure("built-in-event-handler", error),
      ...(this.#compactionPolicy === undefined ? {} : { compaction: this.#compactionPolicy }),
    });
  }

  #recordUsageFromEvent(event: AgentSessionEvent, accounting: AgentEventAccounting): void {
    if (event.type !== "message_end") return;
    const message = event.message;
    if (message?.role !== "assistant" || !message.usage) return;

    this.#usageStore?.record({
      source: this.loopTag,
      timestamp: Date.now(),
      input: message.usage.input || 0,
      output: message.usage.output || 0,
      cacheRead: message.usage.cacheRead || 0,
      cacheWrite: message.usage.cacheWrite || 0,
      ...(message.usage.cacheWrite1h !== undefined ? { cacheWrite1h: message.usage.cacheWrite1h } : {}),
      cost: message.usage.cost?.total || 0,
      costInput: message.usage.cost?.input || 0,
      costOutput: message.usage.cost?.output || 0,
      costCacheRead: message.usage.cost?.cacheRead || 0,
      costCacheWrite: message.usage.cost?.cacheWrite || 0,
      turns: 1,
      ...(accounting.toolCalls === undefined ? {} : { toolCalls: accounting.toolCalls }),
    });
  }

  async #finishPromptRun(): Promise<void> {
    await waitForRetrySettle(this.#runtime.session, this.#logger, this.logTag);
    await this.#settleEventQueue();
    await this.#postTerminalErrorIfNeeded();
    stripProcessedImages(this.#runtime.sessionManager, this.#logger, this.logTag);
    await autoCompactIfNeeded(
      this.#runtime.session,
      this.#compactionPolicy,
      this._runState.contextTokens,
      this.#logger,
      this.logTag,
    );
    await this.#settleEventQueue();
  }

  #finalize(): AgentLoopResult {
    if (this._state === "aborted") {
      this._runState.stopReason = "aborted";
      this.#pauseRequested = false;
    } else if (this.#pauseRequested) {
      this._state = "paused";
      this.#pauseRequested = false;
      this.#logger.info(`[${this.logTag}] Paused after turn ${this._runState.turnCount}`);
    } else if (this._state === "running") {
      this._state = "completed";
    }

    const state = this._runState;
    this.#result = {
      turns: state.turnCount,
      toolCalls: state.toolCount,
      aborted: this._state === "aborted",
      usage: state.usage,
    };
    this.#logger.info(
      `[${this.logTag}] ${this._state} — ${state.turnCount} turns, ${state.toolCount} tools`,
    );
    return this.#result;
  }

  async #destroyRuntime(): Promise<void> {
    const errors: unknown[] = [];
    const settle = async (operation: () => Promise<void> | void): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    await settle(() => this.#lifecycleHooks?.onDestroyStart?.());
    const activeLifecycle = this._activeLifecycle;
    if (activeLifecycle?.kind !== "compact" && (this._state === "running" || this._state === "paused")) {
      await settle(() => this.abort());
    }

    if (activeLifecycle?.promise) {
      await settle(async () => { await activeLifecycle.promise; });
    }
    await settle(() => this.waitForIdle());
    await settle(() => this.#settleEventQueue());

    this.detach();
    clearAgentLoopWaitingHeartbeat(this.#eventHandlerState);
    if (this.#unsubscribe) {
      const unsubscribe = this.#unsubscribe;
      this.#unsubscribe = null;
      await settle(() => unsubscribe());
    }
    await settle(async () => {
      if (this.#runtime.session.hasExtensionHandlers("session_shutdown")) {
        await this.#runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
    });
    await settle(() => this.#runtime.session.dispose());
    this._state = "destroyed";
    await settle(() => this.#lifecycleHooks?.onDestroyed?.());
    this.#logger.info(`[${this.logTag}] Destroyed`);

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to destroy AgentLoop "${this.id}"`);
    }
  }
}

export function forkBranchEntries(runner: {
  getBranch(fromId?: string): SessionEntry[];
  getLeafId(): string | null;
}): SessionEntry[] {
  const leafId = runner.getLeafId();
  if (!leafId) return [];
  return runner.getBranch(leafId);
}
