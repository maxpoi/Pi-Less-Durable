import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentLoopResult } from "#core";
import type { Session } from "../session/session-types.js";

/** Application input for one AgentLoop turn within a Session. */
export interface SessionBridgeRunInput {
  readonly text: string;
  /** Explicit destination; omitted input uses the foreground loop, then the primary loop. */
  readonly loopId?: string;
  readonly images?: readonly ImageContent[];
}

/**
 * Transport-neutral boundary that delegates message-application input to a Session.
 *
 * The Bridge does not own the Session, AgentLoops, or their output bindings.
 */
export class SessionBridge {
  readonly #session: Session;

  constructor(session: Session) {
    this.#session = session;
  }

  get sessionId(): string {
    return this.#session.id;
  }

  run(input: SessionBridgeRunInput): Promise<AgentLoopResult> {
    return this.#session.prompt(input.text, {
      ...(input.loopId === undefined ? {} : { loopId: input.loopId }),
      ...(input.images === undefined ? {} : { images: input.images }),
    });
  }
}
