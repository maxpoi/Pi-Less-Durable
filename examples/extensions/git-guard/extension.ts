/**
 * Git Guard Extension
 *
 * Enforces git best-practice rules via pre-execution blocking (tool_call)
 * and post-execution output checking (tool_result):
 *
 *   1. [post] LFS errors/warnings in output → stop destructive recovery
 *   2. [pre]  git checkout for branching → must use git switch
 *   3. [pre]  git chained with ; instead of && → must use && to stop on error
 *   4. [pre]  git with 2>/dev/null → never suppress stderr on git commands
 *   5. [pre]  git worktree operations/configuration → no worktree usage is allowed
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	findGitInvocations,
	parseGitInvocation,
	parseShellCommands,
} from "../shell-command-parser.js";

// ── Constants ────────────────────────────────────────────────────────────────

const TAG = "[git-guard]";

// Rule 1: LFS error/warning patterns in command output
const LFS_WARNING_PATTERNS = [
	/should have been pointers/i,
	/smudge filter/i,
	/encountered \d+ file/i,
	/lfs.*error/i,
	/error.*lfs/i,
	/clean filter.*lfs/i,
];

// Rule 4: stderr suppression on git commands
const GIT_STDERR_SUPPRESS = /\bgit\s+[^|;]*2>\s*\/dev\/null/;
const GIT_WORK_TREE_ASSIGNMENT = /^GIT_WORK_TREE=/;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Check if a command contains git checkout used for branch operations. */
function checkBranchCheckout(command: string): string | undefined {
	for (const invocation of findGitInvocations(command)) {
		if (invocation.subcommand !== "checkout" || invocation.args.includes("--")) continue;
		if (invocation.args.some(argument => /^-[bB]/.test(argument))) {
			return "Use `git switch -c <branch>` instead of `git checkout -b <branch>`. `git switch` is safer — it only switches branches and won't accidentally overwrite files.";
		}
		const firstArgument = invocation.args[0];
		if (firstArgument !== undefined && !firstArgument.startsWith("-")) {
			return "Use `git switch <branch>` instead of `git checkout <branch>`. `git switch` is safer — it only switches branches and won't accidentally overwrite files. If you're restoring a file, use `git checkout -- <file>` explicitly.";
		}
	}
	return undefined;
}

/**
 * Check if git commands are chained with `;` instead of `&&`.
 *
 * Skips commands that look like shell control structures (for/while/if/case)
 * since `;` is syntactically required there.
 */
function checkSemicolonChaining(command: string): string | undefined {
	// Skip if no git command present
	if (!/\bgit\b/.test(command)) return undefined;

	// Skip if no semicolons
	if (!command.includes(";")) return undefined;

	// Skip shell control structures where `;` is syntactic
	if (/\b(for|while|until|if|elif|case)\b/.test(command)) return undefined;

	// Split by `;` and check if multiple segments contain real commands
	// with at least one being a git command
	const segments = command.split(";").map(s => s.trim()).filter(Boolean);
	if (segments.length < 2) return undefined;

	const hasGitSegment = segments.some(s => /^\s*(cd\s+.*\s*&&\s*)?git\b/.test(s) || /\bgit\s+\w/.test(s));
	if (!hasGitSegment) return undefined;

	return "When git is chained with other commands (including git), use `&&` instead of `;` to stop on error. Example: `git add . && git commit -m \"msg\"` instead of `git add . ; git commit -m \"msg\"`.";
}

/** Check if git commands have stderr suppressed with 2>/dev/null. */
function checkStderrSuppression(command: string): string | undefined {
	if (GIT_STDERR_SUPPRESS.test(command)) {
		return "Never use `2>/dev/null` with git commands. Git stderr contains important warnings and error messages that must not be suppressed.";
	}
	return undefined;
}

function assignsGitWorkTree(command: string): boolean {
	return parseShellCommands(command).some(words => {
		const assignmentIndex = words.findIndex(word => GIT_WORK_TREE_ASSIGNMENT.test(word));
		if (assignmentIndex < 0) return false;
		if (words[0] === "export" || words.every(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) {
			return true;
		}
		const invocation = parseGitInvocation(words);
		return invocation !== undefined && assignmentIndex < invocation.executableIndex;
	});
}

/** Check whether a command performs or configures Git worktree usage. */
export function checkWorktreeUsage(command: string, enabled = true): string | undefined {
	if (!enabled) return undefined;
	const usesWorktree = assignsGitWorkTree(command) || findGitInvocations(command).some(invocation =>
		invocation.usesWorkTreeOption
		|| invocation.subcommand === "worktree"
		|| (
			invocation.subcommand === "config"
			&& invocation.args.some(argument => /^extensions\.worktreeConfig(?:=|$)/i.test(argument))
		)
	);
	if (!usesWorktree) return undefined;
	return "Git worktree usage is blocked. No worktree operations are allowed. Do not use worktrees.";
}

/** Check tool output for LFS warnings/errors. */
function checkLfsOutput(text: string): boolean {
	return LFS_WARNING_PATTERNS.some(pattern => pattern.test(text));
}

// ── Extension ────────────────────────────────────────────────────────────────

function setupGitGuard(
	pi: ExtensionAPI,
	blockWorktreeOperations: boolean,
) {
	// ── Pre-execution: block rule-violating commands ──────────────────────
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;

		const command = (event.input as { command?: string }).command ?? "";
		if (!command) return;

		// Rule 5: git worktree usage (checked first so the policy guidance is not hidden by other git rules)
		const worktreeViolation = checkWorktreeUsage(command, blockWorktreeOperations);
		if (worktreeViolation) {
			console.log(`${TAG} Blocked: git worktree usage`);
			return { block: true, reason: `${TAG} ${worktreeViolation}` };
		}

		// Rule 2: git checkout → git switch
		const checkoutViolation = checkBranchCheckout(command);
		if (checkoutViolation) {
			console.log(`${TAG} Blocked: git checkout for branch operation`);
			return { block: true, reason: `${TAG} ${checkoutViolation}` };
		}

		// Rule 3: semicolon chaining
		const chainingViolation = checkSemicolonChaining(command);
		if (chainingViolation) {
			console.log(`${TAG} Blocked: git chained with semicolon`);
			return { block: true, reason: `${TAG} ${chainingViolation}` };
		}

		// Rule 4: stderr suppression
		const stderrViolation = checkStderrSuppression(command);
		if (stderrViolation) {
			console.log(`${TAG} Blocked: git stderr suppression`);
			return { block: true, reason: `${TAG} ${stderrViolation}` };
		}
	});

	// ── Post-execution: check for LFS warnings ──────────────────────────
	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;

		const command = (event.input as { command?: string }).command ?? "";
		// Only check git-related commands
		if (!/\bgit\b/.test(command)) return;

		const textContent = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");

		if (!checkLfsOutput(textContent)) return;

		console.log(`${TAG} LFS warning/error detected in output`);

		const warning = [
			"",
			`${TAG} ⚠️ Git LFS error/warning detected in the output above.`,
			"STOP what you are doing. Do NOT improvise destructive recovery or continue with git operations.",
		].join("\n");

		const newContent = [...event.content];
		newContent.push({ type: "text", text: warning });
		return { content: newContent };
	});
}

export function createGitGuardExtension(
	blockWorktreeOperations = true,
): ExtensionFactory {
	return pi => setupGitGuard(pi, blockWorktreeOperations);
}
