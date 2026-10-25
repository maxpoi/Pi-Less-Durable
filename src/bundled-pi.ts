import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const LOGIN_ARGS = [
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
] as const;

export interface LaunchBundledPiLoginOptions {
  /** Pi writes credentials to `<agentDir>/auth.json`. */
  readonly agentDir: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LaunchBundledPiLoginResult {
  readonly exitCode: number;
}

function resolveBundledPiCliPath(): string {
  const packageEntry = fileURLToPath(import.meta.resolve(PI_PACKAGE));
  const cliPath = join(dirname(packageEntry), "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(`Bundled Pi CLI was not found at ${cliPath}`);
  }
  return cliPath;
}

/** Launch the pinned Pi interactive UI against a consumer-selected agent directory. */
export async function launchBundledPiLogin(
  options: LaunchBundledPiLoginOptions,
): Promise<LaunchBundledPiLoginResult> {
  const agentDir = options.agentDir.trim();
  if (!agentDir) throw new Error("Pi login requires a non-empty agent directory");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Pi login requires an interactive terminal with stdin and stdout attached");
  }

  const child = spawn(
    process.execPath,
    [resolveBundledPiCliPath(), ...LOGIN_ARGS],
    {
      cwd: resolve(options.cwd ?? homedir()),
      env: {
        ...(options.env ?? process.env),
        PI_CODING_AGENT_DIR: resolve(agentDir),
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: "inherit",
      shell: false,
    },
  );

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", code => resolveExit(code ?? 1));
  });
  return { exitCode };
}
