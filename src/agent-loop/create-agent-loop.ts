import { join } from "node:path";
import {
  AgentLoop,
  SessionManager,
  bindExecutionEnv,
  createAgentSession,
  createCompactionStripExtension,
  createPiExtensionLoader,
  type AgentLoopEventHook,
  type AgentLoopLogger,
  type Api,
  type ExtensionAPI,
  type Model,
  type SettingsManager,
  type TargetedLoopExtensionRegistry,
} from "#core";
import type { SessionInfra } from "../session/session-infra.js";

export interface CreateAgentLoopOptions {
  readonly id: string;
  readonly loopDir: string;
  readonly loopTag?: string;
  readonly model?: Model<Api>;
  readonly onEvent?: AgentLoopEventHook;
  /** Install the host's complete prompt policy through Pi's native extension API. */
  readonly configurePrompt: (pi: ExtensionAPI) => Promise<void> | void;
  readonly logger: AgentLoopLogger;
}

/** Create one native Pi runtime without prompting it or making a model request. */
export async function createAgentLoop(
  infra: SessionInfra,
  options: CreateAgentLoopOptions,
  extensionRegistry: TargetedLoopExtensionRegistry,
): Promise<AgentLoop> {
  if (typeof options?.configurePrompt !== "function") {
    throw new Error("MultiAgentPiHarness requires the host to configure each AgentLoop prompt policy");
  }
  const model = options.model ?? infra.models.getModel();
  const thinkingLevel = infra.models.getThinkingLevel();
  const settings = infra.models.settings;
  // MultiAgentPiSettingsManager is the sole Pi-facing settings adapter. Pi exposes its
  // concrete class here, so bridge the structural adapter without creating a
  // second settings authority.
  const piSettings = settings as unknown as SettingsManager;
  const hostPromptExtensionName = "multi-agent-pi-harness-host-prompt";
  const hostPromptExtensionPath = `<inline:${hostPromptExtensionName}>`;
  const hostPromptExtension = {
    name: hostPromptExtensionName,
    hidden: true,
    factory: options.configurePrompt,
  };
  const compactionExtensionName = "multi-agent-pi-harness-compaction-strip";
  const compactionExtensionPath = `<inline:${compactionExtensionName}>`;
  const compactionExtension = createCompactionStripExtension({
    name: compactionExtensionName,
    logger: options.logger,
  });
  const targetedExtensionName = `multi-agent-pi-harness-targeted-${options.id}`;
  const targetedExtensionPath = `<inline:${targetedExtensionName}>`;
  const targetedExtension = extensionRegistry.createLoopExtension(
    {
      sessionId: infra.id,
      sessionDir: infra.paths.sessionDir,
      loopId: options.id,
      loopDir: options.loopDir,
    },
    targetedExtensionName,
  );
  const resourceLoader = createPiExtensionLoader({
    cwd: infra.paths.cwd,
    agentDir: infra.paths.configDir,
    settingsManager: settings,
    selectedExtensionFiles: [],
    extensionFactories: [hostPromptExtension, compactionExtension, targetedExtension],
  });
  await resourceLoader.reload();
  const extensionError = resourceLoader.getExtensions().errors.find(
    error => error.path === hostPromptExtensionPath
      || error.path === compactionExtensionPath
      || error.path === targetedExtensionPath,
  );
  if (extensionError) {
    throw new Error(
      `Failed to materialize extension for AgentLoop "${options.id}": `
      + `${extensionError.path}: ${extensionError.error}`,
    );
  }

  const sessionManager = SessionManager.open(
    join(options.loopDir, "context.jsonl"),
    options.loopDir,
    infra.paths.cwd,
  );
  const { session } = await createAgentSession({
    cwd: infra.paths.cwd,
    agentDir: infra.paths.configDir,
    modelRuntime: infra.models.runtime,
    model,
    thinkingLevel,
    noTools: "all",
    resourceLoader,
    sessionManager,
    settingsManager: piSettings,
  });

  const compactionPolicy = settings.compactionPolicy;
  const env = infra.resources.env === undefined
    ? undefined
    : bindExecutionEnv(infra.resources.env, {
        sessionId: infra.id,
        loopId: options.id,
        cwd: infra.paths.cwd,
      });
  const getCompactionSettings = () => compactionPolicy.resolveSettingsForContextWindow(
    settings.getCompactionSettings(),
    session.agent.state.model.contextWindow,
  );

  return new AgentLoop({
    id: options.id,
    sessionId: infra.id,
    ...(options.loopTag === undefined ? {} : { loopTag: options.loopTag }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    runtime: {
      agent: session.agent,
      session,
      sessionManager,
    },
    loopDir: options.loopDir,
    logger: options.logger,
    ...(env === undefined ? {} : { env }),
    compactionPolicy: {
      getTriggerPoint: () => compactionPolicy.getTriggerPoint(
        session.agent.state.model.contextWindow,
        getCompactionSettings(),
      ),
      shouldCompact: contextTokens => compactionPolicy.shouldTrigger(
        contextTokens,
        session.agent.state.model.contextWindow,
        getCompactionSettings(),
      ),
    },
  });
}
