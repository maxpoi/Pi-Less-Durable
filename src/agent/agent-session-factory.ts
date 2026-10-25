import { join, resolve } from "node:path";
import {
  Agent,
  type AgentMessage,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
  AgentSession,
  type ExtensionRunner,
  SessionManager,
  convertToLlm,
  type CreateAgentSessionResult,
  type InlineExtension,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { AgentLoop } from "./agent-loop.js";
import {
  initializeConversationHistory,
  type ConversationHistory,
} from "./agent-session-utils.js";
import {
  assertConsumerInlineExtensionNames,
  createBuiltInExtensions,
} from "../extensions/built-in-extensions.js";
import { prepareInitialSessionMessages } from "./runtime-maintainance/context-maintenance.js";
import {
  createPiExtensionAgentHooks,
  createPiExtensionStreamFn,
} from "./to-pi-bindings/pi-extension-bindings.js";
import { createProviderStreamFn } from "./to-pi-bindings/provider-stream.js";
import type { AgentLogger } from "../logger/logger.js";
import type { CodexServerCompactionController } from "../compaction/codex-server-compaction.js";
import type { MultiAgentPiSettingsManager } from "../config/multi-agent-pi-settings-manager.js";
import { MultiAgentPiResourceLoader } from "../extensions/multi-agent-pi-extension-registry.js";
import {
  PRIMARY_AGENT_TAG,
  type AgentIdentity,
} from "../room/loop-manager.js";
import type { Room } from "../room/room.js";


/** Consumer-applied configuration for constructing one agent runtime. */
export interface AgentConfig {
  /** Required working directory for this AgentLoop's native AgentSession and tools. */
  readonly cwd: string;
  readonly model?: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly initialConversationHistory?: ConversationHistory;
}

/** Native Pi extension sources selected for one AgentLoop. */
export interface AgentLoopExtensionSources {
  readonly extensionFiles?: readonly string[];
  readonly inlineExtensions?: readonly InlineExtension[];
}

export interface CreateHarnessAgentSessionOptions {
  readonly room: Room;
  readonly agent: AgentIdentity;
  readonly config: AgentConfig;
  readonly extensionSources: AgentLoopExtensionSources;
  readonly workingDir: string;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: MultiAgentPiSettingsManager;
  readonly logger: AgentLogger;
}

export interface CreateHarnessAgentLoopResult extends CreateAgentSessionResult {
  readonly loop: AgentLoop;
}

interface CreateNativeAgentSessionOptions {
  readonly cwd: string;
  readonly config: AgentConfig;
  readonly initialMessages: readonly AgentMessage[];
  readonly sessionManager: SessionManager;
  readonly settingsManager: MultiAgentPiSettingsManager;
  readonly modelRuntime: ModelRuntime;
  readonly resourceLoader: MultiAgentPiResourceLoader;
  readonly codexServerCompaction: CodexServerCompactionController;
}

/**
 * Construct the native Agent and AgentSession so Harness-owned provider hooks execute in a
 * defined order. This intentionally diverges from Pi's SDK createAgentSession(): it does not
 * restore virtual-model selections, choose first-available/scoped fallback models, install Pi's
 * internal CacheWarmer, or merge Pi provider-attribution headers. Those SDK behaviors are not
 * part of the Harness contract. An unresolved model remains undefined for the consumer to fix.
 */
function createAgentSession(options: CreateNativeAgentSessionOptions): CreateAgentSessionResult {
  const {
    cwd,
    config,
    initialMessages,
    sessionManager,
    settingsManager,
    modelRuntime,
    resourceLoader,
    codexServerCompaction,
  } = options;
  const sessionContext = sessionManager.buildSessionContext();
  const branchEntries = sessionManager.getBranch();
  const hasThinkingEntry = branchEntries.some(
    entry => entry.type === "thinking_level_change",
  );

  let model = config.model;
  let modelResolutionWarning: string | undefined;
  if (model === undefined && sessionContext.model !== null) {
    const persisted = sessionContext.model;
    model = modelRuntime.getModel(persisted.provider, persisted.modelId);
    if (!model) {
      modelResolutionWarning = `Could not restore model ${persisted.provider}/${persisted.modelId}`;
    }
  } else if (model === undefined) {
    const provider = settingsManager.getDefaultProvider();
    const modelId = settingsManager.getDefaultModel();
    if (!provider || !modelId) {
      modelResolutionWarning = "Provider and model must be configured";
    } else {
      model = modelRuntime.getModel(provider, modelId);
      if (!model) {
        modelResolutionWarning = `Model "${provider}/${modelId}" is not registered in the host ModelRuntime`;
      }
    }
  }

  let thinkingLevel = config.thinkingLevel;
  if (thinkingLevel === undefined && hasThinkingEntry) {
    thinkingLevel = sessionContext.thinkingLevel as ThinkingLevel;
  }
  thinkingLevel ??= settingsManager.getDefaultThinkingLevel() as ThinkingLevel;
  thinkingLevel = model === undefined ? "off" : clampThinkingLevel(model, thinkingLevel);

  const extensionRunnerRef: { current?: ExtensionRunner } = {};

  const rawStreamFn = createProviderStreamFn(modelRuntime, settingsManager);
  const mainStreamFn = createPiExtensionStreamFn(rawStreamFn, extensionRunnerRef);
  const extensionAgentHooks = createPiExtensionAgentHooks(
    extensionRunnerRef,
    undefined,
    undefined,
    (payload, requestModel) => codexServerCompaction.rewriteProviderPayload(
      payload,
      requestModel,
    ),
  );
  const agent = new Agent({
    initialState: {
      systemPrompt: "",
      ...(model === undefined ? {} : { model }),
      thinkingLevel,
      tools: [],
      messages: [...initialMessages],
    },
    convertToLlm,
    streamFn: mainStreamFn,
    onPayload: extensionAgentHooks.onPayload,
    onResponse: extensionAgentHooks.onResponse,
    onProviderStreamEvent: extensionAgentHooks.onProviderStreamEvent,
    transformContext: extensionAgentHooks.transformContext as any,
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    transport: settingsManager.getTransport(),
    sessionId: sessionManager.getSessionId(),
  });
  if (model === undefined) {
    // Agent core substitutes an internal "unknown" model when initialState.model is absent.
    // Harness exposes the unresolved state to its consumer instead of treating that sentinel as selected.
    agent.state.model = undefined as any;
  }

  if (
    model !== undefined
    && (
      sessionContext.model === null
      || sessionContext.model.provider !== model.provider
      || sessionContext.model.modelId !== model.id
    )
  ) {
    sessionManager.appendModelChange(model.provider, model.id);
  }
  if (
    !hasThinkingEntry
    || (model !== undefined && sessionContext.thinkingLevel !== thinkingLevel)
  ) {
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }

  const settings = settingsManager as unknown as SettingsManager;
  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager: settings,
    cwd,
    resourceLoader,
    modelRuntime,
    extensionRunnerRef,
  });

  return {
    session,
    extensionsResult: resourceLoader.getExtensions(),
    ...(modelResolutionWarning === undefined ? {} : { modelFallbackMessage: modelResolutionWarning }),
  };
}

/** Materialize one native Pi AgentSession from Harness-owned resources. */
export async function createHarnessAgentSession(
  options: CreateHarnessAgentSessionOptions,
): Promise<CreateHarnessAgentLoopResult> {
  const {
    room,
    agent,
    config,
    extensionSources,
    workingDir,
    modelRuntime,
    settingsManager,
    logger,
  } = options;
  const isPrimary = agent.tag.trim() === PRIMARY_AGENT_TAG;
  const cwd = config.cwd;
  const extensionFiles = extensionSources.extensionFiles ?? [];
  const inlineExtensions = extensionSources.inlineExtensions ?? [];
  assertConsumerInlineExtensionNames(inlineExtensions);
  const loopDir = isPrimary
    ? room.roomDir
    : resolve(room.roomDir, "loops", agent.id);
  const contextFile = join(loopDir, "context.jsonl");
  if (config.initialConversationHistory) {
    initializeConversationHistory({
      contextFile,
      cwd,
      history: config.initialConversationHistory,
    });
  }
  const sessionManager = SessionManager.open(contextFile, loopDir, cwd);
  const logTag = `${room.id}/${agent.id}`;
  const { messages: initialMessages, restoredMessageCount } = prepareInitialSessionMessages(
    sessionManager,
    logger,
  );
  if (restoredMessageCount > 0) {
    logger.info(`[${logTag}] Loaded ${restoredMessageCount} messages from context.jsonl`);
  }
  const {
    codemodeExtension,
    compactionStripExtension,
    codexServerCompactionExtension,
    codexServerCompaction,
  } = createBuiltInExtensions({
    roomId: room.id,
    agentId: agent.id,
    sessionManager,
    modelRuntime,
    settingsManager,
    logger,
  });
  const codemodePath = `<inline:${codemodeExtension.name}>`;
  const compactionStripPath = `<inline:${compactionStripExtension.name}>`;
  const codexServerCompactionPath = `<inline:${codexServerCompactionExtension.name}>`;
  const resourceLoader = new MultiAgentPiResourceLoader(
    {
      cwd,
      agentDir: workingDir,
      settingsManager: settingsManager as unknown as SettingsManager,
      additionalExtensionPaths: [...extensionFiles],
      extensionFactories: [
        ...inlineExtensions,
        codemodeExtension,
        compactionStripExtension,
        codexServerCompactionExtension,
      ],
      extensionsOverride: result => {
        const loadedCodemode = result.extensions.find(extension => extension.path === codemodePath);
        const loadedCompactionStrip = result.extensions.find(
          extension => extension.path === compactionStripPath,
        );
        const loadedCodexServerCompaction = result.extensions.find(
          extension => extension.path === codexServerCompactionPath,
        );
        const consumers = result.extensions.filter(extension =>
          extension !== loadedCodemode
          && extension !== loadedCompactionStrip
          && extension !== loadedCodexServerCompaction
        );
        return {
          ...result,
          extensions: [
            ...(loadedCodemode === undefined ? [] : [loadedCodemode]),
            ...(loadedCompactionStrip === undefined ? [] : [loadedCompactionStrip]),
            ...consumers,
            ...(loadedCodexServerCompaction === undefined ? [] : [loadedCodexServerCompaction]),
          ],
        };
      },
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
    },
    {
      roomId: room.id,
      id: agent.id,
      tag: agent.tag.trim(),
      logger,
    },
  );
  await resourceLoader.reload();

  const result = createAgentSession({
    cwd,
    config,
    initialMessages,
    sessionManager,
    settingsManager,
    modelRuntime,
    resourceLoader,
    codexServerCompaction,
  });
  if (result.session.model === undefined) {
    logger.warning(
      "Agent model is not selected",
      result.modelFallbackMessage ?? "No model was resolved for this agent session",
    );
  }
  const loop = AgentLoop.createForHarness({
    identity: agent,
    session: result.session,
    settingsManager,
    logger,
    logTag,
  });
  try {
    await result.session.bindExtensions({
      onError: error => logger.warning(
        "Pi extension error",
        `${error.extensionPath}: ${error.error}`,
      ),
    });
  } catch (error) {
    try {
      await loop.destroy();
    } catch (destroyError) {
      logger.warning(
        `[${logTag}] Failed to clean up after extension binding failed`,
        destroyError instanceof Error ? destroyError.message : String(destroyError),
      );
    }
    throw error;
  }
  return { ...result, loop };
}
