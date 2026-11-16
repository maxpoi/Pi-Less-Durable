import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  normalizeConversationEntry,
  serializeConversationEntry,
  type ConversationEntry,
  type ConversationEntryId,
} from "./conversation-entry.js";
import { RECENT_CONTEXT_QUEUE_CAPACITY } from "./context-policy.js";
import {
  RecentConversationQueue,
  type RecentConversationEntriesResult,
} from "./recent-conversation-queue.js";
import { queryThreadEntries } from "./thread-context-query.js";

export class DurableConversationStore {
  readonly path: string;

  readonly #recentQueue: RecentConversationQueue;
  #closed = false;

  private constructor(path: string, recentQueue: RecentConversationQueue) {
    this.path = path;
    this.#recentQueue = recentQueue;
  }

  static async open(path: string): Promise<DurableConversationStore> {
    const canonicalPath = resolve(path);
    mkdirSync(dirname(canonicalPath), { recursive: true });
    appendFileSync(canonicalPath, "", "utf8");

    const recentQueue = new RecentConversationQueue(RECENT_CONTEXT_QUEUE_CAPACITY);
    const entries = readConversationEntries(canonicalPath);
    entries.forEach(entry => recentQueue.add(entry));
    return new DurableConversationStore(canonicalPath, recentQueue);
  }

  get cachedEntryCount(): number {
    this.#assertOpen();
    return this.#recentQueue.size;
  }

  async append(entry: ConversationEntry): Promise<void> {
    this.#assertOpen();
    const normalized = normalizeConversationEntry(entry);
    appendFileSync(this.path, `${serializeConversationEntry(normalized)}\n`, "utf8");
    this.#recentQueue.add(normalized);
  }

  async getRecentEntries(
    since: string,
    limit: number,
    until: string,
  ): Promise<RecentConversationEntriesResult> {
    this.#assertOpen();
    const sinceMs = Date.parse(since);
    const untilMs = Date.parse(until);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
      throw new Error("Recent conversation range must contain valid dates");
    }
    if (untilMs < sinceMs) {
      return { entries: [], hasOmittedEntries: false };
    }
    return this.#recentQueue.snapshot(sinceMs, untilMs, limit);
  }

  async getThreadEntries(
    rootId: ConversationEntryId,
  ): Promise<readonly ConversationEntry[]> {
    this.#assertOpen();
    return queryThreadEntries(readConversationEntries(this.path), rootId);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error(`Conversation store is closed: ${this.path}`);
    }
  }
}

function readConversationEntries(path: string): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const lines = readFileSync(path, "utf8").split("\n");

  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`Invalid conversation log JSON at ${path}:${index + 1}`, {
        cause: error,
      });
    }

    try {
      entries.push(normalizeConversationEntry(parsed));
    } catch (error) {
      throw new Error(`Invalid conversation log entry at ${path}:${index + 1}`, {
        cause: error,
      });
    }
  });

  return entries;
}
