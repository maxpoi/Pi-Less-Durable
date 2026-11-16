import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundTaskManager } from "../dist/index.js";
import { detachToolDefinition } from "../dist/tools/detached-built-in-tool.js";

function deferred() {
  let resolvePromise;
  let settled = false;
  const promise = new Promise(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      settled = true;
      resolvePromise(value);
    },
    get settled() {
      return settled;
    },
  };
}

function logger() {
  return { info() {}, warning() {} };
}

function agentTool(execute) {
  return {
    name: "read",
    label: "Read",
    description: "Read something",
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        path: { type: "string" },
      },
      required: ["label", "path"],
    },
    execute,
  };
}

function detachedOptions(backgroundTasks, queued) {
  return {
    backgroundTasks,
    getInitiatingLoop: () => ({
      enqueuePrompt(...args) {
        queued.push(args);
      },
    }),
  };
}

test("detached tools acknowledge immediately and queue eventual results", async () => {
  const eventualResult = deferred();
  const queued = [];
  const backgroundTasks = new BackgroundTaskManager({
    agentId: "detached-test",
    logger: logger(),
  });
  const wrapped = detachToolDefinition(
    agentTool(async () => eventualResult.promise),
    detachedOptions(backgroundTasks, queued),
  );

  const immediate = await wrapped.execute(
    "call-1",
    { label: "Read the file", path: "README.md" },
  );
  assert.equal(immediate.terminate, true);
  assert.equal(wrapped.outputSchema, undefined);
  assert.match(immediate.content[0].text, /Running read in the background/);
  assert.equal(backgroundTasks.activeCount, 1);
  assert.equal(queued.length, 0);

  eventualResult.resolve({
    content: [
      { type: "text", text: "file contents" },
      { type: "image", data: "aA==", mimeType: "image/png" },
    ],
    details: undefined,
    structuredContent: { value: "file contents" },
  });
  await backgroundTasks.list()[0].done;

  assert.equal(backgroundTasks.activeCount, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0], "wait-idle-then-prompt");
  assert.match(queued[0][1], /Status: succeeded/);
  assert.match(queued[0][1], /file contents/);
  assert.equal(queued[0][2][0].mimeType, "image/png");
});

test("detached tool failures are delivered through the prompt queue", async () => {
  const queued = [];
  const backgroundTasks = new BackgroundTaskManager({
    agentId: "detached-error-test",
    logger: logger(),
  });
  const wrapped = detachToolDefinition(
    agentTool(async () => {
      throw new Error("read failed");
    }),
    detachedOptions(backgroundTasks, queued),
  );

  const immediate = await wrapped.execute(
    "call-error",
    { label: "Read the file", path: "missing.md" },
  );
  assert.equal(immediate.terminate, true);
  await backgroundTasks.list()[0].done;

  assert.equal(queued.length, 1);
  assert.match(queued[0][1], /Status: failed/);
  assert.match(queued[0][1], /read failed/);
});

test("framework tool work runs directly rather than as a nested Pi call", async () => {
  const queued = [];
  const backgroundTasks = new BackgroundTaskManager({
    agentId: "detached-definition-test",
    logger: logger(),
  });
  let executions = 0;
  let receivedContext;
  const wrapped = detachToolDefinition(
    {
      ...agentTool(),
      async execute(_toolCallId, _params, _signal, _onUpdate, context) {
        executions += 1;
        receivedContext = context;
        return {
          content: [{ type: "text", text: "definition result" }],
          details: undefined,
        };
      },
    },
    detachedOptions(backgroundTasks, queued),
  );
  const context = {
    executeTool() {
      throw new Error("nested execution must not be used");
    },
  };

  const immediate = await wrapped.execute(
    "definition-call",
    { label: "Run framework tool", path: "README.md" },
    undefined,
    undefined,
    context,
  );
  assert.equal(immediate.terminate, true);
  await backgroundTasks.list()[0].done;

  assert.equal(executions, 1);
  assert.equal(receivedContext, context);
  assert.equal(queued.length, 1);
  assert.match(queued[0][1], /definition result/);
});

test("sequential detached tools serialize their underlying operations", async () => {
  const firstGate = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const queued = [];
  const backgroundTasks = new BackgroundTaskManager({
    agentId: "detached-sequential-test",
    logger: logger(),
  });
  const options = detachedOptions(backgroundTasks, queued);
  const first = detachToolDefinition({
    ...agentTool(),
    name: "first",
    executionMode: "sequential",
    async execute() {
      firstStarted.resolve();
      await firstGate.promise;
      return { content: [{ type: "text", text: "first result" }] };
    },
  }, options);
  const second = detachToolDefinition({
    ...agentTool(),
    name: "second",
    executionMode: "sequential",
    async execute() {
      secondStarted.resolve();
      return { content: [{ type: "text", text: "second result" }] };
    },
  }, options);

  await first.execute("first-call", { label: "Run first", path: "first" });
  await second.execute("second-call", { label: "Run second", path: "second" });
  await firstStarted.promise;
  assert.equal(secondStarted.settled, false);

  firstGate.resolve();
  await secondStarted.promise;
  await Promise.all(backgroundTasks.list().map(task => task.done));
  assert.equal(queued.length, 2);
});

test("background task manager enforces sequential barriers between parallel work", async () => {
  const firstGate = deferred();
  const sequentialGate = deferred();
  const firstStarted = deferred();
  const sequentialStarted = deferred();
  const laterStarted = deferred();
  const backgroundTasks = new BackgroundTaskManager({
    agentId: "background-execution-mode-test",
    logger: logger(),
  });

  const first = backgroundTasks.start({
    label: "first parallel",
    async run() {
      firstStarted.resolve();
      await firstGate.promise;
    },
  });
  const sequential = backgroundTasks.start({
    label: "sequential barrier",
    executionMode: "sequential",
    async run() {
      sequentialStarted.resolve();
      await sequentialGate.promise;
    },
  });
  const later = backgroundTasks.start({
    label: "later parallel",
    async run() {
      laterStarted.resolve();
    },
  });

  await firstStarted.promise;
  assert.equal(sequentialStarted.settled, false);
  assert.equal(laterStarted.settled, false);

  firstGate.resolve();
  await sequentialStarted.promise;
  assert.equal(laterStarted.settled, false);

  sequentialGate.resolve();
  await laterStarted.promise;
  await Promise.all([first.done, sequential.done, later.done]);
});
