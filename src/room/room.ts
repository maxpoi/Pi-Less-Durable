import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { createRoomContext } from "../multi-agent-pi/context-factory.js";
import {
  AgentLoop,
  type AgentLoopQueuedPromptType,
  type AgentLoopResult,
} from "../agent/agent-loop.js";
import { assertIdentityId } from "../identity-validation.js";
import { MultiAgentPiHarness } from "../multi-agent-pi-harness.js";
import {
  resolveExplicitPersistenceDirectory,
  resolvePersistenceDirectory,
} from "../path-validation.js";
import { BackgroundTaskManager } from "./background-task-manager.js";
import {
  archiveRoomSession,
  assertRoomSessionArchiveRestorable,
  currentRoomSessionDirectory,
  ensureCurrentRoomSessionDirectory,
  listRoomSessionArchives,
  restoreRoomSessionArchive,
  type RoomSessionArchive,
} from "./session-archive.js";
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
  RestoreRoomSessionOptions,
  RestoreRoomSessionResult,
  RoomEnqueuePromptOptions,
  RoomId,
  RoomPersistence,
  RoomPromptOptions,
  RoomResetEndEvent,
  RoomResetEndHandler,
  RoomState,
  SessionRestoreEndEvent,
  SessionRestoreEndHandler,
} from "./room-types.js";

export type {
  BeforeRoomResetEvent,
  BeforeRoomResetHandler,
  CreateRoomOptions,
  CreateRoomResult,
  DurableRoomPrimaryAgentLoopOptions,
  MemoryRoomPrimaryAgentLoopOptions,
  PrimaryAgentLoopOptions,
  ResetRoomOptions,
  ResetRoomResult,
  RestoreRoomSessionOptions,
  RestoreRoomSessionResult,
  RoomEnqueuePromptOptions,
  RoomId,
  RoomPersistence,
  RoomPromptOptions,
  RoomResetEndEvent,
  RoomResetEndHandler,
  RoomState,
  SessionRestoreEndEvent,
  SessionRestoreEndHandler,
} from "./room-types.js";
export type { RoomSessionArchive } from "./session-archive.js";

export { PRIMARY_AGENT_TAG };

interface RoomArchiveResult {
  readonly archiveName: string;
}

/** One logical Room owning AgentLoops and detached background operations. */
export class Room {
  readonly id: RoomId;
  readonly persistence: RoomPersistence;
  readonly #loopManager = new LoopManager();
  readonly #backgroundTasks: BackgroundTaskManager;
  readonly #resolvedRoomDir: string | undefined;
  readonly #beforeResetHandlers = new Set<BeforeRoomResetHandler>();
  readonly #resetEndHandlers = new Set<RoomResetEndHandler>();
  readonly #restoreEndHandlers = new Set<SessionRestoreEndHandler>();
  readonly #closedHandlers = new Set<(room: Room) => void>();
  #state: RoomState = "open";
  #closePromise: Promise<void> | undefined;

  private constructor(
    id: RoomId,
    persistence: RoomPersistence,
    roomDir: string | undefined,
  ) {
    this.id = id;
    this.persistence = persistence;
    this.#resolvedRoomDir = roomDir;
    if (roomDir !== undefined) ensureCurrentRoomSessionDirectory(roomDir);
    this.#backgroundTasks = new BackgroundTaskManager({
      roomId: id,
      logger: MultiAgentPiHarness.instance.logger,
    });
  }

  /** Create one standalone Room, optionally with an automatically registered primary. */
  static async create(options: CreateRoomOptions = {}): Promise<CreateRoomResult> {
    const id = createRoomId(options.id);
    const persistence: RoomPersistence = options.persistence ?? "durable";
    if (persistence !== "durable" && persistence !== "memory") {
      throw new Error(`Room "${id}" persistence must be "durable" or "memory"`);
    }
    if (persistence === "memory" && options.roomDir !== undefined) {
      throw new Error(`Memory Room "${id}" must not define a Room directory`);
    }
    const roomDir = persistence === "memory"
      ? undefined
      : options.roomDir === undefined
        ? resolvePersistenceDirectory(
            join(MultiAgentPiHarness.instance.workingDir, "rooms", randomUUID()),
          )
        : resolveExplicitPersistenceDirectory(options.roomDir, "Room directory");
    const room = new Room(id, persistence, roomDir);

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

  get roomDir(): string | undefined {
    return this.#resolvedRoomDir;
  }

  /** Filesystem-canonical location of this durable Room's active conversation. */
  get currentDir(): string | undefined {
    return this.#resolvedRoomDir === undefined
      ? undefined
      : currentRoomSessionDirectory(this.#resolvedRoomDir);
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

  /** Return archived conversation directories by exact name, newest first. */
  listSessionArchives(): readonly RoomSessionArchive[] {
    this.#assertOpen("list session archives");
    return this.#resolvedRoomDir === undefined
      ? Object.freeze([])
      : listRoomSessionArchives(this.#resolvedRoomDir);
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

  /** @internal Preflight Room-owned AgentLoop directory identity before registration. */
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

  /** Register a Room-owned reset-admission listener. */
  on(event: "before_room_reset", handler: BeforeRoomResetHandler): () => void;
  /** Register a Room-owned completed-reset listener. */
  on(event: "room_reset_end", handler: RoomResetEndHandler): () => void;
  /** Register a Room-owned completed-restore listener. */
  on(event: "session_restore_end", handler: SessionRestoreEndHandler): () => void;
  on(
    event: "before_room_reset" | "room_reset_end" | "session_restore_end",
    handler: BeforeRoomResetHandler | RoomResetEndHandler | SessionRestoreEndHandler,
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
    if (event === "room_reset_end") {
      const typedHandler = handler as RoomResetEndHandler;
      this.#resetEndHandlers.add(typedHandler);
      return () => {
        this.#resetEndHandlers.delete(typedHandler);
      };
    }

    const typedHandler = handler as SessionRestoreEndHandler;
    this.#restoreEndHandlers.add(typedHandler);
    return () => {
      this.#restoreEndHandlers.delete(typedHandler);
    };
  }

  /** Archive and reopen one durable Room session. Memory Rooms cannot reset. */
  async reset(options: ResetRoomOptions = {}): Promise<ResetRoomResult> {
    this.#assertOpen("reset");
    if (this.persistence === "memory") {
      throw new Error(`Cannot reset memory Room "${this.id}"`);
    }
    this.#beginSessionReset("reset");
    let archive: RoomArchiveResult;
    try {
      archive = await this.#archiveActiveSession("Room reset");
      ensureCurrentRoomSessionDirectory(this.#requireRoomDir("reset"));
      await this.#emitResetEnd(archive.archiveName);
    } finally {
      this.#endSessionReset();
    }

    const primaryLoop = await this.#createPrimary(options.primaryLoop);
    return {
      room: this,
      persistence: "durable",
      archiveName: archive.archiveName,
      ...(primaryLoop === undefined ? {} : { primaryLoop }),
    };
  }

  /** Archive `current`, rename one exact sibling archive to `current`, then recreate the primary. */
  async restoreSession(
    archiveName: string,
    options: RestoreRoomSessionOptions = {},
  ): Promise<RestoreRoomSessionResult> {
    this.#assertOpen("restore a session");
    if (this.persistence === "memory") {
      throw new Error(`Cannot restore a session in memory Room "${this.id}"`);
    }
    const roomDir = this.#requireRoomDir("restore a session");
    assertRoomSessionArchiveRestorable(roomDir, archiveName);
    this.#beginSessionReset("restore a session");

    let previous: RoomArchiveResult;
    try {
      previous = await this.#archiveActiveSession("Room session restore");
      restoreRoomSessionArchive(roomDir, archiveName);
      await this.#emitResetEnd(previous.archiveName);
      await this.#emitRestoreEnd(archiveName);
    } finally {
      this.#endSessionReset();
    }

    const primaryLoop = await this.#createPrimary(options.primaryLoop);
    return {
      room: this,
      restoredArchiveName: archiveName,
      previousArchiveName: previous.archiveName,
      ...(primaryLoop === undefined ? {} : { primaryLoop }),
    };
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
    this.#restoreEndHandlers.clear();
    const operation = this.#closeRuntime();
    this.#closePromise = operation;
    return operation;
  }

  #beginSessionReset(action: string): void {
    this.#assertOpen(action);
    this.#state = "resetting";
    this.#backgroundTasks.closeAdmission();
  }

  #endSessionReset(): void {
    if (this.#state !== "resetting") return;
    if (this.#resolvedRoomDir !== undefined) {
      ensureCurrentRoomSessionDirectory(this.#resolvedRoomDir);
    }
    this.#backgroundTasks.reopen();
    this.#state = "open";
  }

  async #destroyActiveSession(abortReason: string): Promise<void> {
    await this.#emitBeforeReset();
    try {
      await this.#backgroundTasks.abortAllAndWait(abortReason);
      await this.#loopManager.destroyAll();
    } catch (error) {
      throw new Error(
        `Room "${this.id}" failed to destroy all agents during reset`,
        { cause: error },
      );
    }
  }

  async #archiveActiveSession(abortReason: string): Promise<RoomArchiveResult> {
    await this.#destroyActiveSession(abortReason);
    const archiveName = archiveRoomSession(
      this.#requireRoomDir("archive the active session"),
      this.id,
    );
    return { archiveName };
  }

  async #createPrimary(options: PrimaryAgentLoopOptions | undefined): Promise<AgentLoop | undefined> {
    if (options === undefined) return undefined;
    const primaryAgent = normalizeAgentIdentity(options.agent);
    if (primaryAgent.tag !== PRIMARY_AGENT_TAG) {
      throw new Error(`Primary AgentLoop must use tag "${PRIMARY_AGENT_TAG}"`);
    }
    return AgentLoop.create({
      room: this,
      ...options,
      agent: primaryAgent,
    });
  }

  async #emitBeforeReset(): Promise<void> {
    const event: BeforeRoomResetEvent = {
      type: "before_room_reset",
      roomId: this.id,
      persistence: "durable",
      roomDir: this.#requireRoomDir("emit before_room_reset"),
      currentDir: this.#requireCurrentDir("emit before_room_reset"),
    };
    const context = createRoomContext(this);
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
  }

  async #emitResetEnd(archiveName: string): Promise<void> {
    const event: RoomResetEndEvent = {
      type: "room_reset_end",
      roomId: this.id,
      persistence: "durable",
      roomDir: this.#requireRoomDir("emit room_reset_end"),
      currentDir: this.#requireCurrentDir("emit room_reset_end"),
      archiveName,
    };
    const context = createRoomContext(this);
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
  }

  async #emitRestoreEnd(archiveName: string): Promise<void> {
    const event: SessionRestoreEndEvent = {
      type: "session_restore_end",
      roomId: this.id,
      persistence: "durable",
      roomDir: this.#requireRoomDir("emit session_restore_end"),
      currentDir: this.#requireCurrentDir("emit session_restore_end"),
      archiveName,
    };
    const context = createRoomContext(this);
    for (const handler of [...this.#restoreEndHandlers]) {
      try {
        await handler(event, context);
      } catch (error) {
        MultiAgentPiHarness.instance.logger.warning(
          `[${this.id}] session_restore_end handler failed`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
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
    if (this.persistence === "durable") {
      const currentDir = this.#requireCurrentDir("register an agent");
      const expectedDir = isPrimary
        ? currentDir
        : join(currentDir, "loops", loop.id);
      if (loop.dir !== expectedDir) {
        throw new Error(
          `Room "${this.id}" agent "${loop.id}" directory must be "${expectedDir}"`,
        );
      }
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

  #requireRoomDir(action: string): string {
    if (this.#resolvedRoomDir === undefined) {
      throw new Error(`Cannot ${action} without a durable Room directory`);
    }
    return this.#resolvedRoomDir;
  }

  #requireCurrentDir(action: string): string {
    return currentRoomSessionDirectory(this.#requireRoomDir(action));
  }

  #assertOpen(action: string): void {
    if (this.#state !== "open") {
      throw new Error(`Cannot ${action} while Room "${this.id}" is ${this.#state}`);
    }
  }
}

export function createRoomId(id?: string): RoomId {
  if (id === undefined) return randomUUID() as RoomId;
  assertIdentityId(id, "Room id");
  return id as RoomId;
}
