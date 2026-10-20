import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

function formatUnknownForLog(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatAssistantErrorDetails(message: AssistantMessage, activeModel?: Model<Api>): string {
  const lines: string[] = [
    `api=${message.api || activeModel?.api || "?"}`,
    `provider=${message.provider || activeModel?.provider || "?"}`,
    `model=${message.model || activeModel?.id || "?"}`,
    `stopReason=${message.stopReason || "?"}`,
  ];

  if (message.responseModel) lines.push(`responseModel=${message.responseModel}`);
  if (message.responseId) lines.push(`responseId=${message.responseId}`);
  if (message.rawStopReason) lines.push(`rawStopReason=${message.rawStopReason}`);
  if (message.errorMessage) lines.push(`error=${message.errorMessage}`);

  for (const diagnostic of message.diagnostics || []) {
    lines.push(`diagnostic.type=${diagnostic.type}`);
    if (diagnostic.error) {
      if (diagnostic.error.name) lines.push(`diagnostic.error.name=${diagnostic.error.name}`);
      lines.push(`diagnostic.error.message=${diagnostic.error.message}`);
      if (diagnostic.error.code !== undefined) lines.push(`diagnostic.error.code=${diagnostic.error.code}`);
      if (diagnostic.error.stack) lines.push(`diagnostic.error.stack=${diagnostic.error.stack}`);
    }
    if (diagnostic.details) lines.push(`diagnostic.details=${formatUnknownForLog(diagnostic.details)}`);
  }

  return lines.join("\n");
}

export function formatRetryDetails(event: { finalError?: unknown }, activeModel?: Model<Api>): string {
  const lines = [
    `api=${activeModel?.api || "?"}`,
    `provider=${activeModel?.provider || "?"}`,
    `model=${activeModel?.id || "?"}`,
  ];
  if (event.finalError !== undefined) lines.push(`finalError=${formatUnknownForLog(event.finalError)}`);
  return lines.join("\n");
}
