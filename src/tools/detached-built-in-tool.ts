import { randomUUID } from "node:crypto";
import type {
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentLoop } from "../agent/agent-loop.js";
import type {
  BackgroundTaskExecutionMode,
  BackgroundTaskManager,
} from "../room/background-task-manager.js";
import { isToolProgressLabel } from "./progress-label.js";

export interface DetachedBuiltInToolOptions {
  readonly backgroundTasks: BackgroundTaskManager;
  readonly getInitiatingLoop: () => AgentLoop;
}

export interface DetachedToolAcknowledgementDetails {
  readonly status: "started";
  readonly taskId: string;
  readonly toolName: string;
}

export type DetachedAgentTool =
  Omit<AgentTool<any, any>, "execute" | "outputSchema"> & {
    readonly outputSchema?: never;
    execute: AgentTool<any, DetachedToolAcknowledgementDetails>["execute"];
  };

export type DetachedToolDefinition =
  Omit<ToolDefinition<any, any, any>, "execute" | "outputSchema" | "renderResult"> & {
    readonly outputSchema?: never;
    readonly renderResult?: never;
    execute: ToolDefinition<any, DetachedToolAcknowledgementDetails, any>["execute"];
  };

export interface DetachedToolCorrelation {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly label: string;
}

interface DetachedExecution {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly params: unknown;
  readonly executionMode: BackgroundTaskExecutionMode;
  readonly run: (signal: AbortSignal) => Promise<AgentToolResult<any>>;
}

export function createDetachedToolTaskId(toolName: string, toolCallId: string): string {
  return `tool:${toolName}:${toolCallId}:${randomUUID()}`;
}

function progressLabel(toolName: string, params: unknown): string {
  if (typeof params !== "object" || params === null || !("label" in params)) {
    return toolName;
  }
  return isToolProgressLabel(params.label) ? params.label : toolName;
}

export function formatDetachedToolCompletion(
  correlation: DetachedToolCorrelation,
  result: AgentToolResult<any>,
): { readonly content: string; readonly images: readonly ImageContent[] } {
  const text: string[] = [];
  const images: ImageContent[] = [];
  for (const part of result.content) {
    if (part.type === "text") text.push(part.text);
    else images.push(part);
  }
  return {
    content: [
      "[SYSTEM: Background tool completed]",
      `Task ID: ${correlation.taskId}`,
      `Tool: ${correlation.toolName}`,
      `Tool call ID: ${correlation.toolCallId}`,
      `Label: ${correlation.label}`,
      `Status: ${result.isError ? "failed" : "succeeded"}`,
      "",
      text.join("\n") || "(No text output.)",
    ].join("\n"),
    images,
  };
}

export function formatDetachedToolError(
  correlation: DetachedToolCorrelation,
  error: unknown,
): string {
  return [
    "[SYSTEM: Background tool completed]",
    `Task ID: ${correlation.taskId}`,
    `Tool: ${correlation.toolName}`,
    `Tool call ID: ${correlation.toolCallId}`,
    `Label: ${correlation.label}`,
    "Status: failed",
    "",
    error instanceof Error ? error.message : String(error),
  ].join("\n");
}

export function createDetachedToolAcknowledgement(
  correlation: DetachedToolCorrelation,
): AgentToolResult<DetachedToolAcknowledgementDetails> {
  return {
    content: [{
      type: "text",
      text: `Running ${correlation.toolName} in the background.\nTask ID: ${correlation.taskId}`,
    }],
    details: {
      status: "started",
      taskId: correlation.taskId,
      toolName: correlation.toolName,
    },
    terminate: true,
  };
}

function startDetachedExecution(
  execution: DetachedExecution,
  options: DetachedBuiltInToolOptions,
): AgentToolResult<DetachedToolAcknowledgementDetails> {
  const loop = options.getInitiatingLoop();
  const correlation: DetachedToolCorrelation = {
    taskId: createDetachedToolTaskId(execution.toolName, execution.toolCallId),
    toolCallId: execution.toolCallId,
    toolName: execution.toolName,
    label: progressLabel(execution.toolName, execution.params),
  };
  options.backgroundTasks.start({
    id: correlation.taskId,
    label: correlation.label,
    executionMode: execution.executionMode,
    run: task => execution.run(task.signal),
    onResult: result => {
      const completion = formatDetachedToolCompletion(correlation, result);
      loop.enqueuePrompt("wait-idle-then-prompt", completion.content, completion.images);
    },
    onError: error => {
      loop.enqueuePrompt(
        "wait-idle-then-prompt",
        formatDetachedToolError(correlation, error),
      );
    },
  });

  return createDetachedToolAcknowledgement(correlation);
}

export function detachAgentTool(
  tool: AgentTool,
  options: DetachedBuiltInToolOptions,
): DetachedAgentTool {
  const { execute: _execute, outputSchema: _outputSchema, ...detachedTool } = tool;
  const execute: DetachedAgentTool["execute"] = async (toolCallId, params, signal) => {
    signal?.throwIfAborted();
    return startDetachedExecution({
      toolCallId,
      toolName: tool.name,
      params,
      executionMode: tool.executionMode ?? "parallel",
      run: backgroundSignal => tool.execute(
        toolCallId,
        params,
        backgroundSignal,
        undefined,
      ),
    }, options);
  };
  return { ...detachedTool, execute };
}

export function detachToolDefinition(
  tool: ToolDefinition,
  options: DetachedBuiltInToolOptions,
): DetachedToolDefinition {
  const {
    execute: _execute,
    outputSchema: _outputSchema,
    renderResult: _renderResult,
    ...detachedTool
  } = tool;
  const execute: DetachedToolDefinition["execute"] = async (
    toolCallId,
    params,
    signal,
    _onUpdate,
    context,
  ) => {
    signal?.throwIfAborted();
    return startDetachedExecution({
      toolCallId,
      toolName: tool.name,
      params,
      executionMode: tool.executionMode ?? "parallel",
      run: backgroundSignal => tool.execute(
        toolCallId,
        params,
        backgroundSignal,
        undefined,
        context,
      ),
    }, options);
  };
  return { ...detachedTool, execute };
}
