import type { ImageContent } from "@earendil-works/pi-ai";
import {
  assertLoopManagerMutationAllowed,
  LoopManager,
  type LoopManagerEventHandler,
  type LoopManagerEventType,
  type LoopManagerOptions,
  type OwnedLoop,
} from "../agent-loop/loop-manager.js";
import type { TargetedLoopExtensionRegistry } from "../extensions/targeted-loop-extensions.js";

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
  TSessionId extends string = string,
> {
  readonly id: TSessionId;
  readonly loopManager?: LoopManagerOptions<TLoop>;
  /** Optional process registry whose session scope follows this concrete Core lifecycle. */
  readonly extensionRegistry?: TargetedLoopExtensionRegistry;
  /** Invoked after AgentLoop teardown settles, whether teardown succeeds or fails. */
  readonly onClose?: (session: Session<TLoop, TSessionId>) => void;
}

/**
 * Optional transport-neutral owner for one logical session and its AgentLoops.
 *
 * Standalone consumers may use AgentLoop or LoopManager directly. Hosts that
 * need a session concept can use this component for one LoopManager, foreground
 * prompt routing, targeted extension lifecycle binding, reload admission, and
 * terminal shutdown.
 */
export class Session<
  TLoop extends PromptableLoop<unknown>,
  TSessionId extends string = string,
> {
  readonly id: TSessionId;

  readonly #loopManager: LoopManager<TLoop>;
  #extensionRegistry: TargetedLoopExtensionRegistry | undefined;
  readonly #onClose: ((session: Session<TLoop, TSessionId>) => void) | undefined;
  #state: SessionState = "open";
  #closePromise: Promise<void> | undefined;

  constructor(options: SessionOptions<TLoop, TSessionId>) {
    this.id = options.id;
    this.#loopManager = new LoopManager({ ...options.loopManager, sessionId: this.id });
    this.#onClose = options.onClose;
    if (options.extensionRegistry) this.bindExtensionRegistry(options.extensionRegistry);
  }

  get state(): SessionState {
    return this.#state;
  }

  getState(): SessionState {
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

  get isBusy(): boolean {
    return !this.isIdle;
  }

  get primary(): TLoop | undefined {
    return this.#loopManager.primary;
  }

  get selected(): TLoop | undefined {
    return this.#loopManager.selected;
  }

  /** The explicitly selected loop preferred by prompt() when no loop ID is supplied. */
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

  register(loop: TLoop): void {
    this.#assertOpen("register an AgentLoop");
    this.#loopManager.register(loop);
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
        ? this.foreground ?? this.primary
        : this.#requireLoop(options.loopId);
      if (!loop) {
        throw new Error(`Cannot prompt session "${this.id}": no foreground or primary AgentLoop is available`);
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

  protected bindExtensionRegistry(extensionRegistry: TargetedLoopExtensionRegistry): void {
    this.#assertOpen("bind an extension registry");
    if (this.#extensionRegistry !== undefined) {
      throw new Error(`Session "${this.id}" already has an extension registry`);
    }
    if (this.#loopManager.list().length > 0) {
      throw new Error(`Cannot bind an extension registry after Session "${this.id}" has AgentLoops`);
    }
    extensionRegistry.attachSession(this.id, this.#loopManager);
    this.#extensionRegistry = extensionRegistry;
    this.#loopManager.on("before_loop_destroy", ({ loopId }) => {
      extensionRegistry.removeLoop(this.id, loopId);
    });
  }

  reload(loopId?: string): Promise<void> {
    try {
      this.#assertReloadable(loopId);
      this.#state = "reloading";
    } catch (error) {
      return Promise.reject(error);
    }

    return this.#runReload(async () => {
      const errors = await this.#loopManager.reload(loopId);
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
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;

    let destruction: Promise<void>;
    try {
      this.#assertOpen("close");
      assertLoopManagerMutationAllowed(this.#loopManager, `close session "${this.id}"`);
      destruction = this.#loopManager.destroyAll();
    } catch (error) {
      return Promise.reject(error);
    }
    this.#state = "closed";

    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    this.#closePromise = closePromise;

    void this.#closeRuntime(destruction).then(resolveClose, rejectClose);
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

  #assertReloadable(loopId?: string): void {
    this.#assertOpen("reload AgentLoops");
    if (this.#loopManager.hasPendingOperations) {
      throw new Error(`Cannot reload session "${this.id}" while AgentLoop destruction is pending`);
    }
    const loops = loopId === undefined ? this.#loopManager.list() : [this.#requireLoop(loopId)];
    const busy = loops.find(loop => loop.isBusy);
    if (busy !== undefined) {
      throw new Error(
        `Cannot reload session "${this.id}" while loop "${busy.id}" is ${busy.activeLifecycleKind}`,
      );
    }
  }

  async #runReload<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      if (this.#state === "reloading") this.#state = "open";
    }
  }

  async #closeRuntime(destruction: Promise<void>): Promise<void> {
    const errors: unknown[] = [];
    try {
      await destruction;
    } catch (error) {
      errors.push(error);
    } finally {
      this.#extensionRegistry?.detachSession(this.id, this.#loopManager);
    }
    try {
      this.#onClose?.(this);
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to close session "${this.id}" cleanly`);
    }
  }
}
