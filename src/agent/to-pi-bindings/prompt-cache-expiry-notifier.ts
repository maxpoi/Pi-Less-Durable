import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";

/** Never wait more than one minute before reporting an idle prompt cache. */
export const MAX_PROMPT_CACHE_NOTICE_DELAY_MS = 60_000;

export function getPromptCacheTtlMs(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): number | undefined {
  const retention = options?.cacheRetention
    ?? (getProviderEnvValue("PI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short");
  if (retention === "none") return undefined;

  const seconds = model.promptCache?.[retention];
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

export function getPromptCacheNoticeDelayMs(ttlMs: number): number | undefined {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, MAX_PROMPT_CACHE_NOTICE_DELAY_MS)));
}

export function formatPromptCacheRemainingTime(remainingMs: number): string {
  let remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ] as const;
  const parts: string[] = [];

  for (const [name, seconds] of units) {
    const value = Math.floor(remainingSeconds / seconds);
    if (value === 0) continue;
    parts.push(`${value} ${name}${value === 1 ? "" : "s"}`);
    remainingSeconds %= seconds;
  }
  return parts.join(" ");
}

export function formatPromptCacheExpiryNotice(remainingMs: number): string {
  return `The prompt cache for this conversation will expire in **${formatPromptCacheRemainingTime(remainingMs)}**. If the previous task is already finished, start a new conversation with \`/new\`.`;
}

interface PromptCacheNoticeRun {
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
  isCurrent: () => boolean;
}

export interface PromptCacheExpiryNotifierOptions {
  notify: (message: string) => Promise<void>;
  onError?: (error: unknown) => void;
}

/** Track the latest cacheable provider request and report before its cache expires. */
export class PromptCacheExpiryNotifier {
  private run: PromptCacheNoticeRun | undefined;

  constructor(private readonly options: PromptCacheExpiryNotifierOptions) {}

  start(
    model: Model<Api>,
    requestOptions: SimpleStreamOptions | undefined,
    isCurrent: () => boolean,
  ): void {
    this.cancel();
    const ttlMs = getPromptCacheTtlMs(model, requestOptions);
    if (ttlMs === undefined) return;
    const delayMs = getPromptCacheNoticeDelayMs(ttlMs);
    if (delayMs === undefined) return;

    let run!: PromptCacheNoticeRun;
    run = {
      expiresAt: Date.now() + ttlMs,
      isCurrent,
      timer: setTimeout(() => void this.notify(run), delayMs),
    };
    run.timer.unref?.();
    this.run = run;
  }

  cancel(): void {
    if (!this.run) return;
    clearTimeout(this.run.timer);
    this.run = undefined;
  }

  private async notify(run: PromptCacheNoticeRun): Promise<void> {
    if (this.run !== run) return;
    this.run = undefined;
    if (!run.isCurrent()) return;

    const remainingMs = run.expiresAt - Date.now();
    if (remainingMs <= 0) return;
    try {
      await this.options.notify(formatPromptCacheExpiryNotice(remainingMs));
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}

interface PromptCacheRequestState {
  model: Pick<Model<Api>, "provider" | "id">;
  messages: readonly AgentMessage[];
}

export function createPromptCacheExpiryStreamFn(
  baseStreamFn: StreamFn,
  notifier: Pick<PromptCacheExpiryNotifier, "start">,
  sessionId: string,
  getCurrentState: () => PromptCacheRequestState,
): StreamFn {
  return (requestModel, context, options) => {
    if (options?.sessionId === sessionId) {
      const requestMessages = getCurrentState().messages;
      notifier.start(requestModel, options, () => {
        const current = getCurrentState();
        return current.model.provider === requestModel.provider
          && current.model.id === requestModel.id
          && requestMessages.length <= current.messages.length
          && requestMessages.every((message, index) => {
            const currentMessage = current.messages[index];
            return currentMessage === message || isDeepStrictEqual(currentMessage, message);
          });
      });
    }
    return baseStreamFn(requestModel, context, options);
  };
}
