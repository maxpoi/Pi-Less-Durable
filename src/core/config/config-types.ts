export type KnownProvider = "amazon-bedrock" | "ant-ling" | "anthropic" | "google" | "google-vertex" | "openai" | "azure" | "openai-codex" | "radius" | "typesafe" | "nvidia" | "deepseek" | "github-copilot" | "xai" | "groq" | "cerebras" | "openrouter" | "vercel-ai-gateway" | "zai" | "zai-coding-cn" | "mistral" | "minimax" | "minimax-cn" | "moonshotai" | "moonshotai-cn" | "huggingface" | "fireworks" | "together" | "baseten" | "opencode" | "opencode-go" | "kimi-coding" | "meta" | "cloudflare-workers-ai" | "cloudflare-ai-gateway" | "qwen-token-plan" | "qwen-token-plan-cn" | "qwen-token-plan-individual" | "xiaomi" | "xiaomi-token-plan-cn" | "xiaomi-token-plan-ams" | "xiaomi-token-plan-sgp";

export const KNOWN_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof KNOWN_THINKING_LEVELS)[number];

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

export interface ExternalSourceEntry {
	source: string;
	version?: string;
	/** "bootstrap" means installed automatically from default-skills.json; "user" means explicit hub install. */
	installedBy?: "bootstrap" | "user";
}

export interface ExternalSourcesManifest {
	skills: Record<string, ExternalSourceEntry>;
	extensions: Record<string, ExternalSourceEntry>;
}
