import { homedir } from "node:os";
import { join } from "node:path";
import { launchBundledPiLogin } from "pi-less-durable";
import { logger } from "./logger.js";

async function login(): Promise<void> {
  const [providerId, ...extra] = process.argv.slice(2);
  if (extra.length > 0) {
    logger.warning("Usage", "npm run bot:login -- [provider]");
    process.exitCode = 1;
    return;
  }

  const provider = providerId?.trim();
  const loginCommand = provider ? `/login ${provider}` : "/login";
  const agentDir = join(homedir(), ".multiagentpibot");
  logger.info(
    "Opening bundled Pi",
    `Run ${loginCommand} inside Pi, then /quit when authentication completes.`,
  );
  const { exitCode } = await launchBundledPiLogin({ agentDir });
  if (exitCode !== 0) {
    logger.warning("Bundled Pi exited", `Exit code ${exitCode}`);
    process.exitCode = exitCode;
  }
}

login().catch(error => {
  logger.warning(
    "Login failed",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
