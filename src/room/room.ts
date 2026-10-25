import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import type { AgentLoop } from "../agent/agent-loop.js";
import {
  LoopManager,
  PRIMARY_AGENT_TAG,
  assertAgentIdentity,
  type AgentIdentity,
  type AgentRegistration,
} from "./loop-manager.js";
import type {
  RoomId,
  RoomPromptOptions,
  RoomState,
} from "./room-types.js";

export type {
  RoomId,
  RoomPromptOptions,
  RoomState,
} from "./room-types.js";

export { PRIMARY_AGENT_TAG };

/** Consumer-owned identity and persistence options for a Harness-created Room. */
export interface CreateRoomOptions {
  readonly id?: string;
  /** Room agent-data directory. Harness workingDir provides the default. */
  readonly roomDir?: string;
}

interface RoomRuntime {
  readonly workingDir: string;
  readonly onClosed: (room: Room) => void;
}

interface RoomConstruction {
  readonly roomDir: string | undefined;
  readonly defaultRoomDirectoryName: string;
}

/** One logical Room owning AgentLoops through a LoopManager. */
export class Room {
  readonly id: RoomId;
  readonly #loopManager = new LoopManager();
  readonly #runtime: RoomRuntime;
  readonly #resolvedRoomDir: string;
  #state: RoomState = "open";
  #closePromise: Promise<void> | undefined;

  private constructor(
    id: RoomId,
    construction: RoomConstruction,
    runtime: RoomRuntime,
  ) {
    this.id = id;
    this.#resolvedRoomDir = construction.roomDir === undefined
      ? resolve(runtime.workingDir, "rooms", construction.defaultRoomDirectoryName)
      : resolve(construction.roomDir);
    this.#runtime = runtime;
  }

  /** @internal Harness is the sole Room factory. */
  static createForHarness(
    runtime: RoomRuntime,
    options: CreateRoomOptions = {},
  ): Room {
    const id = createRoomId(options.id);
    const defaultRoomDirectoryName = options.id === undefined
      ? id
      : Buffer.from(id, "utf8").toString("base64url");
    return new Room(
      id,
      {
        roomDir: options.roomDir,
        defaultRoomDirectoryName,
      },
      runtime,
    );
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

  get isBusy(): boolean {
    if (this.#state !== "open") return true;
    return this.#loopManager.listRegistrations().some(
      registration => registration.loop.isBusy,
    );
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
    assertAgentIdentity(loop);
    const isPrimary = loop.tag === PRIMARY_AGENT_TAG;
    if (isPrimary && this.#loopManager.primaryId !== undefined) {
      throw new Error(`Room "${this.id}" already has a primary agent`);
    }
    this.#loopManager.register(loop);
    if (isPrimary) this.#loopManager.setPrimary(loop.id);
  }

  get(agentId: string): AgentLoop | undefined {
    return this.#loopManager.get(agentId);
  }

  has(agentId: string): boolean {
    return this.#loopManager.has(agentId);
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
  ): Promise<void> {
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

  reload(agentId?: string): Promise<void> {
    try {
      this.#assertOpen("reload agents");
      const registrations = agentId === undefined
        ? this.#loopManager.listRegistrations().sort((left, right) =>
            left.id === this.primaryId ? -1 : right.id === this.primaryId ? 1 : 0
          )
        : [this.#requireRegistration(agentId)];
      const busy = registrations.find(registration => registration.loop.isBusy);
      if (busy) throw new Error(`Cannot reload Room "${this.id}" while agent "${busy.id}" is busy`);
      this.#state = "reloading";
      return this.#reloadRegistrations(registrations);
    } catch (error) {
      return Promise.reject(error);
    }
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
    const teardown = this.#loopManager.destroyAll();
    const operation = this.#closeRuntime(teardown);
    this.#closePromise = operation;
    return operation;
  }

  async #reloadRegistrations(registrations: readonly AgentRegistration[]): Promise<void> {
    const errors: unknown[] = [];
    const primaryId = this.primaryId;
    try {
      for (const registration of registrations) {
        try {
          await registration.loop.reload();
        } catch (error) {
          errors.push(error);
          if (registration.id === primaryId) break;
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

  async #closeRuntime(teardown: Promise<void>): Promise<void> {
    const errors: unknown[] = [];
    try {
      await teardown;
    } catch (error) {
      errors.push(error);
    }
    try {
      this.#runtime.onClosed(this);
    } catch (error) {
      errors.push(error);
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Failed to close Room "${this.id}" cleanly`);
    }
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

/** @internal Construct a fully initialized Room for MultiAgentPiHarness. */
export function createRoomForHarness(
  runtime: RoomRuntime,
  options: CreateRoomOptions = {},
): Room {
  return Room.createForHarness(runtime, options);
}
