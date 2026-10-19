import type { MultiAgentPiConfig } from "./config-types.js";

export interface MultiAgentPiConfigStorage {
  loadConfig(): MultiAgentPiConfig;
  saveConfig(config: MultiAgentPiConfig): void;
}
