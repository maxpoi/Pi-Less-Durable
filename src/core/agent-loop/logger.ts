import type { AgentLoopLogger } from "./types.js";

/** Default diagnostic sink used when a host does not provide an override. */
export const defaultAgentLoopLogger: AgentLoopLogger = Object.freeze({
  info(message: string, details?: string): void {
    if (details === undefined) console.info(message);
    else console.info(message, details);
  },
  warning(message: string, details?: string): void {
    if (details === undefined) console.warn(message);
    else console.warn(message, details);
  },
});
