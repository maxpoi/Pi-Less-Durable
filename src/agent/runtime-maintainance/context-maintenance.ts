import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { defaultAgentLogger } from "../../logger/logger.js";
import type { AgentLogger } from "../../logger/logger.js";

// TODO: Persist prompt-supplied image data and include its saved path in replacement text.
const IMAGE_RECOVERY_INSTRUCTION =
  "Re-read the original file if it is available; otherwise ask the user to provide the image again.";

const IMAGE_STRIPPED_DEFAULT = (mime: string): string =>
  `[image (${mime}) was already shown to you and removed from context to save space. ${IMAGE_RECOVERY_INSTRUCTION}]`;

const IMAGE_STRIPPED_ON_RELOAD = (mime: string): string =>
  `[image (${mime}) was removed while restoring this session. ${IMAGE_RECOVERY_INSTRUCTION}]`;

export const IMAGE_STRIPPED_OVERFLOW =
  `[image stripped — images are stripped due to context too large, either due to you read too many images at once or your entire work loop has gone too large. If you need to re-read images, try to read them in smaller patches. If the original image is not available as a file, ask the user to provide it again.]`;

const LARGE_TEXT_THRESHOLD = 1024;
const TOOL_RESULT_TRUNCATE_THRESHOLD = 2048;

interface ProjectedContextMessage {
  readonly sourceEntryId: string;
  readonly message: AgentMessage;
  readonly index: number;
}

type ContentReplacements = Map<string, unknown>;

function hasEditableContent(message: AgentMessage): message is AgentMessage & { content: unknown } {
  return message.role === "user"
    || message.role === "assistant"
    || message.role === "toolResult"
    || message.role === "custom";
}

function getProjectedContextMessages(sessionManager: SessionManager): ProjectedContextMessage[] {
  const projected: ProjectedContextMessage[] = [];
  for (const entry of sessionManager.buildSessionProjection().entries) {
    for (const message of entry.messages) {
      projected.push({
        sourceEntryId: entry.sourceEntry.id,
        message,
        index: projected.length,
      });
    }
  }
  return projected;
}

function getEffectiveContent(item: ProjectedContextMessage, replacements: ContentReplacements): unknown {
  return replacements.has(item.sourceEntryId)
    ? replacements.get(item.sourceEntryId)
    : hasEditableContent(item.message) ? item.message.content : undefined;
}

function replaceContentBlocks(
  content: unknown,
  transform: (block: any) => unknown | undefined,
): { content: unknown; replacements: number } {
  if (!Array.isArray(content)) return { content, replacements: 0 };
  let replacementContent: unknown[] | undefined;
  let replacements = 0;
  for (let index = 0; index < content.length; index++) {
    const replacement = transform(content[index]);
    if (replacement === undefined) continue;
    replacementContent ??= content.slice();
    replacementContent[index] = replacement;
    replacements++;
  }
  return { content: replacementContent ?? content, replacements };
}

function appendContentEdits(sessionManager: SessionManager, replacements: ContentReplacements): number {
  for (const [sourceEntryId, content] of replacements) {
    sessionManager.appendContextEdit(sourceEntryId, { content } as never);
  }
  return replacements.size;
}

/** Remove non-model-visible tool-result metadata before compaction. Mutates the supplied messages. */
export function stripToolResultDetailsForCompaction(messages: AgentMessage[]): number {
  let strippedCount = 0;
  for (const message of messages as any[]) {
    if (message?.role !== "toolResult" || !("details" in message)) continue;
    delete message.details;
    strippedCount++;
  }
  return strippedCount;
}

/** Truncate oversized tool-result text before compaction. Mutates the supplied messages. */
export function truncateToolResultsForCompaction(messages: AgentMessage[]): number {
  let truncatedCount = 0;
  for (const message of messages as any[]) {
    if (message?.role !== "toolResult" || !Array.isArray(message.content)) continue;
    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index];
      if (
        block.type !== "text"
        || typeof block.text !== "string"
        || block.text.length <= TOOL_RESULT_TRUNCATE_THRESHOLD
      ) continue;
      const preview = block.text.slice(0, 200);
      message.content[index] = {
        type: "text" as const,
        text: `[tool result truncated for compaction — was ${block.text.length} chars]\n${preview}…`,
      };
      truncatedCount++;
    }
  }
  return truncatedCount;
}

/** Persist restored-transcript sanitation as append-only canonical SessionManager context edits. */
export function stripHeavySessionContent(
  sessionManager: SessionManager,
  logger: AgentLogger = defaultAgentLogger,
): number {
  const projected = getProjectedContextMessages(sessionManager);
  const replacements: ContentReplacements = new Map();

  for (const item of projected) {
    if (!hasEditableContent(item.message)) continue;
    const result = replaceContentBlocks(item.message.content, block => {
      if (block.type !== "image") return undefined;
      const mime = block.mimeType || block.source?.media_type || "unknown";
      logger.warning(`Stripped image (${mime}) from message ${item.index}`);
      return {
        type: "text" as const,
        text: IMAGE_STRIPPED_ON_RELOAD(mime),
      };
    });
    if (result.replacements > 0) replacements.set(item.sourceEntryId, result.content);
  }

  for (let index = projected.length - 1; index >= 0; index--) {
    const item = projected[index];
    if (!item) continue;
    const message = item.message as any;
    if (message.role !== "assistant") continue;
    if (message.stopReason !== "error") break;

    for (let tailIndex = index; tailIndex >= 0; tailIndex--) {
      const tailItem = projected[tailIndex];
      if (!tailItem) continue;
      if (tailItem.message.role === "user") break;
      if (!hasEditableContent(tailItem.message)) continue;
      const result = replaceContentBlocks(getEffectiveContent(tailItem, replacements), block => {
        if (
          block.type !== "text"
          || typeof block.text !== "string"
          || block.text.length <= LARGE_TEXT_THRESHOLD
        ) return undefined;
        const preview = block.text.slice(0, 80);
        logger.warning(`Stripped large text (${block.text.length} chars) from failed turn at message ${tailItem.index}`);
        return {
          type: "text" as const,
          text: `[large content removed from failed turn — ${block.text.length} chars, started: ${preview}…]`,
        };
      });
      if (result.replacements > 0) replacements.set(tailItem.sourceEntryId, result.content);
    }
  }

  return appendContentEdits(sessionManager, replacements);
}

/** Sanitize restored context and return the canonical messages used to seed a new Agent. */
export function prepareInitialSessionMessages(
  sessionManager: SessionManager,
  logger: AgentLogger = defaultAgentLogger,
): { messages: AgentMessage[]; restoredMessageCount: number } {
  const restoredMessages = sessionManager.buildSessionProjection().messages;
  if (restoredMessages.length === 0) {
    return { messages: restoredMessages, restoredMessageCount: 0 };
  }
  stripHeavySessionContent(sessionManager, logger);
  return {
    messages: sessionManager.buildSessionProjection().messages,
    restoredMessageCount: restoredMessages.length,
  };
}

export function stripImagesAfterPrompt(
  messages: AgentMessage[],
  reason: "prompt" | "overflow" = "prompt",
): number {
  let strippedCount = 0;
  for (const message of messages as any[]) {
    if (!Array.isArray(message.content)) continue;
    if (message.role !== "toolResult" && message.role !== "user") continue;
    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index];
      if (block.type !== "image") continue;
      const mime = block.mimeType || block.source?.media_type || "unknown";
      message.content[index] = {
        type: "text" as const,
        text: reason === "overflow" ? IMAGE_STRIPPED_OVERFLOW : IMAGE_STRIPPED_DEFAULT(mime),
      };
      strippedCount++;
    }
  }
  return strippedCount;
}

export function stripSessionImages(
  sessionManager: SessionManager,
  reason: "prompt" | "overflow" = "prompt",
): number {
  const replacements: ContentReplacements = new Map();
  let strippedCount = 0;
  for (const item of getProjectedContextMessages(sessionManager)) {
    if (!hasEditableContent(item.message)) continue;
    if (item.message.role !== "toolResult" && item.message.role !== "user") continue;
    const result = replaceContentBlocks(item.message.content, block => {
      if (block.type !== "image") return undefined;
      const mime = block.mimeType || block.source?.media_type || "unknown";
      return {
        type: "text" as const,
        text: reason === "overflow" ? IMAGE_STRIPPED_OVERFLOW : IMAGE_STRIPPED_DEFAULT(mime),
      };
    });
    if (result.replacements === 0) continue;
    strippedCount += result.replacements;
    replacements.set(item.sourceEntryId, result.content);
  }
  appendContentEdits(sessionManager, replacements);
  return strippedCount;
}

export interface ImageCohort {
  turnAdded: number;
  msgStart: number;
  msgEnd: number;
}

export interface ImageEvictionState {
  _turnCount: number;
  _lastMessageCount: number;
  _imageCohorts: ImageCohort[];
}

const IMAGE_TTL_TURNS = 4;

function takeExpiredImageCohorts(messages: AgentMessage[], state: ImageEvictionState): ImageCohort[] {
  state._turnCount++;
  let scanFrom = Math.min(state._lastMessageCount, messages.length);

  if (messages.length < state._lastMessageCount) {
    state._imageCohorts = [];
    scanFrom = 0;
  }
  state._lastMessageCount = messages.length;

  let hasNewImages = false;
  for (let index = scanFrom; index < messages.length && !hasNewImages; index++) {
    const message = messages[index] as any;
    if (!Array.isArray(message.content)) continue;
    hasNewImages = message.content.some((block: any) => block.type === "image");
  }
  if (hasNewImages) {
    state._imageCohorts.push({
      turnAdded: state._turnCount,
      msgStart: scanFrom,
      msgEnd: messages.length,
    });
  }

  const expired: ImageCohort[] = [];
  state._imageCohorts = state._imageCohorts.filter(cohort => {
    if (state._turnCount - cohort.turnAdded < IMAGE_TTL_TURNS) return true;
    expired.push(cohort);
    return false;
  });
  return expired;
}

export function evictStaleSessionImages(
  sessionManager: SessionManager,
  state: ImageEvictionState,
): number {
  const projected = getProjectedContextMessages(sessionManager);
  const messages = projected.map(item => item.message);
  const replacements: ContentReplacements = new Map();
  let totalStripped = 0;
  for (const cohort of takeExpiredImageCohorts(messages, state)) {
    const end = Math.min(cohort.msgEnd, projected.length);
    for (let index = cohort.msgStart; index < end; index++) {
      const item = projected[index];
      if (!item || !hasEditableContent(item.message)) continue;
      if (item.message.role !== "toolResult" && item.message.role !== "user") continue;
      const result = replaceContentBlocks(getEffectiveContent(item, replacements), block => {
        if (block.type !== "image") return undefined;
        const mime = block.mimeType || block.source?.media_type || "unknown";
        return { type: "text" as const, text: IMAGE_STRIPPED_DEFAULT(mime) };
      });
      if (result.replacements === 0) continue;
      replacements.set(item.sourceEntryId, result.content);
      totalStripped += result.replacements;
    }
  }
  appendContentEdits(sessionManager, replacements);
  return totalStripped;
}

export function createImageEvictionState(): ImageEvictionState {
  return { _turnCount: 0, _lastMessageCount: 0, _imageCohorts: [] };
}

export function resetImageEvictionState(
  state: ImageEvictionState,
  currentMessageCount: number,
): void {
  state._turnCount = 0;
  state._lastMessageCount = currentMessageCount;
  state._imageCohorts = [];
}
