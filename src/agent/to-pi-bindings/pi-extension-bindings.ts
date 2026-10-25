import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";

export interface LocalExtensionRunner {
  hasHandlers(event: string): boolean;
  emitBeforeProviderRequest(payload: unknown): Promise<unknown>;
  emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders>;
  emit(event: unknown): Promise<unknown>;
  emitContext(messages: unknown[]): Promise<unknown[]>;
}

export interface LocalExtensionRunnerRef {
  current?: LocalExtensionRunner;
}

export function createPiExtensionAgentHooks(
  runnerRef: LocalExtensionRunnerRef,
  baseOnPayload?: (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>,
  assertRuntimeReady?: () => void,
  finalOnPayload?: (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>,
) {
  return {
    onPayload: async (payload: unknown, model: Model<Api>): Promise<unknown> => {
      assertRuntimeReady?.();
      const transformed = baseOnPayload ? await baseOnPayload(payload, model) : payload;
      const basePayload = transformed ?? payload;
      const runner = runnerRef.current;
      const extensionPayload = runner?.hasHandlers("before_provider_request")
        ? await runner.emitBeforeProviderRequest(basePayload)
        : basePayload;
      const payloadAfterExtensions = extensionPayload ?? basePayload;
      const finalPayload = finalOnPayload
        ? await finalOnPayload(payloadAfterExtensions, model)
        : payloadAfterExtensions;
      return finalPayload ?? payloadAfterExtensions;
    },
    onResponse: async (response: {
      status: number;
      headers: Record<string, string>;
    }): Promise<void> => {
      const runner = runnerRef.current;
      if (!runner?.hasHandlers("after_provider_response")) return;
      await runner.emit({
        type: "after_provider_response",
        status: response.status,
        headers: response.headers,
      });
    },
    onProviderStreamEvent: async (data: unknown, model: Model<Api>): Promise<void> => {
      const runner = runnerRef.current;
      if (!runner?.hasHandlers("provider_stream_event")) return;
      await runner.emit({
        type: "provider_stream_event",
        provider: model.provider,
        api: model.api,
        model: model.id,
        data,
      });
    },
    transformContext: async (messages: unknown[]): Promise<unknown[]> => {
      const runner = runnerRef.current;
      return runner ? runner.emitContext(messages) : messages;
    },
  };
}

export async function applyPiExtensionHeaders(
  runnerRef: LocalExtensionRunnerRef,
  headers: ProviderHeaders,
): Promise<ProviderHeaders> {
  const runner = runnerRef.current;
  if (!runner?.hasHandlers("before_provider_headers")) return headers;
  return runner.emitBeforeProviderHeaders(headers);
}

/** Decorate only one AgentSession's model stream with that session's local Pi headers. */
export function createPiExtensionStreamFn(
  baseStreamFn: StreamFn,
  runnerRef: LocalExtensionRunnerRef,
  assertRuntimeReady?: () => void,
): StreamFn {
  return (model, context, options) => {
    assertRuntimeReady?.();
    return baseStreamFn(model, context, {
      ...options,
      transformHeaders: (headers: ProviderHeaders) => applyPiExtensionHeaders(runnerRef, headers),
    } as any);
  };
}
