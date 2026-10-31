import { randomUUID } from "node:crypto";
import {
  createBackgroundTaskRunContext,
  type BackgroundTaskRunContext,
  type RoomContext,
} from "../multi-agent-pi/context.js";
import type { AgentLogger } from "../logger/logger.js";

export type { BackgroundTaskRunContext } from "../multi-agent-pi/context.js";

export interface BackgroundTaskAbortEvent {
  readonly reason: string;
}

export interface BackgroundTaskOptions<TResult = unknown> {
  readonly id?: string;
  readonly label: string;
  /** Optional task-specific cancellation side effect, fired once on task abort. */
  readonly onAbort?: (
    event: BackgroundTaskAbortEvent,
    ctx: BackgroundTaskRunContext,
  ) => Promise<void> | void;
  /** Execute one Room-owned unit of detached work. Undefined suppresses delivery. */
  readonly run: (ctx: BackgroundTaskRunContext) => Promise<TResult | undefined>;
  /** Process one completed result while the task remains owned by its Room. */
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

export interface BackgroundTaskManagerOptions extends RoomContext {
  readonly logger: AgentLogger;
}

/** Room-level owner for detached operation admission, cancellation, and settlement. */
export class BackgroundTaskManager {
  readonly #tasks = new Map<string, BackgroundTaskHandle<unknown>>();
  readonly #options: BackgroundTaskManagerOptions;
  #acceptingTasks = true;

  constructor(options: BackgroundTaskManagerOptions) {
    this.#options = options;
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
        `Cannot start background task "${options.label}" for Room "${this.#options.roomId}": background task shutdown has begun`,
      );
    }

    const id = options.id ?? `${options.label}-${randomUUID()}`;
    if (this.#tasks.has(id)) {
      throw new Error(`Background task "${id}" already exists in Room "${this.#options.roomId}"`);
    }
    const label = options.label;
    const startedAt = Date.now();
    const controller = new AbortController();
    const context = createBackgroundTaskRunContext({
      roomId: this.#options.roomId,
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
    const done = Promise.resolve().then(async (): Promise<TResult | undefined> => {
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
    });

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

  /** @internal Close task admission synchronously before Room teardown begins. */
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
        `Cannot reopen background tasks for Room "${this.#options.roomId}" while tasks remain active`,
      );
    }
    this.#acceptingTasks = true;
  }
}
