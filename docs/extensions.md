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

Extension collisions follow this rule:
1. file type extensions: first win
2. inline extensions: last win
3. framework built in extensions always win

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

Extension sources may observe only their current AgentLoop's completed Rounds:

```ts
export default function extension(pi: ExtensionAPI) {
  multiAgentPi.on("agent_round_end", (event, context) => {
    handleRound(context.agentId, event.result);
  });
}
```

These handlers are collected into the current AgentLoop's extension record. AgentLoop, Room, and Harness reload replace that record instead of appending handlers from repeated factory execution. Direct `loop.on("agent_round_end", handler)` registrations remain owned by the AgentLoop object.

### Extension event load flow

Every AgentLoop **ResourceLoader** owns one active extension-event record. Initial load and reload use the same prepare-then-swap flow:

```ts
// a module scoped static AsyncLocalStorage in place.

→ create empty replacement Map: `storage` = AsyncLocalStorage()
→ clear the active previous Map
→ enter `storage` with { agent, eventHandlers: replacement }
→ Pi imports the extension file and uses Jiti and executes each selected factory
→ multiAgentPi.on(...) writes into `storage`
→ Pi reload succeeds
→ active event record = replacement Map
```

```ts
const replacement = new Map();
activeEventHandlers.clear();

await extensionLoadContext.run(
  { agent: agentContext, eventHandlers: replacement },
  () => piResourceLoader.reload(),
);

activeEventHandlers = replacement;
```

Factory registration resolves through the current load context:

```text
multiAgentPi.on(event, handler)
→ registerAgentLoopExtensionEventHandler(event, handler)
→ extensionLoadContext.getStore()
→ replacement[event].add(handler)
```

Awaited asynchronous factories retain the same load context:

```ts
export default async function extension() {
  await prepare();
  multiAgentPi.on("agent_round_end", handler);
}
```

A reload clears the active old Map before loading. A successful reload installs the replacement Map. A rejected reload leaves no extension-owned framework handlers active.

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
- AgentLoop reload uses the current catalog, clears its temporary disabled-extension set, replaces extension-owned framework handlers, and invokes native `AgentSession.reload()`.

A reload can only happen if all levels below are idle. For example, a room level reload will check all its registered loops have no background tasks and all idle. A harness level reload will check all rooms. 
