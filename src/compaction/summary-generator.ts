import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { generateSummary as generatePiSummary } from "@earendil-works/pi-coding-agent";

export interface CodexCompactionLogger {
	raw(message: string, details: string): void;
	warning(message: string, details: string): void;
}

export const defaultCodexCompactionLogger: CodexCompactionLogger = {
	raw: (message, details) => console.debug(message, details),
	warning: (message, details) => console.warn(message, details),
};

export const SUMMARY_GENERATION_MODES = ["local", "server"] as const;
export type SummaryGenerationMode = (typeof SUMMARY_GENERATION_MODES)[number];

export interface CodexCompactionItem extends Record<string, unknown> {
	type: "compaction" | "compaction_summary";
	id?: string;
	encrypted_content: string;
}

export interface LocalSummaryGenerationOptions {
	mode?: "local";
	messages: AgentMessage[];
	model: Model<any>;
	reserveTokens: number;
	signal?: AbortSignal;
	customInstructions?: string;
	previousSummary?: string;
	thinkingLevel?: ThinkingLevel;
	streamFn?: StreamFn;
	sessionId?: string;
}

export interface ServerSummaryGenerationOptions {
	mode: "server";
	endpoint: string;
	headers: Record<string, string>;
	request: Record<string, unknown>;
	signal: AbortSignal;
	fetch?: typeof globalThis.fetch;
	logger?: CodexCompactionLogger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isCompactionCandidate(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && (value.type === "compaction" || value.type === "compaction_summary");
}

export function isCodexCompactionItem(value: unknown): value is CodexCompactionItem {
	return isCompactionCandidate(value)
		&& (value.id === undefined || isNonEmptyString(value.id))
		&& isNonEmptyString(value.encrypted_content);
}

async function readCompletedCheckpoint(
	response: Response,
	signal: AbortSignal,
	logger: CodexCompactionLogger,
): Promise<CodexCompactionItem> {
	if (!response.body) {
		logger.raw("[codex-compaction] Raw response", "");
		throw new Error("Codex compaction response has no body");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let rawResponse = "";
	let completed = false;
	let completedOutput: unknown[] = [];
	const streamedCandidates: Record<string, unknown>[] = [];
	let serverError: string | undefined;
	let streamReadError: string | undefined;
	const processFrame = (frame: string): void => {
		const data = frame
			.split("\n")
			.filter(line => line.startsWith("data:"))
			.map(line => line.slice(5).trim())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") return;
		const event = JSON.parse(data) as unknown;
		if (!isRecord(event)) return;
		if (event.type === "response.output_item.done" && isCompactionCandidate(event.item)) {
			streamedCandidates.push(event.item);
		}
		if (event.type === "response.completed") {
			completed = true;
			const output = isRecord(event.response) ? event.response.output : undefined;
			completedOutput = Array.isArray(output) ? output : [];
		}
		if (event.type === "response.failed" || event.type === "error") {
			const error = isRecord(event.error) ? event.error : event;
			serverError = typeof error.message === "string" ? error.message : "Codex compaction failed";
		}
	};
	try {
		while (!completed && !serverError) {
			signal.throwIfAborted();
			let readResult: { done: boolean; value?: Uint8Array };
			try {
				readResult = await reader.read();
			} catch (error) {
				rawResponse += decoder.decode();
				streamReadError = error instanceof Error ? error.message : String(error);
				throw error;
			}
			const { done, value } = readResult;
			const decoded = done ? decoder.decode() : decoder.decode(value, { stream: true });
			rawResponse += decoded;
			buffer += decoded;
			buffer = buffer.replaceAll("\r\n", "\n");
			if (done && buffer.trim()) buffer += "\n\n";
			let frameEnd = buffer.indexOf("\n\n");
			while (frameEnd >= 0) {
				processFrame(buffer.slice(0, frameEnd));
				buffer = buffer.slice(frameEnd + 2);
				if (completed || serverError) break;
				frameEnd = buffer.indexOf("\n\n");
			}
			if (done) break;
		}
	} finally {
		try { await reader.cancel(); } catch { /* already closed */ }
		try { reader.releaseLock(); } catch { /* already released */ }
		logger.raw("[codex-compaction] Raw response", rawResponse);
		if (streamReadError) logger.warning("[codex-compaction] Raw response stream failed", streamReadError);
	}
	if (serverError) throw new Error(serverError);
	if (!completed) throw new Error("Codex compaction response ended before response.completed");
	const completedCandidates = completedOutput.filter(isCompactionCandidate);
	const candidates = streamedCandidates.length > 0 ? streamedCandidates : completedCandidates;
	const checkpoints = candidates.filter(isCodexCompactionItem);
	if (checkpoints.length !== candidates.length) {
		throw new Error("Codex compaction response contained a malformed encrypted checkpoint");
	}
	const checkpoint = checkpoints[0];
	if (checkpoints.length !== 1 || checkpoint === undefined) {
		throw new Error(`Codex compaction response contained ${checkpoints.length} encrypted checkpoints; expected exactly one`);
	}
	return structuredClone(checkpoint);
}

async function logRawResponseBody(response: Response, logger: CodexCompactionLogger): Promise<void> {
	if (!response.body) {
		logger.raw("[codex-compaction] Raw response", "");
		return;
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let rawResponse = "";
	let readError: string | undefined;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				rawResponse += decoder.decode();
				break;
			}
			rawResponse += decoder.decode(value, { stream: true });
		}
	} catch (error) {
		rawResponse += decoder.decode();
		readError = error instanceof Error ? error.message : String(error);
	} finally {
		try { await reader.cancel(); } catch { /* already closed */ }
		try { reader.releaseLock(); } catch { /* already released */ }
		logger.raw("[codex-compaction] Raw response", rawResponse);
	}
	if (readError) logger.warning("[codex-compaction] Raw response stream failed", readError);
}

function generateLocalSummary(options: LocalSummaryGenerationOptions): Promise<string> {
	return generatePiSummary(
		options.messages,
		options.model,
		options.reserveTokens,
		undefined,
		undefined,
		options.signal,
		options.customInstructions,
		options.previousSummary,
		options.thinkingLevel,
		options.streamFn,
		undefined,
		undefined,
		undefined,
		options.sessionId,
	);
}

async function generateServerSummary(options: ServerSummaryGenerationOptions): Promise<CodexCompactionItem> {
	const logger = options.logger ?? defaultCodexCompactionLogger;
	let response: Response;
	try {
		response = await (options.fetch ?? globalThis.fetch)(options.endpoint, {
			method: "POST",
			headers: options.headers,
			body: JSON.stringify(options.request),
			signal: options.signal,
		});
	} catch (error) {
		throw new Error(`Codex compaction request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		await logRawResponseBody(response, logger);
		throw new Error(`Codex compaction failed with HTTP ${response.status}`);
	}
	return readCompletedCheckpoint(response, options.signal, logger);
}

export function generateSummary(options: LocalSummaryGenerationOptions): Promise<string>;
export function generateSummary(options: ServerSummaryGenerationOptions): Promise<CodexCompactionItem>;
export function generateSummary(
	options: LocalSummaryGenerationOptions | ServerSummaryGenerationOptions,
): Promise<string | CodexCompactionItem> {
	return options.mode === "server" ? generateServerSummary(options) : generateLocalSummary(options);
}
