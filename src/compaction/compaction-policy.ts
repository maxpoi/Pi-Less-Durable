import {
  DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS,
  type MultiAgentPiCompactionSettings,
} from "../config/config-types.js";

export { DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS };

const AUTO_COMPACT_CEILING = 400_000;

export interface MultiAgentPiCompactionModelRef {
  readonly provider: string;
  readonly id: string;
}

export type MultiAgentPiCompactionModelResolver = (
  model: MultiAgentPiCompactionModelRef,
) => { readonly contextWindow: number } | undefined;

/**
 * Applies MultiAgentPi compaction policy that depends on model context size without
 * extending Pi's settings-manager contract or retaining mutable model state.
 */
export class MultiAgentPiCompactionPolicy {
  readonly #resolveModel: MultiAgentPiCompactionModelResolver | undefined;

  constructor(resolveModel?: MultiAgentPiCompactionModelResolver) {
    this.#resolveModel = resolveModel;
  }

  resolveSettings(
    settings: MultiAgentPiCompactionSettings,
    model?: MultiAgentPiCompactionModelRef,
  ): MultiAgentPiCompactionSettings {
    const contextWindow = model === undefined
      ? undefined
      : this.#resolveModel?.(model)?.contextWindow;
    return this.resolveSettingsForContextWindow(settings, contextWindow);
  }

  resolveSettingsForContextWindow(
    settings: MultiAgentPiCompactionSettings,
    contextWindow: number | undefined,
  ): MultiAgentPiCompactionSettings {
    if (
      contextWindow !== undefined
      && contextWindow > 0
      && settings.reserveTokens > contextWindow
    ) {
      return {
        ...settings,
        reserveTokens: DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS,
      };
    }
    return settings;
  }

  shouldTrigger(
    contextTokens: number,
    contextWindow: number,
    settings: MultiAgentPiCompactionSettings,
  ): boolean {
    if (contextTokens <= 0 || contextWindow <= 0) return false;
    if (settings.reserveTokens !== DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS) {
      return false;
    }
    return contextWindow > AUTO_COMPACT_CEILING && contextTokens > AUTO_COMPACT_CEILING;
  }

  getTriggerPoint(
    contextWindow: number,
    settings: MultiAgentPiCompactionSettings,
  ): number {
    if (contextWindow <= 0) return 0;
    const piThreshold = contextWindow - settings.reserveTokens;
    return settings.reserveTokens === DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS
      ? Math.min(AUTO_COMPACT_CEILING, piThreshold)
      : piThreshold;
  }
}
