import type {
  ConversationEntry,
} from "./conversation-entry.js";

interface QueuedConversationEntry {
  readonly entry: ConversationEntry;
  readonly timestampMs: number;
  readonly ordinal: number;
}

export interface RecentConversationEntriesResult {
  readonly entries: readonly ConversationEntry[];
  readonly hasOmittedEntries: boolean;
}

export class RecentConversationQueue {
  readonly #capacity: number;
  readonly #entries: QueuedConversationEntry[] = [];
  #entryCount = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Recent conversation queue capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#entries.length;
  }

  add(entry: ConversationEntry): void {
    const queued = {
      entry,
      timestampMs: Date.parse(entry.timestamp),
      ordinal: this.#entryCount,
    };
    this.#entryCount += 1;
    const last = this.#entries.at(-1);
    if (last === undefined || compareQueuedEntries(last, queued) <= 0) {
      this.#entries.push(queued);
    } else {
      let low = 0;
      let high = this.#entries.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const current = this.#entries[middle];
        if (current === undefined) {
          throw new Error("Recent conversation queue is inconsistent");
        }
        if (compareQueuedEntries(current, queued) <= 0) low = middle + 1;
        else high = middle;
      }
      this.#entries.splice(low, 0, queued);
    }

    if (this.#entries.length > this.#capacity) this.#entries.shift();
  }

  snapshot(
    sinceMs: number,
    untilMs: number,
    limit: number,
  ): RecentConversationEntriesResult {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("Conversation query limit must be a non-negative integer");
    }

    const eligible = this.#entries.filter(
      queued => queued.timestampMs >= sinceMs && queued.timestampMs <= untilMs,
    );
    const selected = limit === 0 ? [] : eligible.slice(-limit);
    return {
      entries: selected.map(queued => queued.entry),
      hasOmittedEntries: this.#entryCount > selected.length,
    };
  }
}

function compareQueuedEntries(
  left: QueuedConversationEntry,
  right: QueuedConversationEntry,
): number {
  return left.timestampMs - right.timestampMs || left.ordinal - right.ordinal;
}
