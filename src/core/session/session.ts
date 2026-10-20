import type { ImageContent } from "@earendil-works/pi-ai";
import {
  assertLoopManagerMutationAllowed,
  LoopManager,
  type LoopManagerEventHandler,
  type LoopManagerEventType,
  type LoopManagerOptions,
  type OwnedLoop,
} from "../agent-loop/loop-manager.js";
import {
  targetedLoopExtensionSessionBinding,
  type TargetedLoopExtensionRegistry,
} from "../extensions/targeted-loop-extensions.js";

export type SessionState = "open" | "reloading" | "closed";

export interface PromptableLoop<TResult = unknown> extends OwnedLoop {
  prompt(message: string, images?: readonly ImageContent[]): Promise<TResult>;
}

export type SessionPromptResult<TLoop extends PromptableLoop<unknown>> =
  TLoop extends PromptableLoop<infer TResult> ? TResult : never;

export interface SessionPromptOptions {
  readonly loopId?: string;
  readonly images?: readonly ImageContent[];
}

/** Minimal Core contract suitable for application wrappers and inter-session tools. */
export interface PromptableSession<
  TLoop extends PromptableLoop<unknown> = PromptableLoop<unknown>,
  TSessionId extends string = string,
> {
  readonly id: TSessionId;
  readonly foreground: TLoop | undefined;
  get(id: string): TLoop | undefined;
  has(id: string): boolean;
  prompt(message: string, options?: SessionPromptOptions): Promise<SessionPromptResult<TLoop>>;
}

export interface SessionOptions<
  TLoop extends PromptableLoop<unknown>,
  TConfig,
  TSessionId extends string = string,
> {
  readonly id: TSessionId;
  readonly loopManager: LoopManagerOptions<TLoop, TConfig>;
  /** Optional process registry whose session scope follows this concrete Core lifecycle. */
  readonly extensionRegistry?: TargetedLoopExtensionRegistry;
  readonly onClose?: (session: Session<TLoop, TConfig, TSessionId>) => void;
}

/**
 * Optional transport-neutral owner for one logical session and its AgentLoops.
 *
 * Standalone consumers may use AgentLoop or LoopManager directly. Hosts that
 * need a room/session concept can use this component for one LoopManager,
 * foreground prompt routing, targeted extension lifecycle binding, reload
 * admission, stable collection ownership, and terminal shutdown.
 */
export class Session<
  TLoop extends PromptableLoop<unknown>,
  TConfig,
  TSessionId extends string = string,
> {
  readonly id: TSessionId;

  readonly #loopManager: LoopManager<TLoop, TConfig>;
  readonly #extensionRegistry: TargetedLoopExtensionRegistry | undefined;
  readonly #onClose: ((session: Session<TLoop, TConfig, TSessionId>) => void) | undefined;
  #state: SessionState = "open";
  #closePromise: Promise<void> | undefined;

  constructor(options: SessionOptions<TLoop, TConfig, TSessionId>) {
    this.id = options.id;
    const extensionRegistry = options.extensionRegistry;
    this.#extensionRegistry = extensionRegistry;
    this.#loopManager = new LoopManager({ ...options.loopManager, sessionId: this.id });
    if (extensionRegistry) {
      this.#loopManager.on("before_loop_destroy", ({ loopId, reason }) => {
        if (reason !== "creation_failed") {
          extensionRegistry[targetedLoopExtensionSessionBinding]({
            type: "remove_loop",
            sessionId: this.id,
            loopId,
          });
        }
      });
      extensionRegistry[targetedLoopExtensionSessionBinding]({
        type: "attach",
        sessionId: this.id,
        loopManager: this.#loopManager,
      });
    }
    this.#onClose = options.onClose;
  }

  get state(): SessionState {
    return this.#state;
  }

  get isReloading(): boolean {
    return this.#state === "reloading";
  }

  get isIdle(): boolean {
    return this.#state === "open"
      && !this.#loopManager.hasPendingOperations
      && this.#loopManager.list().every(loop => !loop.isBusy);
  }

  get primary(): TLoop | undefined {
    return this.#loopManager.primary;
  }

  get selected(): TLoop | undefined {
    return this.#loopManager.selected;
  }

  /** The explicitly selected loop used by prompt() when no loop ID is supplied. */
  get foreground(): TLoop | undefined {
    return this.#loopManager.selected;
  }

  /** Register a typed generic loop-manager event hook. */
  on<TType extends LoopManagerEventType<TLoop>>(
    type: TType,
    handler: LoopManagerEventHandler<TLoop, TType>,
  ): () => void {
    if (this.#state === "closed") {
      throw new Error(`Cannot register a LoopManager event hook while session "${this.id}" is closed`);
    }
    return this.#loopManager.on(type, handler);
  }

  async create(config: TConfig): Promise<TLoop> {
    this.#assertOpen("create an AgentLoop");
    return this.#loopManager.create(config);
  }

  registerExisting(loop: TLoop): void {
    this.#assertOpen("register an AgentLoop");
    this.#loopManager.registerExisting(loop);
  }

  get(id: string): TLoop | undefined {
    return this.#loopManager.get(id);
  }

  has(id: string): boolean {
    return this.#loopManager.has(id);
  }

  list(): TLoop[] {
    return this.#loopManager.list();
  }

  setPrimary(id: string): TLoop {
    this.#assertOpen("set the primary AgentLoop");
    return this.#loopManager.setPrimary(id);
  }

  select(id: string): TLoop {
    this.#assertOpen("select an AgentLoop");
    return this.#loopManager.select(id);
  }

  selectPrimary(): TLoop | undefined {
    this.#assertOpen("select the primary AgentLoop");
    return this.#loopManager.selectPrimary();
  }

  clearSelection(): void {
    this.#assertOpen("clear AgentLoop selection");
    this.#loopManager.clearSelection();
  }

  prompt(
    message: string,
    options: SessionPromptOptions = {},
  ): Promise<SessionPromptResult<TLoop>> {
    try {
      this.#assertOpen("prompt an AgentLoop");
      const loop = options.loopId === undefined
        ? this.foreground
        : this.#requireLoop(options.loopId);
      if (!loop) {
        throw new Error(`Cannot prompt session "${this.id}": no foreground AgentLoop is selected`);
      }
      return loop.prompt(message, options.images) as Promise<SessionPromptResult<TLoop>>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  destroy(id: string): Promise<void> {
    try {
      this.#assertOpen("destroy an AgentLoop");
      return this.#loopManager.destroy(id);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  assertReloadable(loopId?: string): void {
    this.#assertOpen("reload AgentLoops");
    if (this.#loopManager.hasPendingOperations) {
      throw new Error(`Cannot reload session "${this.id}" while AgentLoop creation or destruction is pending`);
    }
    const loops = loopId === undefined ? this.#loopManager.list() : [this.#requireLoop(loopId)];
    const busy = loops.find(loop => loop.isBusy);
    if (busy) {
      throw new Error(
        `Cannot reload session "${this.id}" while loop "${busy.id}" is ${busy.activeLifecycleKind}`,
      );
    }
  }

  reload(loopId?: string): Promise<void> {
    try {
      return this.reloadAfter(Promise.resolve(), loopId);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  reloadAfter(prerequisite: Promise<void>, loopId?: string): Promise<void> {
    return this.runReload(
      async () => {
        const errors = await this.#loopManager.reload(loopId, prerequisite);
        if (errors.length === 1) {
          const error = errors[0]!;
          throw new Error(`Failed to reload AgentLoop "${error.loopId}": ${error.message}`);
        }
        if (errors.length > 1) {
          throw new AggregateError(
            errors.map(error => new Error(`[${error.loopId}] ${error.message}`)),
            `Failed to reload one or more AgentLoops for session "${this.id}"`,
          );
        }
      },
      loopId,
    );
  }

  async runReload<T>(operation: () => Promise<T>, loopId?: string): Promise<T> {
    this.assertReloadable(loopId);
    const releaseCollection = this.#loopManager.reserveStableCollection();
    this.#state = "reloading";
    return this.#runReload(operation, releaseCollection);
  }

  close(): Promise<void> {
    let destruction: Promise<void>;
    try {
      assertLoopManagerMutationAllowed(this.#loopManager, `close session "${this.id}"`);
      destruction = this.#loopManager.destroyAll();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closed";

    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.#closePromise = closePromise;

    let closeHookError: unknown;
    try {
      this.#onClose?.(this);
    } catch (error) {
      closeHookError = error;
    }
    void this.#closeRuntime(closeHookError, destruction).then(resolveClose, rejectClose);
    return closePromise;
  }

  #assertOpen(action: string): void {
    if (this.#state !== "open") {
      throw new Error(`Cannot ${action} while session "${this.id}" is ${this.#state}`);
    }
  }

  #requireLoop(id: string): TLoop {
    const loop = this.#loopManager.get(id);
    if (!loop) throw new Error(`Loop "${id}" not found`);
    return loop;
  }

  async #runReload<T>(operation: () => Promise<T>, releaseCollection: () => void): Promise<T> {
    try {
      return await operation();
    } finally {
      releaseCollection();
      if (this.#state === "reloading") this.#state = "open";
    }
  }

  async #closeRuntime(closeHookError: unknown, destruction: Promise<void>): Promise<void> {
    const errors: unknown[] = [];
    if (closeHookError !== undefined) errors.push(closeHookError);
    try {
      await destruction;
    } catch (error) {
      errors.push(error);
    } finally {
      this.#extensionRegistry?.[targetedLoopExtensionSessionBinding]({
        type: "detach",
        sessionId: this.id,
        loopManager: this.#loopManager,
      });
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to close session "${this.id}" cleanly`);
    }
  }
}
