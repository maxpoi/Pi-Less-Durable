import type {
  ConversationEntry,
  ConversationEntryId,
} from "./conversation-entry.js";

export function queryThreadEntries(
  entries: readonly ConversationEntry[],
  rootId: ConversationEntryId,
): readonly ConversationEntry[] {
  const root = entries.find(entry => entry.id === rootId);
  if (root === undefined || root.initial !== null) return [];

  const referrersById = new Map<ConversationEntryId, Set<ConversationEntryId>>();
  for (const entry of entries) {
    const references = new Set<ConversationEntryId>();
    if (entry.initial !== null) references.add(entry.initial);
    for (const quoted of entry.quotedMessages) references.add(quoted);

    for (const reference of references) {
      let referrers = referrersById.get(reference);
      if (referrers === undefined) {
        referrers = new Set();
        referrersById.set(reference, referrers);
      }
      referrers.add(entry.id);
    }
  }

  const members = new Set<ConversationEntryId>([rootId]);
  const pending: ConversationEntryId[] = [rootId];
  for (const current of pending) {
    for (const referrer of referrersById.get(current) ?? []) {
      if (members.has(referrer)) continue;
      members.add(referrer);
      pending.push(referrer);
    }
  }

  return entries
    .map((entry, ordinal) => ({ entry, ordinal }))
    .filter(({ entry }) => members.has(entry.id))
    .sort((left, right) => Date.parse(left.entry.timestamp) - Date.parse(right.entry.timestamp)
      || left.ordinal - right.ordinal)
    .map(({ entry }) => entry);
}
