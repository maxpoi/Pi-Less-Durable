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

test("framework extensions win consumer native-path collisions", async () => {
  warnings.length = 0;
  let consumerFactoryCalls = 0;
  const { room } = await Room.create({
    id: "framework-extension-wins",
    roomDir: join(workingDir, "rooms", "framework-extension-wins"),
  });
  harness.register(room);
  await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: { cwd: process.cwd() },
    extensionSources: {
      additionalInlineExtensions: [{
        name: "multi-agent-pi-compaction-strip",
        factory() {
          consumerFactoryCalls += 1;
        },
      }],
    },
  });
  assert.equal(consumerFactoryCalls, 0);
  assert.ok(warnings.some(warning =>
    warning.includes('"<inline:multi-agent-pi-compaction-strip>"')
  ));
});

test("progress labels preserve untouched Pi definitions and skip consumer tools", async () => {
  const { room } = await Room.create({
    id: "built-in-progress-labels",
    roomDir: join(workingDir, "rooms", "built-in-progress-labels"),
  });
  harness.register(room);
  const loop = await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: {
      cwd: process.cwd(),
      toolConfig: {
        additionalTools: [{
          name: "consumer_tool",
          label: "Consumer tool",
          description: "Consumer-provided tool",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          async execute() {
            return { content: [{ type: "text", text: "done" }] };
          },
        }],
      },
    },
  });
  const tools = new Map(loop.getToolList().map(tool => [tool.name, tool]));
  loop.setActiveToolsByName([...loop.session.getActiveToolNames(), "code_review"]);
  const activeTools = new Map(loop.session.agent.state.tools.map(tool => [tool.name, tool]));

  assert.equal(activeTools.get("read")?.parameters.required.includes("label"), false);
  assert.equal(activeTools.get("code_review")?.parameters.required.includes("label"), true);
  assert.equal(activeTools.get("consumer_tool")?.parameters.properties.label, undefined);
  assert.equal(tools.get("codemode")?.parameters.properties?.label, undefined);
  assert.equal(tools.get("read")?.sourceInfo.source, "builtin");
  assert.ok(tools.get("read")?.promptGuidelines?.length > 0);
  assert.deepEqual(
    tools.get("read")?.promptGuidelines,
    loop.session.getToolDefinition("read")?.promptGuidelines,
  );
  assert.ok(activeTools.get("read")?.outputSchema);
});

test("detached built-in mode returns immediately and owns the background task", async () => {
  const { room } = await Room.create({
    id: "detached-built-ins",
    roomDir: join(workingDir, "rooms", "detached-built-ins"),
  });
  harness.register(room);
  const loop = await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: {
      cwd: process.cwd(),
      toolConfig: {
        builtInToolExecutionMode: "detached",
        baseToolOverrides: {
          read: {
            name: "read",
            label: "Read",
            description: "Wait until the detached task is aborted",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
            async execute(_toolCallId, _params, signal) {
              await new Promise((resolve, reject) => {
                if (signal?.aborted) {
                  reject(signal.reason);
                  return;
                }
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            },
          },
        },
      },
    },
  });
  const read = loop.session.agent.state.tools.find(tool => tool.name === "read");
  assert.ok(read);
  assert.equal(read.parameters.required.includes("label"), true);
  assert.equal(read.outputSchema, undefined);

  const result = await read.execute(
    "detached-call",
    { label: "Read the file", path: "README.md" },
  );
  assert.equal(result.terminate, true);
  assert.equal(loop.backgroundTasks.activeCount, 1);
  assert.equal(loop.stop(), "none");
  assert.equal(loop.backgroundTasks.activeCount, 1);

  await loop.backgroundTasks.abortAllAndWait("test complete");
  assert.equal(loop.backgroundTasks.activeCount, 0);
});

test("nested built-in calls use the same detached overrides", async () => {
  const { room } = await Room.create({
    id: "nested-built-in-detached",
    roomDir: join(workingDir, "rooms", "nested-built-in-detached"),
  });
  harness.register(room);
  const loop = await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: {
      cwd: process.cwd(),
      toolConfig: {
        builtInToolExecutionMode: "detached",
        baseToolOverrides: {
          read: {
            name: "read",
            label: "Read",
            description: "Wait until the nested detached task is aborted",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
            async execute(_toolCallId, _params, signal) {
              await new Promise((resolve, reject) => {
                if (signal?.aborted) {
                  reject(signal.reason);
                  return;
                }
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            },
          },
        },
        additionalTools: [{
          name: "nested_probe",
          label: "Nested probe",
          description: "Call read through the nested tool pipeline",
          parameters: { type: "object", properties: {} },
          async execute(_toolCallId, _params, _signal, _onUpdate, context) {
            const outcome = await context.executeTool("read", {
              label: "Read package metadata",
              path: "package.json",
            });
            return outcome.result;
          },
        }],
      },
    },
  });
  loop.session.agent.state.messages = [
    ...loop.session.agent.state.messages,
    {
      role: "assistant",
      content: [{ type: "text", text: "Run nested probe" }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ];
  const probe = loop.session.agent.state.tools.find(tool => tool.name === "nested_probe");
  assert.ok(probe);

  const result = await probe.execute("probe-call", {});
  const text = result.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("\n");
  assert.equal(result.terminate, true);
  assert.match(text, /Running read in the background/);
  assert.equal(loop.backgroundTasks.activeCount, 1);
  await loop.backgroundTasks.abortAllAndWait("test complete");
});

test("nested stock code_review retains its existing background protocol", async () => {
  const { room } = await Room.create({
    id: "nested-stock-code-review",
    roomDir: join(workingDir, "rooms", "nested-stock-code-review"),
  });
  harness.register(room);
  const loop = await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: {
      cwd: process.cwd(),
      toolConfig: {
        builtInToolExecutionMode: "detached",
        initialAdditionalActiveToolNames: ["code_review"],
        additionalTools: [{
          name: "nested_review_probe",
          label: "Nested review probe",
          description: "Call code_review through the nested tool pipeline",
          parameters: { type: "object", properties: {} },
          async execute(_toolCallId, _params, _signal, _onUpdate, context) {
            const outcome = await context.executeTool("code_review", {
              label: "Review nested code",
              summary: "Nested review",
            });
            return outcome.result;
          },
        }],
      },
    },
  });
  loop.session.agent.state.messages = [
    ...loop.session.agent.state.messages,
    {
      role: "assistant",
      content: [{ type: "text", text: "Run nested review probe" }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ];
  const probe = loop.session.agent.state.tools.find(
    tool => tool.name === "nested_review_probe",
  );
  assert.ok(probe);

  const result = await probe.execute("nested-review-probe-call", {});
  assert.equal(result.terminate, undefined);
  assert.equal(result.details.status, "success");
  assert.match(result.content[0].text, /code review agent is running in background/);
  assert.doesNotMatch(result.content[0].text, /Task ID:/);

  await loop.backgroundTasks.abortAllAndWait("test complete");
});

test("stock code_review retains its existing background protocol", async () => {
  const { room } = await Room.create({
    id: "stock-detached-code-review",
    roomDir: join(workingDir, "rooms", "stock-detached-code-review"),
  });
  harness.register(room);
  const loop = await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: {
      cwd: process.cwd(),
      toolConfig: {
        builtInToolExecutionMode: "detached",
        initialAdditionalActiveToolNames: ["code_review"],
      },
    },
  });
  const codeReview = loop.session.agent.state.tools.find(tool => tool.name === "code_review");
  assert.ok(codeReview);

  const acknowledgement = await codeReview.execute(
    "stock-review-call",
    { label: "Review the code", summary: "Verify acknowledgement" },
  );
  assert.equal(acknowledgement.terminate, undefined);
  assert.match(acknowledgement.content[0].text, /code review agent is running in background/);
  assert.doesNotMatch(acknowledgement.content[0].text, /Task ID:/);
  assert.equal(acknowledgement.details.status, "success");
  assert.equal(loop.backgroundTasks.list()[0].label, "code_review");

  const duplicate = await codeReview.execute(
    "duplicate-review-call",
    { label: "Review again", summary: "Duplicate" },
  );
  assert.match(duplicate.content[0].text, /already running/);

  await loop.backgroundTasks.abortAllAndWait("test complete");
});

test("overridden code_review uses generic detached execution", async () => {
  const { room } = await Room.create({
    id: "detached-code-review-override",
    roomDir: join(workingDir, "rooms", "detached-code-review-override"),
  });
  harness.register(room);
  const loop = await AgentLoop.create({
    room,
    agent: { id: "main", name: "Main", tag: PRIMARY_AGENT_TAG },
    config: {
      cwd: process.cwd(),
      toolConfig: {
        builtInToolExecutionMode: "detached",
        initialAdditionalActiveToolNames: ["code_review"],
        baseToolOverrides: {
          code_review: {
            name: "code_review",
            label: "Review",
            description: "Foreground replacement used to verify generic detachment",
            parameters: {
              type: "object",
              properties: { summary: { type: "string" } },
              required: ["summary"],
            },
            async execute(_toolCallId, _params, signal) {
              await new Promise((resolve, reject) => {
                if (signal?.aborted) {
                  reject(signal.reason);
                  return;
                }
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            },
          },
        },
      },
    },
  });
  const codeReview = loop.session.agent.state.tools.find(tool => tool.name === "code_review");
  assert.ok(codeReview);

  const result = await codeReview.execute(
    "detached-review-call",
    { label: "Review the code", summary: "Verify detachment" },
  );
  assert.equal(result.terminate, true);
  assert.match(result.content[0].text, /Running code_review in the background/);
  assert.equal(loop.backgroundTasks.activeCount, 1);

  await loop.backgroundTasks.abortAllAndWait("test complete");
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
    additionalExtensionFiles: [{
      name: "failed-file-targeted-source",
      path: failedFileExtension,
    }],
    additionalInlineExtensions: [
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
    additionalInlineExtensions: [{
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
