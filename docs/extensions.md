# Extension Architecture

## Native Pi extensions

Use direct native Pi registration for behavior shared by every loop receiving the source:

```ts
export default function extension(pi: ExtensionAPI) {
  pi.on("tool_call", handler);
  pi.registerTool(tool);
}
```

Pi-Less-Durable deliberately uses only these native Pi extension mechanisms:

- `additionalExtensionPaths` carries selected Harness file entries, loop-specific file sources, and the explicit `builtin:<name>` paths for selected inline factories marked `builtin: true`. Each AgentLoop loader keeps one stable path array and refreshes its filesystem catalog entries before native reload.
- `extensionFactories` carries framework and consumer inline extensions. Their membership is fixed for the loader lifetime, while Pi executes the factories again on reload. A selected `builtin: true` factory is paired with its explicit Pi resource path so it materializes even though automatic discovery is disabled.
- `extensionsOverride` establishes final runtime order and omits temporarily disabled extensions. Consumer source and inline setup may already have run; framework default wrappers stop before invoking their underlying setup when disabled.

The framework keeps `noExtensions: true`; Pi settings, packages, automatic user/project extension directories, and automatically enabled built-ins are not discovered. `src/multi-agent-pi/api.ts` is the central public export surface for Pi's complete extension event API, framework contexts, and MultiAgentPi callback contracts.

## Harness catalog and discovery

Harness owns one extension catalog shared by its AgentLoops. `extensionDirs` controls filesystem discovery:

- `undefined` scans `<workingDir>/extensions`.
- An empty array disables filesystem discovery.
- Otherwise, every configured root is scanned for direct `<root>/<name>/index.ts` children.

Harness construction may also provide named `additionalExtensionFiles` and named `additionalInlineExtensions`. The declared catalog name remains the file entry's public identity even when it differs from the filename, including for temporary disablement. Catalog collisions remain ordered inputs for native Pi-compatible resolution. `harness.listExtensions()` returns an immutable metadata snapshot without exposing inline factories.

Exact Harness files can be changed after construction with `addExtensionFile()` and `removeExtensionFile()`. Catalog listing changes immediately; existing AgentLoops materialize the new catalog on reload. Discovered files remain owned by their discovery roots and cannot be removed through `removeExtensionFile()`.

Each AgentLoop selects catalog entries before Pi imports files or executes factories:

- An undefined `allowedExtensions` selects the complete Harness catalog.
- An empty `allowedExtensions` selects none.
- `excludedExtensions` applies after the allowlist.

Loop-specific `additionalExtensionFiles` and `additionalInlineExtensions` are named, additive sources that are not listed in the Harness catalog and bypass catalog filtering:

```ts
extensionSources: {
  additionalExtensionFiles: [
    { name: "audit", path: "/plugins/security.ts" },
  ],
  additionalInlineExtensions: [
    { name: "metrics", factory(pi) { /* ... */ } },
  ],
}
```

Extensions resolve in this order: selected Harness catalog entries, loop-specific files, loop-specific inline entries, then framework extensions. Name collisions mirror Pi's built-in factory map: normal `Map.set()` makes the latter definition win without moving the key's original order. Inline native-path collisions also use latter-wins resolution, ensuring a framework factory cannot be displaced through its private Pi name. File-path collisions mirror Pi's resource deduplication: regular file targets use `realpathSync()` identity and the first canonical path wins. All collisions are logged without rejecting AgentLoop construction or reload; losing files are not imported and losing inline factories are not executed. File sources that are missing, inaccessible, directories, or otherwise not regular files are logged and skipped, as are malformed consumer entries without a usable name, path, or inline factory.

Pi treats an inline object with `builtin: true` as the implementation of the synthetic `builtin:<name>` resource rather than as an ordinary inline factory. Pi-Less-Durable explicitly activates that resource whenever the corresponding winning entry is selected or supplied as a loop-specific inline addition.

Each AgentLoop's ResourceLoader owns the applied native-path-to-public-name snapshot from its latest reload. Catalog mutation does not change the identity of a still-loaded source; the next reload replaces the paths and identities together. Temporary disablement resolves only through this applied snapshot, so `{ name: "audit", path: "/plugins/security.ts" }` is addressed as `audit`, never as `security`.

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

Framework sources are resolved after consumer sources, so a framework extension wins when a consumer uses the same name.

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
