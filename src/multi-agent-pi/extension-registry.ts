import { AsyncLocalStorage } from "node:async_hooks";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentLoopContext,
  type AgentLoopContext,
} from "./context.js";
import type { AgentLogger } from "../logger/logger.js";
import { assertAgentId } from "../room/loop-manager.js";
import type { RoomId } from "../room/room-types.js";

export type MultiAgentPiExtensionTarget =
  | { readonly id: string }
  | { readonly tag: string };

export type MultiAgentPiExtensionSetup = (
  pi: ExtensionAPI,
  context: AgentLoopContext,
) => void | Promise<void>;

export interface MultiAgentPiExtensionRegistration {
  /** Diagnostic label reported when targeted setup fails. */
  readonly id: string;
  readonly target: MultiAgentPiExtensionTarget;
  readonly setup: MultiAgentPiExtensionSetup;
}

export interface MultiAgentPiResourceLoaderContext {
  roomId: RoomId | undefined;
  readonly id: string;
  readonly tag: string;
  readonly logger: AgentLogger;
}

const extensionLoadContext = new AsyncLocalStorage<MultiAgentPiResourceLoaderContext>();

/** Pi ResourceLoader that scopes native extension loading to one AgentLoop identity. */
export class MultiAgentPiResourceLoader extends DefaultResourceLoader {
  readonly #context: MultiAgentPiResourceLoaderContext;
  readonly #harnessExtensionPaths: readonly string[];
  readonly #loopExtensionPaths: readonly string[];
  readonly #appliedPiExtensionPaths: string[];

  constructor(
    options: ConstructorParameters<typeof DefaultResourceLoader>[0],
    context: MultiAgentPiResourceLoaderContext,
    harnessExtensionPaths: readonly string[] = [],
  ) {
    const loopExtensionPaths = [...(options.additionalExtensionPaths ?? [])];
    // Pi 1.1.0 retains this constructor array and resolves its current contents on every reload.
    const appliedPiExtensionPaths: string[] = [];
    super({ ...options, additionalExtensionPaths: appliedPiExtensionPaths });
    this.#context = context;
    this.#harnessExtensionPaths = harnessExtensionPaths;
    this.#loopExtensionPaths = loopExtensionPaths;
    this.#appliedPiExtensionPaths = appliedPiExtensionPaths;
  }

  get roomId(): RoomId | undefined {
    return this.#context.roomId;
  }

  setRoomId(roomId: RoomId): void {
    this.#context.roomId = roomId;
  }

  override async reload(
    options?: Parameters<DefaultResourceLoader["reload"]>[0],
  ): Promise<void> {
    const extensionPaths = [...new Set([
      ...this.#harnessExtensionPaths,
      ...this.#loopExtensionPaths,
    ])];
    this.#appliedPiExtensionPaths.splice(
      0,
      this.#appliedPiExtensionPaths.length,
      ...extensionPaths,
    );

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

function requireAgentContext(): MultiAgentPiResourceLoaderContext {
  const context = extensionLoadContext.getStore();
  if (!context) {
    throw new Error(
      "multiAgentPi requires a MultiAgentPi AgentLoop extension load context",
    );
  }
  return context;
}

/** @internal */
export function getContext(): AgentLoopContext {
  return createAgentLoopContext(requireAgentContext());
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
      `MultiAgentPi extension "${registration.id}" requires target { id } or { tag }`,
    );
  }

  const target = registration.target;
  const keys = Object.keys(target);
  if (keys.length !== 1 || !["id", "tag"].includes(keys[0]!)) {
    throw new Error(
      "MultiAgentPi extension target requires exactly one of { id } or { tag }",
    );
  }
  if ("id" in target) {
    assertAgentId(target.id);
    return;
  }
  if (typeof target.tag !== "string" || !target.tag.trim()) {
    throw new Error("MultiAgentPi extension tag target requires a non-empty tag");
  }
}

function matches(
  target: MultiAgentPiExtensionTarget,
  context: MultiAgentPiResourceLoaderContext,
): boolean {
  if ("id" in target) return target.id === context.id;
  return target.tag.trim() === context.tag;
}

function createTargetedSetupError(
  registrationId: string,
  context: MultiAgentPiResourceLoaderContext,
  error: unknown,
): Error {
  const details = error instanceof Error ? error.message : String(error);
  const owner = context.roomId === undefined
    ? `AgentLoop "${context.id}"`
    : `Room "${context.roomId}", AgentLoop "${context.id}"`;
  return new Error(
    `Targeted extension "${registrationId}" failed for ${owner}: ${details}`,
    { cause: error },
  );
}

/** @internal */
export function register(
  pi: ExtensionAPI,
  registration: MultiAgentPiExtensionRegistration,
): Promise<void> {
  if (!pi || typeof pi !== "object" || typeof pi.on !== "function") {
    throw new Error("multiAgentPi.register requires the current Pi ExtensionAPI");
  }
  assertRegistration(registration);
  const context = requireAgentContext();
  if (!matches(registration.target, context)) return Promise.resolve();

  try {
    return Promise.resolve(
      registration.setup(pi, createAgentLoopContext(context)),
    ).catch(error => {
      throw createTargetedSetupError(registration.id.trim(), context, error);
    });
  } catch (error) {
    throw createTargetedSetupError(registration.id.trim(), context, error);
  }
}
