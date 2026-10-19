import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { defaultAgentLoopLogger } from "../../agent-loop/logger.js";
import {
  stripImagesAfterPrompt,
  stripToolResultDetailsForCompaction,
  truncateToolResultsForCompaction,
} from "../../agent-loop/context-maintenance.js";
import type { AgentLoopLogger } from "../../agent-loop/types.js";

export interface CompactionStripCounts {
  readonly strippedDetails: number;
  readonly truncatedBlocks: number;
  readonly strippedImages: number;
}

function detachedCandidate(message: AgentMessage): AgentMessage {
  const candidate = { ...message } as any;
  if (Array.isArray(candidate.content)) candidate.content = candidate.content.slice();
  return candidate;
}

/** Sanitize Pi compaction preparation without mutating SessionManager-owned messages. */
export function stripCompactionMessagesCopyOnWrite(
  messages: AgentMessage[],
): CompactionStripCounts {
  const counts = {
    strippedDetails: 0,
    truncatedBlocks: 0,
    strippedImages: 0,
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as any;
    if (message?.role === "user") {
      if (!Array.isArray(message.content) || !message.content.some((block: any) => block.type === "image")) {
        continue;
      }
      const candidate = detachedCandidate(message);
      const strippedImages = stripImagesAfterPrompt([candidate], "overflow");
      if (strippedImages === 0) continue;
      counts.strippedImages += strippedImages;
      messages[index] = candidate;
      continue;
    }
    if (message?.role !== "toolResult") continue;
    if (!("details" in message) && !Array.isArray(message.content)) continue;

    const candidate = detachedCandidate(message);
    const isolated = [candidate];
    const strippedDetails = stripToolResultDetailsForCompaction(isolated);
    const truncatedBlocks = truncateToolResultsForCompaction(isolated);
    const strippedImages = stripImagesAfterPrompt(isolated, "overflow");
    if (strippedDetails === 0 && truncatedBlocks === 0 && strippedImages === 0) continue;

    counts.strippedDetails += strippedDetails;
    counts.truncatedBlocks += truncatedBlocks;
    counts.strippedImages += strippedImages;
    messages[index] = candidate;
  }

  return counts;
}

/** Install Core's compaction-boundary sanitation policy into one Pi extension runtime. */
export function setupCompactionStripExtension(
  pi: ExtensionAPI,
  logger: AgentLoopLogger = defaultAgentLoopLogger,
): void {
  pi.on("session_before_compact", event => {
    const { messagesToSummarize, turnPrefixMessages } = event.preparation;
    if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
      logger.info("[context-maintenance] No messages to summarize — cancelling compaction");
      return { cancel: true };
    }

    const summaryCounts = stripCompactionMessagesCopyOnWrite(messagesToSummarize);
    const prefixCounts = stripCompactionMessagesCopyOnWrite(turnPrefixMessages);
    const totalStripped = summaryCounts.strippedDetails + prefixCounts.strippedDetails;
    const totalTruncated = summaryCounts.truncatedBlocks + prefixCounts.truncatedBlocks;
    const totalImages = summaryCounts.strippedImages + prefixCounts.strippedImages;

    if (totalStripped > 0 || totalTruncated > 0 || totalImages > 0) {
      logger.info(
        `[context-maintenance] Stripped ${totalStripped} detail(s) and ${totalImages} image(s), truncated ${totalTruncated} block(s) before compaction`,
      );
    }
    return undefined;
  });
}

/** Create the hidden Pi extension that applies Core context maintenance at compaction boundaries. */
export function createCompactionStripExtension(options: {
  readonly name: string;
  readonly logger?: AgentLoopLogger;
}): InlineExtension {
  return {
    name: options.name,
    hidden: true,
    factory: pi => setupCompactionStripExtension(
      pi,
      options.logger ?? defaultAgentLoopLogger,
    ),
  };
}
