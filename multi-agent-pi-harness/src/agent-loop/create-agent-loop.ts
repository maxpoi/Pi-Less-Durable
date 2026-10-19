import type { Api, Model } from "@earendil-works/pi-ai";
import {
  SessionManager,
  createAgentSession,
  type ExtensionAPI,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  AgentLoop,
  bindExecutionEnv,
  createCompactionStripExtension,
  createPiExtensionLoader,
  type AgentLoopLogger,
  type TargetedLoopExtensionRegistry,
  type ThinkingLevel,
} from "multi-agent-pi";
import type { SessionInfra } from "../session/session-infra.js";

export interface CreateAgentLoopOptions {
  readonly id: string;
  readonly loopDir: string;
  readonly loopTag?: string;
  readonly model?: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools?: readonly string[];
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
  const thinkingLevel = options.thinkingLevel ?? infra.models.getThinkingLevel();
  const settings = infra.models.settings;
  // MultiAgentPiSettingsManager is the sole Pi-facing settings adapter. Pi exposes its
  // concrete class here, so bridge the structural adapter without creating a
  // second settings authority.
  const piSettings = settings as unknown as SettingsManager;
  const promptExtensionName = "multi-agent-pi-harness-host-prompt";
  const promptExtensionPath = `<inline:${promptExtensionName}>`;
  const promptExtension = {
    name: promptExtensionName,
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
    extensionFactories: [promptExtension, compactionExtension, targetedExtension],
  });
  await resourceLoader.reload();
  const extensionError = resourceLoader.getExtensions().errors.find(
    error => error.path === promptExtensionPath
      || error.path === compactionExtensionPath
      || error.path === targetedExtensionPath,
  );
  if (extensionError) {
    throw new Error(
      `Failed to materialize extension for AgentLoop "${options.id}": `
      + `${extensionError.path}: ${extensionError.error}`,
    );
  }

  const sessionManager = SessionManager.inMemory(infra.paths.cwd);
  const { session } = await createAgentSession({
    cwd: infra.paths.cwd,
    agentDir: infra.paths.configDir,
    modelRuntime: infra.models.runtime,
    model,
    thinkingLevel,
    ...(options.tools === undefined
      ? { noTools: "all" as const }
      : { tools: [...options.tools] }),
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
