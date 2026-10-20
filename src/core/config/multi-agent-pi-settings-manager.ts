import {
	DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS,
	MultiAgentPiCompactionPolicy,
	type MultiAgentPiCompactionModelRef,
} from "../compaction/compaction-policy.js";
import { deepMerge } from "./config-json-utils.js";
import type { MultiAgentPiConfigStorage } from "./config-storage.js";
import type { MultiAgentPiCompactionSettings, MultiAgentPiConfig, MultiAgentPiRetrySettings, ThinkingLevel } from "./config-types.js";

const DEFAULT_COMPACTION: MultiAgentPiCompactionSettings = {
	enabled: true,
	reserveTokens: DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS,
	keepRecentTokens: 20000,
	codexServerSide: false,
};

const RETRY_MAX_RETRIES = Number.parseInt(process.env.MULTI_AGENT_PI_LLM_MAX_RETRIES || "1", 10);
const RETRY_BASE_DELAY_MS = Number.parseInt(process.env.MULTI_AGENT_PI_LLM_RETRY_BASE_DELAY_MS || "1000", 10);

// Keep the host-supplied provider stream aligned with Pi SDK defaults.
const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

const DEFAULT_RETRY: MultiAgentPiRetrySettings = {
	enabled: true,
	maxRetries: Number.isFinite(RETRY_MAX_RETRIES) && RETRY_MAX_RETRIES >= 0 ? RETRY_MAX_RETRIES : 1,
	baseDelayMs: Number.isFinite(RETRY_BASE_DELAY_MS) && RETRY_BASE_DELAY_MS >= 0 ? RETRY_BASE_DELAY_MS : 1000,
	maxAgentDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
};

/** Shared subset of agent settings supplied by MultiAgentPi policy. */
export interface MultiAgentPiSettingsSnapshot {
	defaultProvider?: string | undefined;
	defaultModel?: string | undefined;
	defaultThinkingLevel?: ThinkingLevel;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	compaction?: Partial<MultiAgentPiCompactionSettings>;
	branchSummary?: { reserveTokens?: number; skipPrompt?: boolean };
	retry?: Partial<MultiAgentPiRetrySettings> & {
		provider?: {
			timeoutMs?: number | undefined;
			maxRetries?: number | undefined;
			maxRetryDelayMs?: number;
		};
	};
	images?: { autoResize?: boolean; blockImages?: boolean };
	terminal?: { showTerminalProgress?: boolean };
	httpIdleTimeoutMs?: number;
}

/**
 * Shared MultiAgentPi settings owner for host applications.
 * This object is the Pi-facing settings adapter consumed directly by a loop's
 * resource loader and AgentSession; there is no second settings owner.
 *
 * config.json field mapping:
 *   model        → getDefaultModel()
 *   provider     → getDefaultProvider()
 *   thinkingLevel → getDefaultThinkingLevel()
 *   compaction   → getCompactionSettings()
 *   retry        → getRetrySettings()
 *
 * Both MultiAgentPi policy consumers and Pi runtimes use this same owner.
 */
export class MultiAgentPiSettingsManager {
	private readonly configStore: MultiAgentPiConfigStorage;
	readonly compactionPolicy: MultiAgentPiCompactionPolicy;
	private settings: MultiAgentPiConfig;

	constructor(
		configStore: MultiAgentPiConfigStorage,
		compactionPolicy = new MultiAgentPiCompactionPolicy(),
	) {
		this.configStore = configStore;
		this.compactionPolicy = compactionPolicy;
		this.settings = configStore.loadConfig();
	}

	/**
	 * Fresh read-merge-write: re-reads config.json, applies the pending
	 * field change, writes back. Prevents clobbering fields written by
	 * other code paths (model.ts, agent runtime) since construction.
	 */
	private persistField(update: Partial<MultiAgentPiConfig>): void {
		const fresh = deepMerge(
			this.configStore.loadConfig() as Record<string, unknown>,
			update as Record<string, unknown>,
		) as MultiAgentPiConfig;
		this.configStore.saveConfig(fresh);
		this.settings = fresh;
	}

	// --- Compaction ---

	private get compaction(): Partial<MultiAgentPiCompactionSettings> | undefined {
		const c = this.settings.compaction;
		return typeof c === "object" && c !== null ? c : undefined;
	}

	getCompactionSettings(model?: MultiAgentPiCompactionModelRef): MultiAgentPiCompactionSettings {
		const configured = { ...DEFAULT_COMPACTION, ...this.compaction };
		return this.compactionPolicy.resolveSettings(configured, model);
	}

	getCompactionEnabled(): boolean {
		return this.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.persistField({ compaction: { enabled } });
	}

	getCodexServerCompactionEnabled(): boolean {
		return this.configStore.loadConfig().compaction?.codexServerSide ?? DEFAULT_COMPACTION.codexServerSide;
	}

	// --- Retry ---

	private get retry(): Partial<MultiAgentPiRetrySettings> | undefined {
		const r = this.settings.retry;
		return typeof r === "object" && r !== null ? r : undefined;
	}

	getRetrySettings(): MultiAgentPiRetrySettings {
		return { ...DEFAULT_RETRY, ...this.retry };
	}

	getRetryEnabled(): boolean {
		return this.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.persistField({ retry: { enabled } });
	}

	/** Provider-level request defaults used by Pi's canonical stream wrapper. */
	getProviderRetrySettings(): {
		timeoutMs: number | undefined;
		maxRetries: number | undefined;
		maxRetryDelayMs: number;
	} {
		return {
			timeoutMs: undefined,
			maxRetries: undefined,
			maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return undefined;
	}

	// --- Model / Provider / Thinking ---

	getDefaultModel(): string | undefined {
		return this.settings.model;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.provider;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.persistField({ provider: provider as NonNullable<MultiAgentPiConfig["provider"]>, model: modelId });
	}

	getDefaultThinkingLevel(): string {
		return this.settings.thinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
		this.persistField({ thinkingLevel: level as NonNullable<MultiAgentPiConfig["thinkingLevel"]> });
	}

	// The host application has one persisted thinking default rather than Pi's optional
	// per-model selector overrides.
	getModelThinkingLevel(_provider: string, _modelId: string): ThinkingLevel | undefined {
		return undefined;
	}

	getAllModelThinkingLevels(): Record<string, ThinkingLevel> { return {}; }
	getTransport(): "auto" { return "auto"; }
	getThinkingBudgets(): undefined { return undefined; }
	getCacheWarmingMode(): "streaming" { return "streaming"; }
	setCacheWarmingMode(_mode: string): void { /* no persisted MultiAgentPi setting. */ }
	getEnabledModels(): undefined { return undefined; }
	setEnabledModels(_patterns: string[] | undefined): void { /* no persisted MultiAgentPi setting. */ }
	getDefaultTools(): undefined { return undefined; }

	// --- Agent runtime compatibility settings ---

	/** Detached view of the host application's current configured settings. */
	getSettings(): MultiAgentPiSettingsSnapshot {
		const compaction = this.getCompactionSettings();
		return {
			defaultProvider: this.getDefaultProvider(),
			defaultModel: this.getDefaultModel(),
			defaultThinkingLevel: this.getDefaultThinkingLevel() as ThinkingLevel,
			steeringMode: this.getSteeringMode(),
			followUpMode: this.getFollowUpMode(),
			compaction: {
				enabled: compaction.enabled,
				reserveTokens: compaction.reserveTokens,
				keepRecentTokens: compaction.keepRecentTokens,
			},
			branchSummary: { ...this.getBranchSummarySettings() },
			retry: {
				...this.getRetrySettings(),
				provider: { ...this.getProviderRetrySettings() },
			},
			images: {
				autoResize: this.getImageAutoResize(),
				blockImages: this.getBlockImages(),
			},
			terminal: { showTerminalProgress: this.getShowTerminalProgress() },
			httpIdleTimeoutMs: this.getHttpIdleTimeoutMs(),
		};
	}

	getSteeringMode(): "all" | "one-at-a-time" { return "one-at-a-time"; }
	setSteeringMode(_mode: "all" | "one-at-a-time"): void { /* no-op */ }
	getFollowUpMode(): "all" | "one-at-a-time" { return "one-at-a-time"; }
	setFollowUpMode(_mode: "all" | "one-at-a-time"): void { /* no-op */ }
	getHookPaths(): string[] { return []; }
	getHookTimeout(): number { return 30000; }
	// Preserve image bytes supplied by tools, including screen-coordinate-sized desktop screenshots.
	getImageAutoResize(): boolean { return false; }
	setImageAutoResize(_enabled: boolean): void { /* no-op */ }
	getBlockImages(): boolean { return false; }
	setBlockImages(_enabled: boolean): void { /* no-op */ }
	getShellCommandPrefix(): string | undefined { return undefined; }
	getShellPath(): string | undefined { return undefined; }
	setShellPath(_path: string | undefined): void { /* no-op */ }
	getTheme(): string | undefined { return undefined; }
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } { return { reserveTokens: 4096, skipPrompt: false }; }
	getShowTerminalProgress(): boolean { return false; }
	setShowTerminalProgress(_enabled: boolean): void { /* no-op */ }
	// MultiAgentPi owns resource discovery instead of loading arbitrary project-local Pi resources.
	// Keep the project trusted and expose no Pi package/resource configuration.
	isProjectTrusted(): boolean { return true; }
	setProjectTrusted(_trusted: boolean): void { /* MultiAgentPi policy remains trusted. */ }
	getGlobalSettings(): MultiAgentPiSettingsSnapshot { return this.getSettings(); }
	getProjectSettings(): MultiAgentPiSettingsSnapshot { return {}; }
	getTerminalCapabilityOverrides(): Record<string, never> { return {}; }

	async reload(): Promise<void> {
		this.settings = this.configStore.loadConfig();
	}
}
