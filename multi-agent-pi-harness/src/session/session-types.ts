import type { SessionState } from "multi-agent-pi";

declare const sessionIdBrand: unique symbol;

export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };
export type MultiAgentPiSessionState = SessionState;
