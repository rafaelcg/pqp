import { SpeechHttpError } from "./types.js";

export interface RetryOptions {
  provider: string;
  /** Total attempts including the first. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Test seam. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called on every retry, for the bench's 429 accounting. */
  onRetry?: (info: { attempt: number; status: number; delayMs: number }) => void;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `Retry-After` is seconds or an HTTP date; also accepts Groq's "1m2.5s" style reset hints. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const dur = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(v);
  if (dur && (dur[1] || dur[2] || dur[3] || dur[4])) {
    return Math.round(
      (Number(dur[1] ?? 0) * 3600 + Number(dur[2] ?? 0) * 60 + Number(dur[3] ?? 0)) * 1000 + Number(dur[4] ?? 0),
    );
  }
  const date = Date.parse(v);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * fetch with retry on 429 and 5xx. The request is rebuilt per attempt by `build`
 * because a FormData body cannot be re-sent. Backoff honours Retry-After, else
 * exponential with jitter. The error message never includes request headers.
 */
export async function fetchWithRetry(
  url: string,
  build: () => RequestInit,
  opts: RetryOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const max = opts.maxAttempts ?? 6;
  const base = opts.baseDelayMs ?? 1500;
  const cap = opts.maxDelayMs ?? 65_000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= max; attempt++) {
    const init = build();
    const res = await fetchImpl(url, { ...init, signal: opts.signal });
    if (res.ok) return res;
    lastStatus = res.status;
    lastBody = (await res.text().catch(() => "")).slice(0, 300);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === max) break;
    const hinted = parseRetryAfterMs(res.headers.get("retry-after"));
    const backoff = Math.min(cap, base * 2 ** (attempt - 1));
    const delayMs = Math.min(
      cap,
      hinted !== undefined ? hinted + 250 : Math.round(backoff * (0.75 + Math.random() * 0.5)),
    );
    opts.onRetry?.({ attempt, status: res.status, delayMs });
    await sleep(delayMs, opts.signal);
  }
  throw new SpeechHttpError(opts.provider, lastStatus, lastBody);
}
