import type { MultiAgentPiConfig } from "./config-types.js";

/** Parse the known MultiAgentPi settings while leaving unknown fields in the persisted document. */
export function parseMultiAgentPiConfig(obj: Record<string, unknown>): MultiAgentPiConfig {
  const config: MultiAgentPiConfig = {};
  if (typeof obj.model === "string") config.model = obj.model;
  if (typeof obj.provider === "string") config.provider = obj.provider as NonNullable<MultiAgentPiConfig["provider"]>;
  if (typeof obj.thinkingLevel === "string") config.thinkingLevel = obj.thinkingLevel as NonNullable<MultiAgentPiConfig["thinkingLevel"]>;
  if (typeof obj.limitedMode === "object" && obj.limitedMode !== null) config.limitedMode = obj.limitedMode as NonNullable<MultiAgentPiConfig["limitedMode"]>;
  if (typeof obj.compaction === "object" && obj.compaction !== null) {
    const c = obj.compaction as Record<string, unknown>;
    config.compaction = {};
    if (typeof c.enabled === "boolean") config.compaction.enabled = c.enabled;
    if (typeof c.reserveTokens === "number") config.compaction.reserveTokens = c.reserveTokens;
    if (typeof c.keepRecentTokens === "number") config.compaction.keepRecentTokens = c.keepRecentTokens;
    if (typeof c.codexServerSide === "boolean") config.compaction.codexServerSide = c.codexServerSide;
  }
  if (typeof obj.retry === "object" && obj.retry !== null) {
    const r = obj.retry as Record<string, unknown>;
    config.retry = {};
    if (typeof r.enabled === "boolean") config.retry.enabled = r.enabled;
    if (typeof r.maxRetries === "number") config.retry.maxRetries = r.maxRetries;
    if (typeof r.baseDelayMs === "number") config.retry.baseDelayMs = r.baseDelayMs;
    if (typeof r.maxAgentDelayMs === "number" && Number.isFinite(r.maxAgentDelayMs) && r.maxAgentDelayMs >= 0) {
      config.retry.maxAgentDelayMs = r.maxAgentDelayMs;
    }
  }
  return config;
}
