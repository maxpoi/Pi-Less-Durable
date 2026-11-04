import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import {
  AgentLoop,
  DEFAULT_MULTI_AGENT_PI_COMPACTION_SETTINGS,
  DEFAULT_MULTI_AGENT_PI_RETRY_SETTINGS,
  ModelRuntime,
  MultiAgentPiHarness,
  PRIMARY_AGENT_TAG,
  Room,
  multiAgentPi,
} from "../dist/index.js";

const COMPACTION_EVENT = "session_before_compact";
const COMPACTION_STRIP_PATH = "<inline:multi-agent-pi-compaction-strip>";
const INLINE_EXTENSION_PATH = "<inline:test-inline-compaction-observer>";
const CUSTOM_EXTENSION_PATH = "<inline:test-custom-compaction-observer>";
const CONFIG = {
  compaction: DEFAULT_MULTI_AGENT_PI_COMPACTION_SETTINGS,
  model: "gpt-5.6-sol",
  provider: "openai-codex",
  retry: DEFAULT_MULTI_AGENT_PI_RETRY_SETTINGS,
  thinkingLevel: "xhigh",
};

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

test("compaction strip runs first in every factory-created loop on initialization and reload", async t => {
  const workingDir = mkdtempSync(join(tmpdir(), "pld-compaction-order-"));
  const extensionFile = new URL("./fixtures/compaction-order-extension.mjs", import.meta.url);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(workingDir, "auth.json"),
    modelsPath: join(workingDir, "models.json"),
  });
  const inlineExtension = {
    name: "test-inline-compaction-observer",
    factory(pi) {
      registerCompactionObserver(pi);
      return multiAgentPi.register(pi, {
        id: "worker-compaction-observer",
        target: { tag: "worker" },
        setup: registerCompactionObserver,
      });
    },
  };
  const customExtension = {
    name: "test-custom-compaction-observer",
    factory: registerCompactionObserver,
  };
  const extensionSources = {
    additionalExtensionFiles: [{
      name: "test-file-compaction-observer",
      path: fileURLToPath(extensionFile),
    }],
    additionalInlineExtensions: [inlineExtension, customExtension],
  };
  const harness = new MultiAgentPiHarness({
    config: CONFIG,
    workingDir,
    modelRuntime,
    logger: { info() {}, warning() {} },
  });
  t.after(async () => {
    try {
      await Promise.all(harness.listRooms().map(room => room.close()));
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
  const { room } = await Room.create({
    id: "compaction-order",
    roomDir: join(workingDir, "rooms", "compaction-order"),
  });
  harness.register(room);
  const main = await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: { cwd: process.cwd() },
    extensionSources,
  });
  const child = await AgentLoop.create({
    dir: join(room.currentDir, "loops", "child"),
    agent: { id: "child", name: "Child", tag: "worker" },
    config: { cwd: process.cwd() },
    extensionSources,
  });
  room.register(child);

  const consumers = new Map([
    [fileURLToPath(extensionFile), "extension-file"],
    [INLINE_EXTENSION_PATH, "Harness inline-extension"],
    [CUSTOM_EXTENSION_PATH, "custom AgentLoop extension"],
  ]);

  const initialMain = await captureCompactionInvocationOrder(main);
  const initialChild = await captureCompactionInvocationOrder(child);
  assertCompactionStripRunsFirst(initialMain, consumers);
  assertCompactionStripRunsFirst(initialChild, consumers);
  assert.equal(initialMain.invocationOrder.filter(path => path === INLINE_EXTENSION_PATH).length, 1);
  assert.equal(initialChild.invocationOrder.filter(path => path === INLINE_EXTENSION_PATH).length, 2);

  await harness.reload({ roomId: room.id });

  const reloadedMain = await captureCompactionInvocationOrder(main);
  const reloadedChild = await captureCompactionInvocationOrder(child);
  assertCompactionStripRunsFirst(reloadedMain, consumers);
  assertCompactionStripRunsFirst(reloadedChild, consumers);
  assert.equal(reloadedMain.invocationOrder.filter(path => path === INLINE_EXTENSION_PATH).length, 1);
  assert.equal(reloadedChild.invocationOrder.filter(path => path === INLINE_EXTENSION_PATH).length, 2);
});
