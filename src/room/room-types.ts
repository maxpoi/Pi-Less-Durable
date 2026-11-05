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
export type RoomPersistence = "durable" | "memory";

export interface RoomPromptOptions {
  /** Explicit destination; omitted input uses the selected agent, then the primary agent. */
  readonly agentId?: string;
  readonly images?: readonly ImageContent[];
}

export interface RoomEnqueuePromptOptions {
  /** Explicit destination; omitted input uses the selected agent, then the primary agent. */
  readonly agentId?: string;
}

interface PrimaryAgentLoopBaseOptions {
  readonly agent: AgentIdentity;
  readonly config: AgentConfig;
  readonly extensionSources?: AgentLoopExtensionSources;
}

/** Primary options for a durable Room, which owns the AgentLoop directory. */
export type DurableRoomPrimaryAgentLoopOptions = PrimaryAgentLoopBaseOptions & {
  readonly dir?: never;
  /** Native Pi transcript persistence. Defaults to durable. */
  readonly persistence?: AgentLoopPersistence;
};

/** Primary options for a memory Room, which cannot provide an AgentLoop directory. */
export type MemoryRoomPrimaryAgentLoopOptions = PrimaryAgentLoopBaseOptions & (
  | {
      readonly persistence: "memory";
      /** Optional loop-owned artifact directory; omission allocates an OS temporary directory. */
      readonly dir?: string;
    }
  | {
      /** Durable is the default when persistence is omitted. */
      readonly persistence?: "durable";
      /** Required loop-owned directory for durable transcript persistence. */
      readonly dir: string;
    }
);

/** Primary options accepted across both Room persistence modes. */
export type PrimaryAgentLoopOptions =
  | DurableRoomPrimaryAgentLoopOptions
  | MemoryRoomPrimaryAgentLoopOptions;

interface CreateRoomBaseOptions {
  /** UX-facing Room name and Harness identity; also used as the archive-directory prefix for durable Rooms. Maximum 200 ASCII characters from `a-zA-Z0-9_-+=.()[]{}!@#$%^&`. */
  readonly id?: string;
}

/** Consumer-owned identity, persistence, and optional primary inputs. */
export type CreateRoomOptions = CreateRoomBaseOptions & (
  | {
      /** Filesystem-backed Room persistence. This is the default. */
      readonly persistence?: "durable";
      /**
       * Room data directory, exposed through roomDir as its filesystem-canonical identity.
       * Defaults beneath the singleton Harness working root; explicit input must not be empty.
       */
      readonly roomDir?: string;
      readonly primaryLoop?: DurableRoomPrimaryAgentLoopOptions;
    }
  | {
      /** Purely virtual Room with no Room directory, archive, reset, or restore support. */
      readonly persistence: "memory";
      readonly roomDir?: never;
      readonly primaryLoop?: MemoryRoomPrimaryAgentLoopOptions;
    }
);

export interface CreateRoomResult {
  readonly room: Room;
  readonly primaryLoop?: AgentLoop;
}

export interface ResetRoomOptions {
  /** Optional primary created only after reset has reopened this durable Room. */
  readonly primaryLoop?: DurableRoomPrimaryAgentLoopOptions;
}

export interface ResetRoomResult {
  readonly room: Room;
  readonly persistence: "durable";
  /** Sibling directory created by renaming `<roomDir>/sessions/current`. */
  readonly archiveName: string;
  readonly primaryLoop?: AgentLoop;
}

export interface RestoreRoomSessionOptions {
  /** Optional primary created only after the restored files are active and the durable Room has reopened. */
  readonly primaryLoop?: DurableRoomPrimaryAgentLoopOptions;
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
  readonly persistence: "durable";
  /** Stable Room container holding arbitrary Room data and the `sessions` namespace. */
  readonly roomDir: string;
  /** Active conversation directory at the time the event is issued. */
  readonly currentDir: string;
}

export interface RoomResetEndEvent {
  readonly type: "room_reset_end";
  readonly roomId: RoomId;
  readonly persistence: "durable";
  readonly roomDir: string;
  /** Fresh active conversation directory. */
  readonly currentDir: string;
  readonly archiveName: string;
}

export interface SessionRestoreEndEvent {
  readonly type: "session_restore_end";
  readonly roomId: RoomId;
  readonly persistence: "durable";
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
