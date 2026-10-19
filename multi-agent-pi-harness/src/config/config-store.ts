import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  deepMerge,
  parseMultiAgentPiConfig,
  readJsonFile,
  type MultiAgentPiConfig,
  type MultiAgentPiConfigStorage,
} from "multi-agent-pi";
import { MultiAgentPiHarnessConfigError } from "./config-path.js";

export interface LoadedMultiAgentPiHarnessConfig {
  readonly configDir: string;
  readonly path: string;
  readonly value: MultiAgentPiConfig;
  readonly diagnostics: readonly MultiAgentPiHarnessConfigError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class MultiAgentPiConfigStore implements MultiAgentPiConfigStorage {
  readonly #configDir: string;
  readonly #bundledConfigDir: string;

  constructor(configDir: string) {
    this.#configDir = configDir;
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    this.#bundledConfigDir = join(packageRoot, "config");
  }

  get configDir(): string {
    return this.#configDir;
  }

  get configPath(): string {
    return join(this.#configDir, "config.json");
  }

  get bundledConfigDir(): string {
    return this.#bundledConfigDir;
  }

  get defaultConfigPath(): string {
    return join(this.#bundledConfigDir, "config.default.json");
  }

  get userMemoryPath(): string {
    return join(this.#configDir, "MEMORY.md");
  }

  getResourceDirs(resourceType: string): string[] {
    return [
      join(this.#configDir, resourceType),
      join(this.#bundledConfigDir, resourceType),
    ];
  }

  initialize(): LoadedMultiAgentPiHarnessConfig {
    const merged = this.#loadEffectiveConfigObject();
    const diagnostics: MultiAgentPiHarnessConfigError[] = [];
    try {
      this.#writeConfigObject(merged);
    } catch (error) {
      if (!(error instanceof MultiAgentPiHarnessConfigError) || error.code !== "config_write_failed") {
        throw error;
      }
      diagnostics.push(error);
    }
    return {
      configDir: this.#configDir,
      path: this.configPath,
      value: parseMultiAgentPiConfig(merged),
      diagnostics,
    };
  }

  /**
   * Read a config markdown file with bundled defaults before user content.
   */
  readConfigFileWithDefaults(relativePath: string): string {
    const userPath = join(this.#configDir, relativePath);
    const defaultPath = join(this.#bundledConfigDir, relativePath);

    let userContent = "";
    let defaultContent = "";
    try {
      if (existsSync(userPath)) userContent = readFileSync(userPath, "utf-8").trim();
    } catch {
      // Preserve existing best-effort resource loading.
    }
    try {
      if (existsSync(defaultPath)) defaultContent = readFileSync(defaultPath, "utf-8").trim();
    } catch {
      // Preserve existing best-effort resource loading.
    }

    return [defaultContent, userContent].filter(Boolean).join("\n\n");
  }

  /**
   * Sync missing keys from bundled defaults into config.json. Defaults are the
   * base and user values win, so explicit local settings are never overwritten.
   */
  syncConfigDefaults(): MultiAgentPiConfig {
    const merged = this.#loadEffectiveConfigObject();
    this.#writeConfigObject(merged);
    return parseMultiAgentPiConfig(merged);
  }

  /** Read effective settings without mutating files. */
  loadConfig(): MultiAgentPiConfig {
    return parseMultiAgentPiConfig(this.#loadEffectiveConfigObject());
  }

  /**
   * Save known settings with a fresh read-merge-write so unknown fields remain
   * untouched. Keys explicitly set to undefined are removed from disk.
   */
  saveConfig(config: MultiAgentPiConfig): void {
    const existing = this.#readConfigObject(this.configPath);
    const merged = deepMerge(existing, config as Record<string, unknown>);
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    this.#writeConfigObject(merged);
  }

  #loadEffectiveConfigObject(): Record<string, unknown> {
    const merged = deepMerge(this.#readDefaultConfigObject(), this.#readConfigObject(this.configPath));
    this.#applyExistingConfigMigrations(merged);
    return merged;
  }

  #readDefaultConfigObject(): Record<string, unknown> {
    const path = this.defaultConfigPath;
    if (!existsSync(path)) {
      throw new MultiAgentPiHarnessConfigError(
        "defaults_not_found",
        path,
        `Bundled MultiAgentPiHarness defaults not found: ${path}`,
      );
    }

    let raw: unknown;
    try {
      raw = readJsonFile(path);
    } catch (error) {
      const code = error instanceof SyntaxError ? "defaults_invalid_json" : "defaults_read_failed";
      throw new MultiAgentPiHarnessConfigError(code, path, `Failed to read bundled MultiAgentPiHarness defaults: ${path}`, error);
    }

    if (!isRecord(raw)) {
      throw new MultiAgentPiHarnessConfigError(
        "defaults_invalid_root",
        path,
        `Bundled MultiAgentPiHarness defaults must contain a JSON object: ${path}`,
      );
    }
    return raw;
  }

  #readConfigObject(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    try {
      const raw = readJsonFile(path);
      return isRecord(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  #writeConfigObject(config: Record<string, unknown>): void {
    try {
      mkdirSync(this.#configDir, { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf-8");
    } catch (error) {
      throw new MultiAgentPiHarnessConfigError(
        "config_write_failed",
        this.configPath,
        `Failed to write MultiAgentPiHarness config: ${this.configPath}`,
        error,
      );
    }
  }

  #applyExistingConfigMigrations(config: Record<string, unknown>): void {
    delete config.cacheControlRoomMembers;

    const limitedMode = config.limitedMode;
    if (!isRecord(limitedMode)) return;

    delete limitedMode.enabled;
    if (
      limitedMode.model === "claude-sonnet-4.5"
      || limitedMode.model === "github-copilot/claude-sonnet-4.5"
    ) {
      limitedMode.model = "github-copilot/claude-sonnet-4.6";
    }
  }
}
