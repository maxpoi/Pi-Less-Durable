import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ModelRuntime,
  MultiAgentPiHarness,
  PRIMARY_AGENT_TAG,
  multiAgentPi,
} from "../dist/index.js";

const COMPACTION_EVENT = "session_before_compact";

function registerCompactionObserver(pi) {
  pi.on(COMPACTION_EVENT, () => undefined);
}

test("consumer inline extensions cannot use framework-reserved names", async t => {
  const configDir = mkdtempSync(join(tmpdir(), "pld-reserved-extension-name-"));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(configDir, "auth.json"),
    modelsPath: join(configDir, "models.json"),
  });
  const harness = new MultiAgentPiHarness({
    configDir,
    modelRuntime,
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
  const room = harness.createRoom({ id: "reserved-extension-name" });
  await assert.rejects(
    harness.createAgentLoop(
      room,
      { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
      { cwd: process.cwd() },
      {
        inlineExtensions: [{
          name: "multi-agent-pi-compaction-strip",
          factory() {},
        }],
      },
    ),
    /Consumer inline extension name "multi-agent-pi-compaction-strip" is reserved/,
  );
});

test("failed extension sources discard their local targeted registrations", async t => {
  const configDir = mkdtempSync(join(tmpdir(), "pld-targeted-transaction-"));
  const failedFileExtension = join(configDir, "failed-targeted-source.mjs");
  writeFileSync(
    failedFileExtension,
    `import { multiAgentPi } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};\n`
      + "export default async function (pi) {\n"
      + "  await multiAgentPi.register(pi, { id: 'discard-file', target: { tag: 'worker' }, setup(targetPi) {\n"
      + `    targetPi.on(${JSON.stringify(COMPACTION_EVENT)}, () => undefined);\n`
      + "  } });\n"
      + "  throw new Error('file source initialization failed');\n"
      + "}\n",
  );
  const warnings = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(configDir, "auth.json"),
    modelsPath: join(configDir, "models.json"),
  });
  const extensionSources = {
    extensionFiles: [failedFileExtension],
    inlineExtensions: [
      {
        name: "failed-targeted-source",
        async factory(pi) {
          await multiAgentPi.register(pi, {
            id: "discard-me",
            target: { tag: "worker" },
            setup: registerCompactionObserver,
          });
          throw new Error("inline source initialization failed");
        },
      },
      {
        name: "successful-targeted-source",
        factory(pi) {
          return multiAgentPi.register(pi, {
            id: "keep-me",
            target: { roomId: "targeted-transaction", id: "child" },
            setup: registerCompactionObserver,
          });
        },
      },
    ],
  };
  const harness = new MultiAgentPiHarness({
    configDir,
    modelRuntime,
    logger: {
      info() {},
      warning(message, details) {
        warnings.push(`${message}: ${details}`);
      },
    },
  });
  t.after(async () => {
    try {
      await harness.close();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  await harness.open();
  const room = harness.createRoom({ id: "targeted-transaction" });
  const main = await harness.createAgentLoop(
    room,
    { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    { cwd: process.cwd() },
    extensionSources,
  );
  room.register(main);
  const child = await harness.createAgentLoop(
    room,
    { id: "child", name: "Child", tag: "worker" },
    { cwd: process.cwd() },
    extensionSources,
  );
  room.register(child);

  for (const loop of [main, child]) {
    const extensions = loop.session.resourceLoader.getExtensions().extensions;
    assert.equal(extensions.some(extension => extension.path === failedFileExtension), false);
    assert.equal(
      extensions.some(extension => extension.path === "<inline:failed-targeted-source>"),
      false,
    );
  }
  const mainSuccessful = main.session.resourceLoader.getExtensions().extensions.find(
    extension => extension.path === "<inline:successful-targeted-source>",
  );
  const childSuccessful = child.session.resourceLoader.getExtensions().extensions.find(
    extension => extension.path === "<inline:successful-targeted-source>",
  );
  assert.ok(mainSuccessful);
  assert.ok(childSuccessful);
  assert.equal(mainSuccessful.handlers.get(COMPACTION_EVENT)?.length ?? 0, 0);
  assert.equal(childSuccessful.handlers.get(COMPACTION_EVENT)?.length, 1);
  assert.ok(warnings.some(warning => warning.includes("file source initialization failed")));
  assert.ok(warnings.some(warning => warning.includes("inline source initialization failed")));
});

test("targeted setup failure discards its native source with an exact diagnostic", async t => {
  const configDir = mkdtempSync(join(tmpdir(), "pld-targeted-setup-failure-"));
  const warnings = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(configDir, "auth.json"),
    modelsPath: join(configDir, "models.json"),
  });
  const extensionSources = {
    inlineExtensions: [{
      name: "targeted-setup-failure",
      async factory(pi) {
        await multiAgentPi.register(pi, {
          id: "setup-before-failure",
          target: { tag: PRIMARY_AGENT_TAG },
          setup: registerCompactionObserver,
        });
        await multiAgentPi.register(pi, {
          id: "broken-targeted-setup",
          target: { tag: PRIMARY_AGENT_TAG },
          setup() {
            throw new Error("targeted setup failed");
          },
        });
      },
    }],
  };
  const harness = new MultiAgentPiHarness({
    configDir,
    modelRuntime,
    logger: {
      info() {},
      warning(message, details) {
        warnings.push(`${message}: ${details}`);
      },
    },
  });
  t.after(async () => {
    try {
      await harness.close();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  await harness.open();
  const room = harness.createRoom({ id: "targeted-setup-failure" });
  const main = await harness.createAgentLoop(
    room,
    { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    { cwd: process.cwd() },
    extensionSources,
  );
  room.register(main);

  const extensions = main.session.resourceLoader.getExtensions();
  assert.equal(
    extensions.extensions.some(
      extension => extension.path === "<inline:targeted-setup-failure>",
    ),
    false,
  );
  assert.ok(warnings.some(warning => warning.includes(
    'Targeted extension "broken-targeted-setup" failed for Room "targeted-setup-failure", AgentLoop "main": targeted setup failed',
  )));
});
