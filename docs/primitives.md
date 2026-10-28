# Runtime Primitives

Pi-Less-Durable has one ownership chain:

```text
MultiAgentPiHarness
└── Room
    └── LoopManager
        └── AgentLoop
            └── AgentSession
```


## Harness

`MultiAgentPiHarness` is the process-lifetime singleton and owner of shared in-memory configuration, the extension source catalog, and admitted Rooms.

## Room

A `Room` owns one `LoopManager`, one persistence directory, and Room lifecycle state. A `main` tagged loop can be used as primary.

Room forwarding APIs (for convience) resolve an explicit target or use the selected loop with primary fallback. Independent AgentLoops may run concurrently; Room itself does not execute prompts.

Room reset preserves the Room while terminally destroying all registered AgentLoops and archiving their settled session state:

```text
before_room_reset
→ destroy every registered AgentLoop
→ archive context, memory, metadata, usage, and child-loop artifacts
→ remove prior-session attachments and leftover loop data
→ room_reset_end
→ reopen the empty Room
```

`Room.reset()` reopens the same Room and optionally creates a primary from declarative `primaryLoop` inputs. Room supplies its root persistence directory to `AgentLoop.create()`, which resolves the process singleton Harness and uses its current shared resources.

## LoopManager

`LoopManager` owns Room-local loop registration, primary and selected identities, and in-flight destruction. It prevents duplicate IDs and prevents one AgentLoop or native AgentSession from being registered more than once.

Destroying a loop removes it from active selection before teardown begins. The same ID remains owned until destruction settles, so callers must await destruction before registering a replacement. Destroy-all settles every admitted teardown and reports collected failures after cleanup has been attempted.

## AgentLoop

`AgentLoop` is a wrapper of native Pi `AgentSession`. Provides required runtime checks and identity.

It has an id, name (for display purpose) and a tag (for groupping purpose). For example, you can register an extension target specific id or specific tag so all loops belong to the same tag will be registered.

Every AgentLoop has an explicit execution `cwd` and an immutable, filesystem-canonical persistence `dir` containing `context.jsonl`. The persistence directory does not define tool execution cwd.

## Construction and admission

Consumers create domain objects through their own factories. Harness supplies process-wide resources internally:

```ts
const { room } = await Room.create();
harness.register(room);

const loop = await AgentLoop.create({
  room,
  agent: identity,
  config,
}); // registered automatically

// Or supply the persistence directory directly and register explicitly:
const child = await AgentLoop.create({
  dir: join(room.roomDir, "loops", childIdentity.id),
  agent: childIdentity,
  config,
});
room.register(child);

// Or let standalone Room creation admit its initial primary atomically:
const { room: initializedRoom, primaryLoop } = await Room.create({
  primaryLoop: { agent: identity, config },
});
harness.register(initializedRoom);

const { primaryLoop: replacement } = await initializedRoom.reset({
  primaryLoop: { agent: identity, config },
});
```

`Room.create()` and `AgentLoop.create()` produce working domain objects. `harness.register(room)` and `room.register(loop)` transfer lifecycle ownership to their containing level.

## Reload ownership

- Harness reload refreshes the shared extension catalog and reloads its selected scope.
- Room reload orders and forwards reload to registered loops without filesystem rediscovery.
- AgentLoop reload uses the current catalog, clears its temporary disabled-extension set, and invokes native `AgentSession.reload()`.

Reload admission requires the selected scope to be idle. Transport-level queuing during Harness reload remains a host/Bridge responsibility.

## Source entry points

- Harness ownership and reload: `src/multi-agent-pi-harness.ts`
- Room lifecycle and forwarding: `src/room/room.ts`
- Registration and teardown ownership: `src/room/loop-manager.ts`
- Agent lifecycle: `src/agent/agent-loop.ts`
- Native AgentSession assembly: `src/agent/agent-session-factory.ts`
- Room archival: `src/room/session-archive.ts`
