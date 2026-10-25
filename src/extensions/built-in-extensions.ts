import {
  createCodemodeExtension,
  type AgentSession,
  type ExtensionFactory,
  type InlineExtension,
  type ModelRuntime,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createCodexServerCompactionController,
  type CodexServerCompactionController,
} from "../compaction/codex-server-compaction.js";
import type { MultiAgentPiSettingsManager } from "../config/multi-agent-pi-settings-manager.js";
import { setupCompactionStripExtension } from "./compaction-strip/extension.js";
import type { AgentLogger } from "../logger/logger.js";

export interface CreateBuiltInExtensionsOptions {
  readonly roomId: string;
  readonly agentId: string;
  readonly sessionManager: SessionManager;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: MultiAgentPiSettingsManager;
  readonly logger: AgentLogger;
}

export const FRAMEWORK_EXTENSION_NAME_PREFIX = "multi-agent-pi-";

const CODEMODE_TOOL_NAME = "codemode";

interface NamedInlineExtension {
  readonly name: string;
  readonly hidden: true;
  readonly factory: ExtensionFactory;
}

export interface BuiltInExtensions {
  readonly codemodeExtension: NamedInlineExtension;
  readonly compactionStripExtension: NamedInlineExtension;
  readonly codexServerCompactionExtension: NamedInlineExtension;
  readonly codexServerCompaction: CodexServerCompactionController;
}

/** Create the private native extensions installed in every Harness AgentSession. */
export function createBuiltInExtensions(
  options: CreateBuiltInExtensionsOptions,
): BuiltInExtensions {
  const {
    roomId,
    agentId,
    sessionManager,
    modelRuntime,
    settingsManager,
    logger,
  } = options;
  const codexServerCompaction = createCodexServerCompactionController({
    sessionManager,
    modelRuntime,
    settingsManager,
    logger: {
      raw: (message, details) => logger.info(message, details),
      warning: (message, details) => logger.warning(message, details),
    },
  });
  const codemodeExtension: NamedInlineExtension = {
    name: `${FRAMEWORK_EXTENSION_NAME_PREFIX}codemode`,
    hidden: true,
    factory: createCodemodeExtension(),
  };
  const compactionStripExtension: NamedInlineExtension = {
    name: `${FRAMEWORK_EXTENSION_NAME_PREFIX}compaction-strip`,
    hidden: true,
    factory: pi => setupCompactionStripExtension(pi, logger),
  };
  const codexServerCompactionExtension: NamedInlineExtension = {
    name: `${FRAMEWORK_EXTENSION_NAME_PREFIX}codex-server-compaction-${roomId}-${agentId}`,
    hidden: true,
    factory: pi => codexServerCompaction.register(pi),
  };

  return {
    codemodeExtension,
    compactionStripExtension,
    codexServerCompactionExtension,
    codexServerCompaction,
  };
}

/** Reject consumer extension names reserved for framework-owned inline extensions. */
export function assertConsumerInlineExtensionNames(
  extensions: readonly InlineExtension[],
): void {
  const reserved = extensions.find(extension =>
    typeof extension !== "function"
    && extension.name.startsWith(FRAMEWORK_EXTENSION_NAME_PREFIX)
  );
  if (reserved === undefined || typeof reserved === "function") return;
  throw new Error(
    `Consumer inline extension name "${reserved.name}" is reserved; names beginning with `
      + `"${FRAMEWORK_EXTENSION_NAME_PREFIX}" are owned by Pi-Less-Durable`,
  );
}

/** Activate the framework-provided Codemode tool without owning a Pi event handler. */
export function activateCodemode(session: AgentSession): void {
  if (!session.getAllTools().some(tool => tool.name === CODEMODE_TOOL_NAME)) return;
  const activeTools = session.getActiveToolNames();
  if (activeTools.includes(CODEMODE_TOOL_NAME)) return;
  session.setActiveToolsByName([...activeTools, CODEMODE_TOOL_NAME]);
}
