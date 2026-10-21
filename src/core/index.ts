/** Runtime bridge to the single Pi installation bundled with this package. */
export {
  Agent,
  type AgentMessage,
  type AgentOptions,
} from "@earendil-works/pi-agent-core";
export {
  AgentSession,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  type AgentSessionConfig,
  type ExtensionAPI,
  type ExtensionFactory,
  type SessionEntry,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
export type { Api, Model } from "@earendil-works/pi-ai";

export {
  AgentLoop,
  assertAgentLoopId,
  forkBranchEntries,
  forkConversationHistory,
  formatAgentLoopLogTag,
  getCurrentAgentLoopExecution,
  requireCurrentAgentLoopExecutionEnv,
  resolveCurrentAgentLoopExecutionEnv,
} from "./agent-loop/agent-loop.js";
export type {
  AgentLoopCompactionPolicy,
  AgentLoopEventHook,
  AgentLoopExecutionContext,
  AgentLoopLifecycle,
  AgentLoopLifecycleKind,
  AgentLoopLogger,
  AgentLoopModelChangeOptions,
  AgentLoopOptions,
  AgentLoopResult,
  AgentLoopRuntime,
  AgentLoopState,
  AgentLoopUsageEntry,
  AgentLoopUsageStore,
} from "./agent-loop/types.js";
export {
  formatAssistantErrorDetails,
  formatRetryDetails,
} from "./agent-loop/error-details.js";
export {
  CODEX_SERVER_COMPACTION_STRATEGY,
  isCodexServerCompactionDetails,
  type CodexServerCompactionDetailsMarker,
} from "./compaction/codex-compaction-details.js";
export {
  DEFAULT_MULTI_AGENT_PI_COMPACTION_RESERVE_TOKENS,
  MultiAgentPiCompactionPolicy,
  type MultiAgentPiCompactionModelRef,
  type MultiAgentPiCompactionModelResolver,
} from "./compaction/compaction-policy.js";
export {
  CODEX_SERVER_COMPACTION_SUMMARY,
  CodexServerCompactionController,
  createCodexServerCompactionController,
  executeCodexCompaction,
  resolveCodexRuntime,
  type CodexCheckpointDetails,
  type CodexCheckpointIdentity,
  type CodexCompactionExecutionOptions,
  type CodexCompactionExecutor,
  type CodexRuntime,
  type CodexRuntimeResolver,
  type CodexServerCompactionControllerOptions,
  type CodexServerCompactionSettings,
  type RuntimeResolution,
} from "./compaction/codex-server-compaction.js";
export {
  SUMMARY_GENERATION_MODES,
  defaultCodexCompactionLogger,
  generateSummary,
  isCodexCompactionItem,
  type CodexCompactionItem,
  type CodexCompactionLogger,
  type LocalSummaryGenerationOptions,
  type ServerSummaryGenerationOptions,
  type SummaryGenerationMode,
} from "./compaction/summary-generator.js";
export { extractResultText } from "./agent-loop/event-utils.js";
export { defaultAgentLoopLogger } from "./agent-loop/logger.js";
export {
  accountAgentEvent,
  applyAssistantMessageTerminalState,
  createAgentLoopRunState,
  type AgentEventAccounting,
  type AgentLoopRunState,
  type AgentLoopRunUsage,
  type PendingToolExecution,
} from "./agent-loop/run-state.js";
export {
  IMAGE_STRIPPED_OVERFLOW,
  createImageEvictionState,
  evictStaleImages,
  evictStaleSessionImages,
  prepareInitialSessionMessages,
  resetImageEvictionState,
  stripHeavyContent,
  stripHeavySessionContent,
  stripImagesAfterPrompt,
  stripSessionImages,
  stripToolResultDetailsForCompaction,
  truncateToolResultsForCompaction,
  type ImageCohort,
  type ImageEvictionState,
} from "./agent-loop/context-maintenance.js";
export {
  createCompactionStripExtension,
  setupCompactionStripExtension,
  stripCompactionMessagesCopyOnWrite,
  type CompactionStripCounts,
} from "./extensions/compaction-strip/extension.js";
export {
  LoopManager,
  type LoopDestroyReason,
  type LoopManagerEventHandler,
  type LoopManagerEventMap,
  type LoopManagerEventResultMap,
  type LoopManagerEventType,
  type LoopManagerOptions,
  type LoopReloadError,
  type OwnedLoop,
} from "./agent-loop/loop-manager.js";
export {
  bindExecutionEnv,
  executionEnvContext,
  type AgentLoopExecutionEnv,
  type ExecutionEnv,
  type ExecutionEnvFactory,
  type ExecutionEnvTarget,
  type ExecutionEnvUse,
} from "./execution-environment.js";
export {
  AvailableExtensions,
  findAvailableExtensions,
  type AvailableExtension,
  type AvailableExtensionsOptions,
  type AvailableExtensionsResult,
  type ExtensionFileCollision,
} from "./extensions/available-extensions.js";
export { ReloadablePiExtensionLoader } from "./extensions/reloadable-pi-extension-loader.js";
export {
  createPiExtensionLoader,
  invalidatePiExtensionFileCache,
  type PiExtensionLoaderOptions,
} from "./extensions/pi-extension-loader.js";
export {
  createActivatedPiToolExtensions,
  createToolDefinitionBridge,
  type ToolDefinitionBridge,
} from "./extensions/runtime-bridges.js";
export {
  TargetedLoopExtensionRegistry,
  type ExtensionLoopContext,
  type ExtensionLoopTarget,
} from "./extensions/targeted-loop-extensions.js";
export { deepMerge, readJsonFile } from "./config/config-json-utils.js";
export { parseMultiAgentPiConfig } from "./config/config-parser.js";
export type { MultiAgentPiConfigStorage } from "./config/config-storage.js";
export {
  KNOWN_THINKING_LEVELS,
  type ExternalSourceEntry,
  type ExternalSourcesManifest,
  type MultiAgentPiCompactionSettings,
  type MultiAgentPiConfig,
  type MultiAgentPiRetrySettings,
  type KnownProvider,
  type ThinkingLevel,
} from "./config/config-types.js";
export {
  getExternalSourcesPath,
  readExternalSources,
  writeExternalSources,
} from "./config/external-sources-manifest.js";
export {
  MultiAgentPiSettingsManager,
  type MultiAgentPiSettingsSnapshot,
} from "./config/multi-agent-pi-settings-manager.js";
export {
  MESSAGE_BATCH_WINDOW_MS,
  MessagePostQueue,
  type BatchingMessageQueue,
  type MessagePostErrorHandler,
  type MessageQueue,
} from "./output/message-post-queue.js";
export {
  Session,
  type PromptableLoop,
  type PromptableSession,
  type SessionOptions,
  type SessionPromptOptions,
  type SessionPromptResult,
  type SessionState,
} from "./session/session.js";
export type {
  SessionInfra,
  SessionPaths,
} from "./session/session-infra.js";
