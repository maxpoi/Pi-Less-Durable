import { basename, dirname, extname } from "node:path";
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
import type { AgentLogger } from "../logger/logger.js";
import type { AgentIdentity } from "../room/loop-manager.js";
import bashTimeoutGuardExtension from "./bash-timeout-guard/extension.js";
import { setupCompactionStripExtension } from "./compaction-strip/extension.js";
import { createGitGuardExtension } from "./git-guard/extension.js";
import permissionGateExtension from "./permission-gate/extension.js";
import protectedPathsExtension from "./protected-paths/extension.js";

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

/** Match public disable names against framework inline and consumer source paths. */
export function isExtensionDisabled(
  path: string,
  disabledExtensions: ReadonlySet<string>,
): boolean {
  const inlinePrefix = "<inline:";
  if (path.startsWith(inlinePrefix) && path.endsWith(">")) {
    const inlineName = path.slice(inlinePrefix.length, -1);
    if (
      inlineName === `${FRAMEWORK_EXTENSION_NAME_PREFIX}${CODEMODE_EXTENSION_NAME}`
      || inlineName.startsWith(
        `${FRAMEWORK_EXTENSION_NAME_PREFIX}${CODEX_SERVER_COMPACTION_EXTENSION_NAME}-`,
      )
    ) {
      return false;
    }
    const publicName = inlineName.startsWith(FRAMEWORK_EXTENSION_NAME_PREFIX)
      ? inlineName.slice(FRAMEWORK_EXTENSION_NAME_PREFIX.length)
      : inlineName;
    return disabledExtensions.has(publicName);
  }

  const fileName = basename(path);
  const sourceName = fileName.slice(0, fileName.length - extname(fileName).length);
  const directoryName = basename(dirname(path));
  if (sourceName === "index") return disabledExtensions.has(directoryName);
  return disabledExtensions.has(directoryName) || disabledExtensions.has(sourceName);
}

interface NamedInlineExtension {
  readonly name: string;
  readonly hidden: true;
  readonly factory: ExtensionFactory;
}

export interface BuiltInExtensions {
  readonly codemodeExtension: NamedInlineExtension;
  readonly compactionStripExtension: NamedInlineExtension;
  readonly defaultExtensions: readonly NamedInlineExtension[];
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
    "compaction-strip",
    pi => setupCompactionStripExtension(pi, logger),
    disabledExtensions,
  );
  const defaultExtensions: readonly NamedInlineExtension[] = Object.freeze([
    createDisableableExtension(
      "bash-timeout-guard",
      bashTimeoutGuardExtension,
      disabledExtensions,
    ),
    createDisableableExtension(
      "git-guard",
      createGitGuardExtension(settingsManager),
      disabledExtensions,
    ),
    createDisableableExtension(
      "permission-gate",
      permissionGateExtension,
      disabledExtensions,
    ),
    createDisableableExtension(
      "protected-paths",
      protectedPathsExtension,
      disabledExtensions,
    ),
  ]);
  const codexServerCompactionExtension: NamedInlineExtension = {
    name: `${FRAMEWORK_EXTENSION_NAME_PREFIX}${CODEX_SERVER_COMPACTION_EXTENSION_NAME}-${agent.id}`,
    hidden: true,
    factory: pi => codexServerCompaction.register(pi),
  };

  return {
    codemodeExtension,
    compactionStripExtension,
    defaultExtensions,
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
  if (!session.getAllTools().some(tool => tool.name === CODEMODE_EXTENSION_NAME)) return;
  const activeTools = session.getActiveToolNames();
  if (activeTools.includes(CODEMODE_EXTENSION_NAME)) return;
  session.setActiveToolsByName([...activeTools, CODEMODE_EXTENSION_NAME]);
}
