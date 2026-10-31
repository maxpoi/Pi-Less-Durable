import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { issueMultiAgentPiEvent } from "../multi-agent-pi/api.js";
import {
  AgentLoop,
  type AgentLoopQueuedPromptType,
  type AgentLoopResult,
} from "../agent/agent-loop.js";
import { MultiAgentPiHarness } from "../multi-agent-pi-harness.js";
import {
  resolveExplicitPersistenceDirectory,
  resolvePersistenceDirectory,
} from "../path-validation.js";
import { BackgroundTaskManager } from "./background-task-manager.js";
import { archiveRoomSession } from "./session-archive.js";
import {
  LoopManager,
  PRIMARY_AGENT_TAG,
  assertAgentIdentity,
  normalizeAgentIdentity,
  type AgentIdentity,
  type AgentRegistration,
} from "./loop-manager.js";
import type {
  BeforeRoomResetEvent,
  BeforeRoomResetHandler,
  CreateRoomOptions,
  CreateRoomResult,
  PrimaryAgentLoopOptions,
  ResetRoomOptions,
  ResetRoomResult,
  RoomEnqueuePromptOptions,
  RoomId,
  RoomPromptOptions,
  RoomResetEndEvent,
  RoomResetEndHandler,
  RoomState,
} from "./room-types.js";

export type {
  BeforeRoomResetEvent,
  BeforeRoomResetHandler,
  CreateRoomOptions,
  CreateRoomResult,
  PrimaryAgentLoopOptions,
  ResetRoomOptions,
  ResetRoomResult,
  RoomEnqueuePromptOptions,
  RoomId,
  RoomPromptOptions,
  RoomResetEndEvent,
  RoomResetEndHandler,
  RoomState,
} from "./room-types.js";

export { PRIMARY_AGENT_TAG };

interface RoomArchiveResult {
  readonly archiveName?: string;
}

/** One logical Room owning AgentLoops and detached background operations. */
export class Room {
  readonly id: RoomId;
  readonly #loopManager = new LoopManager();
  readonly #backgroundTasks: BackgroundTaskManager;
  readonly #resolvedRoomDir: string;
  readonly #beforeResetHandlers = new Set<BeforeRoomResetHandler>();
  readonly #resetEndHandlers = new Set<RoomResetEndHandler>();
  readonly #closedHandlers = new Set<(room: Room) => void>();
  #state: RoomState = "open";
  #closePromise: Promise<void> | undefined;

  private constructor(
    id: RoomId,
    roomDir: string,
  ) {
    this.id = id;
    this.#resolvedRoomDir = roomDir;
    this.#backgroundTasks = new BackgroundTaskManager({
      roomId: id,
      logger: MultiAgentPiHarness.instance.logger,
    });
  }

  /** Create one standalone Room, optionally with an automatically registered primary. */
  static async create(options: CreateRoomOptions = {}): Promise<CreateRoomResult> {
    const id = createRoomId(options.id);
    const roomDir = options.roomDir === undefined
      ? resolvePersistenceDirectory(
          join(MultiAgentPiHarness.instance.workingDir, "rooms", randomUUID()),
        )
      : resolveExplicitPersistenceDirectory(options.roomDir, "Room directory");
    const room = new Room(id, roomDir);

    try {
      if (options.primaryLoop === undefined) return { room };
      const primaryAgent = normalizeAgentIdentity(options.primaryLoop.agent);
      if (primaryAgent.tag !== PRIMARY_AGENT_TAG) {
        throw new Error(`Primary AgentLoop must use tag "${PRIMARY_AGENT_TAG}"`);
      }
      const primaryLoop = await AgentLoop.create({
        room,
        ...options.primaryLoop,
        agent: primaryAgent,
      });
      return { room, primaryLoop };
    } catch (error) {
      try {
        await room.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to discard Room "${room.id}" after primary creation failed`,
        );
      }
      throw error;
    }
  }

  get roomDir(): string {
    return this.#resolvedRoomDir;
  }

  get state(): RoomState {
    return this.#state;
  }

  getState(): RoomState {
    return this.#state;
  }

  get isReloading(): boolean {
    return this.#state === "reloading";
  }

  get isResetting(): boolean {
    return this.#state === "resetting";
  }

  get isBusy(): boolean {
    if (this.#state !== "open") return true;
    return this.#backgroundTasks.activeCount > 0
      || this.#loopManager.listRegistrations().some(
        registration => registration.loop.isBusy,
      );
  }

  get backgroundTasks(): BackgroundTaskManager {
    return this.#backgroundTasks;
  }

  get primaryId(): string | undefined {
    return this.#loopManager.primaryId;
  }

  get primary(): AgentLoop | undefined {
    return this.#loopManager.primary;
  }

  get selectedId(): string | undefined {
    return this.#loopManager.selectedId;
  }

  get selected(): AgentLoop | undefined {
    return this.#loopManager.selected;
  }

  register(loop: AgentLoop): void {
    this.#assertOpen("register an agent");
    this.#register(loop);
  }

  get(agentId: string): AgentLoop | undefined {
    return this.#loopManager.get(agentId);
  }

  has(agentId: string): boolean {
    return this.#loopManager.has(agentId);
  }

  /** @internal Preflight Room-owned persistence before AgentLoop opens its native session. */
  assertAgentLoopDirectoryAvailable(dir: string): void {
    this.#assertOpen("create an agent");
    this.#loopManager.assertDirectoryAvailable(dir);
  }

  list(): AgentLoop[] {
    return this.#loopManager.list();
  }

  listAgentIds(): string[] {
    return this.#loopManager.listAgentIds();
  }

  listAgentIdentities(): AgentIdentity[] {
    return this.#loopManager.listAgentIdentities();
  }

  isAgentBusy(agentId: string): boolean {
    return this.#requireRegistration(agentId).loop.isBusy;
  }

  setPrimary(agentId: string): AgentLoop {
    this.#assertOpen("set the primary agent");
    return this.#loopManager.setPrimary(agentId);
  }

  select(agentId: string): AgentLoop {
    this.#assertOpen("select an agent");
    return this.#loopManager.select(agentId);
  }

  selectPrimary(): AgentLoop | undefined {
    this.#assertOpen("select the primary agent");
    return this.#loopManager.selectPrimary();
  }

  clearSelection(): void {
    this.#assertOpen("clear agent selection");
    this.#loopManager.clearSelection();
  }

  prompt(
    message: string,
    options: RoomPromptOptions = {},
  ): Promise<AgentLoopResult> {
    try {
      this.#assertOpen("prompt an agent");
      const registration = options.agentId === undefined
        ? this.#loopManager.selectedRegistration ?? this.#loopManager.primaryRegistration
        : this.#requireRegistration(options.agentId);
      if (!registration) {
        throw new Error(`Cannot prompt Room "${this.id}": no selected or primary agent is available`);
      }
      return registration.loop.prompt(message, options.images);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  enqueuePrompt(
    type: AgentLoopQueuedPromptType,
    content: string,
    options: RoomEnqueuePromptOptions = {},
  ): void {
    this.#assertOpen("enqueue a prompt");
    const registration = options.agentId === undefined
      ? this.#loopManager.selectedRegistration ?? this.#loopManager.primaryRegistration
      : this.#requireRegistration(options.agentId);
    if (!registration) {
      throw new Error(`Cannot enqueue a prompt in Room "${this.id}": no selected or primary agent is available`);
    }
    registration.loop.enqueuePrompt(type, content);
  }

  abort(agentId: string): Promise<void> {
    try {
      return this.#requireRegistration(agentId).loop.abort();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  stop(agentId: string): "prompt" | "compaction" | "none" {
    return this.#requireRegistration(agentId).loop.stop();
  }

  compact(agentId: string, customInstructions?: string): Promise<CompactionResult> {
    try {
      this.#assertOpen("compact an agent");
      return this.#requireRegistration(agentId).loop.compact(customInstructions);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Disable one extension on an explicit loop, or the selected/primary loop. */
  disable(extension: string, loopId?: string): Promise<void> {
    try {
      this.#assertOpen("disable an extension");
      const registration = loopId === undefined
        ? this.#loopManager.selectedRegistration ?? this.#loopManager.primaryRegistration
        : this.#requireRegistration(loopId);
      if (!registration) {
        throw new Error(
          `Cannot disable an extension in Room "${this.id}": no selected or primary agent is available`,
        );
      }
      return registration.loop.disable(extension);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Validate every targeted AgentLoop before any Room or Harness reload mutation. */
  assertReloadable(agentId?: string): void {
    this.#preflightReload(agentId);
  }

  reload(agentId?: string): Promise<void> {
    try {
      const registrations = this.#preflightReload(agentId);
      this.#state = "reloading";
      return this.#reloadRegistrations(registrations);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** @internal Notify the registered Harness after Room teardown settles. */
  onClosed(handler: (room: Room) => void): () => void {
    this.#assertOpen("register a close handler");
    this.#closedHandlers.add(handler);
    return () => {
      this.#closedHandlers.delete(handler);
    };
  }

  /** @internal Register an owner-local Room lifecycle listener. */
  on(event: "before_room_reset", handler: BeforeRoomResetHandler): () => void;
  /** @internal Register an owner-local Room lifecycle listener. */
  on(event: "room_reset_end", handler: RoomResetEndHandler): () => void;
  on(
    event: "before_room_reset" | "room_reset_end",
    handler: BeforeRoomResetHandler | RoomResetEndHandler,
  ): () => void {
    if (this.#state !== "open" && this.#state !== "reloading") {
      throw new Error(
        `Cannot register a Room lifecycle handler while Room "${this.id}" is ${this.#state}`,
      );
    }
    if (event === "before_room_reset") {
      const typedHandler = handler as BeforeRoomResetHandler;
      this.#beforeResetHandlers.add(typedHandler);
      return () => {
        this.#beforeResetHandlers.delete(typedHandler);
      };
    }

    const typedHandler = handler as RoomResetEndHandler;
    this.#resetEndHandlers.add(typedHandler);
    return () => {
      this.#resetEndHandlers.delete(typedHandler);
    };
  }

  /** Destroy and archive all loops, then optionally create a fresh primary. */
  async reset(options: ResetRoomOptions = {}): Promise<ResetRoomResult> {
    this.#assertOpen("reset");
    const sessionName = options.sessionName
      ?? this.primary?.session.sessionManager.getSessionName();
    this.#state = "resetting";
    this.#backgroundTasks.closeAdmission();

    const archive = await this.#resetRuntime(sessionName);
    if (options.primaryLoop === undefined) return { room: this, ...archive };
    const primaryAgent = normalizeAgentIdentity(options.primaryLoop.agent);
    if (primaryAgent.tag !== PRIMARY_AGENT_TAG) {
      throw new Error(`Primary AgentLoop must use tag "${PRIMARY_AGENT_TAG}"`);
    }

    const primaryLoop = await AgentLoop.create({
      room: this,
      ...options.primaryLoop,
      agent: primaryAgent,
    });
    return { room: this, ...archive, primaryLoop };
  }

  destroy(agentId: string): Promise<void> {
    try {
      this.#assertOpen("destroy an agent");
      return this.#loopManager.destroy(agentId);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    try {
      this.#assertOpen("close");
    } catch (error) {
      return Promise.reject(error);
    }

    this.#state = "closed";
    this.#backgroundTasks.closeAdmission();
    this.#beforeResetHandlers.clear();
    this.#resetEndHandlers.clear();
    const operation = this.#closeRuntime();
    this.#closePromise = operation;
    return operation;
  }

  async #resetRuntime(sessionName: string | undefined): Promise<RoomArchiveResult> {
    try {
      await this.#emitBeforeReset();
      try {
        await this.#backgroundTasks.abortAllAndWait("Room reset");
        await this.#loopManager.destroyAll();
      } catch (error) {
        throw new Error(
          `Room "${this.id}" failed to destroy all agents before reset archival`,
          { cause: error },
        );
      }

      const archiveName = archiveRoomSession(this.roomDir, sessionName);
      for (const directoryName of ["attachments", "loops", "scratch"]) {
        await rm(join(this.roomDir, directoryName), { recursive: true, force: true });
      }
      await this.#emitResetEnd(archiveName);
      return archiveName === undefined ? {} : { archiveName };
    } finally {
      if (this.#state === "resetting") {
        this.#backgroundTasks.reopen();
        this.#state = "open";
      }
    }
  }

  async #emitBeforeReset(): Promise<void> {
    const event: BeforeRoomResetEvent = {
      type: "before_room_reset",
      roomId: this.id,
      roomDir: this.roomDir,
    };
    await issueMultiAgentPiEvent(
      event,
      this,
      async context => {
        for (const handler of [...this.#beforeResetHandlers]) {
          try {
            await handler(event, context);
          } catch (error) {
            MultiAgentPiHarness.instance.logger.warning(
              `[${this.id}] before_room_reset handler failed`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      },
      error => {
        MultiAgentPiHarness.instance.logger.warning(
          `[${this.id}] public before_room_reset handler failed`,
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  }

  async #emitResetEnd(archiveName: string | undefined): Promise<void> {
    const event: RoomResetEndEvent = {
      type: "room_reset_end",
      roomId: this.id,
      roomDir: this.roomDir,
      ...(archiveName === undefined ? {} : { archiveName }),
    };
    await issueMultiAgentPiEvent(
      event,
      this,
      async context => {
        for (const handler of [...this.#resetEndHandlers]) {
          try {
            await handler(event, context);
          } catch (error) {
            MultiAgentPiHarness.instance.logger.warning(
              `[${this.id}] room_reset_end handler failed`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      },
      error => {
        MultiAgentPiHarness.instance.logger.warning(
          `[${this.id}] public room_reset_end handler failed`,
          error instanceof Error ? error.message : String(error),
        );
      },
    );
  }

  #preflightReload(agentId: string | undefined): AgentRegistration[] {
    this.#assertOpen("reload agents");
    if (this.#backgroundTasks.activeCount > 0) {
      throw new Error(`Cannot reload Room "${this.id}" while background tasks are active`);
    }
    const registrations = this.#resolveReloadRegistrations(agentId);
    this.#assertRegistrationsReloadable(registrations);
    return registrations;
  }

  #resolveReloadRegistrations(agentId: string | undefined): AgentRegistration[] {
    if (agentId !== undefined) return [this.#requireRegistration(agentId)];
    return this.#loopManager.listRegistrations();
  }

  #assertRegistrationsReloadable(registrations: readonly AgentRegistration[]): void {
    for (const registration of registrations) registration.loop.assertReloadable();
  }

  async #reloadRegistrations(registrations: readonly AgentRegistration[]): Promise<void> {
    const errors: unknown[] = [];
    try {
      for (const registration of registrations) {
        try {
          await registration.loop.reload();
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      if (this.#state === "reloading") this.#state = "open";
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to reload one or more agents for Room "${this.id}"`);
    }
  }

  async #closeRuntime(): Promise<void> {
    const errors: unknown[] = [];
    for (const operation of [
      () => this.#backgroundTasks.abortAllAndWait("Room closed"),
      () => this.#loopManager.destroyAll(),
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const handler of [...this.#closedHandlers]) {
      try {
        handler(this);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#closedHandlers.clear();

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to close Room "${this.id}" cleanly`);
    }
  }

  #register(loop: AgentLoop): void {
    assertAgentIdentity(loop);
    if (loop.roomId !== undefined && loop.roomId !== this.id) {
      throw new Error(
        `AgentLoop "${loop.id}" already belongs to Room "${loop.roomId}"`,
      );
    }
    const isPrimary = loop.tag === PRIMARY_AGENT_TAG;
    if (isPrimary && loop.dir !== this.roomDir) {
      throw new Error(
        `Room "${this.id}" primary agent directory must be "${this.roomDir}"`,
      );
    }
    if (isPrimary && this.#loopManager.primaryId !== undefined) {
      throw new Error(`Room "${this.id}" already has a primary agent`);
    }
    this.#loopManager.register(loop);
    if (isPrimary) this.#loopManager.setPrimary(loop.id);
    loop.setRoomId(this.id);
  }

  #requireRegistration(agentId: string): AgentRegistration {
    return this.#loopManager.requireRegistration(agentId);
  }

  #assertOpen(action: string): void {
    if (this.#state !== "open") {
      throw new Error(`Cannot ${action} while Room "${this.id}" is ${this.#state}`);
    }
  }
}

export function createRoomId(id?: string): RoomId {
  if (id === undefined) return randomUUID() as RoomId;
  const normalized = id.trim();
  if (!normalized) throw new Error("Room id must not be empty");
  return normalized as RoomId;
}
