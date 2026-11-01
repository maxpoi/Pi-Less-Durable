import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { KnownProvider } from "@earendil-works/pi-ai";

export type { KnownProvider, ThinkingLevel };

export interface MultiAgentPiCompactionSettings {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  /** Use Codex's encrypted server-side checkpoint format for direct Codex sessions. */
  readonly codexServerSide: boolean;
}

export interface MultiAgentPiRetrySettings {
  readonly enabled: boolean;
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxAgentDelayMs: number;
}

export const DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS = 16_384;

export const DEFAULT_MULTI_AGENT_PI_COMPACTION_SETTINGS: MultiAgentPiCompactionSettings =
  Object.freeze({
    enabled: true,
    reserveTokens: DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS,
    keepRecentTokens: 20_000,
    codexServerSide: false,
  });

export const DEFAULT_MULTI_AGENT_PI_RETRY_SETTINGS: MultiAgentPiRetrySettings = Object.freeze({
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxAgentDelayMs: 60_000,
});

/** Complete host-supplied in-memory configuration. */
export interface MultiAgentPiConfig {
  readonly compaction: MultiAgentPiCompactionSettings;
  readonly model: string;
  readonly provider: KnownProvider;
  readonly retry: MultiAgentPiRetrySettings;
  readonly thinkingLevel: ThinkingLevel;
}
