import type { AgentLogger } from "pi-less-durable";

export const logger: AgentLogger = Object.freeze({
  info(message: string, details?: string): void {
    console.info(details === undefined ? `[Bot] ${message}` : `[Bot] ${message}: ${details}`);
  },
  warning(message: string, details?: string): void {
    console.warn(details === undefined ? `[Bot] ${message}` : `[Bot] ${message}: ${details}`);
  },
});
