# Extension Architecture

## Native Pi extensions

Harness discovers native Pi extension sources from direct `<configDir>/extensions/<name>/index.ts` children when it opens. The default config root is `~/.multiagentpi/config`. Use direct native Pi registration for behavior shared by every loop receiving the source:

```ts
export default function extension(pi: ExtensionAPI) {
  pi.on("tool_call", handler);
  pi.registerTool(tool);
}
```

Pass additional sources to each `createAgentLoop()` call that should receive them. Each loop gets independent native extension registrations and runtime state.

## Targeted behavior

Use `multiAgentPi.register()` when part of a source should apply only to matching agent IDs or tags:

```ts
export default async function extension(pi: ExtensionAPI) {
  pi.on("tool_call", commonHandler);

  await multiAgentPi.register(pi, {
    id: "worker-guard",
    target: { tag: "worker" },
    setup(targetPi) {
      targetPi.on("tool_call", workerHandler);
    },
  });
}
```

Direct Pi registration is the shared-behavior path. `{ id }` matches that Room-local ID independently in every Room, while `{ roomId, id }` identifies one exact Room agent. Async targeted setup must be awaited or returned by the source factory.

Target matching happens during each AgentSession's native Pi load transaction. A matching setup failure discards that complete source extension for that loop, while other loops load independently.

## Extension order

`extensionsOverride` preserves consumer relative order while placing framework behavior around the consumer block:

```text
codemode
→ compaction strip
→ consumer extensions
→ Codex server compaction
```

Inline extension names beginning with `multi-agent-pi-` are reserved for framework-owned extensions.

## Reload scope

`harness.reload()` reloads every Room. `harness.reload({ roomId })` reloads one Room, and adding `agentId` reloads one AgentLoop. Room reload keeps primary-before-child ordering. The config extension catalog is captured when Harness opens.

## Source entry points

- AgentSession assembly and extension ordering: `src/agent/agent-session-factory.ts`
- Config extension discovery: `src/extensions/utils.ts`
- Framework-owned inline extensions: `src/extensions/built-in-extensions.ts`
- Agent identity binding and targeted setup: `src/extensions/multi-agent-pi-extension-registry.ts`
- Installed Pi resource-loader and dispatch contracts: `@earendil-works/pi-coding-agent`
