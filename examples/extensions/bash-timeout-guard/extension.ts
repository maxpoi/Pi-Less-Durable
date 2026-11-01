/**
 * Bash Timeout Guard Extension
 *
 * Removes model-provided bash timeout values for git-related and xcodebuild
 * commands. These commands may legitimately run for a long time, and killing
 * them on timeout can leave partial build state or git lock/transfer state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TAG = "[bash-timeout-guard]";
const COMMAND_LOG_LIMIT = 160;

// Keep this intentionally regex-based, like git-guard. Removing a bash timeout
// is low risk, so broad word-boundary matching is preferable to shell parsing.
const LONG_RUNNING_COMMAND_PATTERNS = [/\bgit\b/i, /\bxcodebuild\b/i];

export function timeoutFromInput(input: { timeout?: unknown }): number | undefined {
	return typeof input.timeout === "number" && Number.isFinite(input.timeout) ? input.timeout : undefined;
}

export function shouldRemoveBashTimeout(command: string): boolean {
	return LONG_RUNNING_COMMAND_PATTERNS.some(pattern => pattern.test(command));
}

export function summarizeCommand(command: string): string {
	const singleLine = command.replace(/\s+/g, " ").trim();
	return singleLine.length <= COMMAND_LOG_LIMIT ? singleLine : `${singleLine.slice(0, COMMAND_LOG_LIMIT - 3)}...`;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;

		const input = event.input as { command?: unknown; timeout?: unknown };
		if (typeof input.command !== "string") return;

		const timeout = timeoutFromInput(input);
		if (timeout === undefined) return;
		if (!shouldRemoveBashTimeout(input.command)) return;

		delete input.timeout;
		console.log(`${TAG} Removed ${timeout}s timeout for bash command: ${summarizeCommand(input.command)}`);
	});
}
