# Extension Architecture

## Native Pi extensions

Harness owns one source catalog discovered from direct `<extensionsDir>/<name>/index.ts` children. The host must provide `workingDir`; `extensionsDir` defaults to `<workingDir>/extensions`.

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

The framework keeps `noExtensions: true`; Pi settings, packages, automatic user/project extension directories, and automatically enabled built-ins are not discovered. `src/multi-agent-pi/api.ts` is the central public export surface for Pi's complete extension event API, framework contexts, and MultiAgentPi callback contracts.

## Targeted behavior

Use `multiAgentPi.register()` when part of a source should apply only to matching agent IDs or tags:

```ts
export default async function extension(pi: ExtensionAPI) {
  pi.on("tool_call", commonHandler);

  await multiAgentPi.register(pi, {
    id: "worker-guard",
    target: { tag: "worker" },
    setup(targetPi, loopContext) {
      targetPi.on("tool_call", (event, piContext) => {
        workerHandler(event, piContext, loopContext);
      });
    },
  });
}
```

Direct Pi registration is the shared-behavior path. A direct extension that also needs its current AgentLoop identity can capture it during setup with `multiAgentPi.getContext()`. Native Pi handlers keep receiving Pi's own context; the captured framework context is available beside it.

Targeted setup matches an AgentLoop by `{ id }` or `{ tag }`. Target matching happens during each AgentSession's native Pi load transaction. A matching setup failure discards that complete source extension for that loop, while other loops load independently.

## Framework events

External consumers observe AgentLoop and Room events through the process-wide API and filter by context identity:

```ts
const unsubscribe = multiAgentPi.on("agent_round_end", (event, context) => {
  if (context.roomId !== roomId || context.agentId !== agentId) return;
  handleRound(event.result);
});
```


## Extension order

`extensionsOverride` preserves consumer relative order while placing framework behavior around the consumer block:

```text
system prompt composer
→ codemode
→ compaction strip
→ consumer extensions
→ Codex server compaction
→ system prompt finalizer
```

Inline extension names beginning with `multi-agent-pi-` are reserved for framework-owned
extensions.

## Temporary disable

Extension can be disabled by `loop.disable(name)` or `room.disable(name, loopId?)`. Without `loopId`, Room targets its selected loop and falls back to its primary loop. Other loops are unaffected. Disabled names are cumulative until that loop is reloaded. 

## Reload ownership

- Harness reload refreshes the shared extension catalog and reloads its selected scope.
- Room reload orders and forwards reload to registered loops without filesystem rediscovery.
- AgentLoop reload uses the current catalog, clears its temporary disabled-extension set, and invokes native `AgentSession.reload()`.

A reload can only happen if all levels below are idle. For example, a room level reload will check all its registered loops have no background tasks and all idle. A harness level reload will check all rooms. 


## Source entry points

- Central callback and extension type exports: `src/multi-agent-pi/api.ts`
- Callback context definitions and construction: `src/multi-agent-pi/context.ts`
- AgentSession assembly and extension ordering: `src/agent/agent-session-factory.ts`
- Reloadable explicit source materialization: `src/multi-agent-pi/extension-registry.ts`
- Runtime path resolution and extension discovery: `src/runtime-path.ts`
- Framework-owned inline extensions: `src/extensions/built-in-extensions.ts`
- Opt-in extension examples: `examples/extensions/`
- Per-AgentLoop temporary extension policy: `src/agent/agent-loop.ts`
- Agent identity binding and targeted setup: `src/multi-agent-pi/extension-registry.ts`
- Installed Pi resource-loader and dispatch contracts: `@earendil-works/pi-coding-agent`
