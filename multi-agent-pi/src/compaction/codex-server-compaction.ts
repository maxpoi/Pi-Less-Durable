import { createHash } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	getDeclaredTools,
	getInitialSystemMessage,
	getSystemMessageText,
	resolveTranscript,
	resolveTranscriptTools,
	type Api,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesMessages, convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { getPiUserAgent } from "@earendil-works/pi-ai/utils/pi-user-agent";
import {
	convertToLlm,
	type ExtensionAPI,
	type ModelRegistry,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { CODEX_SERVER_COMPACTION_STRATEGY } from "./codex-compaction-details.js";
import {
	defaultCodexCompactionLogger,
	generateSummary,
	isCodexCompactionItem,
	type CodexCompactionItem,
	type CodexCompactionLogger,
} from "./summary-generator.js";

export { CODEX_SERVER_COMPACTION_STRATEGY } from "./codex-compaction-details.js";
export const CODEX_SERVER_COMPACTION_SUMMARY = "[Codex server compaction checkpoint]";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const ACCOUNT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

export interface CodexCheckpointIdentity {
	provider: string;
	api: string;
	model: string;
	endpoint: string;
	accountFingerprint: string;
}

export type { CodexCompactionItem } from "./summary-generator.js";

export interface CodexCheckpointDetails extends CodexCheckpointIdentity {
	strategy: typeof CODEX_SERVER_COMPACTION_STRATEGY;
	checkpoint: CodexCompactionItem;
}

export interface CodexRuntime {
	identity: CodexCheckpointIdentity;
	model: Model<Api>;
	headers: Record<string, string>;
}

export type RuntimeResolution = { ok: true; runtime: CodexRuntime } | { ok: false; reason: string };
type CodexCheckpointEntry = Extract<SessionEntry, { type: "compaction" }> & { details: CodexCheckpointDetails };
type CheckpointState =
	| { kind: "none" }
	| { kind: "invalid" }
	| { kind: "active"; entry: CodexCheckpointEntry };

interface SerializedCodexContext {
	input: unknown[];
	instructions: string;
	tools: unknown[];
}

interface CodexCompat {
	supportsMidConvoSystemMessages?: boolean;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
}

export interface CodexServerCompactionSettings {
	getCodexServerCompactionEnabled(): boolean;
}

export type CodexRuntimeResolver = (
	model: Model<Api>,
	modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">,
) => Promise<RuntimeResolution>;

export interface CodexCompactionExecutionOptions {
	runtime: CodexRuntime;
	request: Record<string, unknown>;
	signal: AbortSignal;
	fetch?: typeof globalThis.fetch;
}

export type CodexCompactionExecutor = (
	options: CodexCompactionExecutionOptions,
) => Promise<CodexCompactionItem>;

export interface CodexServerCompactionControllerOptions {
	sessionManager: SessionManager;
	modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">;
	settingsManager: CodexServerCompactionSettings;
	logger?: CodexCompactionLogger;
	resolveRuntime?: CodexRuntimeResolver;
	executeCompaction?: CodexCompactionExecutor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isCheckpointDetails(value: unknown): value is CodexCheckpointDetails {
	return isRecord(value)
		&& value.strategy === CODEX_SERVER_COMPACTION_STRATEGY
		&& isNonEmptyString(value.provider)
		&& isNonEmptyString(value.api)
		&& isNonEmptyString(value.model)
		&& isNonEmptyString(value.endpoint)
		&& isNonEmptyString(value.accountFingerprint)
		&& isCodexCompactionItem(value.checkpoint);
}

function resolveCheckpoint(branch: readonly SessionEntry[]): CheckpointState {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "compaction") continue;
		const looksNative = entry.summary === CODEX_SERVER_COMPACTION_SUMMARY
			|| (isRecord(entry.details) && entry.details.strategy === CODEX_SERVER_COMPACTION_STRATEGY);
		if (!looksNative) return { kind: "none" };
		if (entry.summary !== CODEX_SERVER_COMPACTION_SUMMARY || !isCheckpointDetails(entry.details)) {
			return { kind: "invalid" };
		}
		return { kind: "active", entry: entry as CodexCheckpointEntry };
	}
	return { kind: "none" };
}

function normalizeEndpoint(baseUrl: string | undefined): string {
	const url = new URL(baseUrl?.trim() || DEFAULT_CODEX_BASE_URL);
	if (url.username || url.password || url.search) throw new Error("Codex endpoint contains unsupported credentials or query parameters");
	const basePath = url.pathname.replace(/\/+$/, "");
	url.pathname = basePath.endsWith("/codex/responses")
		? basePath
		: basePath.endsWith("/codex")
			? `${basePath}/responses`
			: `${basePath}/codex/responses`;
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function extractAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Codex credential is not a JWT");
	const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
	const auth = payload[ACCOUNT_CLAIM_PATH];
	const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
	if (!isNonEmptyString(accountId)) throw new Error("Codex credential has no account identity");
	return accountId;
}

function isCodexModel(model: Model<Api>): boolean {
	return model.provider === CODEX_PROVIDER && model.api === CODEX_API;
}

export async function resolveCodexRuntime(
	model: Model<Api>,
	modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders">,
): Promise<RuntimeResolution> {
	if (!isCodexModel(model)) return { ok: false, reason: `model uses ${model.provider}/${model.api}, not direct Codex Responses` };
	try {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return { ok: false, reason: auth.error };
		if (!auth.apiKey) return { ok: false, reason: "Codex authentication returned no access token" };
		const accountId = extractAccountId(auth.apiKey);
		const endpoint = normalizeEndpoint(auth.baseUrl ?? model.baseUrl);
		const headers = new Headers(model.headers);
		for (const [name, value] of Object.entries(auth.headers ?? {})) {
			if (value === null) headers.delete(name);
			else headers.set(name, value);
		}
		headers.set("authorization", `Bearer ${auth.apiKey}`);
		headers.set("chatgpt-account-id", accountId);
		headers.set("originator", "pi");
		headers.set("user-agent", getPiUserAgent());
		headers.set("openai-beta", "responses=experimental");
		headers.set("accept", "text/event-stream");
		headers.set("content-type", "application/json");
		return {
			ok: true,
			runtime: {
				identity: {
					provider: model.provider,
					api: model.api,
					model: model.id,
					endpoint,
					accountFingerprint: createHash("sha256").update(accountId).digest("hex"),
				},
				model,
				headers: Object.fromEntries(headers.entries()),
			},
		};
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

function identitiesEqual(left: CodexCheckpointIdentity, right: CodexCheckpointIdentity): boolean {
	return left.provider === right.provider
		&& left.api === right.api
		&& left.model === right.model
		&& left.endpoint === right.endpoint
		&& left.accountFingerprint === right.accountFingerprint;
}

function serializeCodexContext(
	model: Model<Api>,
	messages: readonly AgentMessage[],
	toolContextMessages: readonly AgentMessage[] = messages,
): SerializedCodexContext {
	const compat = (model.compat ?? {}) as CodexCompat;
	const convert = (source: readonly AgentMessage[]): TranscriptContext => resolveTranscript(
		{ messages: convertToLlm([...source]) } as TranscriptContext,
		compat.supportsMidConvoSystemMessages,
	);
	const context = convert(messages);
	const toolContext = toolContextMessages === messages ? context : convert(toolContextMessages);
	const supportsStrictMode = compat.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = compat.supportsOpenAIGrammarTools ?? false;
	const supportsAdditionalTools = compat.supportsAdditionalTools ?? false;
	const supportsToolSearch = compat.supportsToolSearch ?? false;
	const toolOptions = { strict: null, supportsStrictMode, supportsOpenAIGrammarTools };
	const grammarToolInputProperties = createGrammarToolInputProperties(
		getDeclaredTools(toolContext.messages),
		supportsOpenAIGrammarTools,
	);
	const input = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools,
		supportsToolSearch,
		toolOptions,
	});
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const transcriptTools = resolveTranscriptTools(toolContext.messages, supportsAdditionalTools || supportsToolSearch);
	return {
		input: structuredClone(input),
		instructions: initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "",
		tools: convertResponsesTools(transcriptTools.requestTools, toolOptions),
	};
}

function resolveReasoningEffort(model: Model<Api>, thinkingLevel: ThinkingLevel | undefined): string | undefined {
	if (!thinkingLevel || thinkingLevel === "off") return undefined;
	return model.thinkingLevelMap?.[thinkingLevel] ?? thinkingLevel;
}

export function executeCodexCompaction(
	options: CodexCompactionExecutionOptions & { logger?: CodexCompactionLogger },
): Promise<CodexCompactionItem> {
	return generateSummary({
		mode: "server",
		endpoint: options.runtime.identity.endpoint,
		headers: options.runtime.headers,
		request: options.request,
		signal: options.signal,
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(options.logger ? { logger: options.logger } : {}),
	});
}

function formatCompatibilityError(details: CodexCheckpointDetails, model: Model<Api>, reason: string): string {
	return `Cannot send this request with \`${model.provider}/${model.id}\`. `
		+ `This session contains a Codex checkpoint bound to \`${details.provider}/${details.model}\`, its original endpoint, and account. `
		+ `${reason}. Select a compatible Codex model, or use \`/new\`.`;
}

export class CodexServerCompactionController {
	private readonly logger: CodexCompactionLogger;
	private readonly resolveRuntime: CodexRuntimeResolver;
	private readonly executeCompaction: CodexCompactionExecutor;

	constructor(private readonly options: CodexServerCompactionControllerOptions) {
		this.logger = options.logger ?? defaultCodexCompactionLogger;
		this.resolveRuntime = options.resolveRuntime ?? resolveCodexRuntime;
		this.executeCompaction = options.executeCompaction
			?? (executionOptions => executeCodexCompaction({ ...executionOptions, logger: this.logger }));
	}

	register(pi: ExtensionAPI): void {
		pi.on("session_before_compact", async (event, ctx) => {
			try {
				return await this.compact(event, ctx.model as Model<Api> | undefined, pi.getThinkingLevel?.());
			} catch (error) {
				this.logger.warning(
					"[codex-compaction] Native compaction blocked",
					error instanceof Error ? error.message : String(error),
				);
				return { cancel: true };
			}
		});
	}

	async rewriteProviderPayload(payload: unknown, model: Model<Api>): Promise<unknown> {
		const state = resolveCheckpoint(this.options.sessionManager.getBranch());
		if (state.kind === "none") return payload;
		if (state.kind === "invalid") throw new Error("The persisted Codex checkpoint is invalid");
		const resolution = await this.resolveRuntime(model, this.options.modelRegistry);
		if (!resolution.ok) throw new Error(formatCompatibilityError(state.entry.details, model, resolution.reason));
		if (!identitiesEqual(state.entry.details, resolution.runtime.identity)) {
			throw new Error(formatCompatibilityError(state.entry.details, model, "provider, API, model, endpoint, or account changed"));
		}
		if (!isRecord(payload) || !Array.isArray(payload.input) || payload.model !== model.id) {
			throw new Error("Codex checkpoint replay requires a matching Responses payload");
		}
		const projection = this.options.sessionManager.buildSessionProjection();
		const checkpointProjection = projection.entries.find(entry => entry.sourceEntry.id === state.entry.id);
		if (!checkpointProjection) throw new Error("Codex checkpoint is missing from the active projection");
		const markerInput = serializeCodexContext(model, checkpointProjection.messages, projection.messages).input;
		if (markerInput.length === 0 || !valuesEqual(payload.input.slice(0, markerInput.length), markerInput)) {
			throw new Error("Codex checkpoint marker is missing from the provider payload");
		}
		return {
			...payload,
			input: [structuredClone(state.entry.details.checkpoint), ...payload.input.slice(markerInput.length)],
		};
	}

	private async compact(
		event: SessionBeforeCompactEvent,
		model: Model<Api> | undefined,
		thinkingLevel: ThinkingLevel | undefined,
	) {
		const state = resolveCheckpoint(event.branchEntries);
		if (!this.options.settingsManager.getCodexServerCompactionEnabled() && state.kind === "none") return undefined;
		if (state.kind === "invalid") throw new Error("The persisted Codex checkpoint is invalid");
		if (!model || !isCodexModel(model)) {
			if (state.kind === "none") return undefined;
			throw new Error("The active model cannot replay this session's Codex checkpoint");
		}
		const resolution = await this.resolveRuntime(model, this.options.modelRegistry);
		if (!resolution.ok) throw new Error(resolution.reason);
		if (state.kind === "active" && !identitiesEqual(state.entry.details, resolution.runtime.identity)) {
			throw new Error("The current Codex runtime does not match the persisted checkpoint");
		}
		const projection = this.options.sessionManager.buildSessionProjection();
		const preparedMessages = [
			...event.preparation.messagesToSummarize,
			...event.preparation.turnPrefixMessages,
		];
		const preparedInput = serializeCodexContext(model, preparedMessages, projection.messages).input;
		const input = state.kind === "active"
			? [structuredClone(state.entry.details.checkpoint), ...preparedInput]
			: preparedInput;
		const full = serializeCodexContext(model, projection.messages);
		const request: Record<string, unknown> = {
			model: model.id,
			store: false,
			stream: true,
			input: [...input, { type: "compaction_trigger" }],
			text: { verbosity: "low" },
			include: ["reasoning.encrypted_content"],
			prompt_cache_key: this.options.sessionManager.getSessionId(),
			tool_choice: "auto",
			parallel_tool_calls: true,
		};
		if (full.instructions) request.instructions = full.instructions;
		if (full.tools.length > 0) request.tools = full.tools;
		const effort = resolveReasoningEffort(model, thinkingLevel);
		if (effort) request.reasoning = { effort, summary: "auto" };
		const checkpoint = await this.executeCompaction({
			runtime: resolution.runtime,
			request,
			signal: event.signal,
		});
		return {
			compaction: {
				summary: CODEX_SERVER_COMPACTION_SUMMARY,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {
					strategy: CODEX_SERVER_COMPACTION_STRATEGY,
					...resolution.runtime.identity,
					checkpoint,
				} satisfies CodexCheckpointDetails,
			},
		};
	}
}

function valuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right)
			&& left.length === right.length
			&& left.every((value, index) => valuesEqual(value, right[index]));
	}
	if (isRecord(left) || isRecord(right)) {
		if (!isRecord(left) || !isRecord(right)) return false;
		const leftKeys = Object.keys(left).sort();
		const rightKeys = Object.keys(right).sort();
		return valuesEqual(leftKeys, rightKeys) && leftKeys.every(key => valuesEqual(left[key], right[key]));
	}
	return false;
}

export function createCodexServerCompactionController(
	options: CodexServerCompactionControllerOptions,
): CodexServerCompactionController {
	return new CodexServerCompactionController(options);
}
