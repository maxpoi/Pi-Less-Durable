import {
  createCodemodeExtension,
  type ExtensionFactory,
  type ModelRuntime,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  createCodexServerCompactionController,
  type CodexServerCompactionController,
} from "../compaction/codex-server-compaction.js";
import type { MultiAgentPiSettingsManager } from "../config/multi-agent-pi-settings-manager.js";
import type { AgentLogger } from "../logger/logger.js";
import type { AgentIdentity } from "../room/loop-manager.js";
import { setupCompactionStripExtension } from "./compaction-strip/extension.js";

export interface CreateBuiltInExtensionsOptions {
  readonly agent: AgentIdentity;
  readonly sessionManager: SessionManager;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: MultiAgentPiSettingsManager;
  readonly logger: AgentLogger;
  readonly disabledExtensions: ReadonlySet<string>;
}

export const FRAMEWORK_EXTENSION_NAME_PREFIX = "multi-agent-pi-";
export const CODEMODE_EXTENSION_NAME = "codemode";
export const CODEX_SERVER_COMPACTION_EXTENSION_NAME = "codex-server-compaction";
export const COMPACTION_STRIP_EXTENSION_NAME = "compaction-strip";

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

function createDisableableExtension(
  name: string,
  factory: ExtensionFactory,
  disabledExtensions: ReadonlySet<string>,
): NamedInlineExtension {
  return {
    name: `${FRAMEWORK_EXTENSION_NAME_PREFIX}${name}`,
    hidden: true,
    factory: pi => {
      if (disabledExtensions.has(name)) return;
      return factory(pi);
    },
  };
}

/** Create the private native extensions installed in every Harness AgentSession. */
export function createBuiltInExtensions(
  options: CreateBuiltInExtensionsOptions,
): BuiltInExtensions {
  const {
    agent,
    sessionManager,
    modelRuntime,
    settingsManager,
    logger,
    disabledExtensions,
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
    name: `${FRAMEWORK_EXTENSION_NAME_PREFIX}${CODEMODE_EXTENSION_NAME}`,
    hidden: true,
    factory: createCodemodeExtension(),
  };
  const compactionStripExtension = createDisableableExtension(
    COMPACTION_STRIP_EXTENSION_NAME,
    pi => setupCompactionStripExtension(pi, logger),
    disabledExtensions,
  );
  const codexServerCompactionExtension: NamedInlineExtension = {
    name: `${FRAMEWORK_EXTENSION_NAME_PREFIX}${CODEX_SERVER_COMPACTION_EXTENSION_NAME}-${agent.id}`,
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
