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

interface AgentLoopContextSource {
  readonly roomId: RoomId | undefined;
  readonly id: string;
  readonly tag: string;
}

interface RoomContextSource {
  readonly id: RoomId;
}

/** @internal Construct a live AgentLoop context view from its current identity source. */
export function createAgentLoopContext(
  source: AgentLoopContextSource,
): AgentLoopContext {
  return Object.freeze({
    get roomId(): RoomId | undefined {
      return source.roomId;
    },
    agentId: source.id,
    agentTag: source.tag,
  });
}

/** @internal Construct one immutable Room context from its current identity source. */
export function createRoomContext(source: RoomContextSource): RoomContext {
  return Object.freeze({ roomId: source.id });
}

/** @internal Construct one immutable context shared by a background task's callbacks. */
export function createBackgroundTaskRunContext(
  source: BackgroundTaskRunContext,
): BackgroundTaskRunContext {
  return Object.freeze({
    roomId: source.roomId,
    agentId: source.agentId,
    id: source.id,
    label: source.label,
    signal: source.signal,
  });
}
