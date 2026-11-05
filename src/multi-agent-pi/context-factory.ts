import type { RoomId } from "../room/room-types.js";
import type {
  AgentLoopContext,
  BackgroundTaskRunContext,
  RoomContext,
} from "./types.js";

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
