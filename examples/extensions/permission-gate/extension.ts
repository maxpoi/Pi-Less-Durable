/**
 * Permission Gate Extension
 *
 * Blocks dangerous bash commands before execution.
 * Edit the arrays below to customize framework policy. Temporarily deactivate
 * it through AgentLoop.disable("permission-gate").
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	findCommandExecutable,
	findGitInvocations,
	parseShellCommands,
} from "../shell-command-parser.js";

// ============================================================================
// Configuration — edit these to customize
// ============================================================================

/** Exact substring matches (case-insensitive). Blocked if the command contains any of these. */
const BLOCKED_COMMANDS = [
	"mkfs",
	":(){ :|:& };:",
	"> /dev/sda",
	"dd if=/dev/zero",
	"dd if=/dev/random",
];

/** Regex patterns matched against the full command (case-insensitive). */
const BLOCKED_PATTERNS: Array<{ pattern: string; reason: string }> = [
	// chmod 777 on sensitive paths
	{ pattern: "chmod\\s+777\\s+/", reason: "Setting 777 permissions on system paths is blocked. Use minimal permissions required." },
	// pipe curl/wget to shell
	{ pattern: "(curl|wget)\\s+.*\\|\\s*(ba)?sh", reason: "Piping downloads to shell is blocked. Download the script first, inspect it, then run it." },
	// shutdown / reboot
	{ pattern: "^(shutdown|reboot|halt|init\\s+[06])\\b", reason: "System shutdown/reboot is blocked." },
];

// ============================================================================
// Git Safety — structural enforcement of dangerous git operations
// ============================================================================

const GIT_BLOCKED_PATTERNS: Array<{ pattern: string; reason: string }> = [
	// Lock file manipulation
	{
		pattern: "\\.git/index\\.lock",
		reason: "Manipulating git lock files is blocked. If a lock file exists, another git process may be running — wait for it to finish, or report the issue to the user.",
	},
	// rm -rf on LFS-tracked binary directories
	{
		pattern: "rm\\s+(-[^\\s]*\\s+)*(spark-client-framework/thirdparty|thirdparty/(jabber|wme|ecc))",
		reason: "Removing LFS-tracked binary directories is blocked — deleting and re-checking out LFS dirs corrupts them if the smudge filter fails. Report the issue to the user instead.",
	},
];

/** Exact substrings that override blocks (whitelist). If matched, command is always allowed. */
const ALLOWED_COMMANDS: string[] = [];

const ROOT_REMOVAL_REASON =
	"Removing root directory is blocked. Specify the exact path of what you intend to delete.";
const HOME_REMOVAL_REASON =
	"Removing home directory is blocked. Specify the exact path of what you intend to delete.";
const FORCE_PUSH_REASON =
	"Force-push is blocked. Push normally — if rejected, report the conflict to the user and let them decide how to resolve it. If the user needs to force-push, they can run `/disable permission-gate` to temporarily lift this restriction.";
const AMEND_REASON =
	"Amend is blocked. Create a new commit instead — the history should remain intact for traceability. If the user explicitly wants to amend, they can run `/disable permission-gate` to temporarily lift this restriction.";
const HARD_RESET_REASON =
	"Hard reset is blocked — it destroys uncommitted work. If you need to undo changes, use 'git checkout -- <file>' only on files you modified, or report the situation to the user. If the user explicitly wants a hard reset, they can run `/disable permission-gate` to temporarily lift this restriction.";
const LFS_OVERRIDE_REASON =
	"Overriding LFS filters is blocked — it corrupts binary files tracked by LFS. Run git commands without -c filter.lfs flags; the host has LFS configured correctly.";
const CHECKOUT_ALL_REASON =
	"Reverting all tracked files is blocked. Use 'git checkout -- <specific-file>' only on files you personally modified this session.";

function checkDangerousRmTarget(command: string): string | undefined {
	for (const words of parseShellCommands(command)) {
		const executableIndex = findCommandExecutable(words, "rm");
		if (executableIndex === undefined) continue;
		let optionsEnded = false;
		for (const argument of words.slice(executableIndex + 1)) {
			if (!optionsEnded && argument === "--") {
				optionsEnded = true;
				continue;
			}
			if (!optionsEnded && argument.startsWith("-")) continue;
			if (/^\/+$/u.test(argument)) return ROOT_REMOVAL_REASON;
			if (/^(?:~|\$HOME|\$\{HOME\})(?:\/+)?$/u.test(argument)) return HOME_REMOVAL_REASON;
		}
	}
	return undefined;
}

function hasLfsFilterOverride(globalArgs: readonly string[]): boolean {
	return globalArgs.some((argument, index) =>
		(argument === "-c" && /^filter\.lfs\./i.test(globalArgs[index + 1] ?? ""))
		|| /^-cfilter\.lfs\./i.test(argument)
	);
}

function checkDangerousGitOperation(command: string): string | undefined {
	for (const invocation of findGitInvocations(command)) {
		if (hasLfsFilterOverride(invocation.globalArgs)) return LFS_OVERRIDE_REASON;
		if (
			invocation.subcommand === "push"
			&& invocation.args.some(argument =>
				/^-[^-]*f[^-]*$/.test(argument)
				|| argument === "--force"
				|| argument.startsWith("--force=")
				|| argument === "--force-with-lease"
				|| argument.startsWith("--force-with-lease=")
			)
		) {
			return FORCE_PUSH_REASON;
		}
		if (invocation.subcommand === "commit" && invocation.args.includes("--amend")) {
			return AMEND_REASON;
		}
		if (invocation.subcommand === "reset" && invocation.args.includes("--hard")) {
			return HARD_RESET_REASON;
		}
		if (
			invocation.subcommand === "checkout"
			&& invocation.args.some((argument, index) =>
				argument === "--" && invocation.args[index + 1] === "."
			)
		) {
			return CHECKOUT_ALL_REASON;
		}
	}
	return undefined;
}

// ============================================================================

function setupPermissionGate(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;

		const command = (event.input as { command: string }).command;
		const commandLower = command.toLowerCase();

		// Check allowlist first — if matched, always permit
		for (const allowed of ALLOWED_COMMANDS) {
			if (commandLower.includes(allowed.toLowerCase())) {
				return;
			}
		}

		// Check exact substring blocks
		for (const blocked of BLOCKED_COMMANDS) {
			if (commandLower.includes(blocked.toLowerCase())) {
				console.log(`[permission-gate] Blocked command (substring): ${blocked}`);
				return { block: true, reason: `Blocked: "${blocked}" is a destructive system command. Specify the exact target path instead.` };
			}
		}

		const dangerousRmReason = checkDangerousRmTarget(command);
		if (dangerousRmReason) {
			console.log("[permission-gate] Blocked destructive rm target");
			return { block: true, reason: dangerousRmReason };
		}

		// Check general dangerous patterns
		for (const { pattern, reason } of BLOCKED_PATTERNS) {
			try {
				if (new RegExp(pattern, "i").test(command)) {
					console.log(`[permission-gate] Blocked command (pattern): ${pattern}`);
					return { block: true, reason };
				}
			} catch { /* skip invalid regex */ }
		}

		const dangerousGitReason = checkDangerousGitOperation(command);
		if (dangerousGitReason) {
			console.log("[permission-gate] Blocked dangerous git operation");
			return { block: true, reason: dangerousGitReason };
		}

		// Check remaining path-oriented git safety patterns
		for (const { pattern, reason } of GIT_BLOCKED_PATTERNS) {
			try {
				if (new RegExp(pattern, "i").test(command)) {
					console.log(`[permission-gate] Blocked git command (pattern): ${pattern}`);
					return { block: true, reason };
				}
			} catch { /* skip invalid regex */ }
		}
	});
}

export default function permissionGateExtension(pi: ExtensionAPI) {
	setupPermissionGate(pi);
}
