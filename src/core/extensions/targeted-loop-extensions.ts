import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { LoopManager } from "../agent-loop/loop-manager.js";

export interface ExtensionLoopContext {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly loopId: string;
  readonly loopDir: string;
}

export type ExtensionLoopTarget =
  | "all"
  | string
  | readonly string[]
  | {
      readonly sessionId?: string;
      readonly loopIds: "all" | readonly string[];
    }
  | ((context: ExtensionLoopContext) => boolean);

interface StoredRegistration {
  readonly sessionId?: string;
  readonly matches: (context: ExtensionLoopContext) => boolean;
  readonly exactLoopIds?: Set<string>;
  readonly extension: ExtensionFactory;
}

interface NormalizedTarget {
  readonly sessionId: string | undefined;
  readonly matches: (context: ExtensionLoopContext) => boolean;
  readonly exactLoopIds?: Set<string>;
}

type AnyLoopManager = LoopManager<any>;

/**
 * Process/session targeting declarations materialized by each matching loop's
 * private Pi runtime. Core Session binds its authoritative LoopManager; hosts
 * cannot substitute a parallel loop lookup. Registration never mutates a
 * running runtime.
 */
export class TargetedLoopExtensionRegistry {
  readonly #processRegistrations: StoredRegistration[] = [];
  readonly #sessionRegistrations = new Map<string, StoredRegistration[]>();
  readonly #sessionFileRegistrations = new Map<string, StoredRegistration[]>();
  readonly #sessionLoopManagers = new Map<string, AnyLoopManager>();

  attachSession(sessionId: string, loopManager: AnyLoopManager): void {
    if (!sessionId) throw new Error("Targeted extension session requires a session id");
    if (this.#sessionLoopManagers.has(sessionId)) {
      throw new Error(`Targeted extension session is already attached for "${sessionId}"`);
    }
    this.#sessionLoopManagers.set(sessionId, loopManager);
  }

  removeLoop(sessionId: string, loopId: string): void {
    this.#removeExactLoopFromStore(this.#sessionRegistrations, sessionId, loopId);
    this.#removeExactLoopFromStore(this.#sessionFileRegistrations, sessionId, loopId);
  }

  detachSession(sessionId: string, loopManager: AnyLoopManager): void {
    if (this.#sessionLoopManagers.get(sessionId) !== loopManager) return;
    this.#sessionLoopManagers.delete(sessionId);
    this.#sessionFileRegistrations.delete(sessionId);
    this.#removeAllExactRegistrations(sessionId);
  }

  register(
    implicitSessionId: string | undefined,
    target: ExtensionLoopTarget,
    extension: ExtensionFactory,
    options: { readonly fileOwned?: boolean } = {},
  ): void {
    if (typeof extension !== "function") {
      throw new Error("Targeted AgentLoop registration requires a Pi extension factory");
    }

    const normalized = normalizeTarget(target, implicitSessionId);
    if (normalized.sessionId !== undefined && !normalized.sessionId) {
      throw new Error("Targeted AgentLoop registration requires a non-empty session id");
    }
    if (options.fileOwned && normalized.sessionId === undefined) {
      throw new Error("File-owned targeted extension registration requires a session scope");
    }
    this.#assertExactTargetsExist(normalized);

    const registration: StoredRegistration = {
      ...(normalized.sessionId === undefined ? {} : { sessionId: normalized.sessionId }),
      matches: normalized.matches,
      ...(normalized.exactLoopIds === undefined ? {} : { exactLoopIds: normalized.exactLoopIds }),
      extension,
    };

    if (normalized.sessionId === undefined) {
      this.#processRegistrations.push(registration);
      return;
    }

    const stores = options.fileOwned
      ? this.#sessionFileRegistrations
      : this.#sessionRegistrations;
    const registrations = stores.get(normalized.sessionId) ?? [];
    registrations.push(registration);
    stores.set(normalized.sessionId, registrations);
  }

  createLoopExtension(
    context: ExtensionLoopContext,
    name = `targeted-loop-${context.loopId}`,
  ): InlineExtension {
    return {
      name,
      hidden: true,
      factory: async (pi: ExtensionAPI) => {
        const extensions = this.#matchingExtensions(context);
        for (const extension of extensions) await extension(pi);
      },
    };
  }

  clearSessionFileRegistrations(sessionId: string): void {
    this.#sessionFileRegistrations.delete(sessionId);
  }

  #matchingExtensions(context: ExtensionLoopContext): ExtensionFactory[] {
    const extensions: ExtensionFactory[] = [];
    for (const registration of this.#processRegistrations) {
      if (registration.matches(context)) extensions.push(registration.extension);
    }
    for (const registration of this.#sessionFileRegistrations.get(context.sessionId) ?? []) {
      if (registration.matches(context)) extensions.push(registration.extension);
    }
    for (const registration of this.#sessionRegistrations.get(context.sessionId) ?? []) {
      if (registration.matches(context)) extensions.push(registration.extension);
    }
    return extensions;
  }

  #assertExactTargetsExist(target: NormalizedTarget): void {
    if (target.exactLoopIds === undefined) return;
    if (target.sessionId === undefined) {
      throw new Error("Exact AgentLoop extension targets require a session scope");
    }
    const loopManager = this.#sessionLoopManagers.get(target.sessionId);
    for (const loopId of target.exactLoopIds) {
      if (!loopManager?.get(loopId)) {
        throw new Error(`Cannot target AgentLoop "${loopId}": it does not exist in session "${target.sessionId}"`);
      }
    }
  }

  #removeExactLoopFromStore(
    stores: Map<string, StoredRegistration[]>,
    sessionId: string,
    loopId: string,
  ): void {
    const registrations = stores.get(sessionId);
    if (!registrations) return;
    const retained = registrations.filter(registration => {
      if (registration.exactLoopIds === undefined) return true;
      registration.exactLoopIds.delete(loopId);
      return registration.exactLoopIds.size > 0;
    });
    if (retained.length === 0) stores.delete(sessionId);
    else stores.set(sessionId, retained);
  }

  #removeAllExactRegistrations(sessionId: string): void {
    this.#removeAllExactRegistrationsFromStore(this.#sessionRegistrations, sessionId);
    this.#removeAllExactRegistrationsFromStore(this.#sessionFileRegistrations, sessionId);
  }

  #removeAllExactRegistrationsFromStore(
    stores: Map<string, StoredRegistration[]>,
    sessionId: string,
  ): void {
    const registrations = stores.get(sessionId);
    if (!registrations) return;
    const retained = registrations.filter(registration => registration.exactLoopIds === undefined);
    if (retained.length === 0) stores.delete(sessionId);
    else stores.set(sessionId, retained);
  }
}

function normalizeTarget(
  target: ExtensionLoopTarget,
  implicitSessionId: string | undefined,
): NormalizedTarget {
  if (typeof target === "function") {
    return {
      sessionId: implicitSessionId,
      matches: context => (!implicitSessionId || context.sessionId === implicitSessionId) && target(context),
    };
  }
  if (target === "all") {
    return {
      sessionId: implicitSessionId,
      matches: context => !implicitSessionId || context.sessionId === implicitSessionId,
    };
  }
  if (typeof target === "string") {
    const exactLoopIds = createExactLoopIds([target]);
    return {
      sessionId: implicitSessionId,
      exactLoopIds,
      matches: context => (!implicitSessionId || context.sessionId === implicitSessionId)
        && exactLoopIds.has(context.loopId),
    };
  }
  if (Array.isArray(target)) {
    const exactLoopIds = createExactLoopIds(target);
    return {
      sessionId: implicitSessionId,
      exactLoopIds,
      matches: context => (!implicitSessionId || context.sessionId === implicitSessionId)
        && exactLoopIds.has(context.loopId),
    };
  }

  const descriptor = target as Extract<ExtensionLoopTarget, { loopIds: unknown }>;
  const sessionId = descriptor.sessionId ?? implicitSessionId;
  if (descriptor.loopIds === "all") {
    return {
      sessionId,
      matches: context => !sessionId || context.sessionId === sessionId,
    };
  }
  const exactLoopIds = createExactLoopIds(descriptor.loopIds);
  return {
    sessionId,
    exactLoopIds,
    matches: context => (!sessionId || context.sessionId === sessionId)
      && exactLoopIds.has(context.loopId),
  };
}

function createExactLoopIds(loopIds: readonly string[]): Set<string> {
  const exactLoopIds = new Set(loopIds);
  if (exactLoopIds.size === 0) {
    throw new Error("Exact AgentLoop extension target requires at least one loop id");
  }
  for (const loopId of exactLoopIds) {
    if (!loopId) throw new Error("Exact AgentLoop extension target requires a non-empty loop id");
  }
  return exactLoopIds;
}
