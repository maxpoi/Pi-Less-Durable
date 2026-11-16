import type { ConversationEntryId } from "./conversation-entry.js";
import { formatConversationContext } from "./context-formatter.js";
import {
  DEFAULT_CONTEXT_ENTRY_LIMIT,
  DEFAULT_RECENT_CONTEXT_WINDOW_MS,
} from "./context-policy.js";
import type { DurableConversationStore } from "./durable-conversation-store.js";

export interface ContextAssembler {
  getContext(): Promise<string>;
}

/**
 * Assemble recent global conversation. The current prompt is external to this
 * protocol and must not have been appended before this method is called.
 */
export class RecentConversationContextAssembler implements ContextAssembler {
  readonly #store: DurableConversationStore;

  constructor(store: DurableConversationStore) {
    this.#store = store;
  }

  async getContext(): Promise<string> {
    const now = new Date();
    const nowMs = now.getTime();

    const result = await this.#store.getRecentEntries(
      new Date(nowMs - DEFAULT_RECENT_CONTEXT_WINDOW_MS).toISOString(),
      DEFAULT_CONTEXT_ENTRY_LIMIT,
      now.toISOString(),
    );
    return formatConversationContext(result.entries, result.hasOmittedEntries);
  }
}

/**
 * Assemble the complete linked scope of one Thread before applying shared
 * entry and word limits. The current prompt remains external.
 */
export class ThreadConversationContextAssembler implements ContextAssembler {
  readonly #store: DurableConversationStore;
  readonly #rootId: ConversationEntryId;

  constructor(store: DurableConversationStore, rootId: ConversationEntryId) {
    this.#store = store;
    this.#rootId = rootId;
  }

  async getContext(): Promise<string> {
    const entries = await this.#store.getThreadEntries(this.#rootId);
    return formatConversationContext(entries);
  }
}
