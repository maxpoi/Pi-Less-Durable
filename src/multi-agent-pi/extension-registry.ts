import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, statSync } from "node:fs";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createAgentLoopContext } from "./context-factory.js";
import type {
  AgentLoopContext,
  MultiAgentPiEvent,
  MultiAgentPiEventHandler,
  MultiAgentPiEventType,
  MultiAgentPiHandler,
} from "./types.js";
import type { AgentLogger } from "../logger/logger.js";
import { assertAgentId } from "../room/loop-manager.js";
import type { RoomId } from "../room/room-types.js";
import {
  getNamedInlineExtensionPath,
  type HarnessInlineExtension,
} from "../extensions/extension-catalog.js";

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

interface MultiAgentPiResourceLoaderContext {
  roomId: RoomId | undefined;
  readonly id: string;
  readonly tag: string;
  readonly logger: AgentLogger;
}

type AnyAgentLoopExtensionEventHandler = MultiAgentPiHandler<
  MultiAgentPiEvent,
  AgentLoopContext
>;

type AgentLoopExtensionEventHandlers = Map<
  MultiAgentPiEventType,
  Set<AnyAgentLoopExtensionEventHandler>
>;

interface MultiAgentPiExtensionLoadContext {
  readonly agent: MultiAgentPiResourceLoaderContext;
  readonly eventHandlers: AgentLoopExtensionEventHandlers;
}

const extensionLoadContext = new AsyncLocalStorage<MultiAgentPiExtensionLoadContext>();

type MultiAgentPiExtensionSource =
  | {
      readonly name: string;
      readonly kind: "file";
      readonly path: string;
    }
  | {
      readonly name: string;
      readonly kind: "inline";
      readonly extension: HarnessInlineExtension;
    };

function getExtensionPath(source: MultiAgentPiExtensionSource): string {
  return source.kind === "file"
    ? source.path
    : getNamedInlineExtensionPath(source.extension);
}

function getExtensionCollisionPath(source: MultiAgentPiExtensionSource): string {
  if (source.kind === "inline") return getExtensionPath(source);
  try {
    return realpathSync(source.path);
  } catch {
    return source.path;
  }
}

function resolveExtensionSources(
  sources: readonly MultiAgentPiExtensionSource[],
  logger?: AgentLogger,
): readonly MultiAgentPiExtensionSource[] {
  const validSources = sources.filter(source => {
    if (source.kind === "inline") return true;
    try {
      if (statSync(source.path).isFile()) return true;
    } catch {
      // Report through the common malformed-source path below.
    }
    logger?.warning(
      "Skipping invalid extension file",
      `"${source.path}" is not an accessible regular file`,
    );
    return false;
  });

  const byName = new Map<string, MultiAgentPiExtensionSource>();
  for (const source of validSources) {
    const previous = byName.get(source.name);
    if (previous !== undefined) {
      logger?.warning(
        "Extension name collision",
        `"${source.name}": latter extension wins`,
      );
    }
    // Match Pi's built-in factory map: replace the value without moving the key.
    byName.set(source.name, source);
  }

  const namedSources = [...byName.values()];
  const inlineByPath = new Map<string, MultiAgentPiExtensionSource>();
  for (const source of namedSources) {
    if (source.kind === "file") continue;
    const path = getExtensionPath(source);
    if (inlineByPath.has(path)) {
      logger?.warning(
        "Extension inline path collision",
        `"${path}": latter extension wins`,
      );
    }
    inlineByPath.set(path, source);
  }

  // Match Pi's filesystem resource deduplication: first canonical file path wins.
  const seenFilePaths = new Set<string>();
  return namedSources.filter(source => {
    if (source.kind === "inline") {
      return inlineByPath.get(getExtensionPath(source)) === source;
    }
    const path = getExtensionCollisionPath(source);
    if (seenFilePaths.has(path)) {
      logger?.warning(
        "Extension path collision",
        `"${path}": first extension wins`,
      );
      return false;
    }
    seenFilePaths.add(path);
    return true;
  });
}

/** Pi ResourceLoader that applies ordered, latter-wins extension sources. */
export class MultiAgentPiResourceLoader extends DefaultResourceLoader {
  readonly #context: MultiAgentPiResourceLoaderContext;
  readonly #getExtensionSources: () => readonly MultiAgentPiExtensionSource[];
  readonly #appliedPiExtensionPaths: string[];
  readonly #appliedExtensionNames: Map<string, string>;
  #eventHandlers: AgentLoopExtensionEventHandlers = new Map();

  constructor(
    options: Omit<
      ConstructorParameters<typeof DefaultResourceLoader>[0],
      "additionalExtensionPaths" | "extensionFactories"
    >,
    context: MultiAgentPiResourceLoaderContext,
    getExtensionSources: () => readonly MultiAgentPiExtensionSource[],
    disabledExtensions: ReadonlySet<string>,
  ) {
    const initialSources = resolveExtensionSources(getExtensionSources());
    // Pi 1.1.0 retains these constructor values and reads their current contents on reload.
    const appliedPiExtensionPaths: string[] = [];
    const appliedExtensionNames = new Map<string, string>();
    const extensionsOverride = options.extensionsOverride;
    super({
      ...options,
      additionalExtensionPaths: appliedPiExtensionPaths,
      extensionFactories: initialSources.flatMap(source =>
        source.kind === "inline" ? [source.extension] : []
      ),
      extensionsOverride: result => {
        const ordered = extensionsOverride?.(result) ?? result;
        return {
          ...ordered,
          extensions: ordered.extensions.filter(extension => {
            const name = appliedExtensionNames.get(extension.path);
            return name === undefined || !disabledExtensions.has(name);
          }),
        };
      },
    });
    this.#context = context;
    this.#getExtensionSources = getExtensionSources;
    this.#appliedPiExtensionPaths = appliedPiExtensionPaths;
    this.#appliedExtensionNames = appliedExtensionNames;
  }

  get roomId(): RoomId | undefined {
    return this.#context.roomId;
  }

  setRoomId(roomId: RoomId): void {
    this.#context.roomId = roomId;
  }

  /** Return the public identity applied to one native Pi extension path. */
  getAppliedExtensionName(path: string): string | undefined {
    return this.#appliedExtensionNames.get(path);
  }

  /** @internal Return one event's handlers from this AgentLoop's latest extension load. */
  getExtensionEventHandlers<TEvent extends MultiAgentPiEventType>(
    event: TEvent,
  ): readonly MultiAgentPiEventHandler<TEvent>[] {
    return [...(this.#eventHandlers.get(event) ?? [])] as MultiAgentPiEventHandler<TEvent>[];
  }

  /** @internal Release all extension-owned AgentLoop handlers during destruction. */
  clearExtensionEventHandlers(): void {
    this.#eventHandlers.clear();
  }

  override async reload(
    options?: Parameters<DefaultResourceLoader["reload"]>[0],
  ): Promise<void> {
    const sources = resolveExtensionSources(
      this.#getExtensionSources(),
      this.#context.logger,
    );
    const extensionPaths = sources.flatMap(source => {
      const path = getExtensionPath(source);
      return source.kind === "file" || source.extension.builtin === true ? [path] : [];
    });
    this.#appliedPiExtensionPaths.splice(
      0,
      this.#appliedPiExtensionPaths.length,
      ...extensionPaths,
    );
    this.#appliedExtensionNames.clear();
    for (const source of sources) {
      this.#appliedExtensionNames.set(getExtensionPath(source), source.name);
    }

    const { logger } = this.#context;
    const eventHandlers: AgentLoopExtensionEventHandlers = new Map();
    this.#eventHandlers.clear();
    await extensionLoadContext.run(
      { agent: this.#context, eventHandlers },
      () => super.reload(options),
    );
    this.#eventHandlers = eventHandlers;

    const loadedExtensions = this.getExtensions();
    for (const error of loadedExtensions.errors) {
      logger.warning("Pi extension error", `${error.path}: ${error.error}`);
    }
    for (const warning of loadedExtensions.warnings ?? []) {
      logger.warning("Pi extension warning", `${warning.path}: ${warning.warning}`);
    }
  }
}

function requireExtensionLoadContext(): MultiAgentPiExtensionLoadContext {
  const context = extensionLoadContext.getStore();
  if (!context) {
    throw new Error(
      "multiAgentPi requires a MultiAgentPi AgentLoop extension load context",
    );
  }
  return context;
}

function requireAgentContext(): MultiAgentPiResourceLoaderContext {
  return requireExtensionLoadContext().agent;
}

/** @internal */
export function getContext(): AgentLoopContext {
  return createAgentLoopContext(requireAgentContext());
}

/** @internal Register one framework event handler in the current AgentLoop load record. */
export function registerAgentLoopExtensionEventHandler<
  TEvent extends MultiAgentPiEventType,
>(
  event: TEvent,
  handler: MultiAgentPiEventHandler<TEvent>,
): () => void {
  if (typeof handler !== "function") {
    throw new Error(`multiAgentPi.on requires a handler for "${event}"`);
  }
  const eventHandlers = requireExtensionLoadContext().eventHandlers;
  let handlers = eventHandlers.get(event);
  if (handlers === undefined) {
    handlers = new Set();
    eventHandlers.set(event, handlers);
  }
  const registeredHandler = handler as AnyAgentLoopExtensionEventHandler;
  if (handlers.has(registeredHandler)) {
    throw new Error(`Handler is already registered for MultiAgentPi event "${event}"`);
  }
  handlers.add(registeredHandler);
  return () => {
    handlers.delete(registeredHandler);
    if (handlers.size === 0) eventHandlers.delete(event);
  };
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
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !["id", "tag"].includes(key)) {
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
  return target.tag === context.tag;
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
      throw createTargetedSetupError(registration.id, context, error);
    });
  } catch (error) {
    throw createTargetedSetupError(registration.id, context, error);
  }
}
