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
  type CreateAgentSessionResult,
  type ExtensionRunner,
  type InlineExtension,
  type ModelRuntime,
  SessionManager,
  type SettingsManager,
  convertToLlm,
} from "@earendil-works/pi-coding-agent";
import { AgentLoop, type CreateAgentLoopOptions } from "./agent-loop.js";
import {
  initializeConversationHistory,
  type ConversationHistory,
} from "./agent-session-utils.js";
import {
  FRAMEWORK_EXTENSION_NAME_PREFIX,
  assertConsumerInlineExtensionNames,
  createBuiltInExtensions,
  isExtensionDisabled,
} from "../extensions/built-in-extensions.js";
import { prepareInitialSessionMessages } from "./runtime-maintainance/context-maintenance.js";
import {
  createPiExtensionAgentHooks,
  createPiExtensionStreamFn,
} from "./to-pi-bindings/pi-extension-bindings.js";
import { createProviderStreamFn } from "./to-pi-bindings/provider-stream.js";
import {
  createAgentSystemPrompt,
  createAgentSystemPromptExtensions,
  resolveAgentSystemPromptMain,
  type AgentSystemPrompt,
} from "./system-prompt.js";
import type { AgentLogger } from "../logger/logger.js";
import type { CodexServerCompactionController } from "../compaction/codex-server-compaction.js";
import type { MultiAgentPiSettingsManager } from "../config/multi-agent-pi-settings-manager.js";
import { MultiAgentPiResourceLoader } from "../extensions/multi-agent-pi-extension-registry.js";
import { MultiAgentPiHarness } from "../multi-agent-pi-harness.js";
import {
  resolveExplicitPersistenceDirectory,
  resolvePersistenceDirectory,
} from "../path-validation.js";
import {
  PRIMARY_AGENT_TAG,
  assertAgentIdentity,
  type AgentIdentity,
} from "../room/loop-manager.js";


/** Consumer-applied configuration for constructing one agent runtime. */
export interface AgentConfig {
  /** Required working directory for this AgentLoop's native AgentSession and tools. */
  readonly cwd: string;
  readonly model?: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly initialConversationHistory?: ConversationHistory;
  /** Mutable structured prompt state owned and exposed by the created AgentLoop. */
  readonly systemPrompt?: AgentSystemPrompt;
}

/** Native Pi extension sources selected for one AgentLoop. */
export interface AgentLoopExtensionSources {
  readonly extensionFiles?: readonly string[];
  readonly inlineExtensions?: readonly InlineExtension[];
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
function createPiAgentSession(options: CreateNativeAgentSessionOptions): CreateAgentSessionResult {
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

/** @internal Implement AgentLoop.create() through resources owned by the process singleton Harness. */
export async function createAgentLoop(options: CreateAgentLoopOptions): Promise<AgentLoop> {
  const hasDir = typeof options.dir === "string";
  const hasRoom = options.room !== undefined;
  if (hasDir === hasRoom) {
    throw new Error("AgentLoop.create() requires exactly one of dir or room");
  }
  assertAgentIdentity(options.agent);
  if (!options.config || typeof options.config.cwd !== "string" || !options.config.cwd.trim()) {
    throw new Error(`AgentLoop "${options.agent.id}" requires an explicit cwd`);
  }

  const harness = MultiAgentPiHarness.instance;
  if (hasRoom) {
    const room = options.room!;
    harness.assertRoomAdmissionAvailable(room);
    if (room.has(options.agent.id)) {
      throw new Error(`Agent "${options.agent.id}" already exists in Room "${room.id}"`);
    }
    if (options.agent.tag.trim() === PRIMARY_AGENT_TAG && room.primaryId !== undefined) {
      throw new Error(`Room "${room.id}" already has a primary agent`);
    }
  } else if (harness.isReloading) {
    throw new Error("Cannot create an AgentLoop while the Harness is reloading");
  }

  const dir = hasDir
    ? options.dir!
    : options.agent.tag.trim() === PRIMARY_AGENT_TAG
      ? options.room!.roomDir
      : resolve(options.room!.roomDir, "loops", options.agent.id);

  const agent = options.agent;
  const systemPrompt = createAgentSystemPrompt(options.config.systemPrompt);
  const config: AgentConfig = {
    ...options.config,
    cwd: resolve(options.config.cwd),
    systemPrompt,
  };
  const extensionFiles = [...new Set(
    (options.extensionSources?.extensionFiles ?? []).map(extensionPath =>
      resolve(process.cwd(), extensionPath)
    ),
  )];
  const inlineExtensions = [...(options.extensionSources?.inlineExtensions ?? [])];
  const harnessExtensionFiles = harness.extensionFiles;
  const workingDir = harness.workingDir;
  const modelRuntime = harness.modelRuntime;
  const settingsManager = harness.settings;
  const logger = harness.logger;
  const cwd = config.cwd;
  const disabledExtensions = new Set<string>();
  assertConsumerInlineExtensionNames(inlineExtensions);
  const loopDir = hasDir
    ? resolveExplicitPersistenceDirectory(dir, "AgentLoop persistence directory")
    : resolvePersistenceDirectory(dir);
  if (hasRoom) options.room!.assertAgentLoopDirectoryAvailable(loopDir);
  const contextFile = join(loopDir, "context.jsonl");
  if (config.initialConversationHistory) {
    initializeConversationHistory({
      contextFile,
      cwd,
      history: config.initialConversationHistory,
    });
  }
  const sessionManager = SessionManager.open(contextFile, loopDir, cwd);
  const logTag = hasRoom ? `${options.room!.id}/${agent.tag.trim()}` : agent.tag.trim();
  const piSettingsManager = settingsManager as unknown as SettingsManager;
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
    defaultExtensions,
    codexServerCompactionExtension,
    codexServerCompaction,
  } = createBuiltInExtensions({
    agent,
    sessionManager,
    modelRuntime,
    settingsManager,
    logger,
    disabledExtensions,
  });
  const promptExtensions = createAgentSystemPromptExtensions(systemPrompt);
  const promptComposerPath = `<inline:${promptExtensions.composer.name}>`;
  const promptFinalizerPath = `<inline:${promptExtensions.finalizer.name}>`;
  const codemodePath = `<inline:${codemodeExtension.name}>`;
  const compactionStripPath = `<inline:${compactionStripExtension.name}>`;
  const defaultExtensionPaths = new Set(
    defaultExtensions.map(extension => `<inline:${extension.name}>`),
  );
  const codexServerCompactionPath = `<inline:${codexServerCompactionExtension.name}>`;
  const resourceLoader = new MultiAgentPiResourceLoader(
    {
      cwd,
      agentDir: workingDir,
      settingsManager: piSettingsManager,
      additionalExtensionPaths: [...extensionFiles],
      extensionFactories: [
        promptExtensions.composer,
        ...inlineExtensions,
        codemodeExtension,
        compactionStripExtension,
        ...defaultExtensions,
        codexServerCompactionExtension,
        promptExtensions.finalizer,
      ],
      extensionsOverride: result => {
        const loadedPromptComposer = result.extensions.find(
          extension => extension.path === promptComposerPath,
        );
        const loadedPromptFinalizer = result.extensions.find(
          extension => extension.path === promptFinalizerPath,
        );
        const loadedCodemode = result.extensions.find(
          extension => extension.path === codemodePath,
        );
        const loadedCompactionStrip = disabledExtensions.has("compaction-strip")
          ? undefined
          : result.extensions.find(extension => extension.path === compactionStripPath);
        const loadedDefaultExtensions = defaultExtensions.flatMap(defaultExtension => {
          const path = `<inline:${defaultExtension.name}>`;
          const publicName = defaultExtension.name.slice(FRAMEWORK_EXTENSION_NAME_PREFIX.length);
          if (disabledExtensions.has(publicName)) return [];
          const loaded = result.extensions.find(extension => extension.path === path);
          return loaded === undefined ? [] : [loaded];
        });
        const loadedCodexServerCompaction = result.extensions.find(
          extension => extension.path === codexServerCompactionPath,
        );
        const consumers = result.extensions.filter(extension =>
          extension.path !== promptComposerPath
          && extension.path !== promptFinalizerPath
          && extension.path !== codemodePath
          && extension.path !== compactionStripPath
          && !defaultExtensionPaths.has(extension.path)
          && extension.path !== codexServerCompactionPath
          && !isExtensionDisabled(extension.path, disabledExtensions)
        );
        return {
          ...result,
          extensions: [
            ...(loadedPromptComposer === undefined ? [] : [loadedPromptComposer]),
            ...(loadedCodemode === undefined ? [] : [loadedCodemode]),
            ...(loadedCompactionStrip === undefined ? [] : [loadedCompactionStrip]),
            ...loadedDefaultExtensions,
            ...consumers,
            ...(loadedCodexServerCompaction === undefined
              ? []
              : [loadedCodexServerCompaction]),
            ...(loadedPromptFinalizer === undefined ? [] : [loadedPromptFinalizer]),
          ],
        };
      },
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: resolveAgentSystemPromptMain(systemPrompt.main),
      systemPromptOverride: () => resolveAgentSystemPromptMain(systemPrompt.main),
      appendSystemPrompt: [],
      appendSystemPromptOverride: () => [],
    },
    {
      ...(hasRoom ? { roomId: options.room!.id } : {}),
      id: agent.id,
      tag: agent.tag.trim(),
      logger,
    },
    harnessExtensionFiles,
  );
  await resourceLoader.reload();

  const result = createPiAgentSession({
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

  const loop = await AgentLoop.bindSession({
    dir: loopDir,
    identity: agent,
    session: result.session,
    settingsManager,
    logger,
    disabledExtensions,
    systemPrompt,
  });
  if (!hasRoom) return loop;

  try {
    options.room!.register(loop);
    return loop;
  } catch (error) {
    try {
      await loop.destroy();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Room "${options.room!.id}" failed to discard agent "${loop.id}" cleanly`,
      );
    }
    throw error;
  }
}
