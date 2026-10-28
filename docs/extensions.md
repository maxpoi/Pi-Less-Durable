# Extension Architecture

## Native Pi extensions

Harness owns one source catalog discovered from direct `<extensionsDir>/<name>/index.ts` children. extensionsDir` defaults to `<workingDir>/extensions`, which is `~/.multiagentpi/extensions` when neither path is customized.

Use direct native Pi registration for behavior shared by every loop receiving the source:

```ts
export default function extension(pi: ExtensionAPI) {
  pi.on("tool_call", handler);
  pi.registerTool(tool);
}
```

Pi-Less-Durable deliberately uses only these native Pi extension mechanisms:

- `additionalExtensionPaths` carries the current Harness catalog followed by loop-specific file sources. Each AgentLoop loader keeps one stable path array and refreshes its contents before native reload.
- `extensionFactories` carries framework and consumer inline extensions. Their membership is fixed for the loader lifetime, while Pi executes the factories again on reload.
- `extensionsOverride` establishes final runtime order and omits temporarily disabled extensions. Consumer source and inline setup may already have run; framework default wrappers stop before invoking their underlying setup when disabled.

The framework keeps `noExtensions: true`; Pi settings, packages, automatic user/project extension directories, and automatically enabled built-ins are not discovered.

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

Direct Pi registration is the shared-behavior path. Targeted setup matches an AgentLoop by `{ id }` or `{ tag }`;

Target matching happens during each AgentSession's native Pi load transaction. A matching setup failure discards that complete source extension for that loop, while other loops load independently.

## Extension order

`extensionsOverride` preserves consumer relative order while placing framework behavior around the consumer block:

```text
codemode
→ compaction strip
→ framework guards and diagnostics
→ consumer extensions
→ Codex server compaction
```

Inline extension names beginning with `multi-agent-pi-` are reserved for framework-owned
extensions.

## Temporary disable

Extension can be disabled by `loop.disable(name)` or `room.disable(name, loopId?)`. Without `loopId`, Room targets its selected loop and falls back to its primary loop. Other loops are unaffected. Disabled names are cumulative until that loop is reloaded.

## Reload scope

`harness.reload()` refreshes the Harness source catalog and reloads every Room.
`harness.reload({ roomId })` refreshes the same Harness catalog and reloads one Room, and adding
`agentId` reloads one AgentLoop. Room reload keeps primary-before-child ordering. Direct Room or
AgentLoop reload uses the current Harness catalog without rediscovering it; its loop-level purpose is
to rebuild native state and re-enable temporarily disabled extensions.

## Source entry points

- AgentSession assembly and extension ordering: `src/agent/agent-session-factory.ts`
- Reloadable explicit source materialization: `src/extensions/multi-agent-pi-extension-registry.ts`
- Runtime path resolution and extension discovery: `src/runtime-path.ts`
- Framework-owned inline extensions: `src/extensions/built-in-extensions.ts`
- Per-AgentLoop temporary extension policy: `src/agent/agent-loop.ts`
- Agent identity binding and targeted setup: `src/extensions/multi-agent-pi-extension-registry.ts`
- Installed Pi resource-loader and dispatch contracts: `@earendil-works/pi-coding-agent`
