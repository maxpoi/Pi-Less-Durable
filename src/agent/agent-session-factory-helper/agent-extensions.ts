import { resolve } from "node:path";
import type {
  ExtensionRunner,
  SessionManager,
  SettingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CodexServerCompactionController } from "../../compaction/codex-server-compaction.js";
import type { AgentLogger } from "../../logger/logger.js";
import {
  CODEMODE_EXTENSION_NAME,
  CODEX_SERVER_COMPACTION_EXTENSION_NAME,
  COMPACTION_STRIP_EXTENSION_NAME,
  createBuiltInExtensions,
} from "../../extensions/built-in-extensions.js";
import { MultiAgentPiHarness } from "../../multi-agent-pi-harness.js";
import { MultiAgentPiResourceLoader } from "../../multi-agent-pi/extension-registry.js";
import {
  createHarnessExtensionMatcher,
  getValidExtensionName,
  type HarnessExtensionFile,
  type HarnessInlineExtension,
} from "../../extensions/extension-catalog.js";
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
  /** Harness catalog allowlist by catalog name. Undefined allows all; an empty list allows none. */
  readonly allowedExtensions?: readonly string[];
  /** Harness catalog denylist applied after the allowlist. */
  readonly excludedExtensions?: readonly string[];
  /** Named exact file sources added only to this AgentLoop and unaffected by catalog filtering. */
  readonly additionalExtensionFiles?: readonly HarnessExtensionFile[];
  /** Named inline sources added only to this AgentLoop and unaffected by catalog filtering. */
  readonly additionalInlineExtensions?: readonly HarnessInlineExtension[];
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

function createFrameworkExtensionSources(
  promptExtensions: ReturnType<typeof createAgentSystemPromptExtensions>,
  codemodeExtension: HarnessInlineExtension,
  compactionStripExtension: HarnessInlineExtension,
  codexServerCompactionExtension: HarnessInlineExtension,
): Array<{
  readonly name: string;
  readonly kind: "inline";
  readonly extension: HarnessInlineExtension;
}> {
  const extensions: Array<readonly [string, HarnessInlineExtension]> = [
    [promptExtensions.composer.name, promptExtensions.composer],
    [CODEMODE_EXTENSION_NAME, codemodeExtension],
    [COMPACTION_STRIP_EXTENSION_NAME, compactionStripExtension],
    [CODEX_SERVER_COMPACTION_EXTENSION_NAME, codexServerCompactionExtension],
    [promptExtensions.finalizer.name, promptExtensions.finalizer],
  ];
  return extensions.map(([name, extension]) => ({
    name,
    kind: "inline",
    extension,
  }));
}

function resolveAdditionalExtensions(
  sources: AgentLoopExtensionSources | undefined,
  logger: AgentLogger,
): {
  readonly files: readonly HarnessExtensionFile[];
  readonly inline: readonly HarnessInlineExtension[];
} {
  const files = (sources?.additionalExtensionFiles ?? []).flatMap(extension => {
    const name = getValidExtensionName(extension);
    if (name === undefined) {
      logger.warning(
        "Skipping invalid AgentLoop extension",
        "Additional extension files require a non-empty name",
      );
      return [];
    }
    if (typeof extension.path !== "string" || !extension.path.trim()) {
      logger.warning(
        "Skipping invalid AgentLoop extension",
        `Additional extension file "${name}" requires a non-empty path`,
      );
      return [];
    }
    return [{ name, path: resolve(extension.path) }];
  });
  const inline = (sources?.additionalInlineExtensions ?? []).flatMap(extension => {
    const name = getValidExtensionName(extension);
    if (name === undefined) {
      logger.warning(
        "Skipping invalid AgentLoop extension",
        "Inline extensions require a non-empty name",
      );
      return [];
    }
    if (typeof extension.factory !== "function") {
      logger.warning(
        "Skipping invalid AgentLoop extension",
        `Inline extension "${name}" requires a factory`,
      );
      return [];
    }
    return [extension];
  });
  return { files, inline };
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
  const {
    files: additionalExtensionFiles,
    inline: additionalInlineExtensions,
  } = resolveAdditionalExtensions(options.extensionSources, harness.logger);
  const isHarnessExtensionSelected = createHarnessExtensionMatcher(
    options.extensionSources ?? {},
  );
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
        const loadedCompactionStrip = result.extensions.find(
          extension => extension.path === compactionStripPath,
        );
        const loadedCodexServerCompaction = result.extensions.find(
          extension => extension.path === codexServerCompactionPath,
        );
        const consumers = result.extensions.filter(extension =>
          extension.path !== promptComposerPath
          && extension.path !== promptFinalizerPath
          && extension.path !== codemodePath
          && extension.path !== compactionStripPath
          && extension.path !== codexServerCompactionPath
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
    () => [
      ...harness.extensionCatalog
        .filter(isHarnessExtensionSelected)
        .map(extension => extension.kind === "file"
          ? {
              name: extension.name,
              kind: "file" as const,
              path: extension.path,
            }
          : {
              name: extension.name,
              kind: "inline" as const,
              extension: extension.extension,
            }),
      ...additionalExtensionFiles.map(extension => ({
        name: extension.name,
        kind: "file" as const,
        path: extension.path,
      })),
      ...additionalInlineExtensions.map(extension => ({
        name: extension.name,
        kind: "inline" as const,
        extension,
      })),
      ...createFrameworkExtensionSources(
        promptExtensions,
        codemodeExtension,
        compactionStripExtension,
        codexServerCompactionExtension,
      ),
    ],
    disabledExtensions,
  );
  await resourceLoader.reload();
  return {
    resourceLoader,
    codexServerCompaction,
    disabledExtensions,
  };
}
