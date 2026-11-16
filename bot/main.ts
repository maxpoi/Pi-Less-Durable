import { homedir } from "node:os";
import { join } from "node:path";
import {
  ModelRuntime,
  MultiAgentPiHarness,
  PRIMARY_AGENT_TAG,
  Room,
} from "pi-less-durable";
import { BotConfigStore } from "./config-store.js";
import { logger } from "./logger.js";

async function runBot(): Promise<void> {
  const workingDir = join(homedir(), ".multiagentpibot");
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

    const mainIdentity = {
      id: "main",
      name: "Main",
      tag: PRIMARY_AGENT_TAG,
    };
    const { room } = await Room.create({
      primaryLoop: {
        agent: mainIdentity,
        config: {
          cwd: process.cwd(),
          toolConfig: { builtInToolExecutionMode: "detached" },
        },
      },
    });
    try {
      harness.register(room);
      await room.prompt("Hello");
    } finally {
      await room.close();
    }
  } finally {
    configStore.save({
      ...harness.config,
      limitedMode,
    });
  }
}

runBot().catch(error => {
  logger.warning(
    "Bot terminated",
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  process.exitCode = 1;
});
