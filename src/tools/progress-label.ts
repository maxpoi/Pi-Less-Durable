import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const CODEMODE_TOOL_NAME = "codemode";
export const TOOL_PROGRESS_LABEL_DESCRIPTION =
  "Human-friendly description of this tool use in at most 8 words, such as \"Search conversation history\" or \"Rename the file\". Keep it general and do not reveal detailed arguments.";
export const TOOL_PROGRESS_LABEL_PATTERN = /^(?![\s\S]*[^\S ])[^\s]+(?: +[^\s]+){0,7}$/u;

export function isToolProgressLabel(value: unknown): value is string {
  return typeof value === "string" && TOOL_PROGRESS_LABEL_PATTERN.test(value);
}

type ToolWithParameters = AgentTool<any, any> | ToolDefinition<any, any, any>;
type ObjectSchema = ToolWithParameters["parameters"] & {
  properties?: Record<string, unknown>;
  required?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function withProgressLabel<T extends ToolWithParameters>(tool: T): T {
  if (tool.name === CODEMODE_TOOL_NAME) return tool;

  const parameters = tool.parameters as ObjectSchema;
  const properties = parameters.properties ?? {};
  const { label: _label, ...otherProperties } = properties;
  const originalPrepareArguments = tool.prepareArguments;
  return {
    ...tool,
    parameters: {
      ...parameters,
      properties: {
        label: {
          type: "string",
          description: TOOL_PROGRESS_LABEL_DESCRIPTION,
        },
        ...otherProperties,
      },
      required: [...new Set([...(parameters.required ?? []), "label"])],
    },
    ...(originalPrepareArguments === undefined
      ? {}
      : {
          prepareArguments: (args: unknown) => {
            const prepared = originalPrepareArguments(args);
            if (
              !isRecord(args)
              || !("label" in args)
              || !isRecord(prepared)
              || "label" in prepared
            ) {
              return prepared;
            }
            return { ...prepared, label: args.label };
          },
        }),
  };
}
