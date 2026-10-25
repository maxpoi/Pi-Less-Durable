import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface PendingToolExecution {
  readonly toolName: string;
  readonly args: unknown;
  readonly startTime: number;
}

export interface AgentEventAccounting {
  readonly toolDurationMs?: number;
  readonly toolCalls?: Readonly<Record<string, number>>;
}

export interface AgentRunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Mutable accounting for one admitted native AgentSession prompt. */
export interface AgentRunState {
  turnCount: number;
  toolCount: number;
  pendingTools: Map<string, PendingToolExecution>;
  toolCallsMap: Map<string, number>;
  usage: AgentRunUsage;
  lastError: string | undefined;
  stopReason: string;
  contextTokens: number;
  apiModel: string;
  apiProvider: string;
}

export function createAgentRunState(): AgentRunState {
  return {
    turnCount: 0,
    toolCount: 0,
    pendingTools: new Map(),
    toolCallsMap: new Map(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    lastError: undefined,
    stopReason: "stop",
    contextTokens: 0,
    apiModel: "",
    apiProvider: "",
  };
}

export function accountAgentEvent(
  event: AgentSessionEvent,
  state: AgentRunState,
): AgentEventAccounting {
  if (event.type === "turn_start") {
    state.turnCount++;
    return {};
  }
  if (event.type === "tool_execution_start") {
    state.toolCount++;
    state.toolCallsMap.set(event.toolName, (state.toolCallsMap.get(event.toolName) ?? 0) + 1);
    state.pendingTools.set(event.toolCallId, {
      toolName: event.toolName,
      args: event.args,
      startTime: Date.now(),
    });
    return {};
  }
  if (event.type === "tool_execution_end") {
    const pendingTool = state.pendingTools.get(event.toolCallId);
    state.pendingTools.delete(event.toolCallId);
    return {
      toolDurationMs: pendingTool ? Date.now() - pendingTool.startTime : 0,
    };
  }
  if (event.type !== "message_end") return {};

  const message = event.message as any;
  if (message.role !== "assistant") return {};
  if (message.model) state.apiModel = message.model;
  if (message.provider) state.apiProvider = message.provider;
  let toolCalls: Readonly<Record<string, number>> | undefined;
  if (message.usage) {
    state.contextTokens = message.usage.input + message.usage.output
      + message.usage.cacheRead + message.usage.cacheWrite;
    state.usage.input += message.usage.input || 0;
    state.usage.output += message.usage.output || 0;
    state.usage.cacheRead += message.usage.cacheRead || 0;
    state.usage.cacheWrite += message.usage.cacheWrite || 0;
    state.usage.cost += message.usage.cost?.total || 0;
    toolCalls = state.toolCallsMap.size > 0
      ? Object.fromEntries(state.toolCallsMap)
      : undefined;
    state.toolCallsMap.clear();
  }
  applyAssistantMessageTerminalState(state, message);
  return toolCalls === undefined ? {} : { toolCalls };
}

const RAW_STOP_REASON_MAX_LENGTH = 500;
const TRUNCATION_MARKER = "...";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function applyAssistantMessageTerminalState(
  state: Pick<AgentRunState, "stopReason" | "lastError">,
  message: { stopReason?: string; errorMessage?: string; rawStopReason?: string },
): void {
  if (message.stopReason) state.stopReason = message.stopReason;
  const rawStopReason = message.rawStopReason ? normalizeWhitespace(message.rawStopReason) : undefined;
  const displayRawStopReason = rawStopReason && rawStopReason.length > RAW_STOP_REASON_MAX_LENGTH
    ? `${rawStopReason.slice(0, RAW_STOP_REASON_MAX_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
    : rawStopReason;
  const providerReason = displayRawStopReason ? `Provider stop reason: ${displayRawStopReason}` : undefined;
  const normalizedErrorMessage = message.errorMessage ? normalizeWhitespace(message.errorMessage) : undefined;
  if (message.errorMessage) {
    state.lastError = providerReason && rawStopReason && !normalizedErrorMessage?.includes(rawStopReason)
      ? `${message.errorMessage}\n${providerReason}`
      : message.errorMessage;
  } else if (message.stopReason === "error" && providerReason) {
    state.lastError = providerReason;
  } else if (message.stopReason && message.stopReason !== "error") {
    state.lastError = undefined;
  }
}
