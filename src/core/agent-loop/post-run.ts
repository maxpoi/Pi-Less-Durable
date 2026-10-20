import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripSessionImages } from "./context-maintenance.js";
import type { AgentLoopCompactionPolicy, AgentLoopLogger } from "./types.js";

export async function waitForCompactionBeforePrompt(
  session: AgentSession,
  logger: AgentLoopLogger,
  logTag: string,
): Promise<void> {
  if (!session.isCompacting) return;
  logger.info(`[${logTag}] Compaction in progress — waiting before prompt`);
  while (session.isCompacting) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function waitForRetrySettle(
  session: AgentSession,
  logger: AgentLoopLogger,
  logTag: string,
): Promise<void> {
  while (session.isStreaming) {
    logger.info(`[${logTag}] Agent still streaming after prompt returned (retry in progress) — waiting for idle`);
    await session.agent.waitForIdle();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  await new Promise(resolve => setTimeout(resolve, 0));
  if (!session.isCompacting) return;

  logger.info(`[${logTag}] Overflow recovery in progress — waiting for compaction to complete`);
  while (session.isCompacting) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await new Promise(resolve => setTimeout(resolve, 150));
  while (session.isStreaming || session.isRetrying) {
    if (session.isStreaming) {
      logger.info(`[${logTag}] Agent restarted after overflow recovery — waiting for idle`);
      await session.agent.waitForIdle();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export function stripProcessedImages(
  sessionManager: SessionManager,
  logger: AgentLoopLogger,
  logTag: string,
): void {
  const stripped = stripSessionImages(sessionManager);
  if (stripped > 0) {
    logger.info(`[${logTag}] Stripped ${stripped} image(s) from session after prompt`);
  }
}

export async function autoCompactIfNeeded(
  session: AgentSession,
  compaction: AgentLoopCompactionPolicy | undefined,
  contextTokens: number,
  logger: AgentLoopLogger,
  logTag: string,
): Promise<void> {
  if (!compaction || !compaction.shouldCompact(contextTokens)) return;
  logger.info(`[${logTag}] Context ${contextTokens} exceeds auto-compact ceiling, triggering compaction`);
  try {
    const result = await session.compact();
    logger.info(`[${logTag}] Auto-compaction complete: ${result.tokensBefore} tokens before`);
  } catch (error) {
    logger.warning(
      `[${logTag}] Auto-compaction failed`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
