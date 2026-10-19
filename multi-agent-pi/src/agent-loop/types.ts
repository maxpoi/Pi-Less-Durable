import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentLoopExecutionEnv } from "../execution-environment.js";
import type { AgentLoop } from "./agent-loop.js";

export type AgentLoopState = "idle" | "running" | "paused" | "completed" | "aborted" | "destroyed";
export type AgentLoopLifecycleKind = "prompt" | "resume" | "compact" | "reload";

export interface AgentLoopRuntime {
  readonly agent: Agent;
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
}

export interface AgentLoopModelChangeOptions {
  readonly persist?: boolean;
}

export interface AgentLoopLogContext {
  readonly scopeId: string;
  readonly scopeName?: string;
  readonly tag: string;
}

export interface AgentLoopLogger {
  info(message: string, details?: string): void;
  warning(message: string, details?: string): void;
  responseStart?(context: AgentLoopLogContext): void;
  toolStart?(
    context: AgentLoopLogContext,
    toolName: string,
    label: string,
    args: Record<string, unknown>,
  ): void;
  toolError?(
    context: AgentLoopLogContext,
    toolName: string,
    durationMs: number,
    result: string,
  ): void;
  toolSuccess?(
    context: AgentLoopLogContext,
    toolName: string,
    durationMs: number,
    result: string,
  ): void;
  thinking?(context: AgentLoopLogContext, text: string): void;
  response?(context: AgentLoopLogContext, text: string): void;
}

export interface AgentLoopCompactionPolicy {
  getTriggerPoint(): number;
  shouldCompact(contextTokens: number): boolean;
}

export interface AgentLoopExecutionContext {
  readonly loopId: string;
  readonly loop: AgentLoop;
}

export interface AgentLoopTerminalError {
  readonly message: string;
}

/** Optional presentation attachment; AgentLoop knows no output implementation details. */
export interface AgentLoopOutput {
  handleEvent(event: AgentSessionEvent): Promise<void>;
  handleTerminalError(error: AgentLoopTerminalError): void;
  /** Flush admitted presentation and reject later output from the aborted lifecycle. */
  abortLifecycle(): void;
}

export interface AgentLoopUsageEntry {
  readonly source: string;
  readonly timestamp: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number;
  readonly cost: number;
  readonly costInput?: number;
  readonly costOutput?: number;
  readonly costCacheRead?: number;
  readonly costCacheWrite?: number;
  readonly turns?: number;
  readonly toolCalls?: Record<string, number>;
}

export interface AgentLoopUsageStore {
  record(entry: AgentLoopUsageEntry): void;
}

export interface AgentLoopLifecycle {
  /** Runs after reload ownership is claimed and before Pi starts native reload; failure stops reload. */
  onBeforeReloadStart?(): Promise<void> | void;
  /** Runs after native reload completes and before ownership is released; failure rejects reload. */
  onReloadEnd?(): Promise<void> | void;
  onDestroyStart?(): Promise<void> | void;
  onDestroyed?(): Promise<void> | void;
}

export interface AgentLoopResult {
  readonly turns: number;
  readonly toolCalls: number;
  readonly aborted: boolean;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cost: number;
  };
}

/** Serialized application observer invoked after core state, output, and usage handling. */
export type AgentLoopEventHook = (event: AgentSessionEvent) => void | Promise<void>;

export interface AgentLoopOptions {
  readonly id: string;
  readonly runtime: AgentLoopRuntime;
  readonly loopDir: string;
  /** Session segment of diagnostic tags; defaults to Pi's session ID. */
  readonly sessionId?: string;
  /** Initial display name replacing sessionId in diagnostic tags; update through AgentLoop.setSessionName(). */
  readonly sessionName?: string;
  /** Execution-source tag used by diagnostics, usage, and errors. Default: "loop:{id}". */
  readonly loopTag?: string;
  readonly onEvent?: AgentLoopEventHook;
  /** Optional diagnostic override; defaults to the core console logger. */
  readonly logger?: AgentLoopLogger;
  readonly compactionPolicy?: AgentLoopCompactionPolicy;
  readonly usageStore?: AgentLoopUsageStore;
  readonly lifecycleHooks?: AgentLoopLifecycle;
  /** Host-owned Pi execution environment resolved afresh for each use. */
  readonly env?: AgentLoopExecutionEnv;
}
