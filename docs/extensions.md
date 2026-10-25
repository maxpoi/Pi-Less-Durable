# Extension Architecture

## Purpose of `extensionsOverride`

Pi-Less-Durable uses `extensionsOverride` to place its built-in extensions in a deterministic runtime order relative to the otherwise opaque consumer-extension block.

Consumer extensions remain opaque to the framework. Their existing relative order is retained when Pi-Less-Durable places the consumer block between framework-owned boundaries. Inline extension names beginning with `multi-agent-pi-` are reserved for framework-owned extensions.

## Targeted declarations

Extension sources declare behavior for matching Room agents through the current Pi API:

```ts
multiAgentPi.register(pi, {
  id: "my-feature",
  target: "all",
  setup,
});
```

The declaration is backed by `pi.events.on()`, so Pi discards it when its source factory throws or rejects. Matching declarations materialize as one framework extension; targeted setup is all-or-nothing for that AgentLoop, with the failing registration ID in Pi's extension diagnostic.


## Source entry points

- AgentSession assembly and `extensionsOverride`: `src/agent/agent-session-factory.ts`
- Framework-owned inline extensions: `src/extensions/built-in-extensions.ts`
- Room-scoped extension materialization: `src/extensions/multi-agent-pi-extension-registry.ts`
- Installed Pi resource-loader and dispatch contracts: `@earendil-works/pi-coding-agent`
