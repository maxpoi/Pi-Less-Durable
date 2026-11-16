import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type ModelRuntime,
  type ToolDefinition,
  type ToolsOptions,
  createBashTool,
  createBashToolDefinition,
  createEditTool,
  createEditToolDefinition,
  createFindTool,
  createFindToolDefinition,
  createGrepTool,
  createGrepToolDefinition,
  createLsTool,
  createLsToolDefinition,
  createPowerShellTool,
  createPowerShellToolDefinition,
  createReadTool,
  createReadToolDefinition,
  createWriteTool,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { MultiAgentPiSettingsManager } from "../../config/multi-agent-pi-settings-manager.js";
import { CODEMODE_EXTENSION_NAME } from "../../extensions/built-in-extensions.js";
import type { AgentLogger } from "../../logger/logger.js";
import type { BackgroundTaskManager } from "../../room/background-task-manager.js";
import {
  createCancelCodeReviewTool,
  createCodeReviewTool,
} from "../../tools/code-review.js";
import {
  createComputerActionTool,
  isComputerActionSupported,
} from "../../tools/computer-use.js";
import {
  detachAgentTool,
  detachToolDefinition,
  type DetachedBuiltInToolOptions,
} from "../../tools/detached-built-in-tool.js";
import { withProgressLabel } from "../../tools/progress-label.js";
import {
  createScreenshotTool,
  isScreenshotSupported,
} from "../../tools/screenshot.js";
import type { AgentLoop } from "../agent-loop.js";

const PI_BASE_TOOL_NAMES = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
type PiBaseToolName = typeof PI_BASE_TOOL_NAMES[number];
const PI_BASE_TOOL_NAME_SET = new Set<string>(PI_BASE_TOOL_NAMES);

export const PI_DEFAULT_ACTIVE_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export type BuiltInToolExecutionMode = "foreground" | "detached";

export interface AgentToolConfig {
  /** Inline definitions added to the native AgentSession registry after extension tools. */
  readonly additionalTools?: readonly ToolDefinition[];
  /** Tool names activated at creation in addition to the fresh or transcript-restored active set. */
  readonly initialAdditionalActiveToolNames?: readonly string[];
  /** Native Pi allowlist. Undefined allows all names; an empty list allows none. */
  readonly allowedToolNames?: readonly string[];
  /** Native Pi denylist applied after the allowlist. */
  readonly excludedToolNames?: readonly string[];
  /** Execution overrides partitioned between Pi base tools and framework-owned tools. */
  readonly baseToolOverrides?: Readonly<Record<string, AgentTool>>;
  /** Run Pi base and framework-owned tools inline or detached. */
  readonly builtInToolExecutionMode?: BuiltInToolExecutionMode;
}

export interface CreateAgentToolsOptions {
  readonly config: AgentToolConfig;
  readonly cwd: string;
  readonly backgroundTasks: BackgroundTaskManager;
  readonly getInitiatingLoop: () => AgentLoop;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: MultiAgentPiSettingsManager;
  readonly logger: AgentLogger;
}

export interface AgentToolsAssembly {
  readonly customTools: ToolDefinition[];
  readonly piBaseToolOverrides?: Readonly<Record<string, AgentTool>>;
  readonly defaultPiBaseToolDefinitions: readonly ToolDefinition<any, any, any>[];
}

function applyFrameworkToolOverride(
  definition: ToolDefinition,
  override: AgentTool,
): ToolDefinition {
  const merged: ToolDefinition = {
    ...definition,
    ...override,
    name: definition.name,
  };
  if (override.executionMode === undefined && definition.executionMode !== undefined) {
    merged.executionMode = definition.executionMode;
  }
  return merged;
}

function createDefaultPiToolOptions(
  settingsManager: MultiAgentPiSettingsManager,
): ToolsOptions {
  const bash: NonNullable<ToolsOptions["bash"]> = {};
  const commandPrefix = settingsManager.getShellCommandPrefix();
  const shellPath = settingsManager.getShellPath();
  if (commandPrefix !== undefined) bash.commandPrefix = commandPrefix;
  if (shellPath !== undefined) bash.shellPath = shellPath;
  return {
    read: { autoResizeImages: settingsManager.getImageAutoResize() },
    bash,
  };
}

function createDefaultPiBaseTools(
  cwd: string,
  options: ToolsOptions,
): Record<PiBaseToolName, AgentTool> {
  return {
    read: createReadTool(cwd, options.read),
    bash: createBashTool(cwd, options.bash),
    powershell: createPowerShellTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
  };
}

function createDefaultPiBaseToolDefinitions(
  cwd: string,
  options: ToolsOptions,
): Array<ToolDefinition<any, any, any>> {
  return [
    createReadToolDefinition(cwd, options.read),
    createBashToolDefinition(cwd, options.bash),
    createPowerShellToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ];
}

function assembleTools(
  config: AgentToolConfig,
  frameworkTools: readonly ToolDefinition[],
  defaultPiBaseTools: Readonly<Record<PiBaseToolName, AgentTool>>,
  logger: AgentLogger,
  detachedOptions: DetachedBuiltInToolOptions,
): Pick<AgentToolsAssembly, "customTools" | "piBaseToolOverrides"> {
  const frameworkToolsByName = new Map(frameworkTools.map(tool => [tool.name, tool]));
  const frameworkOverrides: Record<string, AgentTool> = {};
  const piBaseToolOverrides: Record<string, AgentTool> = {};
  for (const [name, override] of Object.entries(config.baseToolOverrides ?? {})) {
    if (override.name !== name) {
      throw new Error(
        `baseToolOverrides key "${name}" does not match tool name "${override.name}"`,
      );
    }
    if (frameworkToolsByName.has(name)) {
      frameworkOverrides[name] = override;
    } else if (PI_BASE_TOOL_NAME_SET.has(name)) {
      piBaseToolOverrides[name] = override;
    } else {
      throw new Error(`baseToolOverrides cannot override unknown base tool "${name}"`);
    }
  }

  const detached = config.builtInToolExecutionMode === "detached";
  const customTools = frameworkTools.map(definition => {
    const override = frameworkOverrides[definition.name];
    const labeled = withProgressLabel(
      override === undefined
        ? definition
        : applyFrameworkToolOverride(definition, override),
    );
    if (!detached || (definition.name === "code_review" && override === undefined)) {
      return labeled;
    }
    return detachToolDefinition(labeled, detachedOptions);
  });

  const additionalToolsByName = new Map<string, ToolDefinition>();
  for (const definition of config.additionalTools ?? []) {
    if (
      PI_BASE_TOOL_NAME_SET.has(definition.name)
      || frameworkToolsByName.has(definition.name)
      || definition.name === CODEMODE_EXTENSION_NAME
    ) {
      logger.warning(
        `[agent-tools] Ignoring additional tool "${definition.name}": built-in tool wins name collision`,
      );
      continue;
    }
    if (additionalToolsByName.has(definition.name)) {
      logger.warning(
        `[agent-tools] Duplicate additional tool "${definition.name}": later definition wins`,
      );
    }
    additionalToolsByName.set(definition.name, definition);
  }
  customTools.push(...additionalToolsByName.values());

  const needsPiBaseOverrides = detached || Object.keys(piBaseToolOverrides).length > 0;
  if (!needsPiBaseOverrides) return { customTools };

  const effectivePiBaseTools = { ...defaultPiBaseTools, ...piBaseToolOverrides };
  return {
    customTools,
    piBaseToolOverrides: Object.fromEntries(
      Object.entries(effectivePiBaseTools).map(([name, tool]) => {
        const labeled = withProgressLabel(tool);
        return [name, detached ? detachAgentTool(labeled, detachedOptions) : labeled];
      }),
    ),
  };
}

export function createAgentTools(options: CreateAgentToolsOptions): AgentToolsAssembly {
  const defaultPiToolOptions = createDefaultPiToolOptions(options.settingsManager);
  const defaultPiBaseTools = createDefaultPiBaseTools(options.cwd, defaultPiToolOptions);
  const defaultPiBaseToolDefinitions = createDefaultPiBaseToolDefinitions(
    options.cwd,
    defaultPiToolOptions,
  );
  const codeReviewOptions = {
    backgroundTasks: options.backgroundTasks,
    getInitiatingLoop: options.getInitiatingLoop,
    modelRuntime: options.modelRuntime,
    settingsManager: options.settingsManager,
    logger: options.logger,
  };
  const tools = assembleTools(
    options.config,
    [
      ...(isScreenshotSupported() ? [createScreenshotTool()] : []),
      ...(isComputerActionSupported() ? [createComputerActionTool()] : []),
      createCodeReviewTool(codeReviewOptions),
      createCancelCodeReviewTool(codeReviewOptions),
    ],
    defaultPiBaseTools,
    options.logger,
    {
      backgroundTasks: options.backgroundTasks,
      getInitiatingLoop: options.getInitiatingLoop,
    },
  );
  return {
    ...tools,
    defaultPiBaseToolDefinitions,
  };
}
