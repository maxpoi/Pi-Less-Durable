import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const EFFECTIVELY_DISABLED_TIMEOUT_MS = 2_147_483_647;

export interface ProviderStreamSettings {
  getHttpIdleTimeoutMs(): number;
  getWebSocketConnectTimeoutMs(): number | undefined;
  getProviderRetrySettings(): {
    timeoutMs: number | undefined;
    maxRetries: number | undefined;
    maxRetryDelayMs: number;
  };
}

function resolveProviderStreamOptions(
  options: SimpleStreamOptions | undefined,
  settingsManager: ProviderStreamSettings,
): SimpleStreamOptions {
  const providerRetrySettings = settingsManager.getProviderRetrySettings();
  const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
  // Provider SDKs interpret zero as an immediate timeout, while Pi uses zero
  // to represent a disabled idle timeout in settings.
  const effectiveTimeoutMs = httpIdleTimeoutMs === 0
    ? EFFECTIVELY_DISABLED_TIMEOUT_MS
    : httpIdleTimeoutMs;

  const websocketConnectTimeoutMs = options?.websocketConnectTimeoutMs
    ?? settingsManager.getWebSocketConnectTimeoutMs();
  const maxRetries = options?.maxRetries ?? providerRetrySettings.maxRetries;
  return {
    ...options,
    timeoutMs: options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs,
    ...(websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
    maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
  };
}

/** Create the canonical Harness provider stream with configured timeout/retry precedence. */
export function createProviderStreamFn(
  modelRuntime: Pick<ModelRuntime, "streamSimple">,
  settingsManager: ProviderStreamSettings,
): StreamFn {
  return (model, context, options) => modelRuntime.streamSimple(
    model,
    context,
    resolveProviderStreamOptions(options, settingsManager),
  );
}
