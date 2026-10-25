import { resolve } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentLoop } from "./agent/agent-loop.js";
import {
  createHarnessAgentSession,
  type AgentConfig,
  type AgentLoopExtensionSources,
} from "./agent/agent-session-factory.js";
import { defaultAgentLogger } from "./logger/logger.js";
import type { AgentLogger } from "./logger/logger.js";
import { MultiAgentPiCompactionPolicy } from "./compaction/compaction-policy.js";
import { resolveMultiAgentPiHarnessConfigDirectory, type MultiAgentPiHarnessConfigError } from "./config/config-path.js";
import { MultiAgentPiConfigStore } from "./config/config-store.js";
import type { MultiAgentPiConfig } from "./config/config-types.js";
import { MultiAgentPiSettingsManager } from "./config/multi-agent-pi-settings-manager.js";
import { discoverConfigExtensionFiles } from "./extensions/utils.js";
import {
  PRIMARY_AGENT_TAG,
  assertAgentIdentity,
  type AgentIdentity,
} from "./room/loop-manager.js";
import {
  Room,
  createRoomForHarness,
  type CreateRoomOptions,
  type RoomId,
} from "./room/room.js";

export type MultiAgentPiHarnessState = "created" | "opening" | "open" | "reloading" | "closing" | "closed";

export interface MultiAgentPiHarnessOptions {
  readonly configDir?: string;
  /** Host-owned model/provider/auth runtime. MultiAgentPiHarness borrows but never closes it. */
  readonly modelRuntime: ModelRuntime;
  /** Optional diagnostic sink shared by every admitted Room. */
  readonly logger?: AgentLogger;
}

export interface ReloadMultiAgentPiHarnessOptions {
  readonly roomId?: RoomId;
  readonly agentId?: string;
}

export class MultiAgentPiHarness {
  readonly #configStore: MultiAgentPiConfigStore;
  readonly #modelRuntime: ModelRuntime;
  readonly #logger: AgentLogger;
  #configDiagnostics: readonly MultiAgentPiHarnessConfigError[] = [];
  #configExtensionFiles: readonly string[] = [];
  readonly #settingsManager: MultiAgentPiSettingsManager;
  readonly #rooms = new Map<RoomId, Room>();
  #state: MultiAgentPiHarnessState = "created";
  #openPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: MultiAgentPiHarnessOptions) {
    const configDir = resolveMultiAgentPiHarnessConfigDirectory(options.configDir);
    this.#configStore = new MultiAgentPiConfigStore(configDir);
    this.#modelRuntime = options.modelRuntime;
    this.#settingsManager = new MultiAgentPiSettingsManager(
      this.#configStore,
      new MultiAgentPiCompactionPolicy(
        modelRef => this.#modelRuntime.getModel(modelRef.provider, modelRef.id),
      ),
    );
    this.#logger = options.logger ?? defaultAgentLogger;
  }

  get configDir(): string {
    return this.#configStore.configDir;
  }

  get state(): MultiAgentPiHarnessState {
    return this.#state;
  }

  get configDiagnostics(): readonly MultiAgentPiHarnessConfigError[] {
    return this.#configDiagnostics;
  }

  get config(): Readonly<MultiAgentPiConfig> {
    if (this.#state !== "open") {
      throw new Error(`MultiAgentPiHarness config is unavailable while it is ${this.#state}`);
    }
    return this.#configStore.loadConfig();
  }

  get settings(): MultiAgentPiSettingsManager {
    if (this.#state === "created" || this.#state === "opening" || this.#state === "closed") {
      throw new Error("MultiAgentPiHarness settings are unavailable before open() or after close()");
    }
    return this.#settingsManager;
  }

  open(): Promise<void> {
    if (this.#state === "open") {
      return Promise.resolve();
    }
    if (this.#state === "opening") {
      return this.#openPromise!;
    }
    if (this.#state === "reloading" || this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(new Error(`Cannot open MultiAgentPiHarness while it is ${this.#state}`));
    }

    this.#state = "opening";
    this.#openPromise = this.#openRuntime();
    return this.#openPromise;
  }

  /**
   * Reload only when every targeted Room is idle.
   *
   * Event-bus integration contract for the later Bridge layer: before checking
   * isBusy, Harness must make its bus queue all incoming Room, periodic, and
   * background-agent messages so no new prompt can reach a Room or native AgentSession.
   * Each queued item must retain its original Room/loop target, complete
   * payload, and caller promise. Whether reload succeeds or fails, wait until
   * reload settles and Harness returns to open, then reopen the bus and flush in
   * arrival order. Resolve or reject each original promise from its dispatched
   * result so no steering or follow-up work is discarded or retargeted.
   */
  reload(options: ReloadMultiAgentPiHarnessOptions = {}): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(new Error(`Cannot reload MultiAgentPiHarness while it is ${this.#state}`));
    }
    if (options.agentId !== undefined && options.roomId === undefined) {
      return Promise.reject(new Error("Targeted agent reload requires a roomId"));
    }
    const rooms = [...this.#rooms.values()];
    let targetedRoom: Room | undefined;
    try {
      targetedRoom = options.roomId === undefined
        ? undefined
        : this.#requireRoom(options.roomId);
      const roomsToReload = targetedRoom === undefined ? rooms : [targetedRoom];
      const busyRoom = roomsToReload.find(room => room.isBusy);
      if (busyRoom !== undefined) {
        throw new Error(`Cannot reload MultiAgentPiHarness while Room "${busyRoom.id}" is busy`);
      }
      if (targetedRoom === undefined) {
        const configuration = this.#configStore.initialize();
        this.#configDiagnostics = configuration.diagnostics;
      }
    } catch (error) {
      return Promise.reject(error);
    }

    this.#state = "reloading";
    return this.#reloadRuntime(rooms, targetedRoom, options.agentId);
  }

  /** Create one AgentLoop around a native Pi AgentSession without registering it in the Room. */
  async createAgentLoop(
    room: Room,
    agent: AgentIdentity,
    config: AgentConfig,
    extensionSources: AgentLoopExtensionSources = {},
  ): Promise<AgentLoop> {
    if (this.#state !== "open") {
      throw new Error(`Cannot create an AgentLoop while the Harness is ${this.#state}`);
    }
    if (this.#rooms.get(room.id) !== room) {
      throw new Error(`Room "${room.id}" is not registered with this Harness`);
    }
    assertAgentIdentity(agent);
    if (!config || typeof config.cwd !== "string" || !config.cwd.trim()) {
      throw new Error(`AgentLoop "${agent.id}" requires an explicit cwd`);
    }
    if (room.has(agent.id)) {
      throw new Error(`Agent "${agent.id}" already exists in Room "${room.id}"`);
    }
    const isPrimary = agent.tag.trim() === PRIMARY_AGENT_TAG;
    if (isPrimary && room.primaryId !== undefined) {
      throw new Error(`Room "${room.id}" already has a primary agent`);
    }
    if (!isPrimary && room.primaryId === undefined) {
      throw new Error(`Room "${room.id}" requires its primary agent before creating child agents`);
    }

    const normalizedConfig: AgentConfig = {
      ...config,
      cwd: resolve(config.cwd),
    };
    const extensionFiles = [...new Set([
      ...this.#configExtensionFiles,
      ...(extensionSources.extensionFiles ?? []).map(extensionPath =>
        resolve(process.cwd(), extensionPath)
      ),
    ])];
    const { loop } = await createHarnessAgentSession({
      room,
      agent,
      config: normalizedConfig,
      extensionSources: {
        extensionFiles,
        inlineExtensions: [...(extensionSources.inlineExtensions ?? [])],
      },
      configDir: this.configDir,
      modelRuntime: this.#modelRuntime,
      settingsManager: this.#settingsManager,
      logger: this.#logger,
    });
    return loop;
  }

  /** Create and admit an initialized Room; agent creation and registration remain explicit. */
  createRoom(options: CreateRoomOptions = {}): Room {
    if (this.#state !== "open") {
      throw new Error(`Cannot create a Room while the Harness is ${this.#state}`);
    }

    const runtime = {
      configDir: this.configDir,
      onClosed: (closedRoom: Room) => {
        if (this.#rooms.get(closedRoom.id) === closedRoom) {
          this.#rooms.delete(closedRoom.id);
        }
      },
    };
    let room = createRoomForHarness(runtime, options);
    while (this.#rooms.has(room.id)) {
      if (options.id !== undefined) {
        throw new Error(`Room "${room.id}" is already registered`);
      }
      room = createRoomForHarness(runtime, options);
    }
    this.#rooms.set(room.id, room);
    return room;
  }

  getRoom(id: RoomId): Room | undefined {
    return this.#rooms.get(id);
  }

  #requireRoom(id: RoomId): Room {
    const room = this.#rooms.get(id);
    if (!room) throw new Error(`Room "${id}" not found`);
    return room;
  }

  listRooms(): readonly Room[] {
    return Object.freeze([...this.#rooms.values()]);
  }

  async closeRoom(id: RoomId): Promise<void> {
    if (this.#state !== "open") {
      throw new Error(`Cannot close a Room while the Harness is ${this.#state}`);
    }
    const room = this.#rooms.get(id);
    if (!room) return;
    try {
      await room.close();
    } finally {
      if (this.#rooms.get(id) === room && room.getState() === "closed") {
        this.#rooms.delete(id);
      }
    }
  }

  async #reloadRuntime(
    rooms: readonly Room[],
    targetedRoom: Room | undefined,
    agentId: string | undefined,
  ): Promise<void> {
    try {
      if (targetedRoom !== undefined) {
        await targetedRoom.reload(agentId);
        return;
      }

      await this.#settingsManager.reload();
      const errors: unknown[] = [];
      for (const room of rooms) {
        try {
          await room.reload();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "One or more Rooms failed to reload cleanly");
      }
    } finally {
      if (this.#state === "reloading") this.#state = "open";
    }
  }

  async #openRuntime(): Promise<void> {
    try {
      const configuration = this.#configStore.initialize();
      this.#configDiagnostics = configuration.diagnostics;
      await this.#settingsManager.reload();
      this.#configExtensionFiles = discoverConfigExtensionFiles(this.configDir);
      if (this.#state === "opening") {
        this.#state = "open";
      }
    } catch (error) {
      if (this.#state === "opening") {
        this.#state = "created";
        this.#openPromise = undefined;
      }
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    if (this.#state === "reloading") {
      return Promise.reject(new Error("Cannot close MultiAgentPiHarness while it is reloading"));
    }
    const reloadingRoom = [...this.#rooms.values()]
      .find(room => room.isReloading);
    if (reloadingRoom !== undefined) {
      return Promise.reject(
        new Error(`Cannot close MultiAgentPiHarness while Room "${reloadingRoom.id}" is reloading`),
      );
    }

    this.#state = "closing";
    // Room.close() synchronously transitions to closed while Harness keeps
    // ownership until each returned teardown promise settles.
    const roomClosures = [...this.#rooms.values()].map(room => room.close());
    this.#closePromise = this.#closeRuntime(roomClosures);
    return this.#closePromise;
  }

  async #closeRuntime(roomClosures: readonly Promise<void>[]): Promise<void> {
    try {
      await this.#openPromise;
    } catch {
      // Opening failure is already reported to the open() caller. Closing must
      // still settle the lifecycle and release any partially initialized state.
    }
    const errors: unknown[] = [];
    const closeResults = await Promise.allSettled(roomClosures);
    for (const result of closeResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }

    this.#rooms.clear();
    this.#state = "closed";

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "One or more Rooms failed to close cleanly");
    }
  }
}
