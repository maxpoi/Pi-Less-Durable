import {
  DEFAULT_CONTEXT_ENTRY_LIMIT,
  DEFAULT_CONTEXT_WORD_LIMIT,
} from "./context-policy.js";
import {
  serializeConversationEntry,
  type ConversationEntry,
} from "./conversation-entry.js";

export const CONTEXT_TRUNCATION_NOTICE =
  "[Truncated, use rg to search the conversation history for more context]";

export function formatConversationContext(
  chronologicalEntries: readonly ConversationEntry[],
  hasMoreEntries = false,
): string {
  const selected = chronologicalEntries.slice(-DEFAULT_CONTEXT_ENTRY_LIMIT);
  const context = selected.map(serializeConversationEntry).join("\n");
  const words = [...context.matchAll(/\S+/gu)];
  const exceedsWordLimit = words.length > DEFAULT_CONTEXT_WORD_LIMIT;
  const truncated = hasMoreEntries
    || selected.length < chronologicalEntries.length
    || exceedsWordLimit;

  const firstRetainedWord = exceedsWordLimit
    ? words[words.length - DEFAULT_CONTEXT_WORD_LIMIT]
    : undefined;
  const retainedContext = firstRetainedWord === undefined
    ? context
    : context.slice(firstRetainedWord.index);

  if (!truncated) return retainedContext;
  return retainedContext.length === 0
    ? CONTEXT_TRUNCATION_NOTICE
    : `${CONTEXT_TRUNCATION_NOTICE}\n${retainedContext}`;
}
