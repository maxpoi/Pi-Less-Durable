import { spawn } from "node:child_process";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface LocalProcessOptions {
  readonly cwd?: string;
  readonly timeout?: number;
}

/** Execute a program directly with an argument array on the current machine. */
export function runLocalProcess(
  executable: string,
  args: string[],
  options?: LocalProcessOptions,
): Promise<ExecResult> {
  const timeout = options?.timeout ?? 60_000;
  return new Promise(resolve => {
    const child = spawn(executable, args, {
      cwd: options?.cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(result);
    };
    const timeoutHandle = timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessTree(child.pid);
        }, timeout)
      : undefined;

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", code => {
      if (timedOut) {
        const timeoutMessage = `Command timed out after ${timeout}ms`;
        finish({
          stdout,
          stderr: [stderr.trimEnd(), timeoutMessage].filter(Boolean).join("\n"),
          code: 124,
        });
        return;
      }
      finish({ stdout, stderr, code: code ?? 1 });
    });
    child.on("error", error => {
      finish({ code: -1, stdout: "", stderr: error.message });
    });
  });
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // The process may already have exited.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}
