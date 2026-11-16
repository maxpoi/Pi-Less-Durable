# Canonical Conversation Storage

The bot conversation layer is the final destination for already-transformed conversation entries. It is independent of message-service APIs, commands, transport, agent execution, and UI event rendering.

```text
service and command adapters
          |
          | canonical entry
          v
durable conversation store
          |
          +--> recent global context
          |
          `--> Thread-linked context
```

Every entry carries final text, a participant source label, a canonical UTC timestamp and identity, one optional initial reference, and quoted-message references. Adapters supply unique opaque IDs and current or historical message timestamps; when an adapter needs to generate an ID, `createConversationEntryId()` returns eight base64url characters from six cryptographically random bytes. Storage accepts any non-empty string ID and does not enforce that generated format. The store records canonical group conversation rather than only prompts: human-to-human Thread messages and final bot messages use the same entry model.

## Durable authority

The store is designed to be instantiated once per Room, with one framework-created and framework-managed conversation JSONL file and one bounded recent queue per instance. Runtime Room lifecycle integration is not implemented yet. JSONL is the sole durable authority. Startup reads and parses the file, copies the newest 21 entries into the queue, and discards the rest. New immutable entries are written with Node's synchronous `appendFileSync()`, including the record-separating newline. Native Pi transcripts and UI events remain separate.

ID uniqueness is an adapter invariant rather than a storage registry. A parsing error indicates that the managed file is corrupt and is reported directly.

## Directed Thread membership

References point from the referencing entry to the referenced entry. A first entry, identified by no initial reference, is a Thread root. An entry belongs to every root reachable by following its initial and quoted references.

Thread reachability is computed on demand. The store reads and parses the JSONL file, builds a temporary reverse-reference map, traverses every entry reachable from the requested root, and returns the complete Thread in chronological order. The formatter later takes the newest 20 entries. The parsed history and temporary map are released after the query.

This supports late references, cycles, and entries linked to multiple Threads while avoiding the incorrect undirected behavior that would pull a root's quoted ancestors into its own Thread. Older entries remain available in the plain-text JSONL file for search.

## Context assembly

`ContextAssembler` exposes only a read-only `getContext()` operation. A recent assembler reads its Room's bounded, non-consuming queue. A Thread assembler reads linked entries from that Room's JSONL without applying the global time window. Both serialize the newest 20 entries as JSONL. If that text exceeds 800 whitespace-delimited words, the formatter keeps its final 800 words and prefixes the truncation notice.

The current prompt is external to this protocol. Callers obtain context before appending an entry that will be supplied separately as the current prompt.

## Source entry points

- `bot/conversation/conversation-entry.ts`
- `bot/conversation/durable-conversation-store.ts`
- `bot/conversation/recent-conversation-queue.ts`
- `bot/conversation/thread-context-query.ts`
- `bot/conversation/context-assembler.ts`
- `test/conversation-store.test.mjs`
