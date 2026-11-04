import type {
  AgentMessage,
  StreamFn,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  normalizeContext,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { generateSummary as generatePiSummary } from "@earendil-works/pi-coding-agent";
import { MultiAgentPiHarness } from "./multi-agent-pi-harness.js";
import { createProviderStreamFn } from "./agent/to-pi-bindings/provider-stream.js";

export interface GenerateSummaryOptions {
  readonly messages: AgentMessage[];
  readonly model: Model<Api>;
  readonly reserveTokens: number;
  readonly signal?: AbortSignal;
  readonly customInstructions?: string;
  readonly previousSummary?: string;
  readonly thinkingLevel?: ThinkingLevel;
  /** Optional caller stream override. Defaults to the singleton Harness provider stream. */
  readonly streamFn?: StreamFn;
  readonly sessionId?: string;
}

export interface ProbeModelOptions {
  readonly model: Model<Api>;
  readonly signal?: AbortSignal;
  /** Optional caller stream override. Defaults to the singleton Harness provider stream. */
  readonly streamFn?: StreamFn;
  readonly sessionId?: string;
}

export interface ProbeModelResult {
  readonly apiModel: string;
  readonly apiProvider: string;
}

function resolveStreamFn(streamFn: StreamFn | undefined): StreamFn {
  if (streamFn !== undefined) return streamFn;
  const harness = MultiAgentPiHarness.instance;
  return createProviderStreamFn(harness.modelRuntime, harness.settings);
}

/** Generate a local Pi summary through an object-shaped framework API. */
export function generateSummary(options: GenerateSummaryOptions): Promise<string> {
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
    resolveStreamFn(options.streamFn),
    undefined,
    undefined,
    undefined,
    options.sessionId,
  );
}

/** Probe one model and report the provider/model identity returned by its API. */
export async function probeModel(options: ProbeModelOptions): Promise<ProbeModelResult> {
  const stream = await resolveStreamFn(options.streamFn)(
    options.model,
    normalizeContext({
      systemPrompt: "Respond with exactly one word: ok",
      messages: [{
        role: "user",
        content: "ping",
        timestamp: Date.now(),
      }],
    }),
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    },
  );
  const result = await stream.result();
  return {
    apiModel: result.model || options.model.id,
    apiProvider: result.provider || options.model.provider,
  };
}
