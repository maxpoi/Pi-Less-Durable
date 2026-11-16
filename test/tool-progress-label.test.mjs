import assert from "node:assert/strict";
import test from "node:test";
import {
  isToolProgressLabel,
  withProgressLabel,
} from "../dist/tools/progress-label.js";

function tool(name) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    async execute() {
      return { content: [{ type: "text", text: "done" }] };
    },
  };
}

test("progress labels are required without rejecting content", () => {
  const original = tool("read");
  original.parameters.properties.label = {
    type: "string",
    enum: ["Only this"],
    minLength: 5,
    maxLength: 10,
    pattern: "^Only this$",
  };
  const wrapped = withProgressLabel(original);

  assert.notEqual(wrapped, original);
  assert.deepEqual(wrapped.parameters.required, ["path", "label"]);
  assert.deepEqual(Object.keys(wrapped.parameters.properties), ["label", "path"]);
  assert.deepEqual(
    Object.keys(wrapped.parameters.properties.label).sort(),
    ["description", "type"],
  );
});

test("progress labels survive existing argument preparation", () => {
  const original = tool("read");
  original.prepareArguments = args => ({ path: args.path });

  const wrapped = withProgressLabel(original);

  assert.deepEqual(
    wrapped.prepareArguments({ label: "Read package metadata", path: "package.json" }),
    { label: "Read package metadata", path: "package.json" },
  );
});

test("consumers can recognize recommended progress labels", () => {
  assert.equal(isToolProgressLabel("Search conversation history"), true);
  assert.equal(isToolProgressLabel("one two three four five six seven eight"), true);
  assert.equal(isToolProgressLabel(""), false);
  assert.equal(isToolProgressLabel("Search\nhistory"), false);
  assert.equal(isToolProgressLabel("Search\rhistory"), false);
  assert.equal(isToolProgressLabel("Search\thistory"), false);
  assert.equal(isToolProgressLabel("one two three four five six seven eight nine"), false);
});

test("codemode is exempt", () => {
  const codemode = tool("codemode");
  assert.equal(withProgressLabel(codemode), codemode);
});
