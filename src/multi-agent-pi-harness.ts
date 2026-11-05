import { resolve } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaultAgentLogger } from "./logger/logger.js";
import type { AgentLogger } from "./logger/logger.js";
import { MultiAgentPiCompactionPolicy } from "./compaction/compaction-policy.js";
import type { MultiAgentPiConfig } from "./config/config-types.js";
import { MultiAgentPiSettingsManager } from "./config/multi-agent-pi-settings-manager.js";
import {
  assertExplicitPersistencePath,
  persistenceDirectoryTreesOverlap,
  resolvePersistenceDirectory,
} from "./path-validation.js";
import {
  discoverExtensionFiles,
  resolveMultiAgentPiExtensionDirectories,
  resolveMultiAgentPiWorkingDirectory,
} from "./runtime-path.js";
import {
  getValidExtensionName,
  type HarnessExtensionCatalogEntry,
  type HarnessExtensionCatalogSource,
  type HarnessExtensionFile,
  type HarnessInlineExtension,
} from "./extensions/extension-catalog.js";
import {
  Room,
  createRoomId,
  type RoomId,
} from "./room/room.js";

export interface MultiAgentPiHarnessOptions {
  /** Complete in-memory configuration. The host owns any persistence. */
  readonly config: MultiAgentPiConfig;
  /** Required host-owned framework persistence root. Must not be empty. */
  readonly workingDir: string;
  /** Extension catalog roots. Undefined defaults to [<workingDir>/extensions]; an empty list disables file discovery. */
  readonly extensionDirs?: readonly string[];
  /** Host-owned model/provider/auth runtime. MultiAgentPiHarness borrows but never closes it. */
  readonly modelRuntime: ModelRuntime;
  /** Named exact file sources added to the shared Harness extension catalog. */
  readonly additionalExtensionFiles?: readonly HarnessExtensionFile[];
  /** Named inline sources added to the shared Harness extension catalog. */
  readonly additionalInlineExtensions?: readonly HarnessInlineExtension[];
  /** Optional diagnostic sink shared by this singleton Harness and its framework resources. */
  readonly logger?: AgentLogger;
}

export interface ReloadMultiAgentPiHarnessOptions {
  readonly roomId?: RoomId;
  readonly agentId?: string;
  /** Host-supplied replacement for the shared in-memory configuration. */
  readonly config?: MultiAgentPiConfig;
}

export class MultiAgentPiHarness {
  static #instance: MultiAgentPiHarness | undefined;

  readonly #workingDir: string;
  readonly #extensionDirs: readonly string[];
  readonly #modelRuntime: ModelRuntime;
  readonly #logger: AgentLogger;
  readonly #additionalExtensionFiles: Map<string, HarnessExtensionCatalogSource>;
  readonly #additionalInlineExtensionCatalog: readonly HarnessExtensionCatalogSource[];
  /** Stable shared catalog reference; Harness reload replaces its discovered entries in place. */
  readonly #extensionCatalog: HarnessExtensionCatalogSource[] = [];
  readonly #settingsManager: MultiAgentPiSettingsManager;
  readonly #rooms = new Map<RoomId, Room>();
  #reloading = false;

  constructor(options: MultiAgentPiHarnessOptions) {
    if (MultiAgentPiHarness.#instance !== undefined) {
      throw new Error("MultiAgentPiHarness is a process singleton and already exists");
    }

    assertExplicitPersistencePath(options.workingDir, "Harness working directory");
    for (const extensionDir of options.extensionDirs ?? []) {
      assertExplicitPersistencePath(extensionDir, "Harness extension directory");
    }
    this.#workingDir = resolvePersistenceDirectory(
      resolveMultiAgentPiWorkingDirectory(options.workingDir),
    );
    this.#extensionDirs = Object.freeze(resolveMultiAgentPiExtensionDirectories(
      options.extensionDirs,
      this.#workingDir,
    ));
    this.#modelRuntime = options.modelRuntime;
    this.#settingsManager = new MultiAgentPiSettingsManager(
      options.config,
      new MultiAgentPiCompactionPolicy(
        modelRef => this.#modelRuntime.getModel(modelRef.provider, modelRef.id),
      ),
    );
    this.#logger = options.logger ?? defaultAgentLogger;
    this.#additionalExtensionFiles = this.#createAdditionalExtensionFiles(
      options.additionalExtensionFiles ?? [],
    );
    this.#additionalInlineExtensionCatalog = this.#createAdditionalInlineExtensionCatalog(
      options.additionalInlineExtensions ?? [],
    );
    this.#refreshExtensionCatalog();
    MultiAgentPiHarness.#instance = this;
  }

  static get instance(): MultiAgentPiHarness {
    const instance = MultiAgentPiHarness.#instance;
    if (instance === undefined) {
      throw new Error("MultiAgentPiHarness singleton is not available");
    }
    return instance;
  }

  get workingDir(): string {
    return this.#workingDir;
  }

  get extensionDirs(): readonly string[] {
    return this.#extensionDirs;
  }

  get config(): Readonly<MultiAgentPiConfig> {
    return this.#settingsManager.getConfig();
  }

  get settings(): MultiAgentPiSettingsManager {
    return this.#settingsManager;
  }

  /** @internal Shared resources consumed directly by the AgentLoop factory. */
  get modelRuntime(): ModelRuntime {
    return this.#modelRuntime;
  }

  /** @internal Shared resources consumed directly by the AgentLoop factory. */
  get logger(): AgentLogger {
    return this.#logger;
  }

  /** Return the complete Harness-discovered and consumer-provided extension catalog. */
  listExtensions(): readonly HarnessExtensionCatalogEntry[] {
    return Object.freeze(this.#extensionCatalog.map(extension => Object.freeze({
      name: extension.name,
      kind: extension.kind,
      source: extension.source,
      ...(extension.kind === "file" ? { path: extension.path } : {}),
    })));
  }

  /** Add one named exact file to the shared catalog; existing loops adopt it on reload. */
  addExtensionFile(extension: HarnessExtensionFile): void {
    this.#assertExtensionCatalogMutable();
    const source = this.#createAdditionalExtensionFile(extension);
    if (source === undefined) return;
    if (this.#additionalExtensionFiles.has(source.name)) {
      this.#logger.warning(
        "Extension name collision",
        `Harness additional file "${source.name}" was replaced by a later file`,
      );
    }
    // Match Pi's built-in factory map: replace the value without moving the key.
    this.#additionalExtensionFiles.set(source.name, source);
    this.#refreshExtensionCatalog();
  }

  /** Remove one consumer-added exact file; existing loops drop it on reload. */
  removeExtensionFile(name: string): boolean {
    this.#assertExtensionCatalogMutable();
    const source = this.#additionalExtensionFiles.get(name);
    if (source === undefined) return false;
    this.#additionalExtensionFiles.delete(name);
    this.#refreshExtensionCatalog();
    return true;
  }

  /** @internal Stable shared extension catalog consumed directly by the AgentLoop factory. */
  get extensionCatalog(): readonly HarnessExtensionCatalogSource[] {
    return this.#extensionCatalog;
  }

  /** @internal AgentLoop construction is not admitted during Harness reload. */
  get isReloading(): boolean {
    return this.#reloading;
  }

  /**
   * Reload only after every targeted Room passes complete AgentLoop reload preflight.
   * This is stricter than isBusy because pending prompt queues block reload without
   * making their AgentLoops or Rooms busy.
   *
   * Event-bus integration contract for the later Bridge layer: before invoking
   * reload, the host must queue all incoming Room, periodic, and background-agent
   * messages so no new prompt can reach a Room or native AgentSession. Each queued
   * item must retain its original Room/loop target, complete payload, and caller
   * promise. Whether reload succeeds or fails, wait until reload settles, then reopen
   * the bus and flush in arrival order. Resolve or reject each original promise from
   * its dispatched result so no steering or follow-up work is discarded or retargeted.
   */
  reload(options: ReloadMultiAgentPiHarnessOptions = {}): Promise<void> {
    if (this.#reloading) {
      return Promise.reject(new Error("MultiAgentPiHarness is already reloading"));
    }
    if (options.agentId !== undefined && options.roomId === undefined) {
      return Promise.reject(new Error("Targeted agent reload requires a roomId"));
    }
    if (options.config !== undefined && options.roomId !== undefined) {
      return Promise.reject(new Error("Replacing configuration requires a full Harness reload"));
    }
    const rooms = [...this.#rooms.values()];
    let targetedRoom: Room | undefined;
    try {
      targetedRoom = options.roomId === undefined
        ? undefined
        : this.#requireRoom(options.roomId);
      const roomsToReload = targetedRoom === undefined ? rooms : [targetedRoom];
      for (const room of roomsToReload) {
        room.assertReloadable(room === targetedRoom ? options.agentId : undefined);
      }
    } catch (error) {
      return Promise.reject(error);
    }

    this.#reloading = true;
    return this.#reloadRuntime(
      rooms,
      targetedRoom,
      options.agentId,
      options.config,
    );
  }

  /** @internal Validate that one Room can use Harness resources before opening an AgentSession. */
  assertRoomAdmissionAvailable(room: Room): void {
    if (this.#reloading) {
      throw new Error("Cannot use a Room while the Harness is reloading");
    }
    if (!(room instanceof Room)) {
      throw new Error("Harness admission requires a Room");
    }
    createRoomId(room.id);
    if (room.state !== "open") {
      throw new Error(`Cannot use Room "${room.id}" while it is ${room.state}`);
    }
    const idOwner = this.#rooms.get(room.id);
    if (idOwner !== undefined && idOwner !== room) {
      throw new Error(`Room "${room.id}" is already registered`);
    }
    const roomDir = room.roomDir;
    const directoryOwner = roomDir === undefined
      ? undefined
      : [...this.#rooms.values()].find(registeredRoom => {
          const registeredRoomDir = registeredRoom.roomDir;
          return registeredRoom !== room
            && registeredRoomDir !== undefined
            && persistenceDirectoryTreesOverlap(registeredRoomDir, roomDir);
        });
    if (directoryOwner !== undefined) {
      throw new Error(
        `Room directory "${roomDir}" overlaps Room "${directoryOwner.id}" at "${directoryOwner.roomDir}"`,
      );
    }
  }

  /** Transfer lifecycle ownership of one open Room to this Harness. */
  register(room: Room): void {
    this.assertRoomAdmissionAvailable(room);
    if (this.#rooms.get(room.id) === room) {
      throw new Error(`Room "${room.id}" is already registered`);
    }

    room.onClosed(closedRoom => {
      if (this.#rooms.get(closedRoom.id) === closedRoom) {
        this.#rooms.delete(closedRoom.id);
      }
    });
    this.#rooms.set(room.id, room);
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
    if (this.#reloading) {
      throw new Error("Cannot close a Room while the Harness is reloading");
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
    config: MultiAgentPiConfig | undefined,
  ): Promise<void> {
    try {
      this.#refreshExtensionCatalog();
      if (targetedRoom !== undefined) {
        await targetedRoom.reload(agentId);
        return;
      }

      if (config !== undefined) this.#settingsManager.replaceConfig(config);
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
      this.#reloading = false;
    }
  }

  #createAdditionalExtensionFiles(
    extensions: readonly HarnessExtensionFile[],
  ): Map<string, HarnessExtensionCatalogSource> {
    const sources = new Map<string, HarnessExtensionCatalogSource>();
    for (const extension of extensions) {
      const source = this.#createAdditionalExtensionFile(extension);
      if (source === undefined) continue;
      if (sources.has(source.name)) {
        this.#logger.warning(
          "Extension name collision",
          `Harness additional file "${source.name}" was replaced by a later file`,
        );
      }
      // Match Pi's built-in factory map: replace the value without moving the key.
      sources.set(source.name, source);
    }
    return sources;
  }

  #createAdditionalExtensionFile(
    extension: HarnessExtensionFile,
  ): HarnessExtensionCatalogSource | undefined {
    const name = getValidExtensionName(extension);
    if (name === undefined) {
      this.#logger.warning(
        "Skipping invalid Harness extension",
        "Additional extension files require a non-empty name",
      );
      return undefined;
    }
    if (typeof extension.path !== "string" || !extension.path.trim()) {
      this.#logger.warning(
        "Skipping invalid Harness extension",
        `Additional extension file "${name}" requires a non-empty path`,
      );
      return undefined;
    }
    return {
      name,
      kind: "file",
      source: "additional",
      path: resolve(extension.path),
    };
  }

  #createAdditionalInlineExtensionCatalog(
    extensions: readonly HarnessInlineExtension[],
  ): readonly HarnessExtensionCatalogSource[] {
    const sources: HarnessExtensionCatalogSource[] = [];
    for (const extension of extensions) {
      const source = this.#createAdditionalInlineExtension(extension);
      if (source !== undefined) sources.push(source);
    }
    return Object.freeze(sources);
  }

  #createAdditionalInlineExtension(
    extension: HarnessInlineExtension,
  ): HarnessExtensionCatalogSource | undefined {
    const name = getValidExtensionName(extension);
    if (name === undefined) {
      this.#logger.warning(
        "Skipping invalid Harness extension",
        "Inline extensions require a non-empty name",
      );
      return undefined;
    }
    if (typeof extension.factory !== "function") {
      this.#logger.warning(
        "Skipping invalid Harness extension",
        `Inline extension "${name}" requires a factory`,
      );
      return undefined;
    }
    return {
      name,
      kind: "inline",
      source: "additional",
      extension: { ...extension },
    };
  }

  #refreshExtensionCatalog(): void {
    const discovered: HarnessExtensionCatalogSource[] = this.extensionDirs.flatMap(
      extensionDir => discoverExtensionFiles(extensionDir).map(extension => ({
        name: extension.name,
        kind: "file" as const,
        source: "discovered" as const,
        path: extension.path,
      })),
    );
    const nextCatalog = [
      ...discovered,
      ...this.#additionalExtensionFiles.values(),
      ...this.#additionalInlineExtensionCatalog,
    ];
    this.#extensionCatalog.splice(0, this.#extensionCatalog.length, ...nextCatalog);
  }

  #assertExtensionCatalogMutable(): void {
    if (this.#reloading) {
      throw new Error("Cannot modify the Harness extension catalog while the Harness is reloading");
    }
  }

}
