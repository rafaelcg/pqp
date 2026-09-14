/**
 * Tells the edge Worker's KV denylist (`HLS_REVOKED_USERS`,
 * `PartyPassRevocationGate` in `tools/hls-edge/src/party-pass-revocation.js`)
 * that a viewer's access to a channel was just taken away, so a `?t=` token
 * or `?pp=` party pass minted before the eviction stops being honored by the
 * Worker's shared rendition cache within the gate's 30 s cache window
 * instead of riding out the party pass's full 6 h ceiling. See
 * `tools/hls-edge/README.md` "Enabling in production" for the operator
 * side of this (the KV namespace, the binding, and these env vars) and
 * `hls-revocation.ts` for the eviction seam this hooks into.
 *
 * WHY A DIRECT CLOUDFLARE API CALL, NOT A QUEUE. This fires from the same
 * places `hls-revocation.ts`'s in-memory set already writes to -- a ban, a
 * kick, a role losing VIEW -- rare, human-triggered moderation events, not a
 * hot path.
 *
 * WHY KEYED BY userId:channelId, NOT userId ALONE. A party pass is scoped
 * to one channel (`mintHlsPartyPass` binds `channelId` into its signed
 * claims), and `hls-revocation.ts`'s own model is per-channel too -- a
 * viewer kicked from one channel keeps a still-valid pass (and an
 * unaffected `?t=`) for any OTHER channel they can legitimately watch.
 * `hlsEdgeRevocationKey` matches exactly what the Worker's gate looks up.
 * A SEPARATE `channel:<channelId>` key (`hlsEdgeChannelRevocationKey`)
 * covers the "everyone" case -- a channel deleted or gone private for the
 * whole audience -- which has no fixed list of userIds to key per-viewer
 * entries by; `writeHlsEdgeChannelRevocation` is that hook, called from
 * `revokeHlsAccess` whenever a revocation carries no `only` scope. The
 * Worker's gate checks BOTH keys and takes the newer of the two -- see
 * `party-pass-revocation.js`.
 *
 * MONOTONIC, NOT LAST-WRITE-WINS. The value stored at a key is a
 * revocation TIMESTAMP, not a boolean: the Worker's gate compares it
 * against the credential's own `issuedAt` claim ("was this credential
 * minted before or after the most recent revocation"), the same rule
 * `hls-revocation.ts`'s own `isHlsAccessRevoked` already applies in memory
 * (`entry.at <= tokenIssuedAt` survives). Two evictions of the same
 * (userId, channelId) pair racing each other over the network -- a kick
 * immediately followed by a ban, say, or two instances handling the same
 * eviction on a bus-replicated event -- must never let the OLDER timestamp
 * clobber a NEWER one that already landed, or a viewer re-admitted after
 * the first eviction would read as still-revoked by a write that arrives
 * late. `writeMonotonic` below is a read-modify-write: GET the current
 * value, PUT only when this write's `now` is actually newer. That is a
 * race in itself (two concurrent writers can both read the same "current"
 * value before either PUTs), but the failure mode of losing that race is
 * "the record is exactly as fresh as it would have been if this write lost
 * outright", never staler than not writing at all -- the same shape as
 * `hls-revocation.ts`'s own high-water TTL mark, which only ever grows.
 */

import { logEvent } from "../lib/log.js";
import { LIVE_HLS_PARTY_PASS_MAX_TTL_MS } from "./hls-viewer-token.js";

const KV_REQUEST_TIMEOUT_MS = 4_000;

/**
 * A small pool, not zero and not unbounded. A mass moderation action (a
 * raid ban, a bulk kick) can fire dozens of evictions in the same tick;
 * letting every one of them open its own pair of Cloudflare requests at
 * once is both a burst this process does not need to inflict on itself and
 * an easy way to exhaust outbound sockets under load. Four in flight is
 * enough to keep the queue draining quickly without that burst.
 */
const MAX_CONCURRENT_KV_REQUESTS = 4;
let activeKvRequests = 0;
const kvRequestWaiters: Array<() => void> = [];

async function withKvConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (activeKvRequests >= MAX_CONCURRENT_KV_REQUESTS) {
    await new Promise<void>((resolve) => kvRequestWaiters.push(resolve));
  }
  activeKvRequests += 1;
  try {
    return await fn();
  } finally {
    activeKvRequests -= 1;
    const next = kvRequestWaiters.shift();
    if (next) {
      next();
    }
  }
}

interface KvConfig {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

/**
 * `HLS_EDGE_KV_ACCOUNT_ID` / `HLS_EDGE_KV_NAMESPACE_ID` / `HLS_EDGE_KV_API_TOKEN`
 * -- see `tools/hls-edge/README.md` "Enabling in production" for where each
 * value comes from. Read live (not cached) since these are set once at
 * process start and reading `process.env` is cheap; nothing here runs on a
 * request hot path.
 */
function kvConfig(): KvConfig | null {
  const accountId = process.env.HLS_EDGE_KV_ACCOUNT_ID;
  const namespaceId = process.env.HLS_EDGE_KV_NAMESPACE_ID;
  const apiToken = process.env.HLS_EDGE_KV_API_TOKEN;
  if (!accountId || !namespaceId || !apiToken) {
    return null;
  }
  return { accountId, namespaceId, apiToken };
}

/** The exact per-viewer key `PartyPassRevocationGate.check` looks up on the Worker side. */
export function hlsEdgeRevocationKey(userId: string, channelId: string): string {
  return `${userId}:${channelId}`;
}

/** The channel-wide key -- see the module doc comment for when this fires instead. */
export function hlsEdgeChannelRevocationKey(channelId: string): string {
  return `channel:${channelId}`;
}

/** Injectable for tests only; every production caller uses the global `fetch`. */
export type FetchLike = typeof fetch;

function kvValueUrl(config: KvConfig, key: string): string {
  return (
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}` +
    `/storage/kv/namespaces/${encodeURIComponent(config.namespaceId)}` +
    `/values/${encodeURIComponent(key)}`
  );
}

/**
 * Always reads the body to completion (or cancels it), success or failure
 * -- an unconsumed `fetch` response body can hold its underlying socket
 * open under Node's `undici` until garbage collection gets to it, which on
 * a busy retry/backoff path is exactly the kind of slow leak that goes
 * unnoticed until a raid ban somewhere leaves a pile of half-drained
 * sockets behind it.
 */
async function drain(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * `null` for "no record" (a fresh 404, or a value that failed to parse --
 * treated the same as absent, never as a crash) and `undefined` for "could
 * not find out" (network failure, timeout, non-2xx/404 status) -- the two
 * are different answers: a caller MAY proceed treating `null` as "nothing
 * to beat", but `undefined` means the read itself is untrustworthy, so a
 * write built on top of it must not claim to know it is newer than
 * whatever might already be there.
 */
async function kvGetTimestamp(
  config: KvConfig,
  key: string,
  fetchImpl: FetchLike,
): Promise<number | null | undefined> {
  return withKvConcurrencyLimit(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), KV_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(kvValueUrl(config, key), {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiToken}` },
        signal: controller.signal,
      });
      if (response.status === 404) {
        await drain(response);
        return null;
      }
      const text = await drain(response);
      if (!response.ok) {
        return undefined;
      }
      const parsed = Number(text);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  });
}

async function kvPutTimestamp(
  config: KvConfig,
  key: string,
  value: number,
  fetchImpl: FetchLike,
): Promise<boolean> {
  return withKvConcurrencyLimit(async () => {
    // At least the party pass's own ceiling (the CONSTANT ceiling,
    // `LIVE_HLS_PARTY_PASS_MAX_TTL_MS`, not whatever `LIVE_HLS_PARTY_PASS_TTL_MS`
    // currently says -- a pass minted under a longer-lived setting that was
    // since shortened must not outlive this key, the same reasoning
    // `hls-revocation.ts`'s own high-water mark applies to its in-memory
    // pruning window).
    const ttlSeconds = Math.ceil(LIVE_HLS_PARTY_PASS_MAX_TTL_MS / 1000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), KV_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${kvValueUrl(config, key)}?expiration_ttl=${ttlSeconds}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "text/plain",
        },
        body: String(value),
        signal: controller.signal,
      });
      await drain(response);
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  });
}

/**
 * Read-modify-write: writes `now` only if nothing already there is at
 * least as new. A read failure (`undefined`) is treated as "unknown, might
 * already be newer" and skips straight to a plain write attempt rather
 * than risking a stale value winning a race it never actually needed to
 * enter -- KV's own PUT already always wins the LAST write, so the worst
 * case here is identical to not having read first at all, not worse.
 */
async function writeMonotonic(
  config: KvConfig,
  key: string,
  now: number,
  fetchImpl: FetchLike,
): Promise<boolean> {
  const existing = await kvGetTimestamp(config, key, fetchImpl);
  if (typeof existing === "number" && existing >= now) {
    // Already at least this fresh -- not a failure, nothing to write.
    return true;
  }
  return kvPutTimestamp(config, key, now, fetchImpl);
}

/**
 * Backoff between retries of the SAME (key, now) write, after the first
 * attempt (made synchronously by the caller, see `deliver` below) has
 * already failed once. Three tries past the first -- about 30 s of total
 * retrying -- covers a transient blip without holding a revocation write
 * open indefinitely; `RETRY_QUEUE_MAX` bounds how many are ever in
 * backoff at once, so a sustained Cloudflare outage during a mass-ban
 * degrades to "some revocations arrive late" rather than an unbounded pile
 * of suspended timers.
 */
let retryDelaysMs: readonly number[] = [2_000, 8_000, 20_000];
const RETRY_QUEUE_MAX = 200;
let pendingRetries = 0;

async function deliver(
  config: KvConfig,
  key: string,
  now: number,
  channelId: string,
  fetchImpl: FetchLike,
  attempt = 0,
): Promise<void> {
  const ok = await writeMonotonic(config, key, now, fetchImpl).catch(() => false);
  if (ok) {
    return;
  }
  if (attempt >= retryDelaysMs.length) {
    logEvent("voice.hlsEdgeRevocationWriteFailed", { channelId, attempts: attempt + 1 });
    return;
  }
  if (pendingRetries >= RETRY_QUEUE_MAX) {
    logEvent("voice.hlsEdgeRevocationWriteFailed", {
      channelId,
      reason: "retry-queue-overflow",
      attempts: attempt + 1,
    });
    return;
  }
  pendingRetries += 1;
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
  } finally {
    pendingRetries -= 1;
  }
  return deliver(config, key, now, channelId, fetchImpl, attempt + 1);
}

/**
 * Writes one KV key, monotonically, retrying on failure through the bounded
 * in-process queue above. The full attempt sequence (first try plus every
 * retry) is awaited end to end by THIS function -- what is NOT awaited is
 * this function's own caller (`writeHlsEdgeRevocationForScope`, called from
 * the synchronous `revokeHlsAccess`): the eviction path that removes a
 * viewer from a channel view must not block on a Cloudflare round trip to
 * do it, so it fires this with `void` and moves on. Never throws. No-ops
 * silently (not even a log line) when unconfigured, which is the expected
 * shape for every deployment that has not provisioned the edge KV
 * namespace -- most of them.
 */
export async function writeHlsEdgeRevocationAt(
  key: string,
  channelId: string,
  now = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const config = kvConfig();
  if (!config) {
    return;
  }
  await deliver(config, key, now, channelId, fetchImpl);
}

/** Per-viewer write -- see `hlsEdgeRevocationKey`. */
export async function writeHlsEdgeRevocation(
  userId: string,
  channelId: string,
  now = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  return writeHlsEdgeRevocationAt(hlsEdgeRevocationKey(userId, channelId), channelId, now, fetchImpl);
}

/** Channel-wide write -- see `hlsEdgeChannelRevocationKey` and the module doc comment. */
export async function writeHlsEdgeChannelRevocation(
  channelId: string,
  now = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  return writeHlsEdgeRevocationAt(hlsEdgeChannelRevocationKey(channelId), channelId, now, fetchImpl);
}

/**
 * Writes one KV entry per user this scope actually names. Fire-and-forget
 * from the caller's side (`hls-revocation.ts` never awaits this), but each
 * individual write's own attempt-plus-retry sequence is fully awaited
 * internally -- see `writeHlsEdgeRevocationAt`.
 */
export function writeHlsEdgeRevocationForScope(
  channelId: string,
  onlyUserIds: readonly string[] | undefined,
  now = Date.now(),
): void {
  if (!onlyUserIds || onlyUserIds.length === 0) {
    return;
  }
  for (const userId of onlyUserIds) {
    void writeHlsEdgeRevocation(userId, channelId, now);
  }
}

/** Test-only: shrinks the retry backoff so a retry test does not take 30 real seconds. */
export function setHlsEdgeRevocationRetryDelaysForTests(delays: readonly number[]): void {
  retryDelaysMs = delays;
}

/** Test-only: restores the production backoff schedule. */
export function resetHlsEdgeRevocationRetryDelaysForTests(): void {
  retryDelaysMs = [2_000, 8_000, 20_000];
}
