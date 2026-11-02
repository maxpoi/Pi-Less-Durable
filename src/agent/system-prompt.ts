import type {
  ExtensionAPI,
  ExtensionFactory,
  NormalizedBuildSystemPromptOptions,
  ToolInfo,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface AgentSystemPrompt {
  main: string;
  sections: Record<string, string>;
}

export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  "- You are an expert coding assistant operating with multi-agent-pi, a concurent coding agent harness framework built on top of Pi.",
  "- You help users by reading files, executing commands, editing code, and writing new files, may also search online if tools are provided.",
].join("\n");

const SYSTEM_PROMPT_EXTENSION_NAME = "multi-agent-pi-system-prompt";
const SYSTEM_PROMPT_FINALIZER_EXTENSION_NAME = "multi-agent-pi-system-prompt-finalizer";

interface NamedSystemPromptExtension {
  readonly name: string;
  readonly hidden: true;
  readonly factory: ExtensionFactory;
}

export interface AgentSystemPromptExtensions {
  readonly composer: NamedSystemPromptExtension;
  readonly finalizer: NamedSystemPromptExtension;
}

export function createAgentSystemPrompt(
  input?: AgentSystemPrompt,
): AgentSystemPrompt {
  return {
    main: input?.main ?? "",
    sections: { ...(input?.sections ?? {}) },
  };
}

export function resolveAgentSystemPromptMain(main: string): string {
  return main ? main : DEFAULT_AGENT_SYSTEM_PROMPT;
}

function renderToolsSection(
  options: NormalizedBuildSystemPromptOptions,
  selectedTools: readonly string[],
  registeredTools: readonly ToolInfo[],
  defaultPiBaseTools: ReadonlyMap<string, AnyToolDefinition>,
): string {
  const toolsByName = new Map(registeredTools.map(tool => [tool.name, tool] as const));
  const hiddenTools = new Set(options.hiddenTools);
  const lines: string[] = [];

  for (const name of new Set(selectedTools)) {
    const tool = toolsByName.get(name);
    if (tool === undefined || tool.exposure === "hidden" || hiddenTools.has(name)) continue;
    const defaultPiTool = tool.sourceInfo.source === "builtin"
      ? defaultPiBaseTools.get(name)
      : undefined;
    const snippet = options.toolSnippets[name] ?? defaultPiTool?.promptSnippet ?? "";
    const guidelines = options.toolGuidelines[name]
      ?? defaultPiTool?.promptGuidelines
      ?? [];
    if (!snippet && guidelines.length === 0) continue;

    lines.push(`- **${name}**:${snippet ? ` ${snippet}` : ""}`);
    for (const guideline of guidelines) {
      lines.push(`  - ${guideline}`);
    }
  }

  return lines.join("\n");
}

function renderSkillsSection(): string {
  return "";
}

function refreshFrameworkSections(
  systemPrompt: AgentSystemPrompt,
  options: NormalizedBuildSystemPromptOptions,
  selectedTools: readonly string[],
  registeredTools: readonly ToolInfo[],
  defaultPiBaseTools: ReadonlyMap<string, AnyToolDefinition>,
): { tools: string; skills: string } {
  const tools = renderToolsSection(
    options,
    selectedTools,
    registeredTools,
    defaultPiBaseTools,
  );
  const skills = renderSkillsSection();
  systemPrompt.sections.tools = tools;
  systemPrompt.sections.skills = skills;
  return { tools, skills };
}

function applyBaseSystemPrompt(
  systemPrompt: AgentSystemPrompt,
  options: NormalizedBuildSystemPromptOptions,
  registeredTools: readonly ToolInfo[],
  defaultPiBaseTools: ReadonlyMap<string, AnyToolDefinition>,
): void {
  refreshFrameworkSections(
    systemPrompt,
    options,
    options.selectedTools,
    registeredTools,
    defaultPiBaseTools,
  );
  delete options.forceSystemPrompt;
  options.customPrompt = resolveAgentSystemPromptMain(systemPrompt.main);
  options.appendSystemPrompt = "";
  options.contextFiles = [];
  options.skills = [];
  options.sections = { ...systemPrompt.sections };
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function createAgentSystemPromptExtensions(
  systemPrompt: AgentSystemPrompt,
  defaultPiBaseToolDefinitions: readonly AnyToolDefinition[] = [],
): AgentSystemPromptExtensions {
  const defaultPiBaseTools = new Map(
    defaultPiBaseToolDefinitions.map(definition => [definition.name, definition]),
  );
  let selectedToolsBeforeHandlers: readonly string[] | undefined;

  const composer: NamedSystemPromptExtension = {
    name: SYSTEM_PROMPT_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", event => {
        selectedToolsBeforeHandlers = [...event.systemPromptOptions.selectedTools];
        applyBaseSystemPrompt(
          systemPrompt,
          event.systemPromptOptions,
          pi.getAllTools(),
          defaultPiBaseTools,
        );
      });
    },
  };

  const finalizer: NamedSystemPromptExtension = {
    name: SYSTEM_PROMPT_FINALIZER_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", event => {
        const initialSelection = selectedToolsBeforeHandlers;
        selectedToolsBeforeHandlers = undefined;
        const selectedTools = initialSelection !== undefined
          && stringArraysEqual(event.systemPromptOptions.selectedTools, initialSelection)
          ? pi.getActiveTools()
          : event.systemPromptOptions.selectedTools;

        const sections = refreshFrameworkSections(
          systemPrompt,
          event.systemPromptOptions,
          selectedTools,
          pi.getAllTools(),
          defaultPiBaseTools,
        );
        event.systemPromptOptions.skills = [];
        event.systemPromptOptions.sections.tools = sections.tools;
        event.systemPromptOptions.sections.skills = sections.skills;
      });
    },
  };

  return { composer, finalizer };
}
