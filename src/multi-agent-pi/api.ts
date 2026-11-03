import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentLoopContext,
  createRoomContext,
  type AgentLoopContext,
  type MultiAgentPiHandler,
  type RoomContext,
} from "./context.js";
import type {
  AgentLoop,
  AgentLoopRoundEndEvent,
  AgentLoopRoundEndHandler,
} from "../agent/agent-loop.js";
import {
  getContext,
  register,
  type MultiAgentPiExtensionRegistration,
} from "./extension-registry.js";
import type {
  BeforeRoomResetEvent,
  BeforeRoomResetHandler,
  RoomResetEndEvent,
  RoomResetEndHandler,
  SessionRestoreEndEvent,
  SessionRestoreEndHandler,
} from "../room/room-types.js";
import type { Room } from "../room/room.js";

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
  MultiAgentPiHandler,
  RoomContext,
} from "./context.js";
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
export type {
  BeforeRoomResetEvent,
  BeforeRoomResetHandler,
  RoomResetEndEvent,
  RoomResetEndHandler,
  SessionRestoreEndEvent,
  SessionRestoreEndHandler,
} from "../room/room-types.js";

export interface MultiAgentPiEventMap {
  readonly agent_round_end: {
    readonly event: AgentLoopRoundEndEvent;
    readonly context: AgentLoopContext;
  };
  readonly before_room_reset: {
    readonly event: BeforeRoomResetEvent;
    readonly context: RoomContext;
  };
  readonly room_reset_end: {
    readonly event: RoomResetEndEvent;
    readonly context: RoomContext;
  };
  readonly session_restore_end: {
    readonly event: SessionRestoreEndEvent;
    readonly context: RoomContext;
  };
}

export type MultiAgentPiEventType = keyof MultiAgentPiEventMap;
export type MultiAgentPiEvent = MultiAgentPiEventMap[MultiAgentPiEventType]["event"];
export type MultiAgentPiEventHandler<TEvent extends MultiAgentPiEventType> =
  MultiAgentPiHandler<
    MultiAgentPiEventMap[TEvent]["event"],
    MultiAgentPiEventMap[TEvent]["context"]
  >;

export interface MultiAgentPiAPI {
  /** Return this extension load's current AgentLoop context. */
  getContext(): AgentLoopContext;

  /** Apply native Pi behavior when the current AgentLoop matches `target`. */
  register(
    pi: ExtensionAPI,
    registration: MultiAgentPiExtensionRegistration,
  ): Promise<void>;

  /** Observe completed Rounds. Duplicate handler registration throws. */
  on(event: "agent_round_end", handler: AgentLoopRoundEndHandler): () => void;
  /** Observe reset admission. Duplicate handler registration throws. */
  on(event: "before_room_reset", handler: BeforeRoomResetHandler): () => void;
  /** Observe completed resets. Duplicate handler registration throws. */
  on(event: "room_reset_end", handler: RoomResetEndHandler): () => void;
  /** Observe an archive becoming the active Room session. Duplicate handler registration throws. */
  on(event: "session_restore_end", handler: SessionRestoreEndHandler): () => void;
}

/** Existing extension-facing name for the unified MultiAgentPi API. */
export type MultiAgentPiExtensionAPI = MultiAgentPiAPI;

type AnyMultiAgentPiEventHandler = MultiAgentPiHandler<
  MultiAgentPiEvent,
  AgentLoopContext | RoomContext
>;

const eventHandlers = new Map<
  MultiAgentPiEventType,
  Set<AnyMultiAgentPiEventHandler>
>();

function on(
  event: "agent_round_end",
  handler: AgentLoopRoundEndHandler,
): () => void;
function on(
  event: "before_room_reset",
  handler: BeforeRoomResetHandler,
): () => void;
function on(
  event: "room_reset_end",
  handler: RoomResetEndHandler,
): () => void;
function on(
  event: "session_restore_end",
  handler: SessionRestoreEndHandler,
): () => void;
function on(
  event: MultiAgentPiEventType,
  handler:
    | AgentLoopRoundEndHandler
    | BeforeRoomResetHandler
    | RoomResetEndHandler
    | SessionRestoreEndHandler,
): () => void {
  let handlers = eventHandlers.get(event);
  if (handlers === undefined) {
    handlers = new Set();
    eventHandlers.set(event, handlers);
  }
  const registeredHandler = handler as AnyMultiAgentPiEventHandler;
  if (handlers.has(registeredHandler)) {
    throw new Error(`Handler is already registered for MultiAgentPi event "${event}"`);
  }
  handlers.add(registeredHandler);
  return () => {
    handlers.delete(registeredHandler);
    if (handlers.size === 0) eventHandlers.delete(event);
  };
}

/** Pi extension registration plus process-wide framework event observation. */
export const multiAgentPi: MultiAgentPiAPI = Object.freeze({
  getContext,
  register,
  on,
});

/** @internal Issue one AgentLoop event through local and process-wide scopes. */
export function issueMultiAgentPiEvent(
  event: AgentLoopRoundEndEvent,
  issuer: AgentLoop,
  issueLocally: (context: AgentLoopContext) => void | Promise<void>,
  onPublicError: (error: unknown) => void,
): Promise<void>;
/** @internal Issue one Room event through local and process-wide scopes. */
export function issueMultiAgentPiEvent(
  event: BeforeRoomResetEvent,
  issuer: Room,
  issueLocally: (context: RoomContext) => void | Promise<void>,
  onPublicError: (error: unknown) => void,
): Promise<void>;
/** @internal Issue one Room event through local and process-wide scopes. */
export function issueMultiAgentPiEvent(
  event: RoomResetEndEvent,
  issuer: Room,
  issueLocally: (context: RoomContext) => void | Promise<void>,
  onPublicError: (error: unknown) => void,
): Promise<void>;
/** @internal Issue one Room event through local and process-wide scopes. */
export function issueMultiAgentPiEvent(
  event: SessionRestoreEndEvent,
  issuer: Room,
  issueLocally: (context: RoomContext) => void | Promise<void>,
  onPublicError: (error: unknown) => void,
): Promise<void>;
export async function issueMultiAgentPiEvent(
  event: MultiAgentPiEvent,
  issuer: AgentLoop | Room,
  issueLocally:
    | ((context: AgentLoopContext) => void | Promise<void>)
    | ((context: RoomContext) => void | Promise<void>),
  onPublicError: (error: unknown) => void,
): Promise<void> {
  const context = event.type === "agent_round_end"
    ? createAgentLoopContext(issuer as AgentLoop)
    : createRoomContext(issuer as Room);
  await (
    issueLocally as (
      context: AgentLoopContext | RoomContext,
    ) => void | Promise<void>
  )(context);

  const handlers = eventHandlers.get(event.type);
  if (handlers === undefined) return;
  for (const handler of [...handlers]) {
    try {
      await handler(event, context);
    } catch (error) {
      onPublicError(error);
    }
  }
}
