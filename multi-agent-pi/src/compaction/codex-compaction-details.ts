export const CODEX_SERVER_COMPACTION_STRATEGY = "openai-codex-server-v2";

export interface CodexServerCompactionDetailsMarker {
  readonly strategy: typeof CODEX_SERVER_COMPACTION_STRATEGY;
}

/** Identify the persisted strategy marker used by MultiAgentPi Codex server compaction. */
export function isCodexServerCompactionDetails(
  value: unknown,
): value is CodexServerCompactionDetailsMarker {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).strategy === CODEX_SERVER_COMPACTION_STRATEGY;
}
