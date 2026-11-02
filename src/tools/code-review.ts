import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentLoop } from "../agent/agent-loop.js";
import { createCodeReviewAgentLoop } from "../agent-loop-imp/code-review.js";
import { createProviderStreamFn } from "../agent/to-pi-bindings/provider-stream.js";
import {
  CODE_REVIEW_IDENTITY_PROMPT,
  CODE_REVIEW_SYSTEM_PROMPT_SECTIONS,
  buildCodeReviewTaskPrompt,
} from "../agent-loop-imp/code-review-prompt.js";
import {
  generateSummary,
  type LocalSummaryGenerationOptions,
} from "../compaction/summary-generator.js";
import type { MultiAgentPiSettingsManager } from "../config/multi-agent-pi-settings-manager.js";
import type { AgentLogger } from "../logger/logger.js";
import type { BackgroundTaskManager } from "../room/background-task-manager.js";

const CodeReviewParams = Type.Object({
  summary: Type.String({
    description: "Brief description of what was implemented or changed",
  }),
});

const CancelCodeReviewParams = Type.Object({});

export type CodeReviewResultStatus = "success" | "failed" | "aborted" | "no_output";

export interface CodeReviewResultDetails {
  readonly status: CodeReviewResultStatus;
}

export interface CreateCodeReviewToolOptions {
  readonly backgroundTasks: BackgroundTaskManager;
  readonly getInitiatingLoop: () => AgentLoop;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: MultiAgentPiSettingsManager;
  readonly logger: AgentLogger;
}

interface CodeReviewSnapshot {
  readonly messages: AgentMessage[];
  readonly model: LocalSummaryGenerationOptions["model"];
  readonly thinkingLevel: LocalSummaryGenerationOptions["thinkingLevel"];
  readonly sessionId: string;
  readonly cwd: string;
}

const MAX_RESULT_CHARS = 60_000;

export const CODE_REVIEW_TASK_LABEL = "code_review";
export const CODE_REVIEW_ALREADY_RUNNING_MESSAGE =
  "A code review is already running, if you want to stop it, use cancel_code_review tool to cancel it";
export const CODE_REVIEW_BACKGROUND_RUNNING_NOTICE = "[Code Review is Running in background]";
export const CODE_REVIEW_BACKGROUND_CANCELLED_NOTICE = "[Code Review is cancelled]";
export const BACKGROUND_STARTED_MESSAGE =
  "code review agent is running in background now. result will be posted to you when it is finished automatically. You can do other work normally while waiting for the result. Don't use `sleep` or similar commands to simulate wait; the completed result will only be delivered when you are in idle. You can simply end your turn if there is nothing left to do. Tell user a code review is running in your final message. NEVER commit / push your work before you receive review report.";

export const CODE_REVIEW_PROCESSING_GUIDELINES = [
  "Read and understand the complete review report before editing code. Do not process it as a line-by-line patch checklist.",
  "Validate every finding against the actual code, original requirements, project purpose, and realistic usage. Resolve every finding: fix an accepted defect, reject it with concrete evidence, or ask the user when addressing it would expand the supported scope.",
  "Consider accepted findings together. For each group sharing a systemic root cause, make one coherent correction at the responsible architectural owner. Fix unrelated local defects with the simplest coherent change. Do not add finding-specific guards, fallbacks, retries, or other workarounds.",
  "Do not optimize for a failure-zero system or unlimited hypothetical possibilities. Unless the requirements demand automatic prevention or recovery, a clear contextual error that lets the user retry can be the correct behavior. Do not add behavior solely to babysit every possible user mistake.",
  "Ask the user before implementing support for an edge case that is not already required by the task or existing system behavior.",
  "Re-evaluate concurrency findings against the project’s actual purpose and realistic use cases rather than theoretical interleavings. If concurrency handling is genuinely required, solve it coherently at the appropriate owner instead of adding scattered synchronization workarounds.",
  "Ensure the resulting proposal and implementation are sound, verified, clean, straightforward, maintainable, and understandable.",
] as const;

export const CODE_REVIEW_RESULT_FOLLOWUP_INSTRUCTION =
  `Process the complete code review report before editing:\n${CODE_REVIEW_PROCESSING_GUIDELINES.map(guideline => `- ${guideline}`).join("\n")}`;

export function formatBackgroundCodeReviewReport(reviewText: string): string {
  return `## Background code review result\n\n${reviewText}`;
}

export function formatBackgroundCodeReviewResult(reviewText: string): string {
  return `${formatBackgroundCodeReviewReport(reviewText)}\n\n${CODE_REVIEW_RESULT_FOLLOWUP_INSTRUCTION}`;
}

function getActiveCodeReviewTasksFromManager(
  backgroundTasks: Pick<BackgroundTaskManager, "list">,
) {
  return backgroundTasks.list().filter(task => task.label === CODE_REVIEW_TASK_LABEL);
}

export function hasActiveCodeReviewTask(
  backgroundTasks: Pick<BackgroundTaskManager, "list">,
): boolean {
  return getActiveCodeReviewTasksFromManager(backgroundTasks).length > 0;
}

function extractFinalAssistantText(
  messages: readonly AgentMessage[],
  startIndex = 0,
): string {
  for (let index = messages.length - 1; index >= startIndex; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .flatMap(block => block.type === "text" ? [block.text] : [])
      .join("\n");
    return text || "(no output)";
  }
  return "(no output)";
}

function capResult(text: string, scratchDir: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  mkdirSync(scratchDir, { recursive: true });
  const scratchFile = join(scratchDir, `code-review-${Date.now()}.md`);
  writeFileSync(scratchFile, text, "utf8");
  return `${text.substring(0, MAX_RESULT_CHARS)}\n\n... (truncated -- ${text.length} chars total. Full review: \`${scratchFile}\`)\nYou must read \`${scratchFile}\` before you continue your work.`;
}

function writeDebug(
  scratchDir: string,
  context: string,
  systemPrompt: string,
  logger: AgentLogger,
): void {
  try {
    mkdirSync(scratchDir, { recursive: true });
    const debugFile = join(scratchDir, "code-review-debug.md");
    const content =
      `# code_review Debug\n\n`
      + `Generated: ${new Date().toISOString()}\n\n`
      + `---\n\n`
      + `## Compacted Context\n\n${context}\n\n`
      + `---\n\n`
      + `## Review Agent System Prompt\n\n${systemPrompt}\n`;
    writeFileSync(debugFile, content, "utf8");
    logger.info(`[code_review] Debug written to ${debugFile}`);
  } catch {
    // Best-effort diagnostic only.
  }
}

async function prepareReviewContext(
  options: CreateCodeReviewToolOptions,
  snapshot: CodeReviewSnapshot,
  signal: AbortSignal,
): Promise<string> {
  const compaction = options.settingsManager.getCompactionSettings({
    provider: snapshot.model.provider,
    id: snapshot.model.id,
  });
  const context = await generateSummary({
    messages: snapshot.messages,
    model: snapshot.model,
    reserveTokens: compaction.reserveTokens,
    signal,
    ...(snapshot.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: snapshot.thinkingLevel }),
    sessionId: `${snapshot.sessionId}-code-review-compact`,
    streamFn: createProviderStreamFn(options.modelRuntime, options.settingsManager),
  });
  if (!context) throw new Error("Compaction produced no output");
  options.logger.info(`[code_review] Context compacted: ${context.length} chars`);
  return context;
}

async function runCodeReview(
  options: CreateCodeReviewToolOptions,
  initiatingLoop: AgentLoop,
  params: { readonly summary: string },
  snapshot: CodeReviewSnapshot,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly details: CodeReviewResultDetails }> {
  let reviewLoop: AgentLoop | undefined;
  let result: { text: string; details: CodeReviewResultDetails } = {
    text: "Review produced no output.",
    details: { status: "no_output" },
  };
  const abortReview = () => {
    void reviewLoop?.abort();
  };

  options.logger.info(`[code_review] Starting background review: "${params.summary}"`);

  try {
    signal.throwIfAborted();
    const context = await prepareReviewContext(options, snapshot, signal);
    signal.throwIfAborted();

    const scratchDir = join(initiatingLoop.dir, "scratch");
    reviewLoop = await createCodeReviewAgentLoop({
      persistenceRoot: join(scratchDir, "code-review-loops"),
      cwd: snapshot.cwd,
      model: snapshot.model,
    });
    signal.addEventListener("abort", abortReview, { once: true });
    signal.throwIfAborted();
    writeDebug(
      scratchDir,
      context,
      [
        CODE_REVIEW_IDENTITY_PROMPT,
        ...Object.values(CODE_REVIEW_SYSTEM_PROMPT_SECTIONS),
      ].join("\n\n"),
      options.logger,
    );

    const reviewStartIndex = reviewLoop.messages.length;
    const reviewRound = await reviewLoop.prompt(buildCodeReviewTaskPrompt({
      summary: params.summary,
      context,
    }));

    const rawText = extractFinalAssistantText(reviewLoop.messages, reviewStartIndex);
    const hasOutput = rawText !== "(no output)" && rawText.trim().length > 0;
    if (reviewRound.outcome === "aborted" || signal.aborted) {
      result = { text: "Code review aborted.", details: { status: "aborted" } };
    } else if (reviewRound.outcome !== "completed") {
      result = {
        text: `Review failed: ${reviewRound.error ?? reviewRound.stopReason}`,
        details: { status: "failed" },
      };
    } else if (!hasOutput) {
      result = { text: "Review produced no output.", details: { status: "no_output" } };
    } else {
      result = {
        text: capResult(rawText, scratchDir),
        details: { status: "success" },
      };
    }

    options.logger.info(
      `[code_review] Review complete: ${rawText.length} chars, outcome=${reviewRound.outcome}`,
    );
  } catch (error) {
    if (signal.aborted) {
      result = { text: "Code review aborted.", details: { status: "aborted" } };
    } else {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warning("[code_review] Review failed", message);
      result = { text: `Review failed: ${message}`, details: { status: "failed" } };
    }
  } finally {
    signal.removeEventListener("abort", abortReview);
    if (reviewLoop !== undefined) {
      try {
        await reviewLoop.destroy();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warning("[code_review] Review cleanup failed", message);
        if (!signal.aborted) {
          result = {
            text: `Review cleanup failed: ${message}`,
            details: { status: "failed" },
          };
        }
      }
    }
  }

  return result;
}

function resolveInitiatingLoop(
  options: CreateCodeReviewToolOptions,
  sessionManager: unknown,
): AgentLoop {
  const loop = options.getInitiatingLoop();
  if (loop.state === "destroyed" || loop.session.sessionManager !== sessionManager) {
    throw new Error("code_review initiating AgentLoop is no longer available.");
  }
  return loop;
}

/** Create the inactive-by-default tool that starts one AgentLoop-owned review task. */
export function createCodeReviewTool(
  options: CreateCodeReviewToolOptions,
): ToolDefinition<typeof CodeReviewParams> {
  return {
    name: "code_review",
    label: "code_review",
    description:
      "It spawns a dedicated code review agent that verifies your work and deliver good findings.",
    parameters: CodeReviewParams,
    promptSnippet:
      "Final review step -- spawns a First Principle Thinking agent to verify coding work.",
    promptGuidelines: [
      "You are advised to use this tool to verify your work before you conclude you have finished a coding task.",
      "MUST Address issues found in the review findings based on guidelines before concluding the task",
      "After addressing review findings, report to the user what was fixed and what was not addressed (with reasons)",
      "Use this tool to do code review instead of reviewing by yourself unless user explicitly asks you to do it",
    ],
    executionMode: "sequential",
    defaultActive: false,
    execute: async (
      _toolCallId,
      params: { summary: string },
      signal,
      _onUpdate,
      context,
    ) => {
      signal?.throwIfAborted();
      if (!context.model) throw new Error("code_review requires an active model.");
      const initiatingLoop = resolveInitiatingLoop(options, context.sessionManager);
      const backgroundTasks = options.backgroundTasks;
      if (hasActiveCodeReviewTask(backgroundTasks)) {
        return {
          content: [{ type: "text" as const, text: CODE_REVIEW_ALREADY_RUNNING_MESSAGE }],
          details: { status: "failed" },
        };
      }

      const snapshot: CodeReviewSnapshot = {
        messages: structuredClone(
          context.sessionManager.buildSessionProjection().messages,
        ),
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        sessionId: context.sessionManager.getSessionId(),
        cwd: context.cwd,
      };
      const enqueueResult = (result: string): void => {
        if (initiatingLoop.state === "destroyed") {
          options.logger.warning(
            "[code_review] Completed report was not delivered",
            "The initiating AgentLoop was destroyed",
          );
          return;
        }
        initiatingLoop.enqueuePrompt("wait-idle-then-prompt", result);
      };
      backgroundTasks.start({
        label: CODE_REVIEW_TASK_LABEL,
        run: async task => {
          const result = await runCodeReview(
            options,
            initiatingLoop,
            params,
            snapshot,
            task.signal,
          );
          return task.signal.aborted
            ? undefined
            : formatBackgroundCodeReviewResult(result.text);
        },
        onResult: enqueueResult,
        onError: error => enqueueResult(formatBackgroundCodeReviewResult(
          `Review failed: ${error instanceof Error ? error.message : String(error)}`,
        )),
      });

      return {
        content: [{ type: "text" as const, text: BACKGROUND_STARTED_MESSAGE }],
        details: { status: "success" },
      };
    },
  };
}

/** Create the inactive-by-default tool that cancels this AgentLoop's active reviews. */
export function createCancelCodeReviewTool(
  options: CreateCodeReviewToolOptions,
): ToolDefinition<typeof CancelCodeReviewParams> {
  return {
    name: "cancel_code_review",
    label: "cancel_code_review",
    description: "Cancel the currently running background code_review task.",
    parameters: CancelCodeReviewParams,
    promptSnippet: "Cancel the currently running background code_review task.",
    promptGuidelines: [
      "Use cancel_code_review to stop an active background code_review before starting another review.",
    ],
    defaultActive: false,
    execute: async () => {
      const activeReviews = getActiveCodeReviewTasksFromManager(options.backgroundTasks);
      if (activeReviews.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No running code review to cancel." }],
          details: { status: "not_found" },
        };
      }

      for (const task of activeReviews) task.abort("Cancelled by agent");
      await Promise.allSettled(activeReviews.map(task => task.done));
      return {
        content: [{
          type: "text" as const,
          text: activeReviews.length === 1
            ? "Cancelled running code review."
            : `Cancelled ${activeReviews.length} running code reviews.`,
        }],
        details: {
          status: "success",
          cancelledTaskIds: activeReviews.map(task => task.id),
        },
      };
    },
  };
}
