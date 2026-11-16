export {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
export {
  AgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSessionConfig,
  type CreateAgentSessionResult,
  type SessionEntry,
  type SettingsManager,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
export type { Api, Model } from "@earendil-works/pi-ai";

export { multiAgentPi } from "./multi-agent-pi/api.js";
export type * from "./multi-agent-pi/api.js";

export {
  launchBundledPiLogin,
  type LaunchBundledPiLoginOptions,
  type LaunchBundledPiLoginResult,
} from "./bundled-pi.js";
export {
  RoomBridge,
  type RoomBridgeEnqueueInput,
  type RoomBridgeRunInput,
} from "./bridge/room-bridge.js";
export {
  AgentLoop,
  type AgentLoopLifecycleKind,
  type AgentLoopPersistence,
  type AgentLoopQueuedPromptType,
  type AgentLoopResult,
  type AgentLoopRoundOutcome,
  type AgentLoopState,
  type CreateAgentLoopOptions,
} from "./agent/agent-loop.js";
export type {
  AgentConfig,
  AgentLoopExtensionSources,
  AgentToolConfig,
  BuiltInToolExecutionMode,
} from "./agent/agent-session-factory.js";
export {
  DEFAULT_AGENT_SYSTEM_PROMPT,
  type AgentSystemPrompt,
} from "./agent/system-prompt.js";
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
  generateSummary,
  probeModel,
  type GenerateSummaryOptions,
  type ProbeModelOptions,
  type ProbeModelResult,
} from "./model-operations.js";
export {
  CODE_REVIEW_IDENTITY_PROMPT,
  CODE_REVIEW_METHODOLOGY_PROMPT,
  CODE_REVIEW_STANDARDS_PROMPT,
  FIRST_PRINCIPLE_SECTION,
  REVIEW_IDENTITY,
  REVIEW_TOOL_ALLOWLIST,
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
  MultiAgentPiHarness,
  type MultiAgentPiHarnessOptions,
  type ReloadMultiAgentPiHarnessOptions,
} from "./multi-agent-pi-harness.js";
export type {
  HarnessExtensionCatalogEntry,
  HarnessExtensionFile,
  HarnessInlineExtension,
} from "./extensions/extension-catalog.js";
export {
  MESSAGE_BATCH_WINDOW_MS,
  MessagePostQueue,
  type BatchingMessageQueue,
  type MessagePostErrorHandler,
  type MessageQueue,
} from "./output/message-post-queue.js";
export {
  BackgroundTaskManager,
  type BackgroundTaskExecutionMode,
  type BackgroundTaskHandle,
  type BackgroundTaskManagerOptions,
} from "./room/background-task-manager.js";
export {
  PRIMARY_AGENT_TAG,
  type AgentIdentity,
} from "./room/loop-manager.js";
export {
  createComputerActionTool,
  executeComputerAction,
  isComputerActionSupported,
  validateComputerAction,
  type ActionExecutionResult,
  type ComputerActionDetails,
  type ComputerActionParams,
  type ComputerActionToolDependencies,
  type InterestedAreaAfterAction,
} from "./tools/computer-use.js";
export {
  TOOL_PROGRESS_LABEL_PATTERN,
  isToolProgressLabel,
} from "./tools/progress-label.js";
export {
  SCREENSHOT_DIRECTORY,
  buildScreenshotResult,
  buildWindowsScreenshotProcess,
  captureMainDisplay,
  captureNativeDisplay,
  createScreenshotTool,
  cropScreenshot,
  encodeNativeCapture,
  isScreenshotSupported,
  saveScreenshot,
  type CroppedScreenshot,
  type ScreenshotCapture,
  type ScreenshotCropArea,
  type ScreenshotDetails,
  type ScreenshotToolDependencies,
} from "./tools/screenshot.js";
export {
  BACKGROUND_STARTED_MESSAGE,
  CODE_REVIEW_ALREADY_RUNNING_MESSAGE,
  CODE_REVIEW_BACKGROUND_CANCELLED_NOTICE,
  CODE_REVIEW_BACKGROUND_RUNNING_NOTICE,
  CODE_REVIEW_PROCESSING_GUIDELINES,
  CODE_REVIEW_RESULT_FOLLOWUP_INSTRUCTION,
  CODE_REVIEW_TASK_LABEL,
  createCancelCodeReviewTool,
  createCodeReviewTool,
  formatBackgroundCodeReviewReport,
  formatBackgroundCodeReviewResult,
  hasActiveCodeReviewTask,
  type CodeReviewResultDetails,
  type CodeReviewResultStatus,
  type CreateCodeReviewToolOptions,
} from "./tools/code-review.js";
export {
  Room,
  createRoomId,
  type BeforeRoomResetEvent,
  type BeforeRoomResetHandler,
  type CreateRoomOptions,
  type CreateRoomResult,
  type DurableRoomPrimaryAgentLoopOptions,
  type MemoryRoomPrimaryAgentLoopOptions,
  type PrimaryAgentLoopOptions,
  type ResetRoomOptions,
  type ResetRoomResult,
  type RestoreRoomSessionOptions,
  type RestoreRoomSessionResult,
  type RoomEnqueuePromptOptions,
  type RoomId,
  type RoomPersistence,
  type RoomPromptOptions,
  type RoomResetEndEvent,
  type RoomResetEndHandler,
  type RoomSessionArchive,
  type RoomState,
  type SessionRestoreEndEvent,
  type SessionRestoreEndHandler,
} from "./room/room.js";
