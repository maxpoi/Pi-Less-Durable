import { AsyncLocalStorage } from "node:async_hooks";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AgentLogger } from "../logger/logger.js";
import { assertAgentId } from "../room/loop-manager.js";
import type { RoomId } from "../room/room-types.js";

export type MultiAgentPiExtensionTarget =
  | { readonly tag: string }
  | { readonly id: string; readonly roomId?: string };

export interface MultiAgentPiExtensionRegistration {
  /** Diagnostic label reported when targeted setup fails. */
  readonly id: string;
  readonly target: MultiAgentPiExtensionTarget;
  readonly setup: ExtensionFactory;
}

export interface MultiAgentPiExtensionAPI {
  /**
   * Apply native Pi behavior when the AgentSession currently loading this source matches `target`.
   * Await or return async setup when it must participate in the source's initial load transaction.
   */
  register(
    pi: ExtensionAPI,
    registration: MultiAgentPiExtensionRegistration,
  ): Promise<void>;
}

export interface MultiAgentPiResourceLoaderContext {
  readonly roomId: RoomId;
  readonly id: string;
  readonly tag: string;
  readonly logger: AgentLogger;
}

const extensionLoadContext = new AsyncLocalStorage<MultiAgentPiResourceLoaderContext>();

/** Pi ResourceLoader that scopes native extension loading to one AgentLoop identity. */
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
    const { logger } = this.#context;
    await extensionLoadContext.run(this.#context, () => super.reload(options));

    const loadedExtensions = this.getExtensions();
    for (const error of loadedExtensions.errors) {
      logger.warning("Pi extension error", `${error.path}: ${error.error}`);
    }
    for (const warning of loadedExtensions.warnings ?? []) {
      logger.warning("Pi extension warning", `${warning.path}: ${warning.warning}`);
    }
  }
}

function requireAgentContext(pi: ExtensionAPI): MultiAgentPiResourceLoaderContext {
  if (!pi || typeof pi !== "object" || typeof pi.on !== "function") {
    throw new Error("multiAgentPi.register() requires the current Pi ExtensionAPI");
  }
  const context = extensionLoadContext.getStore();
  if (!context) {
    throw new Error(
      "multiAgentPi.register() requires a MultiAgentPi AgentLoop extension context",
    );
  }
  return context;
}

function assertRegistration(
  registration: MultiAgentPiExtensionRegistration,
): void {
  if (!registration || typeof registration !== "object") {
    throw new Error("MultiAgentPi extension registration requires a registration object");
  }
  if (typeof registration.id !== "string" || !registration.id.trim()) {
    throw new Error("MultiAgentPi extension registration requires a non-empty id");
  }
  if (typeof registration.setup !== "function") {
    throw new Error(
      `MultiAgentPi extension "${registration.id}" requires a Pi extension setup function`,
    );
  }
  if (!registration.target || typeof registration.target !== "object") {
    throw new Error(
      `MultiAgentPi extension "${registration.id}" requires target { tag }, { id }, or { roomId, id }`,
    );
  }

  const target = registration.target;
  const hasTag = "tag" in target;
  const hasId = "id" in target;
  const hasRoomId = "roomId" in target;
  if (hasTag) {
    if (hasId || hasRoomId || typeof target.tag !== "string" || !target.tag.trim()) {
      throw new Error("MultiAgentPi extension tag target requires only one non-empty tag");
    }
    return;
  }
  if (!hasId) throw new Error("MultiAgentPi exact target requires an id");
  assertAgentId(target.id);
  if (hasRoomId && (typeof target.roomId !== "string" || !target.roomId.trim())) {
    throw new Error("MultiAgentPi exact target Room id must not be empty");
  }
}

function matches(
  target: MultiAgentPiExtensionTarget,
  context: MultiAgentPiResourceLoaderContext,
): boolean {
  if ("tag" in target) return target.tag.trim() === context.tag;
  if (target.id !== context.id) return false;
  return target.roomId === undefined || target.roomId.trim() === context.roomId;
}

function createTargetedSetupError(
  registrationId: string,
  context: MultiAgentPiResourceLoaderContext,
  error: unknown,
): Error {
  const details = error instanceof Error ? error.message : String(error);
  return new Error(
    `Targeted extension "${registrationId}" failed for Room "${context.roomId}", `
      + `AgentLoop "${context.id}": ${details}`,
    { cause: error },
  );
}

function register(
  pi: ExtensionAPI,
  registration: MultiAgentPiExtensionRegistration,
): Promise<void> {
  assertRegistration(registration);
  const context = requireAgentContext(pi);
  if (!matches(registration.target, context)) return Promise.resolve();

  try {
    return Promise.resolve(registration.setup(pi)).catch(error => {
      throw createTargetedSetupError(registration.id.trim(), context, error);
    });
  } catch (error) {
    throw createTargetedSetupError(registration.id.trim(), context, error);
  }
}

/** Targeted native Pi behavior evaluated independently in every AgentSession. */
export const multiAgentPi: MultiAgentPiExtensionAPI = Object.freeze({ register });
