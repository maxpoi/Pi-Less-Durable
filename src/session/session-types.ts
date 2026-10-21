import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentLoopResult, SessionState as CoreSessionState } from "#core";

declare const sessionIdBrand: unique symbol;

export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };
export type SessionState = CoreSessionState;
export type MultiAgentPiSessionState = SessionState;

export interface SessionPromptOptions {
  readonly loopId?: string;
  readonly images?: readonly ImageContent[];
}

/** Non-generic public delegation contract consumed by SessionBridge. */
export interface Session {
  readonly id: string;
  readonly isBusy: boolean;
  getState(): SessionState;
  /** Prompt the explicit loop, or the foreground loop with the primary loop as fallback. */
  prompt(message: string, options?: SessionPromptOptions): Promise<AgentLoopResult>;
  reload(loopId?: string): Promise<void>;
  close(): Promise<void>;
}
