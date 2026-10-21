import { AsyncLocalStorage } from "node:async_hooks";

export interface OwnedLoop {
  readonly id: string;
  readonly isBusy: boolean;
  readonly activeLifecycleKind: string | null;
  reload(): Promise<readonly string[]>;
  destroy(): Promise<void>;
}

export interface LoopReloadError {
  readonly loopId: string;
  readonly message: string;
}

export type LoopDestroyReason = "destroy" | "shutdown";

export interface LoopManagerEventMap<TLoop extends OwnedLoop> {
  /** Synchronous hook emitted immediately before Core commits a selection change. */
  readonly before_selection_change: {
    readonly previous: TLoop | undefined;
    readonly selected: TLoop | undefined;
  };
  /** Settled before loop destruction; failures are retained without blocking teardown. */
  readonly before_loop_destroy: {
    readonly loop: TLoop;
    readonly loopId: string;
    readonly sessionId?: string;
    readonly reason: LoopDestroyReason;
  };
}

export interface LoopManagerEventResultMap {
  /** Optional infallible synchronous operation applied after every hook prepares successfully. */
  readonly before_selection_change: void | (() => void);
  readonly before_loop_destroy: Promise<void> | void;
}

export type LoopManagerEventType<TLoop extends OwnedLoop> = keyof LoopManagerEventMap<TLoop>;
export type LoopManagerEventHandler<
  TLoop extends OwnedLoop,
  TType extends LoopManagerEventType<TLoop>,
> = (event: LoopManagerEventMap<TLoop>[TType]) => LoopManagerEventResultMap[TType];

type AnyLoopManagerEventHandler<TLoop extends OwnedLoop> = (
  event: LoopManagerEventMap<TLoop>[LoopManagerEventType<TLoop>],
) => unknown;

interface LoopManagerEventSubscription<TLoop extends OwnedLoop> {
  readonly handler: AnyLoopManagerEventHandler<TLoop>;
}

type LoopManagerCallbackPhase =
  | "before_selection_change"
  | "before_loop_destroy"
  | "after_loop_destroy";

interface LoopManagerCallbackContext {
  readonly manager: object;
  readonly phase: LoopManagerCallbackPhase;
}

const loopManagerCallbackContext = new AsyncLocalStorage<LoopManagerCallbackContext>();

/** Package-private guard shared with Core Session. */
export function assertLoopManagerMutationAllowed(manager: object, action: string): void {
  const context = loopManagerCallbackContext.getStore();
  if (context?.manager === manager) {
    throw new Error(`Cannot ${action} from LoopManager ${context.phase} callback`);
  }
}

export interface LoopManagerOptions<TLoop extends OwnedLoop> {
  /** Optional owner identity included in lifecycle events. */
  readonly sessionId?: string;
  readonly onAfterLoopDestroy?: (loop: TLoop) => Promise<void> | void;
}

interface LoopLifecycleRecord<TLoop extends OwnedLoop> {
  readonly id: string;
  loop?: TLoop;
  destruction?: Promise<void>;
  destroying?: boolean;
}

interface LoopTeardownOptions {
  readonly reason: LoopDestroyReason;
  readonly afterDestroy?: () => void;
}

/**
 * Shared lifecycle and explicit primary/selected ownership for one session's AgentLoops.
 *
 * Hosts retain model, presentation, reload configuration, and execution policy. Core owns
 * collection publication, all-or-targeted sequential reload traversal, selection state,
 * synchronous switch-away before teardown, and shutdown.
 */
export class LoopManager<TLoop extends OwnedLoop> {
  readonly #records = new Map<string, LoopLifecycleRecord<TLoop>>();
  readonly #sessionId: string | undefined;
  readonly #eventHandlers = new Map<
    LoopManagerEventType<TLoop>,
    Set<LoopManagerEventSubscription<TLoop>>
  >();
  readonly #onAfterLoopDestroy: NonNullable<LoopManagerOptions<TLoop>["onAfterLoopDestroy"]>;
  #primaryId: string | undefined;
  #selectedId: string | undefined;
  #acceptingRegistrations = true;
  #acceptingDestructions = true;
  #shutdownPromise: Promise<void> | undefined;

  constructor(options: LoopManagerOptions<TLoop> = {}) {
    this.#sessionId = options.sessionId;
    this.#onAfterLoopDestroy = options.onAfterLoopDestroy ?? (() => {});
  }

  /** Whether an admitted destruction has not settled yet. */
  get hasPendingOperations(): boolean {
    for (const record of this.#records.values()) {
      if (record.destruction !== undefined) return true;
    }
    return false;
  }

  /** Register a typed manager event hook. Returns an idempotent unsubscribe function. */
  on<TType extends LoopManagerEventType<TLoop>>(
    type: TType,
    handler: LoopManagerEventHandler<TLoop, TType>,
  ): () => void {
    if (this.#shutdownPromise !== undefined) {
      throw new Error("Cannot register a LoopManager event hook after shutdown has begun");
    }
    const subscriptions = this.#eventHandlers.get(type)
      ?? new Set<LoopManagerEventSubscription<TLoop>>();
    const subscription: LoopManagerEventSubscription<TLoop> = {
      handler: handler as unknown as AnyLoopManagerEventHandler<TLoop>,
    };
    subscriptions.add(subscription);
    this.#eventHandlers.set(type, subscriptions);
    return () => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) this.#eventHandlers.delete(type);
    };
  }

  get(id: string): TLoop | undefined {
    const record = this.#records.get(id);
    return record?.destroying === true ? undefined : record?.loop;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  get primary(): TLoop | undefined {
    return this.#primaryId === undefined ? undefined : this.get(this.#primaryId);
  }

  get selected(): TLoop | undefined {
    return this.#selectedId === undefined ? undefined : this.get(this.#selectedId);
  }

  /** Designate one published loop as the session primary. Selection remains explicit. */
  setPrimary(id: string): TLoop {
    const loop = this.requirePublishedLoop(id);
    this.#primaryId = id;
    return loop;
  }

  /** Explicitly select one published loop. */
  select(id: string): TLoop {
    const loop = this.requirePublishedLoop(id);
    this.transitionSelection(loop);
    return loop;
  }

  /** Select the primary loop, or clear selection when no primary exists. */
  selectPrimary(): TLoop | undefined {
    const primary = this.primary;
    this.transitionSelection(primary);
    return primary;
  }

  clearSelection(): void {
    this.transitionSelection(undefined);
  }

  /** Return a detached mutable snapshot for compatibility with existing hosts. */
  list(): TLoop[] {
    const loops: TLoop[] = [];
    for (const record of this.#records.values()) {
      if (record.destroying !== true && record.loop !== undefined) loops.push(record.loop);
    }
    return loops;
  }

  /** Reload idle loops sequentially in registration order. */
  async reload(id?: string): Promise<LoopReloadError[]> {
    const loops = id === undefined ? this.list() : [this.requirePublishedLoop(id)];
    const busy = loops.find(loop => loop.isBusy);
    if (busy !== undefined) {
      throw new Error(`Cannot reload loop "${busy.id}" while ${busy.activeLifecycleKind} is active`);
    }

    const errors: LoopReloadError[] = [];
    for (const loop of loops) {
      try {
        const messages = await loop.reload();
        for (const message of messages) errors.push({ loopId: loop.id, message });
      } catch (error) {
        errors.push({
          loopId: loop.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return errors;
  }

  destroy(id: string): Promise<void> {
    try {
      assertLoopManagerMutationAllowed(this, `destroy AgentLoop "${id}"`);
    } catch (error) {
      return Promise.reject(error);
    }

    const record = this.#records.get(id);
    if (record === undefined) return Promise.resolve();
    if (record.destruction !== undefined) return record.destruction;
    if (!this.#acceptingDestructions) {
      return Promise.reject(new Error(`Cannot destroy AgentLoop "${id}": LoopManager shutdown has begun`));
    }
    let admitDestruction!: () => void;
    let rejectDestruction!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, reject) => {
      admitDestruction = resolve;
      rejectDestruction = reject;
    });
    const destruction = admission.then(() => this.destroyRecord(record, "destroy"));
    record.destruction = destruction;

    const loop = record.loop;
    if (loop !== undefined) {
      try {
        this.prepareSelectionForDestroy(loop);
      } catch (error) {
        if (record.destruction === destruction) delete record.destruction;
        rejectDestruction(error);
        return destruction;
      }
    }
    record.destroying = true;
    admitDestruction();
    return destruction;
  }

  /** Terminally close registration and destroy every loop. */
  destroyAll(): Promise<void> {
    try {
      assertLoopManagerMutationAllowed(this, "shut down LoopManager");
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;

    this.#acceptingRegistrations = false;
    this.#acceptingDestructions = false;
    const records = [...this.#records.values()];
    const shutdown = this.destroyAllRecords(records);
    this.#shutdownPromise = shutdown;
    return shutdown;
  }

  private async destroyAllRecords(records: LoopLifecycleRecord<TLoop>[]): Promise<void> {
    const errors: unknown[] = [];

    for (const record of records) {
      const existingDestruction = record.destruction;
      if (existingDestruction !== undefined) {
        try {
          await existingDestruction;
        } catch (error) {
          errors.push(error);
        }
        continue;
      }

      let admitDestruction!: () => void;
      const admission = new Promise<void>(resolve => { admitDestruction = resolve; });
      const destruction = admission.then(() => this.destroyRecord(record, "shutdown"));
      record.destruction = destruction;
      // Terminal shutdown preserves selection-hook failures but never lets them
      // block teardown of the record that Core already owns.
      if (record.loop !== undefined) {
        try {
          this.prepareSelectionForDestroy(record.loop);
        } catch (error) {
          errors.push(error);
        }
      }
      record.destroying = true;
      admitDestruction();
      try {
        await destruction;
      } catch (error) {
        errors.push(error);
      }
    }
    this.#primaryId = undefined;
    this.#selectedId = undefined;
    this.#eventHandlers.clear();

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "One or more AgentLoops failed to shut down cleanly");
    }
  }

  /** Transfer a fully constructed loop into this manager's lifecycle. */
  register(loop: TLoop): void {
    this.assertRegistrationAdmission(loop.id);
    this.#records.set(loop.id, { id: loop.id, loop });
  }

  private requirePublishedLoop(id: string): TLoop {
    const loop = this.get(id);
    if (!loop) throw new Error(`Loop "${id}" not found`);
    return loop;
  }

  private transitionSelection(
    selected: TLoop | undefined,
    previous: TLoop | undefined = this.selected,
  ): void {
    if (previous?.id === selected?.id) return;

    const event: LoopManagerEventMap<TLoop>["before_selection_change"] = { previous, selected };
    this.runLifecycleCallback("before_selection_change", () => {
      const applications: Array<() => void> = [];
      for (const result of this.emit("before_selection_change", event)) {
        if (typeof result === "function") {
          applications.push(result as () => void);
        } else if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          throw new Error(
            "LoopManager before_selection_change hooks must return an optional synchronous apply operation",
          );
        }
      }
      for (const apply of applications) {
        const result: unknown = apply();
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          throw new Error("LoopManager before_selection_change apply operations must complete synchronously");
        }
      }
    });
    this.#selectedId = selected?.id;
  }

  private emit<TType extends LoopManagerEventType<TLoop>>(
    type: TType,
    event: LoopManagerEventMap<TLoop>[TType],
  ): unknown[] {
    const subscriptions = this.#eventHandlers.get(type);
    if (!subscriptions) return [];
    return [...subscriptions].map(subscription => subscription.handler(event));
  }

  private async emitSettled<TType extends LoopManagerEventType<TLoop>>(
    type: TType,
    event: LoopManagerEventMap<TLoop>[TType],
  ): Promise<unknown[]> {
    const subscriptions = this.#eventHandlers.get(type);
    if (!subscriptions) return [];
    const errors: unknown[] = [];
    for (const subscription of [...subscriptions]) {
      try {
        await subscription.handler(event);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private prepareSelectionForDestroy(loop: TLoop): void {
    const wasPrimary = this.#primaryId === loop.id;
    const wasSelected = this.#selectedId === loop.id;
    const fallback = wasPrimary ? undefined : this.primary;
    if (wasSelected) this.transitionSelection(fallback, loop);
    if (wasPrimary) this.#primaryId = undefined;
  }

  private assertRegistrationAdmission(id: string): void {
    assertLoopManagerMutationAllowed(this, `register AgentLoop "${id}"`);
    if (!this.#acceptingRegistrations) {
      const label = id ? ` "${id}"` : "";
      throw new Error(`Cannot register AgentLoop${label}: LoopManager shutdown has begun`);
    }
    if (this.#records.has(id)) throw new Error(`Loop "${id}" already exists`);
  }

  private async destroyRecord(
    record: LoopLifecycleRecord<TLoop>,
    reason: LoopDestroyReason,
  ): Promise<void> {
    const loop = record.loop;
    if (loop === undefined) {
      if (this.#records.get(record.id) === record) this.#records.delete(record.id);
      return;
    }

    const errors = await this.teardownLoop(loop, {
      reason,
      afterDestroy: () => { delete record.loop; },
    });
    if (this.#records.get(record.id) === record) this.#records.delete(record.id);

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to destroy AgentLoop "${loop.id}"`);
    }
  }

  private async teardownLoop(
    loop: TLoop,
    options: LoopTeardownOptions,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    const settle = async (operation: () => Promise<void> | void): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    const event: LoopManagerEventMap<TLoop>["before_loop_destroy"] = {
      loop,
      loopId: loop.id,
      reason: options.reason,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    };
    errors.push(...await this.runLifecycleCallback(
      "before_loop_destroy",
      () => this.emitSettled("before_loop_destroy", event),
    ));
    await settle(() => loop.destroy());
    options.afterDestroy?.();
    await settle(() => this.runLifecycleCallback(
      "after_loop_destroy",
      () => this.#onAfterLoopDestroy(loop),
    ));
    return errors;
  }

  private runLifecycleCallback<TResult>(
    phase: LoopManagerCallbackPhase,
    callback: () => TResult,
  ): TResult {
    return loopManagerCallbackContext.run({ manager: this, phase }, callback);
  }
}
