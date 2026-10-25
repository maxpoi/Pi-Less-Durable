export interface AgentLogger {
  info(message: string, details?: string): void;
  warning(message: string, details?: string): void;
}

export const defaultAgentLogger: AgentLogger = Object.freeze({
  info(message: string, details?: string): void {
    if (details === undefined) console.info(message);
    else console.info(message, details);
  },
  warning(message: string, details?: string): void {
    if (details === undefined) console.warn(message);
    else console.warn(message, details);
  },
});
