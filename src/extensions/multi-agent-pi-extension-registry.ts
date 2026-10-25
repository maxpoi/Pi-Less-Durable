import { AsyncLocalStorage } from "node:async_hooks";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { AgentLogger } from "../logger/logger.js";
import { assertAgentId } from "../room/loop-manager.js";
import type { RoomId } from "../room/room-types.js";

export type MultiAgentPiExtensionTarget =
  | "all"
  | { readonly tag: string }
  | { readonly id: string; readonly roomId?: string };

export interface MultiAgentPiExtensionRegistration {
  readonly target: MultiAgentPiExtensionTarget;
  readonly setup: ExtensionFactory;
}

export interface MultiAgentPiExtensionAPI {
  /** Register native Pi behavior for this Room's agents. */
  register(registration: MultiAgentPiExtensionRegistration): void;
}

interface AgentExtensionContext {
  readonly roomId: RoomId;
  readonly id: string;
  readonly tag: string;
}

interface StoredRegistration {
  readonly target: MultiAgentPiExtensionTarget;
  readonly setup: ExtensionFactory;
}

interface MultiAgentPiExtensionLoadContext {
  readonly registry: MultiAgentPiExtensionRegistry;
  readonly roomId: RoomId;
  readonly isPrimary: boolean;
}

const extensionLoadContext = new AsyncLocalStorage<MultiAgentPiExtensionLoadContext>();

/** Harness-owned Room declarations materialized by matching native AgentSessions. */
export class MultiAgentPiExtensionRegistry {
  readonly #roomRegistrations = new Map<RoomId, StoredRegistration[]>();

  register(
    sourceRoomId: RoomId,
    registration: MultiAgentPiExtensionRegistration,
  ): void {
    assertRegistration(registration);
    const target = normalizeTarget(registration.target, sourceRoomId);
    if (typeof target === "object" && "id" in target && target.roomId !== sourceRoomId) {
      throw new Error(
        `Room extension source "${sourceRoomId}" cannot target agent "${target.id}" in Room "${target.roomId}"`,
      );
    }
    const registrations = this.#roomRegistrations.get(sourceRoomId) ?? [];
    registrations.push({ target, setup: registration.setup });
    this.#roomRegistrations.set(sourceRoomId, registrations);
  }

  clearRoomRegistrations(roomId: RoomId): void {
    this.#roomRegistrations.delete(roomId);
  }

  createAgentExtension(
    context: AgentExtensionContext,
    name = `multi-agent-pi-${context.roomId}-${context.id}`,
  ): InlineExtension {
    return {
      name,
      hidden: true,
      factory: async (pi: ExtensionAPI) => {
        const registrations = [...(this.#roomRegistrations.get(context.roomId) ?? [])];
        for (const registration of registrations) {
          if (matches(registration.target, context)) {
            await registration.setup(pi);
          }
        }
      },
    };
  }
}

export interface MultiAgentPiResourceLoaderContext {
  readonly registry: MultiAgentPiExtensionRegistry;
  readonly roomId: RoomId;
  readonly isPrimary: boolean;
  readonly logger: AgentLogger;
}

/** Pi ResourceLoader whose main runtime owns one Room's extension declarations. */
export class MultiAgentPiResourceLoader extends DefaultResourceLoader {
  readonly #context: MultiAgentPiResourceLoaderContext;

  constructor(
    options: ConstructorParameters<typeof DefaultResourceLoader>[0],
    context: MultiAgentPiResourceLoaderContext,
  ) {
    super(options);
    this.#context = context;
  }

  override async reload(
    options?: Parameters<DefaultResourceLoader["reload"]>[0],
  ): Promise<void> {
    const { registry, roomId, isPrimary, logger } = this.#context;
    if (isPrimary) registry.clearRoomRegistrations(roomId);
    try {
      await extensionLoadContext.run(
        { registry, roomId, isPrimary },
        () => super.reload(options),
      );
      const loadedExtensions = this.getExtensions();
      for (const error of loadedExtensions.errors) {
        logger.warning("Pi extension error", `${error.path}: ${error.error}`);
      }
      for (const warning of loadedExtensions.warnings ?? []) {
        logger.warning("Pi extension warning", `${warning.path}: ${warning.warning}`);
      }
    } catch (error) {
      if (isPrimary) registry.clearRoomRegistrations(roomId);
      throw error;
    }
  }
}

function assertRegistration(
  registration: MultiAgentPiExtensionRegistration,
): void {
  if (!registration || typeof registration !== "object") {
    throw new Error("MultiAgentPi extension registration requires a registration object");
  }
  if (typeof registration.setup !== "function") {
    throw new Error("MultiAgentPi extension registration requires a Pi extension setup function");
  }
  if (registration.target !== "all" && (!registration.target || typeof registration.target !== "object")) {
    throw new Error(
      "MultiAgentPi extension registration requires target \"all\", { tag }, { id }, or { roomId, id }",
    );
  }
}

function normalizeTarget(
  target: MultiAgentPiExtensionTarget,
  sourceRoomId: RoomId,
): MultiAgentPiExtensionTarget {
  if (target === "all") return target;
  const hasTag = "tag" in target;
  const hasId = "id" in target;
  const hasRoomId = "roomId" in target;
  if (hasTag) {
    if (hasId || hasRoomId || typeof target.tag !== "string" || !target.tag.trim()) {
      throw new Error("MultiAgentPi extension tag target requires only one non-empty tag");
    }
    return { tag: target.tag.trim() };
  }
  if (!hasId) {
    throw new Error("MultiAgentPi exact target requires an id");
  }
  if (hasRoomId && (typeof target.roomId !== "string" || !target.roomId.trim())) {
    throw new Error("MultiAgentPi exact target Room id must not be empty");
  }
  assertAgentId(target.id);
  return {
    roomId: hasRoomId ? target.roomId!.trim() : sourceRoomId,
    id: target.id,
  };
}

function matches(
  target: MultiAgentPiExtensionTarget,
  context: AgentExtensionContext,
): boolean {
  if (target === "all") return true;
  if ("tag" in target) return target.tag === context.tag;
  return target.roomId === context.roomId && target.id === context.id;
}

function register(registration: MultiAgentPiExtensionRegistration): void {
  const context = extensionLoadContext.getStore();
  if (!context) {
    throw new Error("multiAgentPi.register() requires a Harness AgentSession extension context");
  }
  if (!context.isPrimary) return;
  context.registry.register(context.roomId, registration);
}

/** Extension-source API backed by the Room main currently loading that source. */
export const multiAgentPi: MultiAgentPiExtensionAPI = Object.freeze({ register });
