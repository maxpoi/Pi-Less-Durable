import {
  MultiAgentPiCompactionPolicy,
  type MultiAgentPiCompactionModelRef,
} from "../compaction/compaction-policy.js";
import type {
  MultiAgentPiCompactionSettings,
  MultiAgentPiConfig,
  MultiAgentPiRetrySettings,
  ThinkingLevel,
} from "./config-types.js";

// Keep the host-supplied provider stream aligned with Pi SDK defaults.
const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

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
  enableInstallTelemetry?: boolean;
  httpIdleTimeoutMs?: number;
}

function cloneConfig(config: MultiAgentPiConfig): MultiAgentPiConfig {
  return {
    compaction: { ...config.compaction },
    model: config.model,
    provider: config.provider,
    retry: { ...config.retry },
    thinkingLevel: config.thinkingLevel,
  };
}

/**
 * In-memory MultiAgentPi settings owner.
 *
 * This object is the Pi-facing settings adapter consumed directly by a loop's
 * resource loader and AgentSession. Persistence belongs to the host, which can
 * read the current detached config snapshot whenever it chooses to save it.
 */
export class MultiAgentPiSettingsManager {
  readonly compactionPolicy: MultiAgentPiCompactionPolicy;
  private config: MultiAgentPiConfig;

  constructor(
    config: MultiAgentPiConfig,
    compactionPolicy = new MultiAgentPiCompactionPolicy(),
  ) {
    this.config = cloneConfig(config);
    this.compactionPolicy = compactionPolicy;
  }

  getConfig(): MultiAgentPiConfig {
    return cloneConfig(this.config);
  }

  replaceConfig(config: MultiAgentPiConfig): void {
    this.config = cloneConfig(config);
  }

  // --- Compaction ---

  getCompactionSettings(model?: MultiAgentPiCompactionModelRef): MultiAgentPiCompactionSettings {
    return this.compactionPolicy.resolveSettings({ ...this.config.compaction }, model);
  }

  getCompactionEnabled(): boolean {
    return this.config.compaction.enabled;
  }

  setCompactionEnabled(enabled: boolean): void {
    this.config = {
      ...this.config,
      compaction: { ...this.config.compaction, enabled },
    };
  }

  getCodexServerCompactionEnabled(): boolean {
    return this.config.compaction.codexServerSide;
  }

  // --- Retry ---

  getRetrySettings(): MultiAgentPiRetrySettings {
    return { ...this.config.retry };
  }

  getRetryEnabled(): boolean {
    return this.config.retry.enabled;
  }

  setRetryEnabled(enabled: boolean): void {
    this.config = {
      ...this.config,
      retry: { ...this.config.retry, enabled },
    };
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

  getDefaultModel(): string {
    return this.config.model;
  }

  getDefaultProvider(): string {
    return this.config.provider;
  }

  setDefaultModelAndProvider(provider: string, modelId: string): void {
    this.config = {
      ...this.config,
      provider: provider as MultiAgentPiConfig["provider"],
      model: modelId,
    };
  }

  getDefaultThinkingLevel(): string {
    return this.config.thinkingLevel;
  }

  setDefaultThinkingLevel(level: string): void {
    this.config = {
      ...this.config,
      thinkingLevel: level as MultiAgentPiConfig["thinkingLevel"],
    };
  }

  // The host application has one thinking default rather than Pi's optional
  // per-model selector overrides.
  getModelThinkingLevel(_provider: string, _modelId: string): ThinkingLevel | undefined {
    return undefined;
  }

  getAllModelThinkingLevels(): Record<string, ThinkingLevel> { return {}; }
  getTransport(): "auto" { return "auto"; }
  getThinkingBudgets(): undefined { return undefined; }
  getCacheWarmingMode(): "streaming" { return "streaming"; }
  setCacheWarmingMode(_mode: string): void { /* no MultiAgentPi setting. */ }
  getEnableInstallTelemetry(): false { return false; }
  setEnableInstallTelemetry(_enabled: boolean): void { /* Harness policy remains disabled. */ }
  getEnabledModels(): undefined { return undefined; }
  setEnabledModels(_patterns: string[] | undefined): void { /* no MultiAgentPi setting. */ }
  getDefaultTools(): undefined { return undefined; }

  // --- Agent runtime compatibility settings ---

  /** Detached view of the Harness's current in-memory configuration. */
  getSettings(): MultiAgentPiSettingsSnapshot {
    const compaction = this.getCompactionSettings();
    return {
      defaultProvider: this.getDefaultProvider(),
      defaultModel: this.getDefaultModel(),
      defaultThinkingLevel: this.config.thinkingLevel,
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
      enableInstallTelemetry: this.getEnableInstallTelemetry(),
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
  getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
    return { reserveTokens: 4096, skipPrompt: false };
  }
  getShowTerminalProgress(): boolean { return false; }
  setShowTerminalProgress(_enabled: boolean): void { /* no-op */ }
  // MultiAgentPi owns resource discovery instead of loading arbitrary project-local Pi resources.
  // Keep the project trusted and expose no Pi package/resource configuration.
  isProjectTrusted(): boolean { return true; }
  setProjectTrusted(_trusted: boolean): void { /* MultiAgentPi policy remains trusted. */ }
  getGlobalSettings(): MultiAgentPiSettingsSnapshot { return this.getSettings(); }
  getProjectSettings(): MultiAgentPiSettingsSnapshot { return {}; }
  getTerminalCapabilityOverrides(): Record<string, never> { return {}; }

  /** Pi reload hook; configuration is already current because it is held in memory. */
  async reload(): Promise<void> {}
}
