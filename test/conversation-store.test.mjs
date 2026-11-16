import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONTEXT_TRUNCATION_NOTICE,
  createConversationEntryId,
  DurableConversationStore,
  RecentConversationContextAssembler,
  ThreadConversationContextAssembler,
} from "../bot/dist/conversation/index.js";

function entryId(number) {
  return `entry-${number}`;
}

function entry(number, overrides = {}) {
  return {
    id: entryId(number),
    timestamp: "2026-11-10T12:00:00.000Z",
    source: "user_x",
    content: `entry ${number}`,
    initial: null,
    quotedMessages: [],
    ...overrides,
  };
}

async function createTestStore(t, name) {
  const directory = await mkdtemp(join(tmpdir(), `pld-conversation-${name}-`));
  const path = join(directory, "conversation.jsonl");
  const store = await DurableConversationStore.open(path);
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, path, store };
}

function contextEntries(context) {
  return context
    .split("\n")
    .filter(line => line.startsWith("{"))
    .map(line => JSON.parse(line));
}

async function threadEntryIds(store, rootId) {
  const entries = await store.getThreadEntries(rootId);
  return entries.map(item => item.id);
}

test("durable conversation entries preserve canonical metadata with bounded replay", async t => {
  const { path, store } = await createTestStore(t, "persistence");
  const quotedMessages = [];
  const original = entry(1, {
    source: "you",
    content: "final canonical response",
    quotedMessages,
  });

  const append = store.append(original);
  quotedMessages.push(entryId(99));
  await append;

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), entry(1, {
    source: "you",
    content: "final canonical response",
  }));
  assert.equal(store.cachedEntryCount, 1);

  await store.close();
  const reopened = await DurableConversationStore.open(path);
  try {
    assert.equal(reopened.cachedEntryCount, 1);
  } finally {
    await reopened.close();
  }

  const firstGeneratedId = createConversationEntryId();
  const secondGeneratedId = createConversationEntryId();
  assert.equal(firstGeneratedId.length, 8);
  assert.equal(secondGeneratedId.length, 8);
  assert.notEqual(firstGeneratedId, secondGeneratedId);
});

test("entry IDs and timestamps enforce only their canonical invariants", async t => {
  const { store } = await createTestStore(t, "timestamps");

  await assert.rejects(
    store.append(entry(30, { timestamp: "2026-11-10T12:00:00" })),
    /canonical UTC ISO format/,
  );
  await assert.rejects(
    store.append(entry(31, { timestamp: "2026-11-10T12:00:00+08:00" })),
    /canonical UTC ISO format/,
  );
  await assert.rejects(
    store.append(entry(32, { timestamp: "2026-02-30T12:00:00.000Z" })),
    /canonical UTC ISO format/,
  );
  await assert.rejects(
    store.append(entry(33, { id: "" })),
    /id must be a non-empty string/,
  );
});

test("directed links place cross-linked entries in every reachable Thread", async t => {
  const { path, store } = await createTestStore(t, "links");
  const q = entry(1, { timestamp: "2026-11-10T12:00:00.000Z", content: "Q" });
  const r = entry(2, {
    timestamp: "2026-11-10T12:00:01.000Z",
    content: "R quotes Q",
    quotedMessages: [q.id],
  });
  const a = entry(3, {
    timestamp: "2026-11-10T12:00:02.000Z",
    content: "A replies to R",
    initial: r.id,
  });
  const b = entry(4, {
    timestamp: "2026-11-10T12:00:03.000Z",
    content: "B quotes A",
    initial: r.id,
    quotedMessages: [a.id],
  });
  const x = entry(5, { timestamp: "2026-11-10T12:00:04.000Z", content: "X" });
  const c = entry(6, {
    timestamp: "2026-11-10T12:00:05.000Z",
    content: "C links X and B",
    initial: x.id,
    quotedMessages: [b.id],
  });
  const d = entry(7, {
    timestamp: "2026-11-10T12:00:06.000Z",
    content: "D follows C",
    initial: c.id,
  });

  for (const item of [q, r, a, b, x, c, d]) await store.append(item);

  assert.deepEqual(
    await threadEntryIds(store, r.id),
    [r.id, a.id, b.id, c.id, d.id],
  );
  assert.deepEqual(
    await threadEntryIds(store, q.id),
    [q.id, r.id, a.id, b.id, c.id, d.id],
  );
  assert.deepEqual(
    await threadEntryIds(store, x.id),
    [x.id, c.id, d.id],
  );

  await store.close();
  const reopened = await DurableConversationStore.open(path);
  try {
    assert.deepEqual(
      await threadEntryIds(reopened, r.id),
      [r.id, a.id, b.id, c.id, d.id],
    );
  } finally {
    await reopened.close();
  }
});

test("on-demand traversal resolves references that arrived before their root", async t => {
  const { store } = await createTestStore(t, "late-root");
  const root = entry(10, { timestamp: "2026-11-10T12:00:00.000Z" });
  const child = entry(11, {
    timestamp: "2026-11-10T12:00:01.000Z",
    initial: root.id,
  });
  const descendant = entry(12, {
    timestamp: "2026-11-10T12:00:02.000Z",
    initial: child.id,
  });

  await store.append(child);
  await store.append(descendant);
  assert.deepEqual(await threadEntryIds(store, root.id), []);

  await store.append(root);
  assert.deepEqual(
    await threadEntryIds(store, root.id),
    [root.id, child.id, descendant.id],
  );
});

test("on-demand Thread traversal terminates across directed cycles", async t => {
  const { store } = await createTestStore(t, "cycles");
  const root = entry(20, { timestamp: "2026-11-10T12:00:00.000Z" });
  const first = entry(21, {
    timestamp: "2026-11-10T12:00:01.000Z",
    initial: entryId(22),
    quotedMessages: [root.id],
  });
  const second = entry(22, {
    timestamp: "2026-11-10T12:00:02.000Z",
    initial: first.id,
  });

  await store.append(root);
  await store.append(first);
  await store.append(second);
  assert.deepEqual(
    await threadEntryIds(store, root.id),
    [root.id, first.id, second.id],
  );
});

test("recent and Thread assemblers apply their distinct scopes and shared limits", async t => {
  const { store } = await createTestStore(t, "assemblers");
  const nowMs = Date.now();
  await store.append(entry(50, {
    timestamp: new Date(nowMs - 6 * 60 * 1_000).toISOString(),
    content: "outside recent window",
  }));
  for (let index = 0; index < 22; index += 1) {
    await store.append(entry(100 + index, {
      timestamp: new Date(nowMs - 2 * 60 * 1_000 + index * 1_000).toISOString(),
      source: index % 2 === 0 ? "user_x" : "you",
    }));
  }

  const recent = new RecentConversationContextAssembler(store);
  const recentContext = await recent.getContext();
  const recentEntries = contextEntries(recentContext);
  assert.ok(recentContext.startsWith(CONTEXT_TRUNCATION_NOTICE));
  assert.equal(recentEntries.length, 20);
  assert.equal(recentEntries[0].id, entryId(102));
  assert.equal(recentEntries.at(-1).id, entryId(121));
  assert.ok(recentEntries.every(item => item.id !== entryId(50)));
  assert.equal(recentEntries[1].source, "you");
  assert.ok(recentEntries.every(item => "initial" in item && "quotedMessages" in item));
  assert.equal(store.cachedEntryCount, 21);

  const oldRoot = entry(200, {
    timestamp: "2026-11-01T12:00:00.000Z",
    content: "old Thread root",
  });
  const oldChild = entry(201, {
    timestamp: "2026-11-02T12:00:00.000Z",
    content: "old Thread child",
    initial: oldRoot.id,
  });
  await store.append(oldRoot);
  await store.append(oldChild);

  const thread = new ThreadConversationContextAssembler(store, oldRoot.id);
  assert.deepEqual(
    contextEntries(await thread.getContext()).map(item => item.id),
    [oldRoot.id, oldChild.id],
  );
});

test("Thread context selects the newest 20 linked entries", async t => {
  const { store } = await createTestStore(t, "thread-entry-limit");
  const root = entry(700, {
    timestamp: "2026-11-10T12:00:00.000Z",
  });
  await store.append(root);

  const children = [];
  for (let index = 1; index <= 22; index += 1) {
    const child = entry(700 + index, {
      timestamp: `2026-11-10T12:00:${String(index).padStart(2, "0")}.000Z`,
      initial: root.id,
    });
    children.push(child);
    await store.append(child);
  }

  assert.deepEqual(
    await threadEntryIds(store, root.id),
    [root, ...children].map(item => item.id),
  );

  const context = await new ThreadConversationContextAssembler(store, root.id).getContext();
  assert.ok(context.startsWith(CONTEXT_TRUNCATION_NOTICE));
  assert.deepEqual(
    contextEntries(context).map(item => item.id),
    children.slice(-20).map(item => item.id),
  );
});

test("recent context marks entries omitted only by the five-minute window", async t => {
  const { store } = await createTestStore(t, "recent-window-marker");
  const nowMs = Date.now();
  await store.append(entry(250, {
    timestamp: new Date(nowMs - 6 * 60 * 1_000).toISOString(),
    content: "older durable history",
  }));

  const recent = new RecentConversationContextAssembler(store);
  assert.equal(await recent.getContext(), CONTEXT_TRUNCATION_NOTICE);

  const visible = entry(251, {
    timestamp: new Date(nowMs - 60 * 1_000).toISOString(),
    content: "visible recent history",
  });
  await store.append(visible);
  const context = await recent.getContext();
  assert.ok(context.startsWith(CONTEXT_TRUNCATION_NOTICE));
  assert.deepEqual(contextEntries(context).map(item => item.id), [visible.id]);
});

test("word truncation keeps the newest 800 words", async t => {
  const { store } = await createTestStore(t, "word-limit");
  const root = entry(300, {
    timestamp: "2026-11-10T12:00:00.000Z",
    content: Array.from({ length: 1_000 }, (_, index) => `word${index}`).join(" "),
  });
  await store.append(root);

  const context = await new ThreadConversationContextAssembler(store, root.id).getContext();
  const retainedContext = context.slice(CONTEXT_TRUNCATION_NOTICE.length + 1);
  assert.ok(context.startsWith(`${CONTEXT_TRUNCATION_NOTICE}\n`));
  assert.equal(retainedContext.match(/\S+/gu)?.length, 800);
  assert.ok(retainedContext.startsWith("word200 "));
  assert.ok(retainedContext.includes("word999"));
});

test("synchronous appends persist in order and malformed entries fail reopening", async t => {
  const { directory, path, store } = await createTestStore(t, "serialization");
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.append(entry(500 + index, {
    timestamp: `2026-11-10T12:00:${String(index).padStart(2, "0")}.000Z`,
  }))));
  assert.equal(store.cachedEntryCount, 21);
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 30);

  await store.close();
  const reopenedStore = await DurableConversationStore.open(path);
  try {
    assert.equal(reopenedStore.cachedEntryCount, 21);
  } finally {
    await reopenedStore.close();
  }

  const malformedPath = join(directory, "malformed.jsonl");
  await writeFile(malformedPath, "{not-json}\n", "utf8");
  await assert.rejects(
    DurableConversationStore.open(malformedPath),
    /Invalid conversation log JSON/,
  );
});
