import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  AgentLoop,
  AgentLoopPersistence,
} from "../agent/agent-loop.js";
import type {
  MultiAgentPiHandler,
  RoomContext,
} from "../multi-agent-pi/types.js";
import type {
  AgentConfig,
  AgentLoopExtensionSources,
} from "../agent/agent-session-factory.js";
import type { AgentIdentity } from "./loop-manager.js";
import type { Room } from "./room.js";

declare const roomIdBrand: unique symbol;

export type RoomId = string & { readonly [roomIdBrand]: "RoomId" };
export type RoomState = "open" | "reloading" | "resetting" | "closed";

export interface RoomPromptOptions {
  /** Explicit destination; omitted input uses the selected agent, then the primary agent. */
  readonly agentId?: string;
  readonly images?: readonly ImageContent[];
}

export interface RoomEnqueuePromptOptions {
  /** Explicit destination; omitted input uses the selected agent, then the primary agent. */
  readonly agentId?: string;
}

/** Consumer-owned inputs for creating one primary AgentLoop. */
export interface PrimaryAgentLoopOptions {
  readonly agent: AgentIdentity;
  readonly config: AgentConfig;
  /** Native Pi transcript persistence. Defaults to durable. */
  readonly persistence?: AgentLoopPersistence;
  readonly extensionSources?: AgentLoopExtensionSources;
}

/** Consumer-owned identity, persistence, and optional primary inputs. */
export interface CreateRoomOptions {
  /** UX-facing Room name and Harness identity; also used as the archive-directory prefix. Maximum 200 ASCII characters from `a-zA-Z0-9_-+=.()[]{}!@#$%^&`. */
  readonly id?: string;
  /**
   * Room data directory, exposed through roomDir as its filesystem-canonical identity.
   * Defaults beneath the singleton Harness working root; explicit input must not be empty.
   */
  readonly roomDir?: string;
  readonly primaryLoop?: PrimaryAgentLoopOptions;
}

export interface CreateRoomResult {
  readonly room: Room;
  readonly primaryLoop?: AgentLoop;
}

export interface ResetRoomOptions {
  /** Optional primary created only after reset has reopened this Room. */
  readonly primaryLoop?: PrimaryAgentLoopOptions;
}

export interface ResetRoomResult {
  readonly room: Room;
  /** Sibling directory created by renaming `<roomDir>/sessions/current`. */
  readonly archiveName: string;
  readonly primaryLoop?: AgentLoop;
}

export interface RestoreRoomSessionOptions {
  /** Optional primary created only after the restored files are active and the Room has reopened. */
  readonly primaryLoop?: PrimaryAgentLoopOptions;
}

export interface RestoreRoomSessionResult {
  readonly room: Room;
  /** Exact sibling archive directory renamed to `<roomDir>/sessions/current`. */
  readonly restoredArchiveName: string;
  /** Archive created by renaming the previously active `<roomDir>/sessions/current`. */
  readonly previousArchiveName: string;
  readonly primaryLoop?: AgentLoop;
}

export interface BeforeRoomResetEvent {
  readonly type: "before_room_reset";
  readonly roomId: RoomId;
  /** Stable Room container holding arbitrary Room data and the `sessions` namespace. */
  readonly roomDir: string;
  /** Active conversation directory at the time the event is issued. */
  readonly currentDir: string;
}

export interface RoomResetEndEvent {
  readonly type: "room_reset_end";
  readonly roomId: RoomId;
  readonly roomDir: string;
  /** Fresh or restored active conversation directory. */
  readonly currentDir: string;
  readonly archiveName: string;
}

export interface SessionRestoreEndEvent {
  readonly type: "session_restore_end";
  readonly roomId: RoomId;
  readonly roomDir: string;
  /** Restored active conversation directory. */
  readonly currentDir: string;
  /** Consumed sibling archive directory name. */
  readonly archiveName: string;
}

export type BeforeRoomResetHandler = MultiAgentPiHandler<
  BeforeRoomResetEvent,
  RoomContext
>;

export type RoomResetEndHandler = MultiAgentPiHandler<
  RoomResetEndEvent,
  RoomContext
>;

export type SessionRestoreEndHandler = MultiAgentPiHandler<
  SessionRestoreEndEvent,
  RoomContext
>;
