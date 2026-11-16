import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
  AgentSession,
  type CreateAgentSessionResult,
  type ModelRuntime,
  SessionManager,
  type SettingsManager,
  type ToolDefinition,
  convertToLlm,
} from "@earendil-works/pi-coding-agent";
import {
  AgentLoop,
  type AgentLoopPersistence,
  type CreateAgentLoopOptions,
} from "./agent-loop.js";
import {
  createConversationHistoryEntries,
  initializeConversationHistory,
  type ConversationHistory,
} from "./agent-session-utils.js";
import { prepareInitialSessionMessages } from "./runtime-maintainance/context-maintenance.js";
import {
  createAgentSystemPrompt,
  type AgentSystemPrompt,
} from "./system-prompt.js";
import type { CodexServerCompactionController } from "../compaction/codex-server-compaction.js";
import type { MultiAgentPiSettingsManager } from "../config/multi-agent-pi-settings-manager.js";
import { MultiAgentPiResourceLoader } from "../multi-agent-pi/extension-registry.js";
import { MultiAgentPiHarness } from "../multi-agent-pi-harness.js";
import {
  resolveExplicitPersistenceDirectory,
  resolvePersistenceDirectory,
} from "../path-validation.js";
import {
  PRIMARY_AGENT_TAG,
  normalizeAgentIdentity,
} from "../room/loop-manager.js";
import { BackgroundTaskManager } from "../room/background-task-manager.js";
import {
  createAgentExtensionRuntime,
  createAgentExtensions,
  type AgentLoopExtensionSources,
} from "./agent-session-factory-helper/agent-extensions.js";
import {
  createAgentTools,
  PI_DEFAULT_ACTIVE_TOOL_NAMES,
  type AgentToolConfig,
} from "./agent-session-factory-helper/agent-tools.js";

export type {
  AgentLoopExtensionSources,
} from "./agent-session-factory-helper/agent-extensions.js";
export type {
  AgentToolConfig,
  BuiltInToolExecutionMode,
} from "./agent-session-factory-helper/agent-tools.js";

/** Consumer-applied configuration for constructing one agent runtime. */
export interface AgentConfig {
  /** Required working directory for this AgentLoop's native AgentSession and tools. */
  readonly cwd: string;
  readonly model?: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly initialConversationHistory?: ConversationHistory;
  /** Tool registration, filtering, and implementation overrides. */
  readonly toolConfig?: AgentToolConfig;
  /** Mutable structured prompt state owned and exposed by the created AgentLoop. */
  readonly systemPrompt?: AgentSystemPrompt;
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
  readonly customTools: readonly ToolDefinition[];
  readonly piBaseToolOverrides?: Readonly<Record<string, AgentTool>>;
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
    customTools,
    piBaseToolOverrides,
  } = options;
  const sessionContext = sessionManager.buildSessionContext();
  const hasPersistedToolLoadout = getCurrentSystemMessage(sessionContext.messages) !== undefined;
  const initialAdditionalActiveToolNames = config.toolConfig?.initialAdditionalActiveToolNames ?? [];
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

  const {
    extensionRunnerRef,
    mainStreamFn,
    extensionAgentHooks,
  } = createAgentExtensionRuntime(codexServerCompaction);
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
    customTools: [...customTools],
    ...(hasPersistedToolLoadout
      ? {}
      : {
          initialActiveToolNames: [
            ...PI_DEFAULT_ACTIVE_TOOL_NAMES,
            ...initialAdditionalActiveToolNames,
          ],
        }),
    ...(config.toolConfig?.allowedToolNames === undefined
      ? {}
      : { allowedToolNames: [...config.toolConfig.allowedToolNames] }),
    ...(config.toolConfig?.excludedToolNames === undefined
      ? {}
      : { excludedToolNames: [...config.toolConfig.excludedToolNames] }),
    ...(piBaseToolOverrides === undefined
      ? {}
      : { baseToolsOverride: { ...piBaseToolOverrides } }),
  });
  if (hasPersistedToolLoadout && initialAdditionalActiveToolNames.length > 0) {
    session.setActiveToolsByName([
      ...session.getActiveToolNames(),
      ...initialAdditionalActiveToolNames,
    ]);
  }

  return {
    session,
    extensionsResult: resourceLoader.getExtensions(),
    ...(modelResolutionWarning === undefined ? {} : { modelFallbackMessage: modelResolutionWarning }),
  };
}

/** @internal Implement AgentLoop.create() through resources owned by the process singleton Harness. */
export async function createAgentLoop(options: CreateAgentLoopOptions): Promise<AgentLoop> {
  const explicitDir = options.dir;
  const room = options.room;
  if (explicitDir !== undefined && typeof explicitDir !== "string") {
    throw new Error("AgentLoop data directory must be a string");
  }
  const hasDir = typeof explicitDir === "string";
  const hasRoom = room !== undefined;
  const persistence: AgentLoopPersistence = options.persistence ?? "durable";
  if (persistence !== "durable" && persistence !== "memory") {
    throw new Error(
      `AgentLoop "${options.agent.id}" persistence must be "durable" or "memory"`,
    );
  }
  if (hasDir && room?.persistence === "durable") {
    throw new Error(`Durable Room "${room.id}" owns its AgentLoop directories`);
  }
  if (room?.persistence === "memory" && persistence === "durable" && !hasDir) {
    throw new Error(
      `Durable AgentLoop "${options.agent.id}" in memory Room "${room.id}" requires an explicit directory`,
    );
  }
  if (!hasDir && !hasRoom && persistence !== "memory") {
    throw new Error(
      "AgentLoop.create() requires dir or room unless persistence is \"memory\"",
    );
  }
  const agent = normalizeAgentIdentity(options.agent);
  if (!options.config || typeof options.config.cwd !== "string" || !options.config.cwd.trim()) {
    throw new Error(`AgentLoop "${options.agent.id}" requires an explicit cwd`);
  }
  if (options.config.cwd !== options.config.cwd.trim()) {
    throw new Error(
      `AgentLoop "${options.agent.id}" cwd must not contain surrounding whitespace`,
    );
  }

  const harness = MultiAgentPiHarness.instance;
  if (room !== undefined) {
    harness.assertRoomAdmissionAvailable(room);
    if (room.has(agent.id)) {
      throw new Error(`Agent "${agent.id}" already exists in Room "${room.id}"`);
    }
    if (agent.tag === PRIMARY_AGENT_TAG && room.primaryId !== undefined) {
      throw new Error(`Room "${room.id}" already has a primary agent`);
    }
  } else if (harness.isReloading) {
    throw new Error("Cannot create an AgentLoop while the Harness is reloading");
  }

  let loopDir: string | undefined;
  if (typeof explicitDir === "string") {
    loopDir = resolveExplicitPersistenceDirectory(explicitDir, "AgentLoop data directory");
    room?.assertAgentLoopDirectoryAvailable(loopDir);
  } else if (room?.persistence === "durable") {
    const currentDir = room.currentDir;
    if (currentDir === undefined) {
      throw new Error(`Durable Room "${room.id}" requires a current directory`);
    }
    const roomLoopDir = agent.tag === PRIMARY_AGENT_TAG
      ? currentDir
      : resolve(currentDir, "loops", agent.id);
    loopDir = resolvePersistenceDirectory(roomLoopDir);
    room.assertAgentLoopDirectoryAvailable(loopDir);
  }
  const systemPrompt = createAgentSystemPrompt(options.config.systemPrompt);
  const config: AgentConfig = {
    ...options.config,
    cwd: resolve(options.config.cwd),
    systemPrompt,
  };
  const modelRuntime = harness.modelRuntime;
  const settingsManager = harness.settings;
  const logger = harness.logger;
  const cwd = config.cwd;
  let sessionManager: SessionManager;
  if (persistence === "memory") {
    const initialEntries = config.initialConversationHistory === undefined
      ? undefined
      : createConversationHistoryEntries(cwd, config.initialConversationHistory);
    sessionManager = SessionManager.inMemory(cwd, undefined, initialEntries);
  } else {
    if (loopDir === undefined) {
      throw new Error("Durable AgentLoop requires a data directory");
    }
    const contextFile = join(loopDir, "context.jsonl");
    if (config.initialConversationHistory !== undefined) {
      initializeConversationHistory({
        contextFile,
        cwd,
        history: config.initialConversationHistory,
      });
    }
    sessionManager = SessionManager.open(contextFile, loopDir, cwd);
  }
  const logTag = room === undefined ? agent.tag : `${room.id}/${agent.tag}`;
  const { messages: initialMessages, restoredMessageCount } = prepareInitialSessionMessages(
    sessionManager,
    logger,
  );
  if (restoredMessageCount > 0) {
    const source = persistence === "memory" ? "initial in-memory history" : "context.jsonl";
    logger.info(`[${logTag}] Loaded ${restoredMessageCount} messages from ${source}`);
  }

  const backgroundTasks = new BackgroundTaskManager({
    ...(room === undefined ? {} : { roomId: room.id }),
    agentId: agent.id,
    logger,
  });
  let boundLoop: AgentLoop | undefined;
  const getInitiatingLoop = (): AgentLoop => {
    if (boundLoop === undefined) {
      throw new Error(`AgentLoop "${agent.id}" is not bound`);
    }
    return boundLoop;
  };
  const {
    customTools,
    piBaseToolOverrides,
    defaultPiBaseToolDefinitions,
  } = createAgentTools({
    config: config.toolConfig ?? {},
    cwd,
    backgroundTasks,
    getInitiatingLoop,
    modelRuntime,
    settingsManager,
    logger,
  });
  const {
    resourceLoader,
    codexServerCompaction,
    disabledExtensions,
  } = await createAgentExtensions({
    agent,
    ...(room === undefined ? {} : { roomId: room.id }),
    cwd,
    ...(options.extensionSources === undefined
      ? {}
      : { extensionSources: options.extensionSources }),
    systemPrompt,
    defaultPiBaseToolDefinitions,
    sessionManager,
  });

  const result = createPiAgentSession({
    cwd,
    config,
    initialMessages,
    sessionManager,
    settingsManager,
    modelRuntime,
    resourceLoader,
    codexServerCompaction,
    customTools,
    ...(piBaseToolOverrides === undefined ? {} : { piBaseToolOverrides }),
  });
  if (result.session.model === undefined) {
    logger.warning(
      "Agent model is not selected",
      result.modelFallbackMessage ?? "No model was resolved for this agent session",
    );
  }

  if (loopDir === undefined) {
    try {
      const temporaryRoot = resolvePersistenceDirectory(tmpdir());
      loopDir = mkdtempSync(join(temporaryRoot, "pi-less-durable-agent-loop-"));
    } catch (error) {
      try {
        result.session.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `AgentLoop "${agent.id}" failed temporary-directory allocation and cleanup`,
        );
      }
      throw error;
    }
  }
  const loop = await AgentLoop.bindSession({
    dir: loopDir,
    persistence,
    identity: agent,
    session: result.session,
    backgroundTasks,
    settingsManager,
    logger,
    disabledExtensions,
    systemPrompt,
  });
  boundLoop = loop;
  if (room === undefined) return loop;

  try {
    room.register(loop);
    return loop;
  } catch (error) {
    try {
      await loop.destroy();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Room "${room.id}" failed to discard agent "${agent.id}" cleanly`,
      );
    }
    throw error;
  }
}
