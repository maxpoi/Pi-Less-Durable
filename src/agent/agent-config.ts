import type {
  Api,
  Model,
  SessionEntry,
  ThinkingLevel,
  ToolDefinition,
} from "#core";

/** Canonical Pi entries used to initialize a new agent session. */
export type ConversationHistory = readonly SessionEntry[];

/** Consumer-applied configuration for constructing one agent runtime. */
export interface AgentConfig {
  readonly model?: Model<Api>;
  readonly thinkingLevel?: ThinkingLevel;
  readonly initialConversationHistory?: ConversationHistory;
  readonly tools?: readonly ToolDefinition<any, any, any>[];
  readonly allowedTools?: readonly string[];
  readonly excludeTools?: readonly string[];
}
