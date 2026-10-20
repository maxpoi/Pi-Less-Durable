import type { SessionState } from "#core";

declare const sessionIdBrand: unique symbol;

export type SessionId = string & { readonly [sessionIdBrand]: "SessionId" };
export type MultiAgentPiSessionState = SessionState;
