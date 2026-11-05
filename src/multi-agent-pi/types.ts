import type { AgentLoopRoundEndEvent } from "../agent/agent-loop.js";
import type { RoomId } from "../room/room-types.js";

/** Common callback shape; result semantics belong to each event dispatcher. */
export type MultiAgentPiHandler<E, C, R = undefined> = (
  event: E,
  context: C,
) => Promise<R | void> | R | void;

/** Current AgentLoop identity available to callbacks issued for that loop. */
export interface AgentLoopContext {
  readonly roomId: RoomId | undefined;
  readonly agentId: string;
  readonly agentTag: string;
}

/** Current Room identity available to callbacks issued by that Room. */
export interface RoomContext {
  readonly roomId: RoomId;
}

/** Owner and task identity available throughout one background task. */
export interface BackgroundTaskRunContext {
  readonly roomId: RoomId | undefined;
  readonly agentId: string | undefined;
  readonly id: string;
  readonly label: string;
  readonly signal: AbortSignal;
}

/** AgentLoop-scoped framework events available to extension sources. */
export interface MultiAgentPiEventMap {
  readonly agent_round_end: {
    readonly event: AgentLoopRoundEndEvent;
    readonly context: AgentLoopContext;
  };
}

export type MultiAgentPiEventType = keyof MultiAgentPiEventMap;
export type MultiAgentPiEvent = MultiAgentPiEventMap[MultiAgentPiEventType]["event"];
export type MultiAgentPiEventHandler<TEvent extends MultiAgentPiEventType> =
  MultiAgentPiHandler<
    MultiAgentPiEventMap[TEvent]["event"],
    MultiAgentPiEventMap[TEvent]["context"]
  >;
