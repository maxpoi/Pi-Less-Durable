import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AgentLoopContext,
  MultiAgentPiEventHandler,
  MultiAgentPiEventType,
} from "./types.js";
import {
  getContext,
  register,
  registerAgentLoopExtensionEventHandler,
  type MultiAgentPiExtensionRegistration,
} from "./extension-registry.js";

export type {
  AfterProviderResponseEvent,
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderHeadersEvent,
  BeforeProviderRequestEvent,
  BeforeProviderRequestEventResult,
  CacheWarmingDecisionEvent,
  CacheWarmingDecisionEventResult,
  ContextEvent,
  ContextEventResult,
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  ExtensionFactory,
  ExtensionHandler,
  ExtensionToolContext,
  InlineExtension,
  InputEvent,
  InputEventResult,
  McpServersChangeEvent,
  MessageEndEvent,
  MessageEndEventResult,
  MessageStartEvent,
  MessageUpdateEvent,
  ModelSelectEvent,
  ProjectTrustContext,
  ProjectTrustEvent,
  ProjectTrustEventResult,
  ProjectTrustHandler,
  ProviderStreamEvent,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionBeforeForkEvent,
  SessionBeforeForkResult,
  SessionBeforeSwitchEvent,
  SessionBeforeSwitchResult,
  SessionBeforeTreeEvent,
  SessionBeforeTreeResult,
  SessionCompactEvent,
  SessionCompactFailedEvent,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ThinkingLevelSelectEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolResultEvent,
  ToolResultEventResult,
  TurnEndEvent,
  TurnEndEventResult,
  TurnStartEvent,
  UIPromptEndEvent,
  UIPromptStartEvent,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";

export type {
  AgentLoopContext,
  BackgroundTaskRunContext,
  MultiAgentPiEvent,
  MultiAgentPiEventHandler,
  MultiAgentPiEventMap,
  MultiAgentPiEventType,
  MultiAgentPiHandler,
  RoomContext,
} from "./types.js";
export type {
  AgentLoopRoundEndEvent,
  AgentLoopRoundEndHandler,
} from "../agent/agent-loop.js";
export type {
  MultiAgentPiExtensionRegistration,
  MultiAgentPiExtensionSetup,
  MultiAgentPiExtensionTarget,
} from "./extension-registry.js";
export type {
  BackgroundTaskAbortEvent,
  BackgroundTaskOptions,
} from "../room/background-task-manager.js";
export interface MultiAgentPiAPI {
  /** Return this extension load's current AgentLoop context. */
  getContext(): AgentLoopContext;

  /** Apply native Pi behavior when the current AgentLoop matches `target`. */
  register(
    pi: ExtensionAPI,
    registration: MultiAgentPiExtensionRegistration,
  ): Promise<void>;

  /** Observe one framework event for the AgentLoop currently loading this extension. */
  on<TEvent extends MultiAgentPiEventType>(
    event: TEvent,
    handler: MultiAgentPiEventHandler<TEvent>,
  ): () => void;
}

/** Existing extension-facing name for the unified MultiAgentPi API. */
export type MultiAgentPiExtensionAPI = MultiAgentPiAPI;

const AGENT_LOOP_EXTENSION_EVENT_TYPES = new Set<MultiAgentPiEventType>([
  "agent_round_end",
]);

function on<TEvent extends MultiAgentPiEventType>(
  event: TEvent,
  handler: MultiAgentPiEventHandler<TEvent>,
): () => void {
  if (!AGENT_LOOP_EXTENSION_EVENT_TYPES.has(event)) {
    throw new Error(`Unknown AgentLoop extension event: ${String(event)}`);
  }
  return registerAgentLoopExtensionEventHandler(event, handler);
}

/** AgentLoop-scoped framework behavior available while one Pi extension is loading. */
export const multiAgentPi: MultiAgentPiAPI = Object.freeze({
  getContext,
  register,
  on,
});
