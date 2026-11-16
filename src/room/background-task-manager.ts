import { randomUUID } from "node:crypto";
import { createBackgroundTaskRunContext } from "../multi-agent-pi/context-factory.js";
import type { BackgroundTaskRunContext } from "../multi-agent-pi/types.js";
import type { AgentLogger } from "../logger/logger.js";
import type { RoomId } from "./room-types.js";

export type { BackgroundTaskRunContext } from "../multi-agent-pi/types.js";

export interface BackgroundTaskAbortEvent {
  readonly reason: string;
}

export type BackgroundTaskExecutionMode = "parallel" | "sequential";

export interface BackgroundTaskOptions<TResult = unknown> {
  readonly id?: string;
  readonly label: string;
  /** Parallel tasks may overlap; sequential tasks wait for prior work and block later work. */
  readonly executionMode?: BackgroundTaskExecutionMode;
  /** Optional task-specific cancellation side effect, fired once on task abort. */
  readonly onAbort?: (
    event: BackgroundTaskAbortEvent,
    ctx: BackgroundTaskRunContext,
  ) => Promise<void> | void;
  /** Execute one owner-scoped unit of detached work. Undefined suppresses delivery. */
  readonly run: (ctx: BackgroundTaskRunContext) => Promise<TResult | undefined>;
  /** Process one completed result while the task remains owned by its manager. */
  readonly onResult?: (
    result: TResult,
    ctx: BackgroundTaskRunContext,
  ) => Promise<void> | void;
  /** Optional task-specific failure delivery. */
  readonly onError?: (
    error: unknown,
    ctx: BackgroundTaskRunContext,
  ) => Promise<void> | void;
}

export interface BackgroundTaskHandle<TResult = unknown> {
  readonly id: string;
  readonly label: string;
  readonly startedAt: number;
  abort(reason?: string): void;
  readonly done: Promise<TResult | undefined>;
}

export type BackgroundTaskManagerOptions = {
  readonly logger: AgentLogger;
} & (
  | { readonly roomId: RoomId; readonly agentId?: string }
  | { readonly roomId?: RoomId; readonly agentId: string }
);

/** Owner-scoped manager for detached operation admission, cancellation, and settlement. */
export class BackgroundTaskManager {
  readonly #tasks = new Map<string, BackgroundTaskHandle<unknown>>();
  readonly #pendingExecutions = new Set<Promise<void>>();
  readonly #options: BackgroundTaskManagerOptions;
  #lastSequentialExecution: Promise<void> = Promise.resolve();
  #roomId: RoomId | undefined;
  #acceptingTasks = true;

  constructor(options: BackgroundTaskManagerOptions) {
    if (options.roomId === undefined && options.agentId === undefined) {
      throw new Error("BackgroundTaskManager requires a Room or AgentLoop identity");
    }
    this.#options = options;
    this.#roomId = options.roomId;
  }

  /** @internal Update Room identity when an idle standalone AgentLoop transfers ownership. */
  setRoomId(roomId: RoomId): void {
    this.#roomId = roomId;
  }

  get activeCount(): number {
    return this.#tasks.size;
  }

  list(): BackgroundTaskHandle<unknown>[] {
    return [...this.#tasks.values()];
  }

  start<TResult>(options: BackgroundTaskOptions<TResult>): BackgroundTaskHandle<TResult> {
    if (!this.#acceptingTasks) {
      throw new Error(
        `Cannot start background task "${options.label}" for ${this.#ownerLabel}: background task shutdown has begun`,
      );
    }

    const id = options.id ?? `${options.label}-${randomUUID()}`;
    if (this.#tasks.has(id)) {
      throw new Error(`Background task "${id}" already exists for ${this.#ownerLabel}`);
    }
    const label = options.label;
    const startedAt = Date.now();
    const controller = new AbortController();
    const context = createBackgroundTaskRunContext({
      roomId: this.#roomId,
      agentId: this.#options.agentId,
      id,
      label,
      signal: controller.signal,
    });
    let abortNotification: Promise<void> | undefined;

    const notifyAbort = (reason: string): Promise<void> => {
      if (options.onAbort === undefined) return Promise.resolve();
      abortNotification ??= Promise.resolve()
        .then(() => options.onAbort?.({ reason }, context))
        .then(() => undefined)
        .catch(error => {
          this.#options.logger.warning(
            `[background:${label}] Abort hook failed`,
            error instanceof Error ? error.message : String(error),
          );
        });
      return abortNotification;
    };
    let handle: BackgroundTaskHandle<TResult>;
    const done = this.#schedule(
      options.executionMode ?? "parallel",
      async (): Promise<TResult | undefined> => {
        try {
          if (controller.signal.aborted) return undefined;
          const result = await options.run(context);
          if (result === undefined || controller.signal.aborted) return undefined;
          await options.onResult?.(result, context);
          return result;
        } catch (error) {
          if (!controller.signal.aborted) {
            this.#options.logger.warning(
              `[background:${label}] Failed`,
              error instanceof Error ? error.message : String(error),
            );
            try {
              await options.onError?.(error, context);
            } catch (deliveryError) {
              this.#options.logger.warning(
                `[background:${label}] Failure delivery failed`,
                deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
              );
            }
          }
          return undefined;
        } finally {
          if (abortNotification !== undefined) await abortNotification;
          this.#tasks.delete(id);
          this.#options.logger.info(`[background:${label}] Finished (${id})`);
        }
      },
    );

    handle = {
      id,
      label,
      startedAt,
      abort: (reason = "Background task aborted") => {
        if (controller.signal.aborted || this.#tasks.get(id) !== handle) return;
        controller.abort(reason);
        void notifyAbort(reason);
      },
      done,
    };
    this.#tasks.set(id, handle);
    this.#options.logger.info(`[background:${label}] Started (${id})`);
    return handle;
  }

  abort(id: string, reason = "Background task aborted"): boolean {
    const task = this.#tasks.get(id);
    if (task === undefined) return false;
    task.abort(reason);
    return true;
  }

  abortAll(reason = "Background task aborted"): void {
    for (const task of this.#tasks.values()) task.abort(reason);
  }

  /** @internal Close task admission synchronously before owner teardown begins. */
  closeAdmission(): void {
    this.#acceptingTasks = false;
  }

  async abortAllAndWait(reason = "Background task aborted"): Promise<void> {
    const done = this.list().map(task => {
      task.abort(reason);
      return task.done;
    });
    await Promise.allSettled(done);
  }

  /** @internal Reopen admission after Room reset has settled every prior task. */
  reopen(): void {
    if (this.#tasks.size > 0) {
      throw new Error(
        `Cannot reopen background tasks for ${this.#ownerLabel} while tasks remain active`,
      );
    }
    this.#acceptingTasks = true;
  }

  #schedule<TResult>(
    executionMode: BackgroundTaskExecutionMode,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const blockers = executionMode === "sequential"
      ? [...this.#pendingExecutions]
      : [this.#lastSequentialExecution];
    const result = Promise.allSettled(blockers).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#pendingExecutions.add(settled);
    if (executionMode === "sequential") this.#lastSequentialExecution = settled;
    void settled.then(() => {
      this.#pendingExecutions.delete(settled);
    });
    return result;
  }

  get #ownerLabel(): string {
    return this.#options.agentId === undefined
      ? `Room "${this.#roomId}"`
      : `AgentLoop "${this.#options.agentId}"`;
  }
}
