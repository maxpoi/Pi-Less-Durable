import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { AgentLoop } from "../agent/agent-loop.js";
import type { Room } from "../room/room.js";
import {
  CODE_REVIEW_AGENT_ID_PREFIX,
  CODE_REVIEW_AGENT_NAME,
  CODE_REVIEW_AGENT_TAG,
  CODE_REVIEW_IDENTITY_PROMPT,
  CODE_REVIEW_SYSTEM_PROMPT_SECTIONS,
  CODE_REVIEW_THINKING_LEVEL,
  REVIEW_TOOL_ALLOWLIST,
} from "./code-review-prompt.js";

export interface CreateCodeReviewAgentLoopOptions {
  readonly room: Room;
  readonly cwd: string;
  readonly model: Model<Api>;
  readonly initialConversationHistory?: readonly SessionEntry[];
}

/** Create and register one restricted code-review AgentLoop. */
export function createCodeReviewAgentLoop(
  options: CreateCodeReviewAgentLoopOptions,
): Promise<AgentLoop> {
  return AgentLoop.create({
    room: options.room,
    agent: {
      id: `${CODE_REVIEW_AGENT_ID_PREFIX}-${randomUUID()}`,
      name: CODE_REVIEW_AGENT_NAME,
      tag: CODE_REVIEW_AGENT_TAG,
    },
    config: {
      cwd: options.cwd,
      model: options.model,
      thinkingLevel: CODE_REVIEW_THINKING_LEVEL,
      allowedToolNames: [...REVIEW_TOOL_ALLOWLIST],
      ...(options.initialConversationHistory === undefined
        ? {}
        : { initialConversationHistory: options.initialConversationHistory }),
      systemPrompt: {
        main: CODE_REVIEW_IDENTITY_PROMPT,
        sections: { ...CODE_REVIEW_SYSTEM_PROMPT_SECTIONS },
      },
    },
  });
}
