import type { ImageContent } from "@earendil-works/pi-ai";
import type { Room, RoomId } from "../room/room.js";

/** Application input for one native agent turn within a Room. */
export interface RoomBridgeRunInput {
  readonly text: string;
  /** Explicit destination; omitted input uses the selected agent, then the primary agent. */
  readonly agentId?: string;
  readonly images?: readonly ImageContent[];
}

/**
 * Transport-neutral boundary that delegates message-application input to a Room.
 *
 * The Bridge does not own the Room or native agents; presentation and output routing are application-owned.
 */
export class RoomBridge {
  readonly #room: Room;

  constructor(room: Room) {
    this.#room = room;
  }

  get roomId(): RoomId {
    return this.#room.id;
  }

  run(input: RoomBridgeRunInput): Promise<void> {
    return this.#room.prompt(input.text, {
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.images === undefined ? {} : { images: input.images }),
    });
  }
}
