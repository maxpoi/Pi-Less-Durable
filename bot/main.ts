import { homedir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  MultiAgentPiHarness,
  PRIMARY_AGENT_TAG,
} from "pi-less-durable";
import { logger } from "./logger.js";

async function runBot(): Promise<void> {
  const agentDir = join(homedir(), ".multiagentpi");
  const configDir = join(agentDir, "config");
  const authPath = join(agentDir, "auth.json");
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath: join(agentDir, "models.json"),
  });
  const harness = new MultiAgentPiHarness({ configDir, modelRuntime, logger });

  await harness.open();
  try {
    const provider = harness.settings.getDefaultProvider();
    const modelId = harness.settings.getDefaultModel();
    const model = provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined;
    if (!model) {
      logger.warning("Model required", `Configure a model in ${join(configDir, "config.json")}.`);
      return;
    }

    const hasConfiguredAuth = modelRuntime.hasConfiguredAuth(model.provider)
      || await modelRuntime.checkAuth(model.provider) !== undefined;
    if (!hasConfiguredAuth) {
      logger.warning(
        "Authentication required",
        `Run "npm run bot:login -- ${model.provider}", then run Bot again.`,
      );
      return;
    }

    const room = harness.createRoom();
    const mainIdentity = {
      id: "main",
      name: "Main",
      tag: PRIMARY_AGENT_TAG,
    };
    const main = await harness.createAgentLoop(room, mainIdentity, { cwd: process.cwd() });
    room.register(main);

    await room.prompt("Hello");
  } finally {
    await harness.close();
  }
}

runBot().catch(error => {
  logger.warning(
    "Bot terminated",
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  process.exitCode = 1;
});
