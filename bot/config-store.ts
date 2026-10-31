import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type MultiAgentPiCompactionSettings,
  type MultiAgentPiConfig,
  type MultiAgentPiRetrySettings,
} from "pi-less-durable";

export interface BotLimitedModeSettings {
  readonly allowedUsers: readonly string[];
  readonly allowedTools: readonly string[];
  readonly timeoutMs: number;
  readonly model: string;
}

export interface BotConfig extends MultiAgentPiConfig {
  readonly limitedMode: BotLimitedModeSettings;
}

export type BotConfigErrorCode =
  | "defaults_not_found"
  | "defaults_read_failed"
  | "defaults_invalid_json"
  | "defaults_invalid_root"
  | "config_read_failed"
  | "config_invalid_json"
  | "config_invalid_root"
  | "config_write_failed";

export class BotConfigError extends Error {
  readonly code: BotConfigErrorCode;
  readonly path: string;

  constructor(code: BotConfigErrorCode, path: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BotConfigError";
    this.code = code;
    this.path = path;
  }
}

export interface LoadedBotConfig {
  readonly path: string;
  readonly config: BotConfig;
  readonly diagnostics: readonly BotConfigError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): unknown {
  const content = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
  return JSON.parse(content);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const baseValue = base[key];
    const overrideValue = override[key];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string")
    ? [...value]
    : [...fallback];
}

function parseCompaction(
  value: unknown,
  fallback: MultiAgentPiCompactionSettings,
): MultiAgentPiCompactionSettings {
  const record = isRecord(value) ? value : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    reserveTokens: typeof record.reserveTokens === "number"
      ? record.reserveTokens
      : fallback.reserveTokens,
    keepRecentTokens: typeof record.keepRecentTokens === "number"
      ? record.keepRecentTokens
      : fallback.keepRecentTokens,
    codexServerSide: typeof record.codexServerSide === "boolean"
      ? record.codexServerSide
      : fallback.codexServerSide,
  };
}

function parseLimitedMode(
  value: unknown,
  fallback: BotLimitedModeSettings,
): BotLimitedModeSettings {
  const record = isRecord(value) ? value : {};
  return {
    allowedUsers: stringArray(record.allowedUsers, fallback.allowedUsers),
    allowedTools: stringArray(record.allowedTools, fallback.allowedTools),
    timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : fallback.timeoutMs,
    model: typeof record.model === "string" ? record.model : fallback.model,
  };
}

function parseRetry(
  value: unknown,
  fallback: MultiAgentPiRetrySettings,
): MultiAgentPiRetrySettings {
  const record = isRecord(value) ? value : {};
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : fallback.enabled,
    maxRetries: typeof record.maxRetries === "number" ? record.maxRetries : fallback.maxRetries,
    baseDelayMs: typeof record.baseDelayMs === "number" ? record.baseDelayMs : fallback.baseDelayMs,
    maxAgentDelayMs: typeof record.maxAgentDelayMs === "number"
      && Number.isFinite(record.maxAgentDelayMs)
      && record.maxAgentDelayMs >= 0
      ? record.maxAgentDelayMs
      : fallback.maxAgentDelayMs,
  };
}

function parseConfig(
  value: Record<string, unknown>,
  fallback: BotConfig,
): BotConfig {
  return {
    compaction: parseCompaction(value.compaction, fallback.compaction),
    guardWorktree: typeof value.guardWorktree === "boolean"
      ? value.guardWorktree
      : fallback.guardWorktree,
    limitedMode: parseLimitedMode(value.limitedMode, fallback.limitedMode),
    model: typeof value.model === "string" ? value.model : fallback.model,
    provider: typeof value.provider === "string"
      ? value.provider as MultiAgentPiConfig["provider"]
      : fallback.provider,
    retry: parseRetry(value.retry, fallback.retry),
    thinkingLevel: typeof value.thinkingLevel === "string"
      ? value.thinkingLevel as MultiAgentPiConfig["thinkingLevel"]
      : fallback.thinkingLevel,
  };
}

function requireDefaultConfig(value: Record<string, unknown>, path: string): BotConfig {
  const compaction = value.compaction;
  const limitedMode = value.limitedMode;
  const retry = value.retry;
  if (
    !isRecord(compaction)
    || typeof compaction.enabled !== "boolean"
    || typeof compaction.reserveTokens !== "number"
    || typeof compaction.keepRecentTokens !== "number"
    || typeof compaction.codexServerSide !== "boolean"
    || typeof value.guardWorktree !== "boolean"
    || !isRecord(limitedMode)
    || !Array.isArray(limitedMode.allowedUsers)
    || !limitedMode.allowedUsers.every(entry => typeof entry === "string")
    || !Array.isArray(limitedMode.allowedTools)
    || !limitedMode.allowedTools.every(entry => typeof entry === "string")
    || typeof limitedMode.timeoutMs !== "number"
    || typeof limitedMode.model !== "string"
    || typeof value.model !== "string"
    || typeof value.provider !== "string"
    || !isRecord(retry)
    || typeof retry.enabled !== "boolean"
    || typeof retry.maxRetries !== "number"
    || typeof retry.baseDelayMs !== "number"
    || typeof retry.maxAgentDelayMs !== "number"
    || typeof value.thinkingLevel !== "string"
  ) {
    throw new BotConfigError(
      "defaults_invalid_root",
      path,
      `Bundled Bot defaults must contain a complete configuration: ${path}`,
    );
  }
  return {
    compaction: {
      enabled: compaction.enabled,
      reserveTokens: compaction.reserveTokens,
      keepRecentTokens: compaction.keepRecentTokens,
      codexServerSide: compaction.codexServerSide,
    },
    guardWorktree: value.guardWorktree,
    limitedMode: {
      allowedUsers: [...limitedMode.allowedUsers] as string[],
      allowedTools: [...limitedMode.allowedTools] as string[],
      timeoutMs: limitedMode.timeoutMs,
      model: limitedMode.model,
    },
    model: value.model,
    provider: value.provider as MultiAgentPiConfig["provider"],
    retry: {
      enabled: retry.enabled,
      maxRetries: retry.maxRetries,
      baseDelayMs: retry.baseDelayMs,
      maxAgentDelayMs: retry.maxAgentDelayMs,
    },
    thinkingLevel: value.thinkingLevel as MultiAgentPiConfig["thinkingLevel"],
  };
}

export class BotConfigStore {
  readonly #workingDir: string;
  readonly #defaultConfigPath: string;

  constructor(workingDir: string) {
    this.#workingDir = resolve(workingDir);
    this.#defaultConfigPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "config.default.json",
    );
  }

  get configPath(): string {
    return join(this.#workingDir, "config.json");
  }

  initialize(): LoadedBotConfig {
    const { document, config } = this.#load();
    const diagnostics: BotConfigError[] = [];
    try {
      this.#writeConfigObject(deepMerge(document, config as unknown as Record<string, unknown>));
    } catch (error) {
      if (!(error instanceof BotConfigError) || error.code !== "config_write_failed") throw error;
      diagnostics.push(error);
    }
    return { path: this.configPath, config, diagnostics };
  }

  load(): BotConfig {
    return this.#load().config;
  }

  save(config: BotConfig): void {
    const existing = this.#readConfigObject(this.configPath);
    this.#writeConfigObject(deepMerge(existing, config as unknown as Record<string, unknown>));
  }

  #load(): { document: Record<string, unknown>; config: BotConfig } {
    const defaultsObject = this.#readDefaultConfigObject();
    const defaults = requireDefaultConfig(defaultsObject, this.#defaultConfigPath);
    const document = deepMerge(defaultsObject, this.#readConfigObject(this.configPath));
    return { document, config: parseConfig(document, defaults) };
  }

  #readDefaultConfigObject(): Record<string, unknown> {
    const path = this.#defaultConfigPath;
    if (!existsSync(path)) {
      throw new BotConfigError(
        "defaults_not_found",
        path,
        `Bundled Bot defaults not found: ${path}`,
      );
    }

    let raw: unknown;
    try {
      raw = readJsonFile(path);
    } catch (error) {
      const code = error instanceof SyntaxError ? "defaults_invalid_json" : "defaults_read_failed";
      throw new BotConfigError(code, path, `Failed to read bundled Bot defaults: ${path}`, error);
    }
    if (!isRecord(raw)) {
      throw new BotConfigError(
        "defaults_invalid_root",
        path,
        `Bundled Bot defaults must contain a JSON object: ${path}`,
      );
    }
    return raw;
  }

  #readConfigObject(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};

    let raw: unknown;
    try {
      raw = readJsonFile(path);
    } catch (error) {
      const code = error instanceof SyntaxError ? "config_invalid_json" : "config_read_failed";
      throw new BotConfigError(code, path, `Failed to read Bot config: ${path}`, error);
    }
    if (!isRecord(raw)) {
      throw new BotConfigError(
        "config_invalid_root",
        path,
        `Bot config must contain a JSON object: ${path}`,
      );
    }
    return raw;
  }

  #writeConfigObject(config: Record<string, unknown>): void {
    try {
      mkdirSync(this.#workingDir, { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    } catch (error) {
      throw new BotConfigError(
        "config_write_failed",
        this.configPath,
        `Failed to write Bot config: ${this.configPath}`,
        error,
      );
    }
  }

}
