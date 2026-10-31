# Runtime Primitives

Pi-Less-Durable has one ownership chain:

```text
MultiAgentPiHarness
└── Room
    ├── BackgroundTaskManager
    └── LoopManager
        └── AgentLoop
            └── AgentSession
```


## Harness

`MultiAgentPiHarness` is the process-lifetime singleton and owner of shared in-memory configuration, the extension source catalog, and admitted Rooms.

## Room

A `Room` is a virtual concept of a manager, which manage and act as a boundary of a bunch of `Agent Loop` via `BackgroundTaskManager` and `LoopManager`. It is represented physically on device by having a `dir`, which turns it to an actual folder on device. Artifacts like `context.jsonl`, `loops` dir goes under the `Room`'s `dir`

It is not mandatory to have a `Room` in order to have an `Agent Loop`. But register a loop to a `Room` means its lifecycle is bounded by the `Room` internally so `Room` may call destroy / reload when needed.

`Room` can be reset. It means the `Room` archives all its internal runtime and refresh to a empty state.
Roughly:
```text
→ before_room_reset
→ abort and settle every background task
→ destroy every registered AgentLoop
→ archive context, prompt-queue journal, memory, metadata, usage, and child-loop artifacts
→ remove prior-session attachments, leftover loop data, and review scratch output
→ room_reset_end
→ reopen the empty Room
```

### LoopManager

A simple map to hold all loops registered with associated `Room`.

### BackgroundTaskManager

A simple manager to hold all detached tasks created within `Room`. Manage the lifecycle and completion of the tasks.

## AgentLoop

`AgentLoop` is a wrapper of native Pi `AgentSession`. Provides required runtime checks and identity.

It has an id, name (for display purpose) and a tag (for grouping purpose). For example, you can register an extension target specific id or specific tag so all loops belong to the same tag will be registered.

Every AgentLoop has an explicit execution `cwd` and an immutable, filesystem-canonical persistence `dir` containing `context.jsonl`. The persistence directory does not define tool execution cwd.

If you want to register a loop as primary loop into a room, it needs to have a PRIMARY_AGENT_TAG and same `dir` as the `Room` dir.

### Round
A `Round` is a complete lifecycle from begin to end started by a prompt (direct prompt, resume prompt or enqueued prompt).

### Enqueued prompt
`group-before-idle-then-prompt` | `wait-idle-then-prompt`
Enqueue prompt while loop is idle will automatically prompt it. Enqueue means put the prompt in a waiting queue, and when loop `Round` finishes, it automatically pops it (FIFO) and starts next `Round`.
`group-before-idle-then-prompt` means next automatic prompt will group all enqueued `group-before-idle-then-prompt` until `wait-idle-then-prompt` or end of queue, and send them as one.
`wait-idle-then-prompt` means it will be sent as a stand-alone prompt.

## MultiAgentPi (../extensions.md)

Like Pi's extension system, `pi.on()`, we have `multiAgentPi.on()`. It works just like how you write extensions inside Pi. It provides room and agent loop context on demands besides Pi's extension context. It provides MultiAgentPi framework's custom events as well.

## Source entry points

- Harness ownership and reload: `src/multi-agent-pi-harness.ts`
- Public callback and extension exports: `src/multi-agent-pi/api.ts`
- Callback context declarations and constructors: `src/multi-agent-pi/context.ts`
- Room lifecycle and forwarding: `src/room/room.ts`
- Registration and teardown ownership: `src/room/loop-manager.ts`
- Detached operation ownership: `src/room/background-task-manager.ts`
- Agent lifecycle: `src/agent/agent-loop.ts`
- Native AgentSession assembly: `src/agent/agent-session-factory.ts`
- Built-in code-review tool orchestration: `src/tools/code-review.ts`
- Code-review AgentLoop construction and prompt: `src/agent-loop-imp/code-review.ts`, `src/agent-loop-imp/code-review-prompt.ts`
- Room archival: `src/room/session-archive.ts`
