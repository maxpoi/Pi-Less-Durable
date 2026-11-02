import type { AgentIdentity, AgentLoop } from "../agent/agent-loop.js";
import { assertIdentityId } from "../identity-validation.js";

export type { AgentIdentity } from "../agent/agent-loop.js";

export const PRIMARY_AGENT_TAG = "main";

export interface AgentRegistration extends AgentIdentity {
  readonly loop: AgentLoop;
}

export function assertAgentId(id: string): void {
  assertIdentityId(id, "Agent id");
}

export function assertAgentIdentity(identity: AgentIdentity): void {
  if (!identity || typeof identity !== "object") {
    throw new Error("Agent identity is required");
  }
  assertAgentId(identity.id);
  if (typeof identity.name !== "string" || !identity.name.trim()) {
    throw new Error("Agent name must not be empty");
  }
  if (typeof identity.tag !== "string" || !identity.tag.trim()) {
    throw new Error("Agent tag must not be empty");
  }
}

/** Validate and copy one identity before any AgentLoop resources are assembled. */
export function normalizeAgentIdentity(identity: AgentIdentity): AgentIdentity {
  assertAgentIdentity(identity);
  return {
    id: identity.id,
    name: identity.name,
    tag: identity.tag,
  };
}

/** Owns AgentLoop registration, selection, and teardown for one Room. */
export class LoopManager {
  readonly #records = new Map<string, AgentRegistration>();
  readonly #destructions = new Map<
    string,
    { readonly registration: AgentRegistration; readonly promise: Promise<void> }
  >();
  #primaryId: string | undefined;
  #selectedId: string | undefined;

  get primaryId(): string | undefined {
    return this.primaryRegistration?.id;
  }

  get primary(): AgentLoop | undefined {
    return this.primaryRegistration?.loop;
  }

  get primaryRegistration(): AgentRegistration | undefined {
    return this.getRegistration(this.#primaryId);
  }

  get selectedId(): string | undefined {
    return this.selectedRegistration?.id;
  }

  get selected(): AgentLoop | undefined {
    return this.selectedRegistration?.loop;
  }

  get selectedRegistration(): AgentRegistration | undefined {
    return this.getRegistration(this.#selectedId);
  }

  register(loop: AgentLoop): AgentRegistration {
    assertAgentIdentity(loop);
    if (loop.state !== "idle" || loop.isBusy) {
      throw new Error(
        `Cannot register agent loop "${loop.id}" while it is ${loop.state === "idle" ? "busy" : loop.state}`,
      );
    }
    if (this.#records.has(loop.id) || this.#destructions.has(loop.id)) {
      throw new Error(`Agent "${loop.id}" already exists`);
    }
    const ownedRegistrations = this.#listOwnedRegistrations();
    if (ownedRegistrations.some(record => record.loop === loop || record.loop.session === loop.session)) {
      throw new Error("The same AgentLoop or AgentSession cannot be registered more than once");
    }
    this.assertDirectoryAvailable(loop.dir);
    const registration: AgentRegistration = {
      id: loop.id,
      name: loop.name,
      tag: loop.tag,
      loop,
    };
    this.#records.set(loop.id, registration);
    return registration;
  }

  assertDirectoryAvailable(dir: string): void {
    const directoryOwner = this.#listOwnedRegistrations()
      .find(record => record.loop.dir === dir);
    if (directoryOwner !== undefined) {
      throw new Error(
        `AgentLoop directory "${dir}" is already owned by agent "${directoryOwner.id}"`,
      );
    }
  }

  get(id: string): AgentLoop | undefined {
    return this.getRegistration(id)?.loop;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  getRegistration(id: string | undefined): AgentRegistration | undefined {
    if (id === undefined) return undefined;
    return this.#records.get(id);
  }

  requireRegistration(id: string): AgentRegistration {
    const registration = this.getRegistration(id);
    if (!registration) throw new Error(`Agent "${id}" not found`);
    return registration;
  }

  list(): AgentLoop[] {
    return this.listRegistrations().map(registration => registration.loop);
  }

  listAgentIds(): string[] {
    return this.listRegistrations().map(registration => registration.id);
  }

  listAgentIdentities(): AgentIdentity[] {
    return this.listRegistrations().map(({ id, name, tag }) => ({ id, name, tag }));
  }

  listRegistrations(): AgentRegistration[] {
    return [...this.#records.values()];
  }

  setPrimary(id: string): AgentLoop {
    const registration = this.requireRegistration(id);
    if (registration.tag !== PRIMARY_AGENT_TAG) {
      throw new Error(`Room primary agent must use tag "${PRIMARY_AGENT_TAG}"`);
    }
    this.#primaryId = id;
    return registration.loop;
  }

  select(id: string): AgentLoop {
    const registration = this.requireRegistration(id);
    this.#selectedId = id;
    return registration.loop;
  }

  selectPrimary(): AgentLoop | undefined {
    const primary = this.primaryRegistration;
    this.#selectedId = primary?.id;
    return primary?.loop;
  }

  clearSelection(): void {
    this.#selectedId = undefined;
  }

  destroy(id: string): Promise<void> {
    const admitted = this.#destructions.get(id);
    if (admitted !== undefined) return admitted.promise;

    const registration = this.#records.get(id);
    if (!registration) return Promise.resolve();

    this.#prepareSelectionForDestroy(registration);
    this.#records.delete(id);
    const promise = registration.loop.destroy().finally(() => {
      if (this.#destructions.get(id)?.promise === promise) {
        this.#destructions.delete(id);
      }
    });
    this.#destructions.set(id, { registration, promise });
    return promise;
  }

  destroyAll(): Promise<void> {
    const pending = [...this.#destructions.values()].map(destruction => destruction.promise);
    for (const id of this.#records.keys()) pending.push(this.destroy(id));
    this.#primaryId = undefined;
    this.#selectedId = undefined;
    return this.#settleDestructions(pending);
  }

  async #settleDestructions(destructions: readonly Promise<void>[]): Promise<void> {
    const errors: unknown[] = [];
    for (const destruction of destructions) {
      try {
        await destruction;
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "One or more agent loops failed to shut down cleanly");
    }
  }

  #listOwnedRegistrations(): AgentRegistration[] {
    return [
      ...this.#records.values(),
      ...[...this.#destructions.values()].map(destruction => destruction.registration),
    ];
  }

  #prepareSelectionForDestroy(registration: AgentRegistration): void {
    if (this.#selectedId === registration.id) {
      this.#selectedId = this.#primaryId === registration.id
        ? undefined
        : this.primaryRegistration?.id;
    }
    if (this.#primaryId === registration.id) this.#primaryId = undefined;
  }
}
