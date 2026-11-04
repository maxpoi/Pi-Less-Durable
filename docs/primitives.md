# Runtime Primitives

Pi-Less-Durable has one ownership chain:

```text
MultiAgentPiHarness
└── Room
    ├── BackgroundTaskManager
    └── LoopManager
        └── AgentLoop
            ├── BackgroundTaskManager
            └── AgentSession
```


## Harness

`MultiAgentPiHarness` is the process-lifetime singleton and owner of shared in-memory configuration, the extension source catalog, and admitted Rooms.

## Room

A `Room` is a virtual concept of a manager, which manage and act as a boundary of a bunch of `Agent Loop` via `BackgroundTaskManager` and `LoopManager`. It is represented physically on device by having a `dir`, which turns it to an actual folder on device. The active conversation and all its artifacts go under the Room's `sessions/current` dir, while every sibling folder under `sessions` appears in the session archive listing.

It is not mandatory to have a `Room` in order to have an `Agent Loop`. But register a loop to a `Room` means its lifecycle is bounded by the `Room` internally so `Room` may call destroy / reload when needed.

`Room` can be reset. It means the `Room` archives all its internal runtime and refresh to a empty state.
Roughly:
```text
→ before_room_reset
→ abort and settle every background task
→ destroy every registered AgentLoop
→ rename the complete `sessions/current` conversation directory to a sibling archive
→ create an empty `sessions/current` conversation directory
→ room_reset_end
→ reopen the empty Room
```

### LoopManager

A simple map to hold all loops registered with associated `Room`.

### BackgroundTaskManager

A manager for owner-scoped detached work. A Room manager owns Room-wide operations. Every AgentLoop has a separate manager for work initiated by that exact loop. Room close/reset destroys its loops, and each loop aborts and settles its own tasks before disposing its AgentSession.

## AgentLoop

`AgentLoop` owns a native Pi `AgentSession` and an AgentLoop-scoped `BackgroundTaskManager`. It provides runtime checks, identity, and deterministic settlement of both foreground and detached work.

It has an id, name (for display purpose) and a tag (for grouping purpose). For example, you can register an extension target specific id or specific tag so all loops belong to the same tag will be registered.

Every AgentLoop has an explicit execution `cwd` and an immutable, filesystem-canonical data `dir`. Durable persistence stores the native transcript in `<dir>/context.jsonl` after conversation begins. Memory persistence keeps the transcript entirely in Pi's in-memory SessionManager; its data directory remains available for non-transcript artifacts and does not contain a framework-created `context.jsonl`. Active loop-owned background tasks make the AgentLoop busy, block reload, and are aborted and awaited by `destroy()`.

If you want to register a loop as primary loop into a room, it needs to have a PRIMARY_AGENT_TAG and same `dir` as the Room's `sessions/current` dir.

### Round
A `Round` is a complete lifecycle from begin to end started by a prompt (direct prompt, resume prompt or enqueued prompt).

### Enqueued prompt
`group-before-idle-then-prompt` | `wait-idle-then-prompt`
Enqueue prompt while loop is idle will automatically prompt it. Enqueue means put the prompt in a waiting queue, and when loop `Round` finishes, it automatically pops it (FIFO) and starts next `Round`.
`group-before-idle-then-prompt` means next automatic prompt will group all enqueued `group-before-idle-then-prompt` until `wait-idle-then-prompt` or end of queue, and send them as one.
`wait-idle-then-prompt` means it will be sent as a stand-alone prompt.

## MultiAgentPi (../extensions.md)

Like Pi's extension system, `pi.on()`, we have `multiAgentPi.on()`. It works just like how you write extensions inside Pi. It provides room and agent loop context on demands besides Pi's extension context. It provides MultiAgentPi framework's custom events as well.

## Tools
A tool expand Agent's capability and keep it under control. A Tool can have 5 different exposure settings.
```text
direct
		•	Activated and declared to the model.
		•	Callable while active.
model-only
		•	Activated and declared to the model.
		•	Not callable by other tools.
codemode
		•	Registered and callable through nested execution.
		•	Not directly declared merely because it was allowed.
deferred
		•	Registered and callable through nested execution/search.
		•	Not directly declared merely because it was allowed.
	hidden
		•	Registered but unreachable.
		•	Never model-visible or callable.
```
A tool's admission is controlled via 
```text
export interface AgentToolConfig {
  /** Inline definitions added to the native AgentSession registry after extension tools. */
  readonly additionalTools?: readonly ToolDefinition[];
  /** Tool names activated at creation in addition to the fresh or transcript-restored active set. */
  readonly initialAdditionalActiveToolNames?: readonly string[];
  /** Native Pi allowlist. Undefined allows all names; an empty list allows none. */
  readonly allowedToolNames?: readonly string[];
  /** Native Pi denylist applied after the allowlist. */
  readonly excludedToolNames?: readonly string[];
  /** Execution overrides partitioned between Pi base tools and framework-owned tools. */
  readonly baseToolOverrides?: Readonly<Record<string, AgentTool>>;
}
```
A tool can be registered (discovered) by extensions or via `additionalTools` (inline tools). Additional definitions that collide with Pi or framework built-ins are logged and ignored so the built-in wins; duplicate additional names are logged and preserve Pi's later-definition-wins behavior.
Built-in tools can be overridden via `baseToolOverrides`. 
`initialAdditionalActiveToolNames` activates registered `defaultActive: false` tools on creation.

## Source entry points

- Harness ownership and reload: `src/multi-agent-pi-harness.ts`
- Public callback and extension exports: `src/multi-agent-pi/api.ts`
- Callback context declarations and constructors: `src/multi-agent-pi/context.ts`
- Room lifecycle and forwarding: `src/room/room.ts`
- Registration and teardown ownership: `src/room/loop-manager.ts`
- Detached operation ownership: `src/room/background-task-manager.ts`
- Agent lifecycle: `src/agent/agent-loop.ts`
- Native AgentSession assembly: `src/agent/agent-session-factory.ts`
- Agent tool assembly and overrides: `src/agent/agent-session-factory-helper/agent-tools.ts`
- Agent extension loading and runtime bindings: `src/agent/agent-session-factory-helper/agent-extensions.ts`
- Built-in code-review tool orchestration: `src/tools/code-review.ts`
- Standalone screenshot tool and capture helpers: `src/tools/screenshot.ts`, `src/tools/screenshot/`
- Computer actions: `src/tools/computer-use.ts`, `src/tools/computer-use/`
- Code-review AgentLoop construction and prompt: `src/agent-loop-imp/code-review.ts`, `src/agent-loop-imp/code-review-prompt.ts`
- Room archival: `src/room/session-archive.ts`
