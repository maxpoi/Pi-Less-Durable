import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import {
  ModelRuntime,
  MultiAgentPiHarness,
  PRIMARY_AGENT_TAG,
  multiAgentPi,
} from "../dist/index.js";

const COMPACTION_EVENT = "session_before_compact";
const COMPACTION_STRIP_PATH = "<inline:multi-agent-pi-compaction-strip>";
const INLINE_EXTENSION_PATH = "<inline:test-inline-compaction-observer>";
const CUSTOM_EXTENSION_PATH = "<inline:test-custom-compaction-observer>";

function registerCompactionObserver(pi) {
  pi.on(COMPACTION_EVENT, () => undefined);
}

function createCompactionEvent() {
  return {
    type: COMPACTION_EVENT,
    preparation: {
      firstKeptEntryId: "first-kept-entry",
      messagesToSummarize: [{ role: "user", content: "test" }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1,
      fileOps: {
        read: new Set(),
        written: new Set(),
        edited: new Set(),
      },
      settings: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 1,
      },
    },
    branchEntries: [],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

async function captureCompactionInvocationOrder(loop) {
  const invocationOrder = [];
  const extensions = loop.session.resourceLoader.getExtensions().extensions;
  const registeredPaths = [];

  for (const extension of extensions) {
    const handlers = extension.handlers.get(COMPACTION_EVENT) ?? [];
    if (handlers.length === 0) continue;
    registeredPaths.push(extension.path);
    extension.handlers.set(
      COMPACTION_EVENT,
      handlers.map(handler => async (...args) => {
        invocationOrder.push(extension.path);
        return handler(...args);
      }),
    );
  }

  await loop.session.extensionRunner.emit(createCompactionEvent());
  return { invocationOrder, registeredPaths };
}

function assertCompactionStripRunsFirst(result, expectedConsumerPaths) {
  assert.equal(result.registeredPaths[0], COMPACTION_STRIP_PATH);
  assert.equal(result.invocationOrder[0], COMPACTION_STRIP_PATH);

  for (const [path, description] of expectedConsumerPaths) {
    assert.ok(
      result.invocationOrder.includes(path),
      `${description} handler was not invoked`,
    );
  }
}

function frameworkExtensionPath(roomId, agentId) {
  return `<inline:multi-agent-pi-framework-${roomId}-${agentId}>`;
}

test("compaction strip runs first in every factory-created loop on initialization and reload", async t => {
  const configDir = mkdtempSync(join(tmpdir(), "pld-compaction-order-"));
  const extensionFile = new URL("./fixtures/compaction-order-extension.mjs", import.meta.url);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(configDir, "auth.json"),
    modelsPath: join(configDir, "models.json"),
  });
  const inlineExtension = {
    name: "test-inline-compaction-observer",
    factory(pi) {
      registerCompactionObserver(pi);
      multiAgentPi.register({
        target: "all",
        setup: registerCompactionObserver,
      });
    },
  };
  const customExtension = {
    name: "test-custom-compaction-observer",
    factory: registerCompactionObserver,
  };
  const harness = new MultiAgentPiHarness({
    configDir,
    modelRuntime,
    extensionFiles: [fileURLToPath(extensionFile)],
    inlineExtensions: [inlineExtension],
    logger: { info() {}, warning() {} },
  });
  t.after(async () => {
    try {
      await harness.close();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  await harness.open();
  const room = harness.createRoom({ id: "compaction-order" });
  const main = await harness.createAgentLoop(
    room,
    { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    {},
    [customExtension],
  );
  room.register(main);
  const child = await harness.createAgentLoop(
    room,
    { id: "child", name: "Child", tag: "worker" },
    {},
    [customExtension],
  );
  room.register(child);

  const mainConsumers = new Map([
    [fileURLToPath(extensionFile), "extension-file"],
    [INLINE_EXTENSION_PATH, "Harness inline-extension"],
    [CUSTOM_EXTENSION_PATH, "custom AgentLoop extension"],
    [frameworkExtensionPath(room.id, main.id), "multiAgentPi.register()"],
  ]);
  const childConsumers = new Map([
    [CUSTOM_EXTENSION_PATH, "custom child AgentLoop extension"],
    [frameworkExtensionPath(room.id, child.id), "child multiAgentPi.register()"],
  ]);

  assertCompactionStripRunsFirst(
    await captureCompactionInvocationOrder(main),
    mainConsumers,
  );
  assertCompactionStripRunsFirst(
    await captureCompactionInvocationOrder(child),
    childConsumers,
  );

  await harness.reload({ roomId: room.id });

  assertCompactionStripRunsFirst(
    await captureCompactionInvocationOrder(main),
    mainConsumers,
  );
  assertCompactionStripRunsFirst(
    await captureCompactionInvocationOrder(child),
    childConsumers,
  );
});
