import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  CompactionResult,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentLoopContext,
  MultiAgentPiHandler,
} from "../multi-agent-pi/context.js";
import { issueMultiAgentPiEvent } from "../multi-agent-pi/api.js";
import type { MultiAgentPiSettingsManager } from "../config/multi-agent-pi-settings-manager.js";
import { MultiAgentPiResourceLoader } from "../multi-agent-pi/extension-registry.js";
import type { AgentLogger } from "../logger/logger.js";
import type { Room } from "../room/room.js";
import { BackgroundTaskManager } from "../room/background-task-manager.js";
import type { RoomId } from "../room/room-types.js";
import {
  CODEMODE_EXTENSION_NAME,
  CODEX_SERVER_COMPACTION_EXTENSION_NAME,
} from "../extensions/built-in-extensions.js";
import {
  clearAgentWaitingHeartbeat,
  createAgentEventHandlerState,
  resetAgentEventHandlerState,
  type AgentEventHandlerState,
} from "./runtime-maintainance/agent-event-handler-utils.js";
import { handleGenericEvent } from "./runtime-maintainance/agent-event-handler.js";
import { createAgentRunState } from "./runtime-maintainance/agent-run-state.js";
import { stripSessionImages } from "./runtime-maintainance/context-maintenance.js";
import {
  createAgentLoop,
  type AgentConfig,
  type AgentLoopExtensionSources,
} from "./agent-session-factory.js";
import type { AgentSystemPrompt } from "./system-prompt.js";

export type AgentLoopLifecycleKind = "prompt" | "resume" | "compact" | "reload";
export type AgentLoopState = "idle" | "running" | "paused" | "aborted" | "destroyed"; // paused is a special alternative of idle
export type AgentLoopQueuedPromptType =
  | "group-before-idle-then-prompt"
  | "wait-idle-then-prompt";
export type AgentLoopRoundOutcome = "completed" | "failed" | "aborted" | "paused";
export type AgentLoopPersistence = "durable" | "memory";

export interface AgentLoopResult {
  readonly round: number;
  readonly outcome: AgentLoopRoundOutcome;
  readonly turns: number;
  readonly toolCalls: number;
  readonly usage: Readonly<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  }>;
  readonly stopReason: string;
  readonly error?: string;
}

export interface AgentLoopRoundEndEvent {
  readonly type: "agent_round_end";
  readonly agentId: string;
  readonly result: AgentLoopResult;
}

export type AgentLoopRoundEndHandler = MultiAgentPiHandler<
  AgentLoopRoundEndEvent,
  AgentLoopContext
>;

export interface AgentIdentity {
  /** Stable identity unique within the containing Room. Maximum 200 ASCII characters from `a-zA-Z0-9_-+=.()[]{}!@#$%^&`. */
  readonly id: string;
  /** Non-unique user-facing label. */
  readonly name: string;
  /** Non-unique role used for extension targeting across Rooms. */
  readonly tag: string;
}

export type CreateAgentLoopOptions = {
  readonly agent: AgentIdentity;
  readonly config: AgentConfig;
  /** Native Pi transcript persistence. Defaults to durable. */
  readonly persistence?: AgentLoopPersistence;
  readonly extensionSources?: AgentLoopExtensionSources;
} & (
  | {
      /** AgentLoop data directory; AgentLoop.dir exposes its filesystem-canonical identity. */
      readonly dir: string;
      readonly room?: never;
    }
  | {
      /** Room whose canonical root/child directory should contain this AgentLoop. */
      readonly room: Room;
      readonly dir?: never;
    }
  | {
      /** In-memory standalone loops receive a unique OS temporary data directory. */
      readonly persistence: "memory";
      readonly dir?: never;
      readonly room?: never;
    }
);

interface AgentLoopOptions {
  readonly dir: string;
  readonly identity: AgentIdentity;
  readonly session: AgentSession;
  readonly backgroundTasks: BackgroundTaskManager;
  readonly settingsManager: MultiAgentPiSettingsManager;
  readonly logger: AgentLogger;
  readonly disabledExtensions: Set<string>;
  readonly systemPrompt: AgentSystemPrompt;
}

interface ActiveLifecycle {
  readonly kind: AgentLoopLifecycleKind;
  promise: Promise<unknown> | undefined;
}

interface QueuedAgentLoopPrompt {
  readonly id: string;
  readonly type: AgentLoopQueuedPromptType;
  readonly content: string;
}

const AGENT_LOOP_QUEUE_LOG_FILE = "log.jsonl";
const GROUPED_PROMPT_SEPARATOR = "\n\n";

/** Whole-operation lifecycle owner around one native Pi AgentSession. */
export class AgentLoop {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly session: AgentSession;
  readonly backgroundTasks: BackgroundTaskManager;
  readonly systemPrompt: AgentSystemPrompt;

  readonly #dir: string;
  readonly #settingsManager: MultiAgentPiSettingsManager;
  readonly #logger: AgentLogger;
  readonly #eventHandlerState: AgentEventHandlerState;
  readonly #disabledExtensions: Set<string>;
  #unsubscribe: (() => void) | undefined;
  #runState = createAgentRunState();
  #state: AgentLoopState = "idle";
  #activeLifecycle: ActiveLifecycle | undefined;
  #destroyPromise: Promise<void> | undefined;
  readonly #promptQueue: QueuedAgentLoopPrompt[] = [];
  readonly #roundEndHandlers = new Set<AgentLoopRoundEndHandler>();
  #round = 0;
  #pauseRequested = false;
  #previousTurnAborted = false;

  /** Public API */
  /** Init */
  /** Create an AgentLoop, registering it automatically when a Room is supplied. */
  static create(options: CreateAgentLoopOptions): Promise<AgentLoop> {
    return createAgentLoop(options);
  }

  /** Prompt lifecycle */

  /** Start one independent Round immediately; reject when another lifecycle is active. */
  prompt(message: string, images: readonly ImageContent[] = []): Promise<AgentLoopResult> {
    return this.#prompt(message, images);
  }

  /** Enqueue text for automatic fire-and-forget FIFO submission. */
  enqueuePrompt(type: AgentLoopQueuedPromptType, content: string): void {
    this.#assertUsable("enqueue a prompt on");
    const queued: QueuedAgentLoopPrompt = {
      id: randomUUID(),
      type,
      content,
    };
    this.#appendPromptQueueLog([queued], "queued");
    this.#promptQueue.push(queued);
    this.#startNextQueuedPrompt();
  }

  /** Admitted runtime failures resolve as a failed Round; admission validation throws. */
  resume(): Promise<AgentLoopResult> {
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
    const round = ++this.#round;
    return this.#runLifecycle("resume", () => this.#runPromptLifecycle(
      round,
      "resume",
      () => this.session.prompt("[SYSTEM: Resume your work. Continue from where you left off.]"),
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

  abort(): Promise<void> {
    if (this.#state === "destroyed") return Promise.resolve();
    if (this.#activeLifecycle?.kind === "compact") return this.session.abort();
    if (this.#state === "running") {
      this.#state = "aborted";
      this.#runState.stopReason = "aborted";
      this.#logger.info(`[${this.#logTag}] Aborted`);
      return this.session.abort();
    }
    if (this.#state === "paused") {
      this.#state = "idle";
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

  /** Reload lifecycle */

  /** Validate reload admission without mutating this AgentLoop. */
  assertReloadable(): void {
    this.#assertUsable("reload");
    this.#assertSessionReloadAvailable("reload");
  }

  reload(): Promise<void> {
    this.assertReloadable();
    this.#disabledExtensions.clear();
    return this.#reloadSession();
  }

  /** Disable one loaded extension for this AgentLoop until its next explicit reload. */
  disable(extension: string): Promise<void> {
    this.#assertUsable("disable an extension on");
    if (!extension.trim()) throw new Error("Extension name must not be empty");
    this.#assertSessionReloadAvailable("disable an extension on");
    if (extension === CODEMODE_EXTENSION_NAME) {
      throw new Error(
        `Extension "${extension}" is controlled through setActiveToolsByName()`,
      );
    }
    if (extension === CODEX_SERVER_COMPACTION_EXTENSION_NAME) {
      throw new Error(
        `Extension "${extension}" is controlled by compaction.codexServerSide`,
      );
    }
    if (this.#disabledExtensions.has(extension)) return Promise.resolve();

    const resourceLoader = this.#resourceLoader();
    const matches = resourceLoader.getExtensions().extensions.filter(loadedExtension =>
      resourceLoader.getAppliedExtensionName(loadedExtension.path) === extension
    );
    if (matches.length === 0) {
      throw new Error(
        `Extension "${extension}" is not loaded in agent loop "${this.id}"`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Extension name "${extension}" is ambiguous in agent loop "${this.id}"`,
      );
    }

    this.#disabledExtensions.add(extension);
    return this.#reloadSession();
  }

  /** Destroy lifecycle */

  destroy(): Promise<void> {
    if (this.#destroyPromise !== undefined) return this.#destroyPromise;
    const destruction = this.#destroy();
    this.#destroyPromise = destruction;
    return destruction;
  }

  /** Helpers */

  /** @internal Observe one loop's executed Rounds before queued continuation. */
  on(event: "agent_round_end", handler: AgentLoopRoundEndHandler): () => void {
    this.#assertUsable("register an agent_round_end handler on");
    this.#roundEndHandlers.add(handler);
    return () => {
      this.#roundEndHandlers.delete(handler);
    };
  }

  get dir(): string {
    return this.#dir;
  }

  get roomId(): RoomId | undefined {
    return this.#resourceLoader().roomId;
  }

  get state(): AgentLoopState {
    return this.#state;
  }

  get activeLifecycleKind(): AgentLoopLifecycleKind | undefined {
    return this.#activeLifecycle?.kind;
  }

  get isBusy(): boolean {
    return this.#activeLifecycle !== undefined
      || !this.session.isIdle
      || this.backgroundTasks.activeCount > 0;
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

  get disabledExtensions(): readonly string[] {
    return Object.freeze([...this.#disabledExtensions].sort());
  }

  /** Return every tool in the native AgentSession's effective post-filter registry. */
  getToolList(): readonly ToolInfo[] {
    return this.session.getAllTools();
  }

  setActiveToolsByName(toolNames: readonly string[]): void {
    this.#assertUsable("set active tools on");
    this.session.setActiveToolsByName([...toolNames]);
  }

  /** Internal implementation */

  /** Init */

  private constructor(options: AgentLoopOptions) {
    this.#dir = options.dir;
    this.id = options.identity.id;
    this.name = options.identity.name;
    this.tag = options.identity.tag;
    this.session = options.session;
    this.backgroundTasks = options.backgroundTasks;
    this.systemPrompt = options.systemPrompt;
    this.#settingsManager = options.settingsManager;
    this.#logger = options.logger;
    this.#disabledExtensions = options.disabledExtensions;
    this.#eventHandlerState = createAgentEventHandlerState();
  }

  /** @internal Bind one fully assembled native AgentSession to its AgentLoop owner. */
  static async bindSession(options: AgentLoopOptions): Promise<AgentLoop> {
    const loop = new AgentLoop(options);
    try {
      await loop.#bindSession(loop.session);
      return loop;
    } catch (error) {
      try {
        await loop.destroy();
      } catch (destroyError) {
        throw new AggregateError(
          [error, destroyError],
          `AgentLoop "${loop.id}" failed extension binding and cleanup`,
        );
      }
      throw error;
    }
  }

  /** @internal Assign Room identity when ownership transfers through Room.register(). */
  setRoomId(roomId: RoomId): void {
    this.#resourceLoader().setRoomId(roomId);
    this.backgroundTasks.setRoomId(roomId);
  }

  async #bindSession(session: AgentSession): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;

    this.#unsubscribe = session.subscribe(event => {
      this.#abortInterruptedRequestIfNeeded();
      handleGenericEvent(event, {
        session,
        handlerState: this.#eventHandlerState,
        runState: this.#runState,
        logger: this.#logger,
        logTag: this.#logTag,
        getCompactionTriggerPoint: () => this.#getCompactionTriggerPoint(),
      });
    });
    try {
      await session.bindExtensions({
        onError: error => this.#logger.warning(
          "Pi extension error",
          `${error.extensionPath}: ${error.error}`,
        ),
      });
    } catch (error) {
      this.#unsubscribe();
      this.#unsubscribe = undefined;
      throw error;
    }
  }

  /** Prompt lifecycle */

  #startNextQueuedPrompt(): void {
    if (
      this.#destroyPromise !== undefined
      || this.#state === "destroyed"
      || this.#state === "paused"
      || this.#activeLifecycle !== undefined
      || !this.session.isIdle
      || this.#promptQueue.length === 0
    ) {
      return;
    }

    const queued = this.#takeNextQueuedPromptGroup();
    const content = queued.map(item => item.content).join(GROUPED_PROMPT_SEPARATOR);
    try {
      const operation = this.#prompt(content, [], () => {
        try {
          this.#appendPromptQueueLog(queued, "un-queued");
        } catch (error) {
          this.#logger.warning(
            `[${this.#logTag}] Failed to append queued prompt submission status`,
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      void operation.catch(error => {
        this.#logger.warning(
          `[${this.#logTag}] Queued prompt failed`,
          error instanceof Error ? error.message : String(error),
        );
      });
    } catch (error) {
      this.#logger.warning(
        `[${this.#logTag}] Failed to start queued prompt`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  #takeNextQueuedPromptGroup(): QueuedAgentLoopPrompt[] {
    const first = this.#promptQueue.shift();
    if (first === undefined) {
      throw new Error(`Cannot take a queued prompt from empty agent loop "${this.id}"`);
    }
    if (first.type === "wait-idle-then-prompt") return [first];

    const group = [first];
    while (this.#promptQueue[0]?.type === "group-before-idle-then-prompt") {
      group.push(this.#promptQueue.shift()!);
    }
    return group;
  }

  #prompt(
    message: string,
    images: readonly ImageContent[],
    onSubmitted?: () => void,
  ): Promise<AgentLoopResult> {
    this.#assertPromptable("prompt");
    this.#state = "running";
    const round = ++this.#round;
    return this.#runLifecycle("prompt", () => this.#runPromptLifecycle(
      round,
      "prompt",
      async () => {
        const promptMessage = this.#withUserStopReminder(message);
        const operation = this.session.prompt(
          promptMessage,
          images.length === 0
            ? undefined
            : { images: images.map(image => ({ ...image })) },
        );
        onSubmitted?.();
        await operation;
      },
      () => this.#waitForCompactionBeforePrompt(),
    ));
  }

  #appendPromptQueueLog(
    queued: readonly QueuedAgentLoopPrompt[],
    status: "queued" | "un-queued",
  ): void {
    const timestamp = new Date().toISOString();
    appendFileSync(
      join(this.#dir, AGENT_LOOP_QUEUE_LOG_FILE),
      queued.map(item => JSON.stringify({
        timestamp,
        id: item.id,
        content: item.content,
        type: item.type,
        status,
      })).join("\n") + "\n",
      "utf8",
    );
  }

  #beginRun(): void {
    this.#runState = createAgentRunState();
    resetAgentEventHandlerState(this.#eventHandlerState, this.messages.length);
  }

  async #runPromptLifecycle(
    round: number,
    kind: "prompt" | "resume",
    promptOperation: () => Promise<void>,
    beforePrompt?: () => Promise<void>,
  ): Promise<AgentLoopResult> {
    try {
      this.#beginRun();
      await beforePrompt?.();
    } catch (error) {
      this.#recordPromptFailure(kind, error);
      return this.#finishRound(round);
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
    return this.#finishRound(round);
  }

  /*
   * Pi prompt preflight performs asynchronous work before a native run becomes active:
   *
   *   await input handlers
   *   await authentication check
   *   await automatic compaction check
   *   await before_agent_start handlers
   *   await image normalization
   *
   * A stop during those awaits calls session.abort() while Pi still appears idle. That abort is not
   * sticky, so preflight can subsequently start native agent or compaction work. Re-check Pi's
   * public activity state on each resulting session event and issue a second abort when that late
   * native work becomes active. A requested pause uses the same check while native work settles.
   *
   * AgentSession.abort() issues every cancellation synchronously before its first await:
   *
   *   session event reports streaming or compaction
   *     session.abort()
   *       abort retry, compaction, branch summary, and agent
   *       await native idle settlement
   *     handle the current session event synchronously
   *
   * The listener does not await the returned abort Promise. The owning prompt or compaction Promise
   * remains pending until Pi settles its native lifecycle, and AgentLoop awaits that owner before
   * Round completion or destruction.
   */
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

    const interrupted = this.#isAborted()
      || this.#pauseRequested
      || this.#runState.stopReason === "error";
    if (interrupted) return;

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

  async #finishRound(round: number): Promise<AgentLoopResult> {
    const result = this.#finalize(round);
    const event: AgentLoopRoundEndEvent = Object.freeze({
      type: "agent_round_end",
      agentId: this.id,
      result,
    });
    await issueMultiAgentPiEvent(
      event,
      this,
      async context => {
        for (const handler of [...this.#roundEndHandlers]) {
          try {
            await handler(event, context);
          } catch (error) {
            this.#logger.warning(
              `[${this.#logTag}] agent_round_end handler failed`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      },
      error => {
        this.#logger.warning(
          `[${this.#logTag}] public agent_round_end handler failed`,
          error instanceof Error ? error.message : String(error),
        );
      },
    );
    return result;
  }

  #finalize(round: number): AgentLoopResult {
    let outcome: AgentLoopRoundOutcome;
    if (this.#state === "aborted") {
      this.#runState.stopReason = "aborted";
      this.#pauseRequested = false;
      outcome = "aborted";
    } else if (this.#runState.stopReason === "error") {
      this.#pauseRequested = false;
      outcome = "failed";
    } else if (this.#pauseRequested) {
      this.#pauseRequested = false;
      outcome = "paused";
      this.#logger.info(`[${this.#logTag}] Paused after turn ${this.#runState.turnCount}`);
    } else if (this.#runState.stopReason === "aborted") {
      outcome = "aborted";
    } else {
      outcome = "completed";
    }
    this.#state = outcome === "paused" ? "paused" : "idle";

    const result: AgentLoopResult = Object.freeze({
      round,
      outcome,
      turns: this.#runState.turnCount,
      toolCalls: this.#runState.toolCount,
      usage: Object.freeze({ ...this.#runState.usage }),
      stopReason: this.#runState.stopReason,
      ...(this.#runState.lastError === undefined
        ? {}
        : { error: this.#runState.lastError }),
    });
    this.#logger.info(
      `[${this.#logTag}] Round ${round} ${outcome} — ${result.turns} turns, ${result.toolCalls} tools`,
    );
    return result;
  }

  /** Reload lifecycle */

  #reloadSession(): Promise<void> {
    return this.#runLifecycle("reload", () => this.session.reload());
  }

  #assertSessionReloadAvailable(operation: string): void {
    this.#assertLifecycleAvailable("reload");
    if (this.backgroundTasks.activeCount > 0) {
      throw new Error(
        `Cannot ${operation} agent loop "${this.id}" while background tasks are active`,
      );
    }
    if (this.#promptQueue.length > 0) {
      throw new Error(
        `Cannot ${operation} agent loop "${this.id}" while its prompt queue is not empty`,
      );
    }
    if (!this.session.isIdle) {
      throw new Error(
        `Cannot ${operation} agent loop "${this.id}" while its AgentSession is busy`,
      );
    }
  }

  /** Destroy lifecycle */

  async #destroy(): Promise<void> {
    const errors: unknown[] = [];
    this.backgroundTasks.closeAdmission();
    this.backgroundTasks.abortAll("AgentLoop destroyed");
    this.#promptQueue.length = 0;
    const settle = async (operation: () => Promise<void> | void): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    const activeLifecycle = this.#activeLifecycle;
    if (activeLifecycle?.kind === "prompt" || activeLifecycle?.kind === "resume") {
      await settle(() => this.abort());
    } else if (activeLifecycle !== undefined || !this.session.isIdle) {
      await settle(() => this.session.abort());
    }
    if (activeLifecycle?.promise !== undefined) {
      await settle(async () => {
        await activeLifecycle.promise;
      });
    }
    await settle(() => this.backgroundTasks.abortAllAndWait("AgentLoop destroyed"));
    this.#promptQueue.length = 0;
    await settle(() => this.session.waitForIdle());
    await settle(() => {
      clearAgentWaitingHeartbeat(this.#eventHandlerState);
      this.#roundEndHandlers.clear();
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
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

  /** Helpers */

  get #logTag(): string {
    return this.roomId === undefined ? this.tag : `${this.roomId}/${this.tag}`;
  }

  #resourceLoader(): MultiAgentPiResourceLoader {
    const resourceLoader = this.session.resourceLoader;
    if (!(resourceLoader instanceof MultiAgentPiResourceLoader)) {
      throw new Error(`AgentLoop "${this.id}" requires a MultiAgentPiResourceLoader`);
    }
    return resourceLoader;
  }

  #runLifecycle<T>(
    kind: AgentLoopLifecycleKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.#assertLifecycleAvailable(kind);

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
    const scheduleNextQueuedPrompt = () => {
      queueMicrotask(() => this.#startNextQueuedPrompt());
    };
    void promise.then(scheduleNextQueuedPrompt, scheduleNextQueuedPrompt);
    return promise;
  }

  #isAborted(): boolean {
    return this.#state === "aborted";
  }

  #assertLifecycleAvailable(kind: AgentLoopLifecycleKind): void {
    if (this.#activeLifecycle !== undefined) {
      throw new Error(
        `Cannot start ${kind} on agent loop "${this.id}" while ${this.#activeLifecycle.kind} is active`,
      );
    }
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
    if (this.#state !== "idle") {
      throw new Error(`Cannot ${operation} agent loop "${this.id}" while it is ${this.#state}`);
    }
  }

  /** Error handling */

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
}
