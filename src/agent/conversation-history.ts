import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

export interface InitializeConversationHistoryOptions {
  readonly contextFile: string;
  readonly cwd: string;
  readonly history: readonly SessionEntry[];
}

/** Write canonical history for a new persistent Pi session without replacing an existing one. */
export function initializeConversationHistory(
  options: InitializeConversationHistoryOptions,
): void {
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: options.cwd,
  };
  const entries: FileEntry[] = [header, ...options.history];
  const contents = `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;

  mkdirSync(dirname(options.contextFile), { recursive: true });
  writeFileSync(options.contextFile, contents, { encoding: "utf8", flag: "wx" });
}
