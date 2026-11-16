import { randomBytes } from "node:crypto";

export type ConversationEntryId = string;

export function createConversationEntryId(): ConversationEntryId {
  return randomBytes(6).toString("base64url");
}

export interface ConversationEntry {
  readonly id: ConversationEntryId;
  readonly timestamp: string;
  readonly source: string;
  readonly content: string;
  readonly initial: ConversationEntryId | null;
  readonly quotedMessages: readonly ConversationEntryId[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEntryId(value: unknown, field: string): ConversationEntryId {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid conversation entry: ${field} must be a non-empty string`);
  }
  return value;
}

export function normalizeConversationEntry(value: unknown): ConversationEntry {
  if (!isRecord(value)) {
    throw new Error("Invalid conversation entry: expected an object");
  }

  const id = requireEntryId(value.id, "id");
  if (typeof value.timestamp !== "string") {
    throw new Error("Invalid conversation entry: timestamp must be a canonical UTC date string");
  }
  const timestampMs = Date.parse(value.timestamp);
  if (
    !Number.isFinite(timestampMs)
    || new Date(timestampMs).toISOString() !== value.timestamp
  ) {
    throw new Error(
      "Invalid conversation entry: timestamp must use canonical UTC ISO format",
    );
  }
  if (typeof value.source !== "string" || value.source.length === 0) {
    throw new Error("Invalid conversation entry: source must be a non-empty string");
  }
  if (typeof value.content !== "string") {
    throw new Error("Invalid conversation entry: content must be a string");
  }

  const initial = value.initial === null
    ? null
    : requireEntryId(value.initial, "initial");
  if (!Array.isArray(value.quotedMessages)) {
    throw new Error("Invalid conversation entry: quotedMessages must be an array of IDs");
  }
  const quotedMessages = value.quotedMessages.map(
    (quoted, index) => requireEntryId(quoted, `quotedMessages[${index}]`),
  );

  return Object.freeze({
    id,
    timestamp: value.timestamp,
    source: value.source,
    content: value.content,
    initial,
    quotedMessages: Object.freeze(quotedMessages),
  });
}

export function serializeConversationEntry(entry: ConversationEntry): string {
  return JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    source: entry.source,
    content: entry.content,
    initial: entry.initial,
    quotedMessages: entry.quotedMessages,
  });
}
