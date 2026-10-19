import {
  createCodemodeExtension,
  createToolSearchExtension,
  type ExtensionAPI,
  type ExtensionFactory,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface ToolDefinitionBridge {
  readonly extension: InlineExtension;
  reset(): void;
  materialize(definitions: readonly ToolDefinition<any, any, any>[]): void;
}

/** Materialize host-owned definitions through one loop's native Pi extension runtime. */
export function createToolDefinitionBridge(options: {
  readonly name: string;
  readonly getDefinitions: () => readonly ToolDefinition<any, any, any>[];
  readonly configure?: (pi: ExtensionAPI) => void;
}): ToolDefinitionBridge {
  let boundPi: ExtensionAPI | undefined;
  return {
    extension: {
      name: options.name,
      hidden: true,
      factory: (pi: ExtensionAPI) => {
        for (const definition of options.getDefinitions()) pi.registerTool(definition);
        options.configure?.(pi);
        boundPi = pi;
      },
    },
    reset(): void {
      boundPi = undefined;
    },
    materialize(definitions): void {
      if (!boundPi) throw new Error(`Tool bridge "${options.name}" is not bound`);
      for (const definition of definitions) boundPi.registerTool(definition);
    },
  };
}

/** Pi-native Codemode and tool-search capabilities, activated when materialized. */
export function createActivatedPiToolExtensions(): readonly InlineExtension[] {
  return [
    createEnabledPiToolExtension("codemode", createCodemodeExtension()),
    createEnabledPiToolExtension("tool_search", createToolSearchExtension()),
  ];
}

function createEnabledPiToolExtension(name: string, factory: ExtensionFactory): InlineExtension {
  return {
    name,
    hidden: true,
    replaceable: true,
    factory: async pi => {
      await factory(pi);
      pi.on("session_start", () => {
        if (!pi.getAllTools().some(tool => tool.name === name)) return;
        const activeTools = pi.getActiveTools();
        if (!activeTools.includes(name)) pi.setActiveTools([...activeTools, name]);
      });
    },
  };
}
