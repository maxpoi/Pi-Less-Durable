import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export type MultiAgentPiHarnessConfigErrorCode =
  | "missing_config_dir"
  | "defaults_not_found"
  | "defaults_read_failed"
  | "defaults_invalid_json"
  | "defaults_invalid_root"
  | "config_read_failed"
  | "config_write_failed";

export class MultiAgentPiHarnessConfigError extends Error {
  readonly code: MultiAgentPiHarnessConfigErrorCode;
  readonly path: string;

  constructor(code: MultiAgentPiHarnessConfigErrorCode, path: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MultiAgentPiHarnessConfigError";
    this.code = code;
    this.path = path;
  }
}

function normalizeDirectory(path: string): string {
  const unquoted = path.trim().replace(/^["']|["']$/g, "");
  if (unquoted === "~") {
    return homedir();
  }
  if (unquoted.startsWith(`~${sep}`) || unquoted.startsWith("~/")) {
    return join(homedir(), unquoted.slice(2));
  }
  return resolve(unquoted);
}

export function resolveMultiAgentPiHarnessConfigDirectory(configDir?: string): string {
  const candidate = configDir === undefined ? process.env.MULTI_AGENT_PI_CONFIG_DIR : configDir;
  if (candidate === undefined || candidate.trim() === "") {
    throw new MultiAgentPiHarnessConfigError(
      "missing_config_dir",
      "MULTI_AGENT_PI_CONFIG_DIR",
      "MultiAgentPiHarness requires configDir in its constructor or MULTI_AGENT_PI_CONFIG_DIR in the environment",
    );
  }
  return normalizeDirectory(candidate);
}
