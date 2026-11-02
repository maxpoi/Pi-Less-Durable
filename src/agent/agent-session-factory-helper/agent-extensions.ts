import { resolve } from "node:path";
import type {
  ExtensionRunner,
  InlineExtension,
  SessionManager,
  SettingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CodexServerCompactionController } from "../../compaction/codex-server-compaction.js";
import {
  assertConsumerInlineExtensionNames,
  createBuiltInExtensions,
  isExtensionDisabled,
} from "../../extensions/built-in-extensions.js";
import { MultiAgentPiHarness } from "../../multi-agent-pi-harness.js";
import { MultiAgentPiResourceLoader } from "../../multi-agent-pi/extension-registry.js";
import type { RoomId } from "../../room/room-types.js";
import type { AgentIdentity } from "../../room/loop-manager.js";
import {
  createPiExtensionAgentHooks,
  createPiExtensionStreamFn,
} from "../to-pi-bindings/pi-extension-bindings.js";
import { createProviderStreamFn } from "../to-pi-bindings/provider-stream.js";
import {
  createAgentSystemPromptExtensions,
  resolveAgentSystemPromptMain,
  type AgentSystemPrompt,
} from "../system-prompt.js";

/** Native Pi extension sources selected for one AgentLoop. */
export interface AgentLoopExtensionSources {
  readonly extensionFiles?: readonly string[];
  readonly inlineExtensions?: readonly InlineExtension[];
}

interface CreateAgentExtensionsOptions {
  readonly agent: AgentIdentity;
  readonly roomId?: RoomId;
  readonly cwd: string;
  readonly extensionSources?: AgentLoopExtensionSources;
  readonly systemPrompt: AgentSystemPrompt;
  readonly defaultPiBaseToolDefinitions: readonly ToolDefinition<any, any, any>[];
  readonly sessionManager: SessionManager;
}

interface AgentExtensionRuntime {
  readonly extensionRunnerRef: { current?: ExtensionRunner };
  readonly mainStreamFn: ReturnType<typeof createPiExtensionStreamFn>;
  readonly extensionAgentHooks: ReturnType<typeof createPiExtensionAgentHooks>;
}

interface AgentExtensionsAssembly {
  readonly resourceLoader: MultiAgentPiResourceLoader;
  readonly codexServerCompaction: CodexServerCompactionController;
  readonly disabledExtensions: Set<string>;
}

/** Bind provider execution through the native Pi extension runner. */
export function createAgentExtensionRuntime(
  codexServerCompaction: CodexServerCompactionController,
): AgentExtensionRuntime {
  const harness = MultiAgentPiHarness.instance;
  const extensionRunnerRef: { current?: ExtensionRunner } = {};
  const rawStreamFn = createProviderStreamFn(harness.modelRuntime, harness.settings);
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
  return { extensionRunnerRef, mainStreamFn, extensionAgentHooks };
}

/** Assemble, order, and load all framework and consumer extensions for one AgentLoop. */
export async function createAgentExtensions(
  options: CreateAgentExtensionsOptions,
): Promise<AgentExtensionsAssembly> {
  const harness = MultiAgentPiHarness.instance;
  const extensionFiles = [...new Set(
    (options.extensionSources?.extensionFiles ?? []).map(extensionPath =>
      resolve(process.cwd(), extensionPath)
    ),
  )];
  const inlineExtensions = [...(options.extensionSources?.inlineExtensions ?? [])];
  assertConsumerInlineExtensionNames(inlineExtensions);
  const disabledExtensions = new Set<string>();
  const {
    codemodeExtension,
    compactionStripExtension,
    codexServerCompactionExtension,
    codexServerCompaction,
  } = createBuiltInExtensions({
    agent: options.agent,
    sessionManager: options.sessionManager,
    modelRuntime: harness.modelRuntime,
    settingsManager: harness.settings,
    logger: harness.logger,
    disabledExtensions,
  });
  const promptExtensions = createAgentSystemPromptExtensions(
    options.systemPrompt,
    options.defaultPiBaseToolDefinitions,
  );
  const promptComposerPath = `<inline:${promptExtensions.composer.name}>`;
  const promptFinalizerPath = `<inline:${promptExtensions.finalizer.name}>`;
  const codemodePath = `<inline:${codemodeExtension.name}>`;
  const compactionStripPath = `<inline:${compactionStripExtension.name}>`;
  const codexServerCompactionPath = `<inline:${codexServerCompactionExtension.name}>`;
  const resourceLoader = new MultiAgentPiResourceLoader(
    {
      cwd: options.cwd,
      agentDir: harness.workingDir,
      settingsManager: harness.settings as unknown as SettingsManager,
      additionalExtensionPaths: extensionFiles,
      extensionFactories: [
        promptExtensions.composer,
        ...inlineExtensions,
        codemodeExtension,
        compactionStripExtension,
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
        const loadedCodexServerCompaction = result.extensions.find(
          extension => extension.path === codexServerCompactionPath,
        );
        const consumers = result.extensions.filter(extension =>
          extension.path !== promptComposerPath
          && extension.path !== promptFinalizerPath
          && extension.path !== codemodePath
          && extension.path !== compactionStripPath
          && extension.path !== codexServerCompactionPath
          && !isExtensionDisabled(extension.path, disabledExtensions)
        );
        return {
          ...result,
          extensions: [
            ...(loadedPromptComposer === undefined ? [] : [loadedPromptComposer]),
            ...(loadedCodemode === undefined ? [] : [loadedCodemode]),
            ...(loadedCompactionStrip === undefined ? [] : [loadedCompactionStrip]),
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
      systemPrompt: resolveAgentSystemPromptMain(options.systemPrompt.main),
      systemPromptOverride: () => resolveAgentSystemPromptMain(options.systemPrompt.main),
      appendSystemPrompt: [],
      appendSystemPromptOverride: () => [],
    },
    {
      roomId: options.roomId,
      id: options.agent.id,
      tag: options.agent.tag,
      logger: harness.logger,
    },
    harness.extensionFiles,
  );
  await resourceLoader.reload();
  return {
    resourceLoader,
    codexServerCompaction,
    disabledExtensions,
  };
}
