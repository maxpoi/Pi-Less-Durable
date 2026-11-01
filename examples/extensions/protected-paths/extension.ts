/**
 * Protected Paths Extension
 *
 * Blocks write/edit operations to sensitive files and directories.
 * Edit the arrays below to customize framework policy. Temporarily deactivate
 * it through AgentLoop.disable("protected-paths").
 */

import { basename, normalize } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Configuration — edit these to customize
// ============================================================================

/**
 * Glob-like patterns for protected files/dirs.
 * Supports: `*` (any chars except /), `**` (any path depth), `?` (single char)
 * Matched against both the full path and the filename.
 */
const PROTECTED_PATHS = [
	// Environment & secrets
	".env",
	".env.*",
	"**/.env",
	"**/.env.*",
	// Git internals
	".git/**",
	"**/.git/**",
	// SSH keys
	"id_rsa",
	"id_rsa.*",
	"id_ed25519",
	"id_ed25519.*",
	"**/.ssh/*",
	// Certificates & private keys
	"*.pem",
	"*.key",
	"*.p12",
	"*.pfx",
	// Credential files
	"**/credentials",
	"**/credentials.json",
	"**/.npmrc",
	"**/.pypirc",
];

/** Exact substring overrides — files matching these are always allowed. */
const ALLOWED_PATHS: string[] = [];

// ============================================================================

/**
 * Convert a glob-like pattern to a RegExp.
 * Supports: ** (any depth), * (segment wildcard), ? (single char)
 */
function globToRegex(pattern: string): RegExp {
	let regex = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern.charAt(i);
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				regex += ".*";
				i += 2;
				if (pattern[i] === "/") i++;
			} else {
				regex += "[^/]*";
				i++;
			}
		} else if (ch === "?") {
			regex += "[^/]";
			i++;
		} else if (".+^${}()|[]\\".includes(ch)) {
			regex += "\\" + ch;
			i++;
		} else {
			regex += ch;
			i++;
		}
	}
	return new RegExp(`(^|/)${regex}$`, "i");
}

function isProtected(filePath: string): string | null {
	const normalized = normalize(filePath);
	const fileName = basename(normalized);

	for (const allowed of ALLOWED_PATHS) {
		if (normalized.includes(allowed) || fileName === allowed) {
			return null;
		}
	}

	for (const pattern of PROTECTED_PATHS) {
		const regex = globToRegex(pattern);
		if (regex.test(normalized) || regex.test(fileName)) {
			return pattern;
		}
	}

	return null;
}

function setupProtectedPaths(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const filePath = (event.input as { path: string }).path;
		const matchedPattern = isProtected(filePath);

		if (matchedPattern) {
			console.log(`[protected-paths] Blocked ${event.toolName} to ${filePath} (matched: ${matchedPattern})`);
			return {
				block: true,
				reason: `Protected path: "${filePath}" matches pattern "${matchedPattern}". This file is protected from modifications.`,
			};
		}
	});
}

export default function protectedPathsExtension(pi: ExtensionAPI) {
	setupProtectedPaths(pi);
}
