import {
  type AgentLoopLogger,
  type Api,
  type ExecutionEnvFactory,
  type Model,
  type ModelRuntime,
  type MultiAgentPiSettingsManager,
  type SessionInfra as SharedSessionInfra,
  type SessionPaths,
  type SettingsManager,
  type TargetedLoopExtensionRegistry,
  type ThinkingLevel,
} from "#core";
import type { SessionId } from "./session-types.js";

export interface SessionModelState {
  readonly runtime: ModelRuntime;
  readonly settings: MultiAgentPiSettingsManager;
  /** The same settings owner exposed at Pi's nominal AgentSession boundary. */
  readonly piSettings: SettingsManager;
  getModel(): Model<Api>;
  getThinkingLevel(): ThinkingLevel;
}

class ConfiguredSessionModelState implements SessionModelState {
  readonly runtime: ModelRuntime;
  readonly settings: MultiAgentPiSettingsManager;
  readonly piSettings: SettingsManager;

  constructor(runtime: ModelRuntime, settings: MultiAgentPiSettingsManager) {
    this.runtime = runtime;
    this.settings = settings;
    // Pi exposes a concrete class although AgentSession only consumes this
    // object's public settings methods. Keep one settings authority.
    this.piSettings = settings as unknown as SettingsManager;
  }

  getModel(): Model<Api> {
    const provider = this.settings.getDefaultProvider();
    const modelId = this.settings.getDefaultModel();
    if (!provider || !modelId) {
      throw new Error("Cannot resolve session model: provider and model must be configured");
    }
    const model = this.runtime.getModel(provider, modelId);
    if (!model) {
      throw new Error(
        `Cannot resolve session model: model "${provider}/${modelId}" is not registered in the host ModelRuntime`,
      );
    }
    return model;
  }

  getThinkingLevel(): ThinkingLevel {
    return this.settings.getDefaultThinkingLevel() as ThinkingLevel;
  }
}

export interface SessionResourceState {
  readonly logger: AgentLoopLogger;
  readonly extensionRegistry: TargetedLoopExtensionRegistry;
  readonly env?: ExecutionEnvFactory<SessionId>;
}

export type SessionInfra = SharedSessionInfra<
  SessionId,
  SessionModelState,
  SessionResourceState
>;

export interface CreateSessionInfraOptions {
  readonly id: SessionId;
  readonly paths: SessionPaths;
  readonly modelRuntime: ModelRuntime;
  readonly settings: MultiAgentPiSettingsManager;
  readonly logger: AgentLoopLogger;
  readonly extensionRegistry: TargetedLoopExtensionRegistry;
  readonly env?: ExecutionEnvFactory<SessionId>;
}

export function createSessionInfra(options: CreateSessionInfraOptions): SessionInfra {
  return Object.freeze({
    id: options.id,
    paths: Object.freeze({ ...options.paths }),
    models: new ConfiguredSessionModelState(options.modelRuntime, options.settings),
    resources: Object.freeze({
      logger: options.logger,
      extensionRegistry: options.extensionRegistry,
      ...(options.env === undefined ? {} : { env: options.env }),
    }),
  });
}
