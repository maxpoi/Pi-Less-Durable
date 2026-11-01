/**
 * Token Breakdown Extension — Debug diagnostic for understanding token usage.
 *
 * Snapshots each API request payload, logs a single breakdown when the agent
 * loop ends (agent_end), and optionally writes a debug log file for diagnosis.
 *
 * Uses proportional splitting: distributes API-reported total tokens across
 * components by their character ratio. No calibration needed.
 *
 * Debug log strategy: only log on meaningful events:
 *   - Session start (first call): full system prompt + tools baseline
 *   - System prompt changed: diff of what changed
 *   - Tools changed: note the change
 *   - Cache break: full context of what invalidated
 *   Normal calls (messages growing, cache hit) just get the turn summary.
 *
 * Toggle debug log:
 *   Enabled by default.
 *   Set TOKEN_BREAKDOWN_DEBUG=0 in the host environment to disable.
 *   Requires a process restart after changing the environment.
 *   Log location: {roomDir}/token-breakdown-debug.log
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Room } from "../../../src/room/room.js";
import { extractProviderSystemText } from "./provider-prompt.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface Snapshot {
	timestamp: number;
	system: string;
	tools: string;
	messages: string;
	lastUserMsg: string;
}

interface DiffResult {
	systemChanged: boolean;
	toolsChanged: boolean;
	messagesGrew: boolean;
	newContent: string;
	causes: string[];
}

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface TurnCall {
	timestamp: string;
	snapshot: Snapshot;
	diff: DiffResult;
	usage: Usage;
	cacheBreak: boolean;
	isFirstCall: boolean;
}

interface TurnState {
	calls: TurnCall[];
}

interface CacheBreakEntry {
	causes: string[];
	tokensWritten: number;
}

interface SessionStats {
	apiCalls: number;
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	peakInputTokens: number;
	cacheBreaks: CacheBreakEntry[];
	systemChars: number;
	toolsChars: number;
	messagesCharsMax: number;
}

// ── State ───────────────────────────────────────────────────────────────────

// Request/turn correlation is loop-local. Session totals remain room-scoped.
const prevSnapshots = new Map<string, Snapshot>();
const pendingSnapshots = new Map<string, Snapshot>();
const sessionStats = new Map<string, SessionStats>();
const turnStates = new Map<string, TurnState>();
const hasLoggedBaseline = new Map<string, boolean>();

const roomsWithLifecycleRegistration = new WeakSet<Room>();

function isDebugLogEnabled(): boolean {
	return process.env.TOKEN_BREAKDOWN_DEBUG !== "0";
}

// Baseline token estimates for stable components (established on first valid call,
// re-established when system prompt or tools change). Used to pin stable components
// so their token estimates don't fluctuate as messages grow.
interface BaselineSplit {
	system: number;
	tools: number;
	systemChars: number;
	toolsChars: number;
}
const baselineSplits = new Map<string, BaselineSplit>();

// ── Proportional token estimation ───────────────────────────────────────────

function proportionalSplit(snapshot: Snapshot, apiTotal: number) {
	const chars = {
		system: snapshot.system.length,
		tools: snapshot.tools.length,
		messages: snapshot.messages.length,
	};
	const totalChars = chars.system + chars.tools + chars.messages;
	if (totalChars === 0) return { system: 0, tools: 0, messages: 0, totalChars };

	return {
		system: Math.round((chars.system / totalChars) * apiTotal),
		tools: Math.round((chars.tools / totalChars) * apiTotal),
		messages: Math.round((chars.messages / totalChars) * apiTotal),
		totalChars,
	};
}

/**
 * Anchored split: pins token estimates for components whose char count hasn't
 * changed since the baseline, assigns the remainder to components that changed
 * (typically just messages). This prevents stable components from appearing to
 * fluctuate as the total token count changes.
 */
function anchoredSplit(snapshot: Snapshot, apiTotal: number, baseline: BaselineSplit | undefined) {
	if (!baseline || apiTotal === 0) {
		return proportionalSplit(snapshot, apiTotal);
	}

	const totalChars = snapshot.system.length + snapshot.tools.length + snapshot.messages.length;
	if (totalChars === 0) return { system: 0, tools: 0, messages: 0, totalChars };

	const system = snapshot.system.length === baseline.systemChars
		? baseline.system : Math.round((snapshot.system.length / totalChars) * apiTotal);
	const tools = snapshot.tools.length === baseline.toolsChars
		? baseline.tools : Math.round((snapshot.tools.length / totalChars) * apiTotal);

	const pinned = system + tools;

	// Sanity: if pinned exceeds total (stale baseline after context compaction), fall back
	if (pinned >= apiTotal) {
		return proportionalSplit(snapshot, apiTotal);
	}

	return { system, tools, messages: apiTotal - pinned, totalChars };
}

// ── Payload parsing ─────────────────────────────────────────────────────────

function extractToolsText(payload: any): string {
	if (!payload.tools) return "";
	return JSON.stringify(payload.tools);
}

function extractMessagesText(payload: any): { full: string; lastUser: string } {
	let msgs: any[] = [];
	if (Array.isArray(payload.messages)) {
		msgs = payload.messages.filter((m: any) => m.role !== "system" && m.role !== "developer");
	} else if (Array.isArray(payload.input)) {
		msgs = payload.input.filter((m: any) => m.role !== "system" && m.role !== "developer");
	}

	const parts: string[] = [];
	let lastUser = "";
	for (const msg of msgs) {
		if (typeof msg.content === "string") {
			parts.push(msg.content);
			if (msg.role === "user") lastUser = msg.content.slice(0, 200);
		} else if (Array.isArray(msg.content)) {
			const text = msg.content
				.filter((c: any) => c.type === "text" || c.type === "tool_result")
				.map((c: any) => c.text || JSON.stringify(c.content || ""))
				.join("\n");
			parts.push(text);
			if (msg.role === "user") lastUser = text.slice(0, 200);
		}
	}
	return { full: parts.join("\n"), lastUser };
}

function createSnapshot(payload: any): Snapshot {
	const tools = extractToolsText(payload);
	const messages = extractMessagesText(payload);
	return {
		timestamp: Date.now(),
		system: extractProviderSystemText(payload),
		tools,
		messages: messages.full,
		lastUserMsg: messages.lastUser,
	};
}

// ── Diff computation ────────────────────────────────────────────────────────

function computeDiff(prev: Snapshot | undefined, curr: Snapshot): DiffResult {
	if (!prev) {
		return {
			systemChanged: true,
			toolsChanged: true,
			messagesGrew: true,
			newContent: "(cold start — entire payload is new)",
			causes: ["first request (cold start — full cache write)"],
		};
	}

	const systemChanged = prev.system !== curr.system;
	const toolsChanged = prev.tools !== curr.tools;
	const messagesGrew = curr.messages.length > prev.messages.length;

	const causes: string[] = [];
	if (systemChanged) {
		const prevLines = prev.system.split("\n");
		const currLines = curr.system.split("\n");
		if (prevLines.length !== currLines.length) {
			causes.push(`system prompt: line count ${prevLines.length} → ${currLines.length}`);
		} else {
			for (let i = 0; i < prevLines.length; i++) {
				if (prevLines[i] !== currLines[i]) {
					const section = identifySection(currLines, i);
					causes.push(`system prompt changed at line ${i + 1}${section ? ` (${section})` : ""}`);
					break;
				}
			}
		}
	}
	if (toolsChanged) causes.push("tool definitions changed");
	if (messagesGrew) {
		const newChars = curr.messages.length - prev.messages.length;
		causes.push(`+${newChars} chars in messages`);
	}
	if (causes.length === 0) causes.push("no changes detected (possible TTL expiry)");

	// Build content preview for terminal (kept short)
	const contentParts: string[] = [];
	if (systemChanged) contentParts.push("[system prompt changed]");
	if (toolsChanged) contentParts.push("[tools changed]");
	if (messagesGrew) contentParts.push(`[+${curr.messages.length - prev.messages.length} chars msgs]`);
	const newContent = contentParts.length > 0 ? contentParts.join(" | ") : "(no changes)";

	return { systemChanged, toolsChanged, messagesGrew, newContent, causes };
}

function identifySection(lines: string[], lineIdx: number): string {
	for (let i = lineIdx; i >= 0; i--) {
		const line = lines[i];
		if (line?.startsWith("## ")) return line.slice(3).trim();
		if (line?.startsWith("# ")) return line.slice(2).trim();
	}
	return "";
}

// ── Line diff helper ────────────────────────────────────────────────────────

function computeLineDiff(prev: string, curr: string): string[] {
	const prevLines = prev.split("\n");
	const currLines = curr.split("\n");
	const diffLines: string[] = [];

	// Simple diff: find added/removed lines (not a full diff algorithm, just enough for diagnosis)
	const maxLines = Math.max(prevLines.length, currLines.length);
	let diffCount = 0;
	const MAX_DIFF_LINES = 30;

	for (let i = 0; i < maxLines && diffCount < MAX_DIFF_LINES; i++) {
		const p = prevLines[i];
		const c = currLines[i];
		if (p === undefined && c !== undefined) {
			diffLines.push(`  + line ${i + 1}: ${c.slice(0, 200)}`);
			diffCount++;
		} else if (c === undefined && p !== undefined) {
			diffLines.push(`  - line ${i + 1}: ${p.slice(0, 200)}`);
			diffCount++;
		} else if (p !== c) {
			diffLines.push(`  - line ${i + 1}: ${(p || "").slice(0, 200)}`);
			diffLines.push(`  + line ${i + 1}: ${(c || "").slice(0, 200)}`);
			diffCount += 2;
		}
	}

	if (diffCount >= MAX_DIFF_LINES) {
		diffLines.push(`  ... (truncated, ${maxLines - MAX_DIFF_LINES} more lines differ)`);
	}

	return diffLines;
}

// ── Formatting (terminal) ───────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatBreakdown(snapshot: Snapshot, diff: DiffResult, usage: Usage, interrupted = false, baseline?: BaselineSplit): string {
	const apiTotal = usage.input + usage.cacheRead + usage.cacheWrite;

	// No token data (turn interrupted before any response) — show char-only breakdown
	if (apiTotal === 0) {
		const chars = {
			system: snapshot.system.length,
			tools: snapshot.tools.length,
			messages: snapshot.messages.length,
		};
		const totalChars = chars.system + chars.tools + chars.messages;
		const pct = (n: number) => totalChars > 0 ? (n / totalChars * 100).toFixed(1) : "?";
		const lines: string[] = [
			`┌─ Context: ${formatTokens(totalChars)} chars (no token data${interrupted ? " — interrupted" : ""})`,
			`│  System Prompt:           ${formatTokens(chars.system)} chars (${pct(chars.system)}%)`,
			`│  Tool Definitions:        ${formatTokens(chars.tools)} chars (${pct(chars.tools)}%)`,
			`│  Messages + History:      ${formatTokens(chars.messages)} chars (${pct(chars.messages)}%)`,
			`└─────────────────────────────`,
		];
		return lines.join("\n");
	}

	// Use anchored split (pins stable components) when baseline is available
	const split = anchoredSplit(snapshot, apiTotal, baseline);

	const pctSystem = (split.system / apiTotal * 100).toFixed(1);
	const pctTools = (split.tools / apiTotal * 100).toFixed(1);
	const pctMessages = (split.messages / apiTotal * 100).toFixed(1);
	const hitRate = (usage.cacheRead / apiTotal * 100).toFixed(1);

	const lines: string[] = [
		`┌─ Token Breakdown (${formatTokens(split.totalChars)} chars → ${formatTokens(apiTotal)} tokens)${interrupted ? " [last complete call]" : ""}`,
		`│  System Prompt:           ${formatTokens(split.system)} (${pctSystem}%)`,
		`│  Tool Definitions:        ${formatTokens(split.tools)} (${pctTools}%)`,
		`│  Messages + History:      ${formatTokens(split.messages)} (${pctMessages}%)`,
		`├─ Cache Analysis`,
		`│  Hit Rate:  ${hitRate}% (${formatTokens(usage.cacheRead)} read / ${formatTokens(apiTotal)} total)`,
		`│  Fresh:     ${formatTokens(usage.input)} tokens`,
		`│  Written:   ${formatTokens(usage.cacheWrite)} tokens`,
		`│  Read:      ${formatTokens(usage.cacheRead)} tokens`,
	];

	const isPrefixBreak = usage.cacheWrite > split.system * 0.5;
	if (isPrefixBreak) {
		lines.push(`├─ ⚠ CACHE PREFIX INVALIDATED (${formatTokens(usage.cacheWrite)} written)`);
		for (const cause of diff.causes) {
			lines.push(`│  • ${cause}`);
		}
	} else if (usage.cacheWrite > 0) {
		lines.push(`├─ Cache: Prefix hit, +${formatTokens(usage.cacheWrite)} incremental`);
	} else {
		lines.push(`├─ Cache: Full hit (no write)`);
	}

	lines.push(`└─────────────────────────────`);
	return lines.join("\n");
}

function formatSessionSummary(stats: SessionStats): string {
	const totalInputAll = stats.totalInput + stats.totalCacheRead + stats.totalCacheWrite;
	const totalChars = stats.systemChars + stats.toolsChars + stats.messagesCharsMax;

	const split = totalChars > 0 ? {
		system: Math.round((stats.systemChars / totalChars) * totalInputAll),
		tools: Math.round((stats.toolsChars / totalChars) * totalInputAll),
		messages: Math.round((stats.messagesCharsMax / totalChars) * totalInputAll),
	} : { system: 0, tools: 0, messages: 0 };

	const pctSystem = totalInputAll > 0 ? (split.system / totalInputAll * 100).toFixed(1) : "?";
	const pctTools = totalInputAll > 0 ? (split.tools / totalInputAll * 100).toFixed(1) : "?";
	const pctMessages = totalInputAll > 0 ? (split.messages / totalInputAll * 100).toFixed(1) : "?";
	const hitRate = totalInputAll > 0 ? (stats.totalCacheRead / totalInputAll * 100).toFixed(1) : "0.0";

	const lines: string[] = [
		`╔══ SESSION SUMMARY (${stats.apiCalls} API calls) ══`,
		`║  System: ${pctSystem}%  |  Tools: ${pctTools}%  |  Messages: ${pctMessages}%`,
		`║  Cache Hit Rate: ${hitRate}%`,
		`║  Total Read: ${formatTokens(stats.totalCacheRead)}  Written: ${formatTokens(stats.totalCacheWrite)}  Fresh: ${formatTokens(stats.totalInput)}`,
		`║  Peak Input: ${formatTokens(stats.peakInputTokens)} tokens/call`,
	];

	if (stats.cacheBreaks.length > 0) {
		lines.push(`║  Cache Breaks (${stats.cacheBreaks.length}):`);
		for (const brk of stats.cacheBreaks) {
			lines.push(`║    • ${formatTokens(brk.tokensWritten)} written — ${brk.causes.join("; ")}`);
		}
	}

	lines.push(`╚${'═'.repeat(50)}`);
	return lines.join("\n");
}

// ── Debug log (every turn with summary + detail on changes) ─────────────────

function writeDebugLog(roomDir: string, calls: TurnCall[]): void {
	const logPath = join(roomDir, "token-breakdown-debug.log");
	try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* exists */ }

	const lines: string[] = [];

	for (const call of calls) {
		const callApiTotal = call.usage.input + call.usage.cacheRead + call.usage.cacheWrite;

		// First call of session — full baseline dump
		if (call.isFirstCall) {
			lines.push(`\n${'═'.repeat(80)}`);
			lines.push(`SESSION START [${call.timestamp}]`);
			lines.push(`${'═'.repeat(80)}`);
			lines.push(`API: input=${call.usage.input} cacheRead=${call.usage.cacheRead} cacheWrite=${call.usage.cacheWrite} total=${callApiTotal}`);
			lines.push(``);
			lines.push(`── System Prompt [${call.snapshot.system.length} chars] ──`);
			lines.push(call.snapshot.system);
			lines.push(``);
			lines.push(`── Tools [${call.snapshot.tools.length} chars] ──`);
			lines.push(call.snapshot.tools);
			lines.push(``);
			lines.push(`${'─'.repeat(80)}`);
			continue;
		}

		// Change detected — log the delta details
		const hasChange = call.diff.systemChanged || call.diff.toolsChanged || call.cacheBreak;
		if (hasChange) {
			lines.push(``);
			lines.push(`── [${call.timestamp}]${call.cacheBreak ? " ⚠ CACHE BREAK" : " CHANGE DETECTED"} ──`);
			lines.push(`API: input=${call.usage.input} cacheRead=${call.usage.cacheRead} cacheWrite=${call.usage.cacheWrite} total=${callApiTotal}`);
			lines.push(`Causes: ${call.diff.causes.join("; ")}`);

			if (call.diff.systemChanged) {
				const prevCall = findPreviousCall(calls, call);
				if (prevCall) {
					lines.push(``);
					lines.push(`System Prompt diff:`);
					const diffLines = computeLineDiff(prevCall.snapshot.system, call.snapshot.system);
					lines.push(...diffLines);
				}
			}

			if (call.diff.toolsChanged) {
				const prevCall = findPreviousCall(calls, call);
				if (prevCall) {
					lines.push(``);
					lines.push(`Tools changed: [${prevCall.snapshot.tools.length} chars] → [${call.snapshot.tools.length} chars]`);
					const prevToolNames = extractToolNames(prevCall.snapshot.tools);
					const currToolNames = extractToolNames(call.snapshot.tools);
					const added = currToolNames.filter(t => !prevToolNames.includes(t));
					const removed = prevToolNames.filter(t => !currToolNames.includes(t));
					if (added.length > 0) lines.push(`  Added: ${added.join(", ")}`);
					if (removed.length > 0) lines.push(`  Removed: ${removed.join(", ")}`);
					if (added.length === 0 && removed.length === 0) lines.push(`  (tool definitions modified, same set)`);
				} else {
					lines.push(``);
					lines.push(`Tools [${call.snapshot.tools.length} chars]:`);
					lines.push(call.snapshot.tools);
				}
			}

			lines.push(`${'─'.repeat(80)}`);
		}
	}

	// Always append turn summary (breakdown from last call)
	const lastCall = calls.at(-1);
	if (!lastCall) return;
	const apiTotal = lastCall.usage.input + lastCall.usage.cacheRead + lastCall.usage.cacheWrite;
	const split = proportionalSplit(lastCall.snapshot, apiTotal);
	const pctSystem = apiTotal > 0 ? (split.system / apiTotal * 100).toFixed(1) : "?";
	const pctTools = apiTotal > 0 ? (split.tools / apiTotal * 100).toFixed(1) : "?";
	const pctMessages = apiTotal > 0 ? (split.messages / apiTotal * 100).toFixed(1) : "?";
	const hitRate = apiTotal > 0 ? (lastCall.usage.cacheRead / apiTotal * 100).toFixed(1) : "0.0";

	lines.push(``);
	lines.push(`[${lastCall.timestamp}] Turn (${calls.length} calls)`);
	lines.push(`┌─ Token Breakdown (${formatTokens(split.totalChars)} chars → ${formatTokens(apiTotal)} tokens)`);
	lines.push(`│  System Prompt:           ${formatTokens(split.system)} (${pctSystem}%)`);
	lines.push(`│  Tool Definitions:        ${formatTokens(split.tools)} (${pctTools}%)`);
	lines.push(`│  Messages + History:      ${formatTokens(split.messages)} (${pctMessages}%)`);
	lines.push(`├─ Cache Analysis`);
	lines.push(`│  Hit Rate:  ${hitRate}% (${formatTokens(lastCall.usage.cacheRead)} read / ${formatTokens(apiTotal)} total)`);
	lines.push(`│  Fresh:     ${formatTokens(lastCall.usage.input)} tokens`);
	lines.push(`│  Written:   ${formatTokens(lastCall.usage.cacheWrite)} tokens`);
	lines.push(`│  Read:      ${formatTokens(lastCall.usage.cacheRead)} tokens`);

	const hasAnyChange = calls.some(c => !c.isFirstCall && (c.diff.systemChanged || c.diff.toolsChanged || c.cacheBreak));
	if (!hasAnyChange && !calls[0]?.isFirstCall) {
		lines.push(`├─ No changes to system prompt or tools`);
	}
	lines.push(`└─────────────────────────────`);
	lines.push(``);

	appendFileSync(logPath, lines.join("\n"), "utf-8");
}

function findPreviousCall(calls: TurnCall[], current: TurnCall): TurnCall | undefined {
	const idx = calls.indexOf(current);
	return idx > 0 ? calls[idx - 1] : undefined;
}

function extractToolNames(toolsJson: string): string[] {
	try {
		const tools = JSON.parse(toolsJson);
		if (Array.isArray(tools)) {
			return tools.map((t: any) => t.name || t.function?.name || "unknown");
		}
	} catch { /* not valid json */ }
	return [];
}

// ── Session stats helpers ───────────────────────────────────────────────────

function getOrCreateStats(roomKey: string): SessionStats {
	let stats = sessionStats.get(roomKey);
	if (!stats) {
		stats = {
			apiCalls: 0,
			totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0,
			peakInputTokens: 0,
			cacheBreaks: [],
			systemChars: 0, toolsChars: 0, messagesCharsMax: 0,
		};
		sessionStats.set(roomKey, stats);
	}
	return stats;
}

interface OwningLoop {
	readonly roomId: string;
	readonly roomDir: string;
	readonly loopId: string;
	readonly key: string;
}

function getOwningLoop(room: Room, loopId: string): OwningLoop {
	return {
		roomId: room.id,
		roomDir: room.roomDir,
		loopId,
		key: `${room.roomDir}\0${loopId}`,
	};
}

const loopStateStores = [prevSnapshots, pendingSnapshots, turnStates, hasLoggedBaseline, baselineSplits];

function clearLoopState(key: string): void {
	for (const store of loopStateStores) store.delete(key);
}

function clearLoopStateForRoom(roomDir: string): void {
	const prefix = `${roomDir}\0`;
	for (const store of loopStateStores) {
		for (const key of store.keys()) {
			if (key.startsWith(prefix)) store.delete(key);
		}
	}
}

// ── Extension entry point ───────────────────────────────────────────────────

export function setupTokenBreakdownHooks(
	pi: ExtensionAPI,
	room: Room,
	loopId: string,
) {

	// Capture payload in this loop's native Pi pipeline so concurrent loops in
	// one room cannot consume each other's request snapshots.
	pi.on("before_provider_request", (event) => {
		const { payload } = event as any;
		const owner = getOwningLoop(room, loopId);
		if (!payload || owner.loopId.startsWith("event-")) return undefined;
		pendingSnapshots.set(owner.key, createSnapshot(payload));
		return undefined;
	});

	// After response, accumulate turn + session stats
	pi.on("message_end", (event) => {
		const owner = getOwningLoop(room, loopId);
		if (owner.loopId.startsWith("event-")) {
			pendingSnapshots.delete(owner.key);
			return;
		}

		const msg = event?.message;
		if (!msg || msg.role !== "assistant" || !msg.usage) return;

		const { roomId, roomDir, key } = owner;
		const snapshot = pendingSnapshots.get(key);
		if (!snapshot) return;
		pendingSnapshots.delete(key);

		const prev = prevSnapshots.get(key);
		const diff = computeDiff(prev, snapshot);
		const usage: Usage = {
			input: msg.usage.input || 0,
			output: msg.usage.output || 0,
			cacheRead: msg.usage.cacheRead || 0,
			cacheWrite: msg.usage.cacheWrite || 0,
		};

		const apiTotal = usage.input + usage.cacheRead + usage.cacheWrite;
		const split = proportionalSplit(snapshot, apiTotal);
		const isPrefixBreak = usage.cacheWrite > split.system * 0.5;
		const isFirstCall = !hasLoggedBaseline.get(key);

		if (isFirstCall) {
			hasLoggedBaseline.set(key, true);
		}

		// Establish or update baseline for anchored splitting.
		// Re-baseline when any stable component's char count changes.
		if (apiTotal > 0) {
			const existing = baselineSplits.get(key);
			if (!existing ||
				snapshot.system.length !== existing.systemChars ||
				snapshot.tools.length !== existing.toolsChars) {
				baselineSplits.set(key, {
					system: split.system,
					tools: split.tools,
					systemChars: snapshot.system.length,
					toolsChars: snapshot.tools.length,
				});
			}
		}

		// Accumulate turn state
		const turn = turnStates.get(key) || { calls: [] };
		turn.calls.push({
			timestamp: new Date().toISOString(),
			snapshot,
			diff,
			usage,
			cacheBreak: isPrefixBreak,
			isFirstCall,
		});
		turnStates.set(key, turn);

		// Accumulate session stats
		const stats = getOrCreateStats(roomDir);
		stats.apiCalls++;
		stats.totalInput += usage.input;
		stats.totalOutput += usage.output;
		stats.totalCacheRead += usage.cacheRead;
		stats.totalCacheWrite += usage.cacheWrite;
		stats.peakInputTokens = Math.max(stats.peakInputTokens, apiTotal);
		stats.systemChars = snapshot.system.length;
		stats.toolsChars = snapshot.tools.length;
		stats.messagesCharsMax = Math.max(stats.messagesCharsMax, snapshot.messages.length);

		if (isPrefixBreak) {
			stats.cacheBreaks.push({ causes: diff.causes, tokensWritten: usage.cacheWrite });
		}

		prevSnapshots.set(key, snapshot);
	});

	// Log breakdown once when the entire agent loop ends + write debug log
	pi.on("agent_end", () => {
		const owner = getOwningLoop(room, loopId);
		if (owner.loopId.startsWith("event-")) {
			pendingSnapshots.delete(owner.key);
			return;
		}

		const { roomId, roomDir, key } = owner;
		const turn = turnStates.get(key);
		const pending = pendingSnapshots.get(key);

		// Handle case where turn was killed before any response completed.
		if (!turn || turn.calls.length === 0) {
			if (pending === undefined) return;
			pendingSnapshots.delete(key);
			turnStates.delete(key);
			const emptyUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			const emptyDiff: DiffResult = { systemChanged: false, toolsChanged: false, messagesGrew: false, newContent: "", causes: [] };
			const breakdown = formatBreakdown(pending, emptyDiff, emptyUsage, true);
			console.log(`[token-breakdown] ${roomId.slice(-8)} [interrupted]\n` + breakdown);
			return;
		}

		// Clean up pending snapshot (request started but never completed).
		if (pending !== undefined) pendingSnapshots.delete(key);
		turnStates.delete(key);

		// Write debug log (only events — initial + changes)
		if (isDebugLogEnabled()) {
			try { writeDebugLog(roomDir, turn.calls); } catch { /* best effort */ }
		}

		// Find the best call for display: prefer last call with valid usage.
		// When a turn is interrupted, the last API call may have 0 usage
		// (response never completed). Fall back to the last call that has
		// real token data so the breakdown is useful.
		let displayCall = turn.calls.at(-1);
		if (!displayCall) return;
		const lastApiTotal = displayCall.usage.input + displayCall.usage.cacheRead + displayCall.usage.cacheWrite;
		let interrupted = lastApiTotal === 0 || !!pending;

		if (lastApiTotal === 0 && turn.calls.length > 1) {
			for (let i = turn.calls.length - 2; i >= 0; i--) {
				const candidate = turn.calls[i];
				if (!candidate) continue;
				const u = candidate.usage;
				if (u.input + u.cacheRead + u.cacheWrite > 0) {
					displayCall = candidate;
					break;
				}
			}
		}

		const baseline = baselineSplits.get(key);
		const breakdown = formatBreakdown(displayCall.snapshot, displayCall.diff, displayCall.usage, interrupted, baseline);
		const callCountStr = turn.calls.length > 1 ? ` (${turn.calls.length} API calls)` : "";
		const interruptStr = interrupted ? " [interrupted]" : "";
		console.log(`[token-breakdown] ${roomId.slice(-8)}${callCountStr}${interruptStr}\n` + breakdown);
	});

	// AgentLoop destruction emits session_shutdown for this private Pi runtime.
	// Release request-sized snapshots here; room-level totals survive until reset.
	pi.on("session_shutdown", () => {
		clearLoopState(getOwningLoop(room, loopId).key);
	});
}

function ensureRoomLifecycleRegistration(
	room: Room,
	isEnabled: () => boolean,
): void {
	if (roomsWithLifecycleRegistration.has(room)) return;

	const unsubscribeBeforeReset = room.on("before_room_reset", ({ roomId }) => {
		if (!isEnabled()) return;
		const stats = sessionStats.get(room.roomDir);
		if (stats && stats.apiCalls > 0) {
			console.log(`[token-breakdown] ${roomId.slice(-8)} SESSION END\n${formatSessionSummary(stats)}`);
		}
	});
	let unsubscribeResetEnd = (): void => {};
	try {
		unsubscribeResetEnd = room.on("room_reset_end", ({ roomDir, archiveName }) => {
			try {
				if (!isEnabled()) return;
				clearLoopStateForRoom(roomDir);
				sessionStats.delete(roomDir);
				const logFile = join(roomDir, "token-breakdown-debug.log");
				if (archiveName && existsSync(logFile)) {
					try {
						renameSync(
							logFile,
							join(roomDir, "sessions", archiveName, "token-breakdown-debug.log"),
						);
					} catch { /* best-effort */ }
				}
			} finally {
				roomsWithLifecycleRegistration.delete(room);
				unsubscribeBeforeReset();
				unsubscribeResetEnd();
			}
		});
	} catch (error) {
		unsubscribeBeforeReset();
		throw error;
	}
	roomsWithLifecycleRegistration.add(room);
}

export function createTokenBreakdownExtension(options: {
	readonly room: Room;
	readonly loopId: string;
	readonly primary: boolean;
	readonly isEnabled: () => boolean;
}): ExtensionFactory {
	const { room, loopId, primary, isEnabled } = options;
	return pi => {
		setupTokenBreakdownHooks(pi, room, loopId);
		if (primary) ensureRoomLifecycleRegistration(room, isEnabled);
	};
}
