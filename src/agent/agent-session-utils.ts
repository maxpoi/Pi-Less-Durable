import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

/** Canonical Pi entries used to initialize a new agent session. */
export type ConversationHistory = readonly SessionEntry[];

interface ConversationHistorySource {
  getBranch(fromId?: string): SessionEntry[];
  getLeafId(): string | null;
}

export interface InitializeConversationHistoryOptions {
  readonly contextFile: string;
  readonly cwd: string;
  readonly history: readonly SessionEntry[];
}

/** @internal Build detached canonical Pi file entries from JSON-serializable history. */
export function createConversationHistoryEntries(
  cwd: string,
  history: readonly SessionEntry[],
): FileEntry[] {
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  };
  const detachedHistory = history.map(entry =>
    JSON.parse(JSON.stringify(entry)) as SessionEntry
  );
  return [header, ...detachedHistory];
}

/** Write canonical history for a new persistent Pi session without replacing an existing one. */
export function initializeConversationHistory(
  options: InitializeConversationHistoryOptions,
): void {
  const entries = createConversationHistoryEntries(options.cwd, options.history);
  const contents = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;

  mkdirSync(dirname(options.contextFile), { recursive: true });
  writeFileSync(options.contextFile, contents, { encoding: "utf8", flag: "wx" });
}

/** Copy one branch into canonical history suitable for a new native AgentSession. */
export function forkConversationHistory(
  source: ConversationHistorySource,
  fromId?: string,
): SessionEntry[] {
  const leafId = fromId ?? source.getLeafId();
  if (!leafId) return [];
  return source.getBranch(leafId);
}

/** @deprecated Use forkConversationHistory(). */
export function forkBranchEntries(
  source: ConversationHistorySource,
  fromId?: string,
): SessionEntry[] {
  return forkConversationHistory(source, fromId);
}
