import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
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

const workingDir = mkdtempSync(join(tmpdir(), "pld-extension-targeting-"));
const warnings = [];
let harness;

before(async () => {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(workingDir, "auth.json"),
    modelsPath: join(workingDir, "models.json"),
  });
  harness = new MultiAgentPiHarness({
    config: CONFIG,
    workingDir,
    modelRuntime,
    logger: {
      info() {},
      warning(message, details) {
        warnings.push(`${message}: ${details}`);
      },
    },
  });
});

after(async () => {
  try {
    await Promise.all(harness?.listRooms().map(room => room.close()) ?? []);
  } finally {
    rmSync(workingDir, { recursive: true, force: true });
  }
});

test("consumer inline extensions cannot use framework-reserved names", async () => {
  const { room } = await Room.create({
    id: "reserved-extension-name",
    roomDir: join(workingDir, "rooms", "reserved-extension-name"),
  });
  harness.register(room);
  await assert.rejects(
    AgentLoop.create({
      room,
      agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
      config: { cwd: process.cwd() },
      extensionSources: {
        inlineExtensions: [{
          name: "multi-agent-pi-compaction-strip",
          factory() {},
        }],
      },
    }),
    /Consumer inline extension name "multi-agent-pi-compaction-strip" is reserved/,
  );
});

test("failed extension sources discard their local targeted registrations", async () => {
  warnings.length = 0;
  const failedFileExtension = join(workingDir, "failed-targeted-source.mjs");
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
            target: { id: "child" },
            setup: registerCompactionObserver,
          });
        },
      },
    ],
  };
  const { room } = await Room.create({
    id: "targeted-transaction",
    roomDir: join(workingDir, "rooms", "targeted-transaction"),
  });
  harness.register(room);
  const main = await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: { cwd: process.cwd() },
    extensionSources,
  });
  const child = await AgentLoop.create({
    room,
    agent: { id: "child", name: "Child", tag: "worker" },
    config: { cwd: process.cwd() },
    extensionSources,
  });

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

test("targeted setup failure discards its native source with an exact diagnostic", async () => {
  warnings.length = 0;
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
  const { room } = await Room.create({
    id: "targeted-setup-failure",
    roomDir: join(workingDir, "rooms", "targeted-setup-failure"),
  });
  harness.register(room);
  const main = await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: { cwd: process.cwd() },
    extensionSources,
  });

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
