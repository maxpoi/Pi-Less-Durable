import { homedir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  MultiAgentPiHarness,
  PRIMARY_AGENT_TAG,
} from "pi-less-durable";
import { BotConfigStore } from "./config-store.js";
import { logger } from "./logger.js";

async function runBot(): Promise<void> {
  const workingDir = join(homedir(), ".multiagentpi");
  const configStore = new BotConfigStore(workingDir);
  const loadedConfig = configStore.initialize();
  const { limitedMode, ...harnessConfig } = loadedConfig.config;
  for (const diagnostic of loadedConfig.diagnostics) {
    logger.warning("Config persistence warning", diagnostic.message);
  }

  const authPath = join(workingDir, "auth.json");
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath: join(workingDir, "models.json"),
  });
  const harness = new MultiAgentPiHarness({
    config: harnessConfig,
    workingDir,
    modelRuntime,
    logger,
  });

  await harness.open();
  try {
    const provider = harness.settings.getDefaultProvider();
    const modelId = harness.settings.getDefaultModel();
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) {
      logger.warning("Model required", `Configure a model in ${loadedConfig.path}.`);
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
    try {
      await harness.close();
    } finally {
      configStore.save({
        ...harness.config,
        limitedMode,
      });
    }
  }
}

runBot().catch(error => {
  logger.warning(
    "Bot terminated",
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  process.exitCode = 1;
});
