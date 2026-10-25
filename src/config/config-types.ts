import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { KnownProvider } from "@earendil-works/pi-ai";

export type { KnownProvider, ThinkingLevel };

export interface MultiAgentPiCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/** Use Codex's encrypted server-side checkpoint format for direct Codex sessions. */
	codexServerSide: boolean;
}

export interface MultiAgentPiRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs: number;
}

export interface MultiAgentPiConfig {
	model?: string;
	provider?: KnownProvider;
	thinkingLevel?: ThinkingLevel;
	limitedMode?: {
		allowedUsers?: string[];
		allowedTools?: string[];
		timeoutMs?: number;
		model?: string;
	};
	compaction?: Partial<MultiAgentPiCompactionSettings>;
	retry?: Partial<MultiAgentPiRetrySettings>;
}
