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

A `Room` is a logical manager and ownership boundary for a group of AgentLoops through `BackgroundTaskManager` and `LoopManager`. It is not mandatory to have a Room in order to have an AgentLoop. Registering a loop transfers its lifecycle to the Room, so Room reload, reset, close, and destroy operations can act on it.

Room persistence has two modes:

```text
durable (default)
→ owns a filesystem-canonical roomDir
→ active conversation is under sessions/current
→ sibling session directories are archives
→ supports reset, archive listing, and restore

memory
→ owns no roomDir or currentDir
→ creates no Room filesystem entries
→ does not change AgentLoop persistence defaults
→ accepts durable AgentLoops with explicit loop-owned directories
→ supports reload and close, but not reset, archive, or restore
```

Durable Room reset preserves the Room object and its direct lifecycle handlers:

```text
→ before_room_reset
→ abort and settle Room background tasks
→ destroy every registered AgentLoop
→ archive sessions/current and create an empty current directory
→ room_reset_end
→ reopen the empty Room
→ optionally create a replacement primary
```

Memory Rooms reject reset without changing their state or loops. Reset events are therefore durable-only and contain `roomDir`, `currentDir`, and an archive name where applicable.

### LoopManager

A simple map to hold all loops registered with associated `Room`.

### BackgroundTaskManager

A manager for owner-scoped detached work. A Room manager owns Room-wide operations. Every AgentLoop has a separate manager for work initiated by that exact loop. Tasks default to parallel execution. A sequential task waits for all previously admitted tasks and blocks later tasks until its complete task lifecycle settles. Room close/reset destroys its loops, and each loop aborts and settles its own tasks before disposing its AgentSession.

## AgentLoop

`AgentLoop` owns a native Pi `AgentSession` and an AgentLoop-scoped `BackgroundTaskManager`. It provides runtime checks, identity, and deterministic settlement of both foreground and detached work.

It has an id, name (for display purpose) and a tag (for grouping purpose). For example, you can register an extension target specific id or specific tag so all loops belong to the same tag will be registered.

Every AgentLoop has an explicit execution `cwd` and an immutable, filesystem-canonical data `dir`. Durable persistence stores the native transcript in `<dir>/context.jsonl` after conversation begins. Memory persistence keeps the transcript entirely in Pi's in-memory SessionManager and does not create `context.jsonl`. 

### Round
A `Round` is a complete lifecycle from begin to end started by a prompt (direct prompt, resume prompt or enqueued prompt).

### Enqueued prompt
`group-before-idle-then-prompt` | `wait-idle-then-prompt`
Enqueue prompt while loop is idle will automatically prompt it. Enqueue means put the prompt in a waiting queue, and when loop `Round` finishes, it automatically pops it (FIFO) and starts next `Round`.
`group-before-idle-then-prompt` means next automatic prompt will group all enqueued `group-before-idle-then-prompt` until `wait-idle-then-prompt` or end of queue, and send them as one.
`wait-idle-then-prompt` means it will be sent as a stand-alone prompt.

## MultiAgentPi (../extensions.md)

Extensions use native `pi.on()` for Pi events and `multiAgentPi.register()` for ID/tag-targeted Pi setup. `multiAgentPi.on` also provides some framework defined events for Agent Loop. Room events are registered via `room.on()`.

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
  /** Run Pi base and framework-owned tools inline or detached. */
  readonly builtInToolExecutionMode?: "foreground" | "detached";
}
```
A tool can be registered (discovered) by extensions or via `additionalTools` (inline tools). Additional definitions that collide with Pi or framework built-ins are logged and ignored so the built-in wins; duplicate additional names are logged and preserve Pi's later-definition-wins behavior.
Built-in tools can be overridden via `baseToolOverrides`. 
`initialAdditionalActiveToolNames` activates registered `defaultActive: false` tools on creation.

Framework-owned tools and Pi base-tool overrides receive a required string `label` parameter. Its schema describes a human-friendly progress label of at most eight words that omits detailed arguments, but deliberately does not reject empty, long, or otherwise poorly formatted strings. Existing argument normalizers retain a caller-supplied label when preparing the remaining fields. Event consumers can use `isToolProgressLabel()` or `TOOL_PROGRESS_LABEL_PATTERN` before displaying a label; the built-in logger falls back to the tool name when a label does not match. Consumer-provided tools, untouched native Pi base definitions, and the raw-grammar `codemode` tool itself remain unchanged.

Built-in execution remains `foreground` when `builtInToolExecutionMode` is omitted. Without a Pi base-tool override, foreground mode leaves Pi's complete native definitions and metadata intact. Explicit foreground overrides and detached Pi base tools use Pi's `baseToolsOverride`; the framework's system-prompt builder continues to source their prompt snippets and guidelines from the complete default definitions. These plain `AgentTool` overrides intentionally use the base-tool execution contract rather than session-only `ExtensionToolContext` details. Framework-owned tools retain their complete definitions and context. Every generic detached invocation—including nested `ctx.executeTool()` and codemode calls—schedules its operation through the AgentLoop's background-task manager and immediately returns a terminating “running in the background” result. Pi then processes that acknowledgement through its normal `tool_result` hooks and `tool_execution_end` event; neither event is delayed until the operation finishes. Background tasks default to parallel execution; a sequential task waits for prior tasks and blocks later tasks in the same manager.

The background operation executes directly rather than as a nested Pi tool call. Its eventual text and images are delivered separately through the next `wait-idle-then-prompt` Round, where they enter the input pipeline and ReAct transcript as a new prompt rather than replacing the completed acknowledgement. Consequently, completion content does not become a second `tool_result` for the completed call; result hooks apply to the acknowledgement, while ordinary input hooks apply to the completion prompt. Stock `code_review` already manages its own background task, so it retains its existing acknowledgement and completion behavior rather than being wrapped again; an explicit consumer replacement uses generic detachment. Consumer-provided additional and extension tools remain responsible for their own execution policy. `stop()` and `abort()` stop the model Round rather than detached work; AgentLoop destruction aborts and settles owned background tasks. The bundled bot opts into detached built-ins by default.
