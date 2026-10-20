/**
 * Transport-neutral AgentSessionEvent classification for one source-local output queue.
 * Hosts decide how semantic output operations map to their presentation model.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { isCodexServerCompactionDetails } from "../compaction/codex-compaction-details.js";
import { extractResultText } from "../agent-loop/event-utils.js";
import type { AgentLoopOutput, AgentLoopTerminalError } from "../agent-loop/types.js";
import type { MessageQueue } from "./message-post-queue.js";

export type { MessageQueue } from "./message-post-queue.js";

export interface OutputTag {
  readonly id: string;
}

export type OutputPolicy<TTag extends OutputTag = OutputTag> =
  | { readonly kind: "default" }
  | { readonly kind: "tagged"; readonly outputTag: TTag }
  | { readonly kind: "silent" };

export type OutputPhase = "start" | "update" | "end";
export type OutputLogMode = "clean" | "normal" | "full";
export type ResponseCompletion = "mid-turn" | "final" | "error" | "aborted";
export type ResponseVisibility = "primary" | "diagnostic";
export type RuntimeOutputKind = "status" | "compaction" | "retry";

type TaggedOutput<TTag extends OutputTag> = {
  readonly text: string;
  readonly outputTag?: TTag;
};

export interface PhasedTextPart {
  readonly phase: OutputPhase;
  readonly text: string;
}

export type PhasedTextOutput<TTag extends OutputTag = OutputTag> = TaggedOutput<TTag> & {
  /** Latest lifecycle phase represented by this batched operation. */
  readonly phase: OutputPhase;
  /** Ordered lifecycle inputs combined into this one host operation. */
  readonly lifecycle: readonly PhasedTextPart[];
};

export type ResponseOutput<TTag extends OutputTag = OutputTag> = TaggedOutput<TTag> & {
  readonly completion: ResponseCompletion;
  readonly visibility?: ResponseVisibility;
};

export type RuntimeOutput<TTag extends OutputTag = OutputTag> = TaggedOutput<TTag> & {
  readonly kind: RuntimeOutputKind;
  readonly phase: OutputPhase;
};

export interface PipeTarget<TTag extends OutputTag = OutputTag> {
  postThinking(output: PhasedTextOutput<TTag>): Promise<void>;
  postTool(output: PhasedTextOutput<TTag>): Promise<void>;
  postResponse(output: ResponseOutput<TTag>): Promise<void>;
  postRuntime(output: RuntimeOutput<TTag>): Promise<void>;
  releaseOutputTag?(outputTag: TTag): Promise<void>;
  readonly logMode?: OutputLogMode;
}

export interface OutputSourceOptions<TTag extends OutputTag = OutputTag> {
  readonly policy?: OutputPolicy<TTag>;
  readonly getSourceLabel: () => string;
}

const THINKING_PLACEHOLDER_TEXT = "💭 Thinking...";

function isRequestTooLargeError(message: string): boolean {
  const hasLeadingStatus = /^\s*413(?!\.\d)\b/i.test(message);
  const hasLabeledStatus = /\b(?:http(?:\/[\d.]+)?|status(?:\s+code)?|error)(?:\s+|\s*[:=]\s*)413(?!\.\d)\b/i.test(message);
  const hasParenthesizedStatus = /\berror\s*\(\s*413(?!\.\d)\b\s*\)/i.test(message);
  const hasKnownErrorText = /\b(?:request_too_large|request(?: is)? too large|body too large|payload too large|request entity too large|content too large)\b/i.test(message);
  return hasLeadingStatus || hasLabeledStatus || hasParenthesizedStatus || hasKnownErrorText;
}

export class OutputPipe<TTag extends OutputTag = OutputTag> {
  #target: PipeTarget<TTag>;
  #queue: MessageQueue;

  constructor(target: PipeTarget<TTag>, queue: MessageQueue) {
    this.#target = target;
    this.#queue = queue;
  }

  get logMode(): OutputLogMode {
    return this.#target.logMode ?? "normal";
  }

  get target(): PipeTarget<TTag> {
    return this.#target;
  }

  get queue(): MessageQueue {
    return this.#queue;
  }

  setTarget(target: PipeTarget<TTag>, queue: MessageQueue): void {
    this.#target = target;
    this.#queue = queue;
  }

  createSource(options: OutputSourceOptions<TTag>): AgentLoopOutput {
    const state = createOutputDispatchState(options.policy);
    let lifecycleActive = true;
    const beginLifecycleIfNeeded = (): void => {
      if (lifecycleActive) return;
      resetOutputDispatchState(state);
      lifecycleActive = true;
    };
    return Object.freeze({
      handleEvent: (event: AgentSessionEvent) => {
        if (event.type === "agent_start" || event.type === "compaction_start") beginLifecycleIfNeeded();
        return lifecycleActive ? this.#dispatch(event, state) : Promise.resolve();
      },
      handleTerminalError: (error: AgentLoopTerminalError) => {
        beginLifecycleIfNeeded();
        this.#postTerminalError(state, options.getSourceLabel(), error.message);
      },
      abortLifecycle: () => {
        if (!lifecycleActive) return;
        lifecycleActive = false;
        this.#queue.flush?.();
        resetOutputDispatchState(state);
      },
    });
  }

  #postTerminalError(
    state: OutputDispatchState<TTag>,
    logTag: string,
    errMsg: string,
    errorContext = "agent error",
  ): void {
    if (!errMsg || state.policy.kind === "silent") return;
    const outputTag = outputTagFor(state.policy);
    const tagged = outputTag !== undefined;
    if (tagged && this.logMode === "clean") return;

    const post = (text: string, visibility: ResponseVisibility): void => {
      this.#queue.enqueue(
        () => this.#target.postResponse({
          text,
          completion: "error",
          visibility,
          ...(outputTag === undefined ? {} : { outputTag }),
        }),
        errorContext,
      );
    };

    if (tagged) {
      post(`_[${logTag}] Error: ${errMsg}_`, "diagnostic");
    } else if (isRequestTooLargeError(errMsg)) {
      post(`_[${logTag}] Request was too large for the API. Please try again with a shorter message or fewer attachments._`, "primary");
    } else if (this.logMode === "full") {
      post(`_[${logTag}] Sorry, something went wrong_`, "primary");
      post(`_[${logTag}] Error: ${errMsg}_`, "diagnostic");
    } else {
      post(`_[${logTag}] Sorry, something went wrong: ${errMsg}_`, "primary");
    }
  }

  #postRuntime(
    state: OutputDispatchState<TTag>,
    output: Omit<RuntimeOutput<TTag>, "outputTag">,
    errorContext: string,
  ): void {
    if (state.policy.kind === "silent") return;
    const outputTag = outputTagFor(state.policy);
    if (outputTag !== undefined && this.logMode === "clean") return;
    this.#queue.enqueue(
      () => this.#target.postRuntime({
        ...output,
        ...(outputTag === undefined ? {} : { outputTag }),
      }),
      errorContext,
    );
  }

  async releaseOutputTag(outputTag: TTag): Promise<void> {
    await this.#target.releaseOutputTag?.(outputTag);
  }

  /** Classify one Pi AgentSessionEvent and enqueue its semantic output operations. */
  async #dispatch(
    event: AgentSessionEvent,
    state: OutputDispatchState<TTag>,
  ): Promise<void> {
    const target = this.#target;
    const queue = this.#queue;
    const logMode = this.logMode;
    const outputTag = outputTagFor(state.policy);
    const batchPrefix = outputTag === undefined ? "default" : `tagged:${outputTag.id}`;
    const postBatch = (
      key: string,
      text: string,
      post: (combinedText: string) => Promise<void>,
      errorContext: string,
    ): void => {
      if (queue.enqueueBatch) queue.enqueueBatch(key, text, post, errorContext);
      else queue.enqueue(() => post(text), errorContext);
    };
    const postPhased = (
      kind: "thinking" | "tool",
      phase: OutputPhase,
      text: string,
      errorContext: string,
    ): void => {
      const item: PhasedTextPart = { phase, text };
      const post = (items: readonly PhasedTextPart[]): Promise<void> => {
        const latestPhase = items[items.length - 1]?.phase ?? phase;
        const output = {
          phase: latestPhase,
          text: items.map(part => part.text).join("\n"),
          lifecycle: items,
          ...(outputTag === undefined ? {} : { outputTag }),
        };
        return kind === "thinking" ? target.postThinking(output) : target.postTool(output);
      };
      if (queue.enqueueBatchItems) {
        queue.enqueueBatchItems(`${batchPrefix}:${kind}`, item, post, errorContext);
      } else {
        queue.enqueue(() => post([item]), errorContext);
      }
    };
    const shouldPostProgress = (): boolean => state.policy.kind !== "silent" && logMode !== "clean";

    if (event.type === "agent_start") {
      resetOutputDispatchState(state);
      return;
    }
    if (event.type === "compaction_start") {
      this.#postRuntime(state, {
        kind: "compaction",
        phase: "start",
        text: "_Compacting context..._",
      }, "compaction start");
      return;
    } else if (event.type === "compaction_end") {
      if (event.result) {
        const mode = isCodexServerCompactionDetails(event.result.details) ? " (Codex server-side)" : "";
        const message = `Compaction complete${mode}: ${event.result.tokensBefore} tokens compacted`;
        this.#postRuntime(state, {
          kind: "compaction",
          phase: "end",
          text: `_${message}_`,
        }, "compaction end");
      } else if (event.aborted) {
        this.#postRuntime(state, {
          kind: "compaction",
          phase: "end",
          text: "_Compaction aborted_",
        }, "compaction end");
      } else if (event.errorMessage) {
        this.#postRuntime(state, {
          kind: "compaction",
          phase: "end",
          text: `_${event.errorMessage}_`,
        }, "compaction end");
      }
      return;
    } else if (event.type === "auto_retry_start") {
      this.#postRuntime(state, {
        kind: "retry",
        phase: "start",
        text: `_Retrying (${event.attempt}/${event.maxAttempts})..._`,
      }, "retry");
      return;
    } else if (event.type === "auto_retry_end") {
      return;
    }

    if (event.type === "turn_start" || event.type === "turn_end" || event.type === "tool_execution_update"
      || event.type === "agent_end") {
      return;
    }

    if (event.type === "tool_execution_start") {
      state.pendingTools.set(event.toolCallId, {
        args: event.args,
        startTime: Date.now(),
      });
      const args = event.args as { label?: string } & Record<string, unknown>;
      const label = args?.label || event.toolName;

      if (shouldPostProgress()) {
        const argsFormatted = formatToolArgs(event.toolName, event.args as Record<string, unknown>);
        if (argsFormatted) {
          let message = `**→ ${event.toolName}**`;
          if (label && label !== event.toolName) message += `: ${label}`;
          message += `\n\`\`\`\n${argsFormatted}\n\`\`\``;
          postPhased("tool", "start", message, "tool args");
        } else {
          postPhased("tool", "start", `_→ ${label}_`, "tool label");
        }
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      const resultText = extractResultText(event.result);
      const pending = state.pendingTools.get(event.toolCallId);
      state.pendingTools.delete(event.toolCallId);
      const duration = ((pending ? Date.now() - pending.startTime : 0) / 1000).toFixed(1);
      if (shouldPostProgress()) {
        const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
        let message = `**${event.isError ? "✗" : "✓"} ${event.toolName}**`;
        if (label) message += `: ${label}`;
        message += ` (${duration}s)\n`;
        message += `**Result:**\n\`\`\`\n${truncateForDisplay(resultText, 50)}\n\`\`\``;
        postPhased("tool", "end", message, "tool result");

        if (event.isError) {
          const errorText = `_Error: ${resultText.length > 200 ? `${resultText.substring(0, 200)}...` : resultText}_`;
          postPhased("tool", "end", errorText, "tool error");
        }
      }
      return;
    }

    if (event.type === "message_end") {
      const message = event.message as any;
      if (message.role === "assistant") {
        const thinkingParts: string[] = [];
        const textParts: string[] = [];
        for (const part of message.content || []) {
          if (part.type === "thinking" && part.thinking) thinkingParts.push(part.thinking);
          else if (part.type === "text" && part.text) textParts.push(part.text);
        }

        const formattedThinking = thinkingParts
          .filter(thinking => thinking.trim())
          .map(thinking => `💭 _${thinking}_`);
        if (state.thinkingPlaceholderPending && formattedThinking.length > 0) {
          formattedThinking.unshift(THINKING_PLACEHOLDER_TEXT);
        }
        state.thinkingPlaceholderPending = false;
        if (shouldPostProgress() && formattedThinking.length > 0) {
          postPhased("thinking", "end", formattedThinking.join("\n"), "thinking");
        }

        const text = textParts.join("\n");
        if (state.policy.kind !== "silent" && text.trim()) {
          if (outputTag !== undefined) {
            if (logMode !== "clean" && message.stopReason === "stop") {
              queue.enqueue(
                () => target.postResponse({ text, completion: "final", outputTag }),
                "tagged final text",
              );
            } else if (logMode !== "clean" && message.stopReason !== "error" && message.stopReason !== "aborted") {
              postBatch(
                `${batchPrefix}:response:mid-turn`,
                text,
                combinedText => target.postResponse({ text: combinedText, completion: "mid-turn", outputTag }),
                "tagged mid-turn text",
              );
            }
          } else if (message.stopReason === "stop") {
            queue.enqueue(() => target.postResponse({ text, completion: "final" }), "final text");
          } else if (message.stopReason !== "error" && message.stopReason !== "aborted") {
            postBatch(
              `${batchPrefix}:response:mid-turn`,
              text,
              combinedText => target.postResponse({ text: combinedText, completion: "mid-turn" }),
              "mid-turn text",
            );
          }
        }
      }
      return;
    }

    if (event.type === "message_start") {
      const message = event.message as any;
      if (message.role === "assistant" && state.pendingTools.size === 0 && state.policy.kind === "default") {
        queue.enqueue(
          () => target.postRuntime({ kind: "status", phase: "start", text: "_Thinking_" }),
          "thinking status",
        );
      }
      return;
    }

    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "thinking_start" && shouldPostProgress()) {
        state.thinkingPlaceholderPending = true;
      }
      return;
    }
  }
}

interface PendingOutputTool {
  readonly args: unknown;
  readonly startTime: number;
}

export interface OutputDispatchState<TTag extends OutputTag = OutputTag> {
  readonly pendingTools: Map<string, PendingOutputTool>;
  readonly policy: OutputPolicy<TTag>;
  thinkingPlaceholderPending: boolean;
}

function createOutputDispatchState<TTag extends OutputTag>(
  policy: OutputPolicy<TTag> = { kind: "default" },
): OutputDispatchState<TTag> {
  return {
    pendingTools: new Map(),
    policy,
    thinkingPlaceholderPending: false,
  };
}

function resetOutputDispatchState(state: OutputDispatchState): void {
  state.pendingTools.clear();
  state.thinkingPlaceholderPending = false;
}

function outputTagFor<TTag extends OutputTag>(policy: OutputPolicy<TTag>): TTag | undefined {
  return policy.kind === "tagged" ? policy.outputTag : undefined;
}

export function formatToolArgs(_toolName: string, args: Record<string, unknown>): string {
  const lines: string[] = [];
  const clamp = (value: string): string => value.length > 300 ? `${value.substring(0, 300)} ...` : value;
  for (const [key, value] of Object.entries(args)) {
    if (key === "label" || key === "offset" || key === "limit") continue;
    if (key === "path" && typeof value === "string") {
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      lines.push(clamp(offset !== undefined && limit !== undefined ? `${value}:${offset}-${offset + limit}` : value));
      continue;
    }
    if (typeof value === "string") lines.push(clamp(value));
    else lines.push(clamp(JSON.stringify(value)));
  }
  return lines.join("\n");
}

function truncateForDisplay(text: string, maxWords: number, maxChars = 300): string {
  if (text.length > maxChars) return `${text.substring(0, maxChars)} ...`;
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")} ...`;
}
