export {
  Agent,
  type AgentMessage,
  type AgentOptions,
} from "@earendil-works/pi-agent-core";
export {
  AgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSessionConfig,
  type CreateAgentSessionResult,
  type ExtensionAPI,
  type ExtensionFactory,
  type InlineExtension,
  type SessionEntry,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
export type { Api, Model } from "@earendil-works/pi-ai";

export {
  launchBundledPiLogin,
  type LaunchBundledPiLoginOptions,
  type LaunchBundledPiLoginResult,
} from "./bundled-pi.js";
export {
  RoomBridge,
  type RoomBridgeRunInput,
} from "./bridge/room-bridge.js";
export {
  AgentLoop,
  type AgentLoopLifecycleKind,
  type AgentLoopState,
  type CreateAgentLoopOptions,
} from "./agent/agent-loop.js";
export type {
  AgentConfig,
  AgentLoopExtensionSources,
} from "./agent/agent-session-factory.js";
export {
  forkBranchEntries,
  forkConversationHistory,
  initializeConversationHistory,
  type ConversationHistory,
  type InitializeConversationHistoryOptions,
} from "./agent/agent-session-utils.js";
export {
  defaultAgentLogger,
  type AgentLogger,
} from "./logger/logger.js";
export {
  CODE_REVIEW_IDENTITY_PROMPT,
  CODE_REVIEW_METHODOLOGY_PROMPT,
  CODE_REVIEW_STANDARDS_PROMPT,
  buildCodeReviewTaskPrompt,
} from "./agent-loop-imp/code-review-prompt.js";
export {
  DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS,
  DEFAULT_MULTI_AGENT_PI_COMPACTION_SETTINGS,
  DEFAULT_MULTI_AGENT_PI_RETRY_SETTINGS,
  type KnownProvider,
  type MultiAgentPiCompactionSettings,
  type MultiAgentPiConfig,
  type MultiAgentPiRetrySettings,
  type ThinkingLevel,
} from "./config/config-types.js";
export { MultiAgentPiSettingsManager } from "./config/multi-agent-pi-settings-manager.js";
export {
  multiAgentPi,
  type MultiAgentPiExtensionAPI,
  type MultiAgentPiExtensionRegistration,
  type MultiAgentPiExtensionTarget,
} from "./extensions/multi-agent-pi-extension-registry.js";
export {
  MultiAgentPiHarness,
  type MultiAgentPiHarnessOptions,
  type ReloadMultiAgentPiHarnessOptions,
} from "./multi-agent-pi-harness.js";
export {
  MESSAGE_BATCH_WINDOW_MS,
  MessagePostQueue,
  type BatchingMessageQueue,
  type MessagePostErrorHandler,
  type MessageQueue,
} from "./output/message-post-queue.js";
export {
  PRIMARY_AGENT_TAG,
  type AgentIdentity,
} from "./room/loop-manager.js";
export {
  Room,
  createRoomId,
  type BeforeRoomResetEvent,
  type BeforeRoomResetHandler,
  type CreateRoomOptions,
  type CreateRoomResult,
  type PrimaryAgentLoopOptions,
  type ResetRoomOptions,
  type ResetRoomResult,
  type RoomId,
  type RoomPromptOptions,
  type RoomResetEndEvent,
  type RoomResetEndHandler,
  type RoomState,
} from "./room/room.js";
