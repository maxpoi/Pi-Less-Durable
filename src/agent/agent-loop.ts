import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, CompactionResult } from "@earendil-works/pi-coding-agent";
import type { MultiAgentPiSettingsManager } from "../config/multi-agent-pi-settings-manager.js";
import type { AgentLogger } from "../logger/logger.js";
import { activateCodemode } from "../extensions/built-in-extensions.js";
import {
  clearAgentWaitingHeartbeat,
  createAgentEventHandlerState,
  resetAgentEventHandlerState,
  type AgentEventHandlerState,
} from "./runtime-maintainance/agent-event-handler-utils.js";
import { handleGenericEvent } from "./runtime-maintainance/agent-event-handler.js";
import { createAgentRunState } from "./runtime-maintainance/agent-run-state.js";
import { stripSessionImages } from "./runtime-maintainance/context-maintenance.js";

export type AgentLoopLifecycleKind = "prompt" | "resume" | "compact" | "reload";
export type AgentLoopState = "idle" | "running" | "paused" | "completed" | "failed" | "aborted" | "destroyed";

export interface AgentIdentity {
  /** Stable identity unique within the containing Room. */
  readonly id: string;
  /** Non-unique user-facing label. */
  readonly name: string;
  /** Non-unique role used for extension targeting across Rooms. */
  readonly tag: string;
}

export interface AgentLoopOptions {
  readonly identity: AgentIdentity;
  readonly session: AgentSession;
  readonly settingsManager: MultiAgentPiSettingsManager;
  readonly logger: AgentLogger;
  readonly logTag: string;
}

interface ActiveLifecycle {
  readonly kind: AgentLoopLifecycleKind;
  promise: Promise<unknown> | undefined;
}

/** Whole-operation lifecycle owner around one native Pi AgentSession. */
export class AgentLoop {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly session: AgentSession;

  readonly #settingsManager: MultiAgentPiSettingsManager;
  readonly #logger: AgentLogger;
  readonly #logTag: string;
  readonly #eventHandlerState: AgentEventHandlerState;
  readonly #unsubscribe: () => void;
  #runState = createAgentRunState();
  #state: AgentLoopState = "idle";
  #activeLifecycle: ActiveLifecycle | undefined;
  #destroyPromise: Promise<void> | undefined;
  #pauseRequested = false;
  #previousTurnAborted = false;

  private constructor(options: AgentLoopOptions) {
    this.id = options.identity.id;
    this.name = options.identity.name.trim();
    this.tag = options.identity.tag.trim();
    this.session = options.session;
    this.#settingsManager = options.settingsManager;
    this.#logger = options.logger;
    this.#logTag = options.logTag;
    this.#eventHandlerState = createAgentEventHandlerState();
    activateCodemode(this.session);
    this.#unsubscribe = this.session.subscribe(event => {
      this.#abortInterruptedRequestIfNeeded();
      handleGenericEvent(event, {
        session: this.session,
        handlerState: this.#eventHandlerState,
        runState: this.#runState,
        logger: this.#logger,
        logTag: this.#logTag,
        getCompactionTriggerPoint: () => this.#getCompactionTriggerPoint(),
      });
    });
  }

  /** @internal MultiAgentPiHarness is the sole AgentLoop factory. */
  static createForHarness(options: AgentLoopOptions): AgentLoop {
    return new AgentLoop(options);
  }

  get state(): AgentLoopState {
    return this.#state;
  }

  get activeLifecycleKind(): AgentLoopLifecycleKind | undefined {
    return this.#activeLifecycle?.kind;
  }

  get isBusy(): boolean {
    return this.#activeLifecycle !== undefined || !this.session.isIdle;
  }

  get stopReason(): string {
    return this.#runState.stopReason;
  }

  get lastError(): string | undefined {
    return this.#runState.lastError;
  }

  get messages(): AgentMessage[] {
    return this.session.sessionManager.buildSessionProjection().messages;
  }

  setActiveToolsByName(toolNames: readonly string[]): void {
    this.#assertUsable("set active tools on");
    this.session.setActiveToolsByName([...toolNames]);
  }

  /** Admitted runtime failures resolve as a failed loop; admission validation throws. */
  prompt(message: string, images: readonly ImageContent[] = []): Promise<void> {
    this.#assertPromptable("prompt");
    this.#state = "running";
    return this.#runLifecycle("prompt", () => this.#runPromptLifecycle(
      "prompt",
      async () => {
        const promptMessage = this.#withUserStopReminder(message);
        await this.session.prompt(
          promptMessage,
          images.length === 0
            ? undefined
            : { images: images.map(image => ({ ...image })) },
        );
      },
      () => this.#waitForCompactionBeforePrompt(),
    ));
  }

  /** Admitted runtime failures resolve as a failed loop; admission validation throws. */
  resume(): Promise<void> {
    this.#assertUsable("resume");
    if (this.#activeLifecycle !== undefined) {
      throw new Error(
        `Cannot resume agent loop "${this.id}" while ${this.#activeLifecycle.kind} is active`,
      );
    }
    if (this.#state !== "paused") {
      throw new Error(`Cannot resume agent loop "${this.id}" while it is ${this.#state}`);
    }
    this.#state = "running";
    this.#pauseRequested = false;
    return this.#runLifecycle("resume", () => this.#runPromptLifecycle("resume", () =>
      this.session.prompt("[SYSTEM: Resume your work. Continue from where you left off.]"),
    ));
  }

  /** Pause only while AgentSession is processing a prompt; use stop() before that boundary. */
  pause(): void {
    if (this.#state !== "running") return;
    if (!this.session.isStreaming) {
      throw new Error(
        `Cannot pause agent loop "${this.id}" before AgentSession starts processing its prompt; use stop() instead`,
      );
    }
    this.#pauseRequested = true;
    this.#logger.info(`[${this.#logTag}] Pause requested — aborting current run`);
    void this.session.abort();
  }

  compact(customInstructions?: string): Promise<CompactionResult> {
    this.#assertUsable("compact");
    return this.#runLifecycle(
      "compact",
      () => this.session.compact(customInstructions),
    );
  }

  reload(): Promise<void> {
    this.#assertUsable("reload");
    return this.#runLifecycle("reload", () => this.session.reload({
      beforeSessionStart: () => activateCodemode(this.session),
    }));
  }

  abort(): Promise<void> {
    if (this.#state === "destroyed") return Promise.resolve();
    if (this.#activeLifecycle?.kind === "compact") return this.session.abort();
    if (this.#state === "running" || this.#state === "paused") {
      this.#state = "aborted";
      this.#runState.stopReason = "aborted";
      this.#logger.info(`[${this.#logTag}] Aborted`);
      return this.session.abort();
    }
    return this.session.isCompacting ? this.session.abort() : Promise.resolve();
  }

  stop(): "prompt" | "compaction" | "none" {
    if (this.#activeLifecycle?.kind === "compact") {
      void this.session.abort();
      return "compaction";
    }
    if (this.#state === "running" || this.#state === "paused") {
      this.#previousTurnAborted = true;
      void this.abort();
      return "prompt";
    }
    if (this.session.isCompacting) {
      void this.session.abort();
      return "compaction";
    }
    return "none";
  }

  async waitForIdle(): Promise<void> {
    await this.#activeLifecycle?.promise?.catch(() => undefined);
    await this.session.waitForIdle();
  }

  destroy(): Promise<void> {
    this.#destroyPromise ??= this.#destroy();
    return this.#destroyPromise;
  }

  #beginRun(): void {
    this.#runState = createAgentRunState();
    resetAgentEventHandlerState(this.#eventHandlerState, this.messages.length);
  }

  async #runPromptLifecycle(
    kind: "prompt" | "resume",
    promptOperation: () => Promise<void>,
    beforePrompt?: () => Promise<void>,
  ): Promise<void> {
    try {
      this.#beginRun();
      await beforePrompt?.();
    } catch (error) {
      this.#recordPromptFailure(kind, error);
      this.#finalize();
      return;
    }

    if (!this.#isAborted()) {
      try {
        await promptOperation();
      } catch (error) {
        this.#recordPromptFailure(kind, error);
      }
    }

    try {
      await this.#finishPromptRun();
    } catch (error) {
      this.#recordPromptFailure(`${kind} post-run maintenance`, error);
    }
    this.#finalize();
  }

  #recordPromptFailure(phase: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failureAlreadyRecorded = this.#runState.stopReason === "error";
    if (!this.#isAborted() && !failureAlreadyRecorded) {
      this.#runState.stopReason = "error";
    }
    if (!failureAlreadyRecorded && this.#runState.lastError === undefined) {
      this.#runState.lastError = errorMessage;
    }
    this.#logger.warning(`[${this.#logTag}] Error during ${phase}`, errorMessage);
  }

  #abortInterruptedRequestIfNeeded(): void {
    const hasPendingPrompt = this.#activeLifecycle?.kind === "prompt"
      || this.#activeLifecycle?.kind === "resume";
    const interrupted = this.#state === "aborted" || this.#pauseRequested;
    if (!hasPendingPrompt || !interrupted) return;
    if (!this.session.isStreaming && !this.session.isCompacting) return;

    void this.session.abort().catch(error => {
      this.#logger.warning(
        `[${this.#logTag}] Failed to abort native work for interrupted request`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  #getCompactionTriggerPoint(): number | undefined {
    const model = this.session.agent.state.model;
    if (!model) return undefined;
    const compaction = this.#settingsManager.getCompactionSettings({
      provider: model.provider,
      id: model.id,
    });
    return this.#settingsManager.compactionPolicy.getTriggerPoint(
      model.contextWindow,
      compaction,
    );
  }

  async #waitForCompactionBeforePrompt(): Promise<void> {
    if (!this.session.isCompacting) return;
    this.#logger.info(`[${this.#logTag}] Compaction in progress — waiting before prompt`);
    await this.session.waitForIdle();
  }

  #withUserStopReminder(message: string): string {
    if (!this.#previousTurnAborted) return message;
    this.#previousTurnAborted = false;
    this.#logger.info(`[${this.#logTag}] Previous turn was aborted — added user-stop reminder`);
    return `[SYSTEM: You were stopped by the user while you were working on user's previous prompt. Following is user's new prompt.]\n\n${message}`;
  }

  async #finishPromptRun(): Promise<void> {
    const stripped = stripSessionImages(this.session.sessionManager);
    if (stripped > 0) {
      this.#logger.info(`[${this.#logTag}] Stripped ${stripped} image(s) from session after prompt`);
    }

    const model = this.session.agent.state.model;
    const contextTokens = this.#runState.contextTokens;
    if (!model) return;
    const compaction = this.#settingsManager.getCompactionSettings({
      provider: model.provider,
      id: model.id,
    });
    if (!this.#settingsManager.compactionPolicy.shouldTrigger(
      contextTokens,
      model.contextWindow,
      compaction,
    )) return;

    this.#logger.info(
      `[${this.#logTag}] Context ${contextTokens} exceeds auto-compact ceiling, triggering compaction`,
    );
    try {
      const result = await this.session.compact();
      this.#logger.info(`[${this.#logTag}] Auto-compaction complete: ${result.tokensBefore} tokens before`);
    } catch (error) {
      this.#logger.warning(
        `[${this.#logTag}] Auto-compaction failed`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #finalize(): void {
    if (this.#state === "aborted") {
      this.#runState.stopReason = "aborted";
      this.#pauseRequested = false;
    } else if (this.#runState.stopReason === "error") {
      this.#state = "failed";
      this.#pauseRequested = false;
    } else if (this.#pauseRequested) {
      this.#state = "paused";
      this.#pauseRequested = false;
      this.#logger.info(`[${this.#logTag}] Paused after turn ${this.#runState.turnCount}`);
    } else if (this.#state === "running") {
      this.#state = "completed";
    }

    this.#logger.info(
      `[${this.#logTag}] ${this.#state} — ${this.#runState.turnCount} turns, ${this.#runState.toolCount} tools`,
    );
  }

  #runLifecycle<T>(
    kind: AgentLoopLifecycleKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.#activeLifecycle !== undefined) {
      return Promise.reject(
        new Error(
          `Cannot start ${kind} on agent loop "${this.id}" while ${this.#activeLifecycle.kind} is active`,
        ),
      );
    }

    const lifecycle: ActiveLifecycle = { kind, promise: undefined };
    this.#activeLifecycle = lifecycle;
    const promise = Promise.resolve().then(operation).finally(() => {
      if (kind === "prompt" || kind === "resume") {
        clearAgentWaitingHeartbeat(this.#eventHandlerState);
        if (this.#state === "running") {
          this.#state = "idle";
          this.#pauseRequested = false;
        }
      }
      if (this.#activeLifecycle === lifecycle) this.#activeLifecycle = undefined;
    });
    lifecycle.promise = promise;
    return promise;
  }

  #isAborted(): boolean {
    return this.#state === "aborted";
  }

  #assertUsable(operation: string): void {
    if (this.#destroyPromise !== undefined || this.#state === "destroyed") {
      throw new Error(`Cannot ${operation} destroyed agent loop "${this.id}"`);
    }
  }

  #assertPromptable(operation: string): void {
    this.#assertUsable(operation);
    if (this.#activeLifecycle !== undefined) {
      throw new Error(
        `Cannot ${operation} agent loop "${this.id}" while ${this.#activeLifecycle.kind} is active`,
      );
    }
    if (
      this.#state !== "idle"
      && this.#state !== "completed"
      && this.#state !== "failed"
      && this.#state !== "aborted"
    ) {
      throw new Error(`Cannot ${operation} agent loop "${this.id}" while it is ${this.#state}`);
    }
  }

  async #destroy(): Promise<void> {
    const errors: unknown[] = [];
    const settle = async (operation: () => Promise<void> | void): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    if (this.#activeLifecycle?.kind === "prompt" || this.#activeLifecycle?.kind === "resume") {
      await settle(() => this.abort());
    } else if (this.#activeLifecycle !== undefined || !this.session.isIdle) {
      await settle(() => this.session.abort());
    }
    await settle(() => this.waitForIdle());
    await settle(() => {
      clearAgentWaitingHeartbeat(this.#eventHandlerState);
      this.#unsubscribe();
    });
    await settle(async () => {
      if (this.session.hasExtensionHandlers("session_shutdown")) {
        await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
    });
    await settle(() => this.session.dispose());
    this.#state = "destroyed";

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to destroy agent loop "${this.id}"`);
    }
  }
}
