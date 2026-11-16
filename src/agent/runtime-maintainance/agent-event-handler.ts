import type { Agent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentLogger } from "../../logger/logger.js";
import { isToolProgressLabel } from "../../tools/progress-label.js";
import { evictStaleSessionImages } from "./context-maintenance.js";
import {
  clearAgentWaitingHeartbeat,
  formatAssistantErrorDetails,
  formatRetryDetails,
  type AgentEventHandlerState,
} from "./agent-event-handler-utils.js";
import {
  accountAgentEvent,
  type AgentEventAccounting,
  type AgentRunState,
} from "./agent-run-state.js";

export interface AgentEventHandlerOptions {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly logger: AgentLogger;
  readonly logTag: string;
  readonly reportFailure: (error: unknown) => void;
  readonly getCompactionTriggerPoint?: () => number | undefined;
}

export function applyAgentEventMaintenance(
  event: AgentSessionEvent,
  state: AgentEventHandlerState,
  options: AgentEventHandlerOptions,
): void {
  const {
    agent,
    getCompactionTriggerPoint,
    logTag,
    logger,
    reportFailure,
    sessionManager,
  } = options;

  if (event.type === "message_start" && event.message?.role === "assistant") {
    clearAgentWaitingHeartbeat(state);
    state.waitingStartedAt = Date.now();
    state.waitingHeartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.waitingStartedAt) / 1000);
      try {
        logger.info(`[${logTag}] ⏳ Waiting for LLM response... (${elapsed}s)`);
      } catch (error) {
        reportFailure(error);
      }
    }, 10_000);
  }
  if (event.type === "message_update" || event.type === "message_end") {
    clearAgentWaitingHeartbeat(state);
  }

  if (event.type === "message_end") {
    const assistantMessage = event.message as AssistantMessage;
    if (assistantMessage?.role === "assistant") {
      if (assistantMessage.model || assistantMessage.provider) {
        logger.info(
          `[${logTag}] API response: model=${assistantMessage.model || "?"}, provider=${assistantMessage.provider || "?"}`,
        );
      }
      if (assistantMessage.usage) {
        const contextTokens = assistantMessage.usage.input + assistantMessage.usage.output
          + assistantMessage.usage.cacheRead + assistantMessage.usage.cacheWrite;
        const contextWindow = agent.state.model.contextWindow;
        if (contextWindow > 0) {
          const percentUsed = ((contextTokens / contextWindow) * 100).toFixed(0);
          const triggerAt = getCompactionTriggerPoint?.();
          const triggerText = triggerAt === undefined
            ? ""
            : `, compaction at ${triggerAt} (${((triggerAt / contextWindow) * 100).toFixed(0)}%)`;
          logger.info(
            `[${logTag}] Context: ${contextTokens}/${contextWindow} tokens (${percentUsed}%)${triggerText}`,
          );
        }
      }

      if (assistantMessage.stopReason === "error") {
        logger.warning(
          `[${logTag}] Assistant response ended with error`,
          formatAssistantErrorDetails(assistantMessage, agent.state.model as Model<Api>),
        );
      }

    }
  }

  if (event.type === "compaction_start") {
    logger.info(`[${logTag}] Compaction started (reason: ${event.reason})`);
  } else if (event.type === "compaction_end") {
    if (event.result) {
      logger.info(`[${logTag}] Compaction complete: ${event.result.tokensBefore} tokens compacted`);
    } else if (event.aborted) {
      logger.info(`[${logTag}] Compaction aborted`);
    } else if (event.errorMessage) {
      logger.warning(`[${logTag}] Compaction failed (reason: ${event.reason})`, event.errorMessage);
    }
  } else if (event.type === "auto_retry_start") {
    logger.warning(
      `[${logTag}] Retrying (${event.attempt}/${event.maxAttempts})`,
      event.errorMessage,
    );
  } else if (event.type === "auto_retry_end") {
    if (event.success) {
      logger.info(`[${logTag}] Retry succeeded (attempt ${event.attempt})`);
    } else {
      logger.warning(
        `[${logTag}] Retry failed after ${event.attempt} attempts`,
        formatRetryDetails(event, agent.state.model as Model<Api>),
      );
    }
  }

  if (event.type === "turn_end") {
    const stripped = evictStaleSessionImages(sessionManager, state.imageEvictionState);
    if (stripped > 0) {
      logger.info(`[${logTag}] Mid-turn image eviction: stripped ${stripped} image(s) (TTL expired)`);
    }
  }
}

export interface AgentEventDiagnosticOptions {
  readonly state: AgentEventHandlerState;
  readonly logger: AgentLogger;
  readonly logTag: string;
  readonly runState: AgentRunState;
  readonly accounting: AgentEventAccounting;
}

/** Emit event diagnostics through the ordinary framework logger. */
export function logAgentEventDiagnostics(
  event: AgentSessionEvent,
  options: AgentEventDiagnosticOptions,
): void {
  const { accounting, logger, logTag, runState, state } = options;

  if (event.type === "turn_start") {
    logger.info(`[${logTag}] Turn ${runState.turnCount}`);
  } else if (event.type === "turn_end") {
    logger.info(`[${logTag}] Turn ${runState.turnCount} ended`);
  } else if (event.type === "agent_start") {
    logger.info(`[${logTag}] Agent started`);
  } else if (event.type === "agent_end") {
    logger.info(`[${logTag}] Agent ended — ${runState.turnCount} turns, ${runState.toolCount} tools`);
  } else if (event.type === "message_start" && event.message?.role === "assistant") {
    logger.info(`[${logTag}] ⏳ Waiting for LLM response...`);
  } else if (event.type === "tool_execution_start") {
    const label = isToolProgressLabel(event.args?.label)
      ? event.args.label
      : event.toolName;
    const labelSuffix = label === event.toolName ? "" : `: ${label}`;
    logger.info(
      `[${logTag}] Tool started: ${event.toolName}${labelSuffix}`,
      JSON.stringify(event.args, null, 2),
    );
  } else if (event.type === "tool_execution_end") {
    const duration = ((accounting.toolDurationMs ?? 0) / 1000).toFixed(1);
    const result = extractResultText(event.result);
    const message = `[${logTag}] Tool ${event.isError ? "failed" : "succeeded"}: ${event.toolName} (${duration}s)`;
    if (event.isError) logger.warning(message, result);
    else logger.info(message, result);
  } else if (event.type === "message_end") {
    const assistantMessage = event.message as AssistantMessage;
    if (assistantMessage?.role === "assistant") {
      if (assistantMessage.errorMessage && assistantMessage.stopReason !== "error") {
        logger.warning(`[${logTag}] Model error: ${assistantMessage.errorMessage}`);
      }
      logger.info(`[${logTag}] Message end (stopReason=${assistantMessage.stopReason ?? "?"})`);
      for (const part of assistantMessage.content || []) {
        if (part.type === "thinking" && part.thinking) {
          logger.info(`[${logTag}] Thinking`, part.thinking);
        }
      }
      const responseText = (assistantMessage.content || [])
        .filter(part => part.type === "text" && part.text)
        .map(part => part.type === "text" ? part.text : "")
        .join("\n");
      if (responseText.trim()) logger.info(`[${logTag}] Response`, responseText);
    }
  } else if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent;
    const deltaType = assistantEvent?.type ?? "?";
    if (assistantEvent.type === "thinking_start") {
      logger.info(`[${logTag}] 💭 Thinking...`);
    } else if (assistantEvent.type === "thinking_end") {
      logger.info(`[${logTag}] 💭 Thinking done`);
    } else if (assistantEvent.type === "text_start") {
      logger.info(`[${logTag}] 📝 Generating text...`);
    } else if (assistantEvent.type === "text_end") {
      logger.info(`[${logTag}] 📝 Text done`);
    } else if (assistantEvent.type === "toolcall_start") {
      const block = assistantEvent.partial?.content?.[assistantEvent.contentIndex];
      logger.info(`[${logTag}] 🔧 Tool call: ${block?.type === "toolCall" ? block.name : "?"}`);
    } else if (assistantEvent.type === "toolcall_end") {
      const block = assistantEvent.partial?.content?.[assistantEvent.contentIndex];
      logger.info(`[${logTag}] 🔧 Tool call done: ${block?.type === "toolCall" ? block.name : "?"}`);
    } else if (assistantEvent.type === "toolcall_delta") {
      const now = Date.now();
      if (now - state.lastUpdateLogAt >= 2_000) {
        state.lastUpdateLogAt = now;
        const block = assistantEvent.partial?.content?.[assistantEvent.contentIndex];
        logger.info(`[${logTag}] 🔧 Streaming args for ${block?.type === "toolCall" ? block.name : "?"}...`);
      }
    } else {
      const now = Date.now();
      if (now - state.lastUpdateLogAt >= 2_000) {
        state.lastUpdateLogAt = now;
        logger.info(`[${logTag}] Streaming (${deltaType})...`);
      }
    }
  }
}

export interface GenericAgentEventHandlerOptions {
  readonly session: AgentSession;
  readonly handlerState: AgentEventHandlerState;
  readonly runState: AgentRunState;
  readonly logger: AgentLogger;
  readonly logTag: string;
  readonly getCompactionTriggerPoint?: () => number | undefined;
}

/** Apply framework accounting, maintenance, and diagnostics for one session event. */
export function handleGenericEvent(
  event: AgentSessionEvent,
  options: GenericAgentEventHandlerOptions,
): void {
  const {
    session,
    handlerState,
    runState,
    logger,
    logTag,
    getCompactionTriggerPoint,
  } = options;
  const reportFailure = (error: unknown): void => {
    logger.warning(
      `[${logTag}] Internal event handling failed`,
      error instanceof Error ? error.message : String(error),
    );
  };

  try {
    const accounting = accountAgentEvent(event, runState);
    applyAgentEventMaintenance(event, handlerState, {
      agent: session.agent,
      sessionManager: session.sessionManager,
      logger,
      logTag,
      reportFailure,
      ...(getCompactionTriggerPoint === undefined ? {} : { getCompactionTriggerPoint }),
    });
    logAgentEventDiagnostics(event, {
      state: handlerState,
      logger,
      logTag,
      runState,
      accounting,
    });
  } catch (error) {
    reportFailure(error);
  } finally {
    if (event.type === "agent_settled") clearAgentWaitingHeartbeat(handlerState);
  }
}

export function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result && Array.isArray((result as any).content)) {
    const parts: string[] = [];
    for (const part of (result as any).content) {
      if (part.type === "text" && part.text) parts.push(part.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return JSON.stringify(result);
}
