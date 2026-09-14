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
 * APPEND-ONLY, NOT READ-MODIFY-WRITE. An earlier version of this file kept
 * ONE mutable key per (userId, channelId) and tried to keep it monotonic by
 * reading the current value before every PUT and only writing a strictly
 * newer one. That is a real race, not a theoretical one: two evictions
 * racing each other (a kick immediately followed by a ban, or the same
 * eviction replicated to two instances over the cluster bus) can each read
 * the SAME "nothing here yet" snapshot before either PUT lands, and if the
 * OLDER write's PUT happens to reach Cloudflare after the NEWER write's PUT
 * -- pure network reordering, nothing exotic -- the older, smaller
 * timestamp overwrites the newer one that already landed, silently
 * un-revoking a viewer who is still supposed to be locked out (Farol,
 * 2026-09-14). Read-then-conditionally-write is not atomic against a
 * concurrent writer doing the same thing; no client-side check can fix
 * that without a real compare-and-swap, which the KV REST API does not
 * offer.
 *
 * The fix removes the race by removing the READ from the write path
 * entirely: every eviction writes to its OWN key,
 * `<userId>:<channelId>:<revokedAtMs>` (or `channel:<channelId>:<revokedAtMs>`
 * for the unscoped case), an unconditional PUT with no GET first. Two
 * concurrent writers for the same (userId, channelId) now write two
 * DIFFERENT keys, so there is nothing to race -- both survive regardless of
 * which PUT lands first, each retried independently on failure. The
 * Worker's gate (`party-pass-revocation.js`) reads the whole set back with
 * `kv.list({ prefix })` and takes the newest, comparing it against the
 * credential's own `issuedAt` claim, so the READ side is where "which one
 * is newest" gets decided -- a question a single snapshot read can always
 * answer correctly, unlike a write trying to guess it in advance. Each key
 * self-expires after `LIVE_HLS_PARTY_PASS_MAX_TTL_MS`, so a burst of
 * evictions for one (userId, channelId) pair inside one 6 h window costs a
 * few extra small KV objects, never an unbounded pile.
 *
 * WHY KEYED BY userId:channelId:revokedAtMs, NOT userId ALONE. A party pass
 * is scoped to one channel (`mintHlsPartyPass` binds `channelId` into its
 * signed claims), and `hls-revocation.ts`'s own model is per-channel too --
 * a viewer kicked from one channel keeps a still-valid pass (and an
 * unaffected `?t=`) for any OTHER channel they can legitimately watch.
 * `hlsEdgeRevocationKey` matches exactly the prefix shape the Worker's gate
 * lists. A SEPARATE `channel:<channelId>:<revokedAtMs>` key
 * (`hlsEdgeChannelRevocationKey`) covers the "everyone" case -- a channel
 * deleted or gone private for the whole audience -- which has no fixed
 * list of userIds to key per-viewer entries by; `writeHlsEdgeChannelRevocation`
 * is that hook, called from `revokeHlsAccess` whenever a revocation carries
 * no `only` scope.
 */

import { logEvent } from "../lib/log.js";
import { LIVE_HLS_PARTY_PASS_MAX_TTL_MS } from "./hls-viewer-token.js";

const KV_REQUEST_TIMEOUT_MS = 4_000;

/**
 * A small pool, not zero and not unbounded. A mass moderation action (a
 * raid ban, a bulk kick) can fire dozens of evictions in the same tick;
 * letting every one of them open its own Cloudflare request at once is
 * both a burst this process does not need to inflict on itself and an easy
 * way to exhaust outbound sockets under load. Four in flight is enough to
 * keep the queue draining quickly without that burst. Only ever guards
 * PUTs now (the read-before-write GET this used to also bound is gone with
 * it -- see the module doc comment).
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

/** The exact per-viewer key this write lands at -- `PartyPassRevocationGate` lists the `<userId>:<channelId>:` prefix on the Worker side. */
export function hlsEdgeRevocationKey(userId: string, channelId: string, revokedAtMs: number): string {
  return `${userId}:${channelId}:${revokedAtMs}`;
}

/** The channel-wide key -- see the module doc comment for when this fires instead. */
export function hlsEdgeChannelRevocationKey(channelId: string, revokedAtMs: number): string {
  return `channel:${channelId}:${revokedAtMs}`;
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
async function drain(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // already unusable -- nothing left to drain
  }
}

/**
 * A single unconditional PUT. No GET first: see the module doc comment for
 * why a read-before-write was the bug, and why append-only removes the
 * need for one. Idempotent by construction (the same key with the same
 * value), which is exactly what makes retrying this safe.
 */
async function kvPut(config: KvConfig, key: string, value: number, fetchImpl: FetchLike): Promise<boolean> {
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
 * Backoff between retries of the SAME key, after the first attempt (made
 * synchronously by the caller, see `deliver` below) has already failed
 * once. Three tries past the first -- about 30 s of total retrying --
 * covers a transient blip without holding a revocation write open
 * indefinitely.
 */
let retryDelaysMs: readonly number[] = [2_000, 8_000, 20_000];

/**
 * Bounds the TOTAL number of revocation deliveries (first attempt plus any
 * retries still in backoff) this process holds open at once, across every
 * key -- not just how many are actively hitting the network
 * (`MAX_CONCURRENT_KV_REQUESTS` already bounds that separately). A
 * sustained Cloudflare outage during a mass-ban used to let every one of
 * potentially hundreds of evictions queue its own independent retry chain
 * with no shared ceiling; past this bound a NEW delivery is dropped
 * outright rather than queued, logged once via
 * `voice.hlsEdgeRevocationQueueFull` -- the same "drop and count" shape
 * `rejectionLog` and `partyPassRevocationCache` already use elsewhere in
 * this feature for an attacker- or incident-sized burst. A dropped write
 * degrades to "this one revocation's edge record never lands", not a
 * memory or socket leak; the in-memory `hls-revocation.ts` set (and the
 * WebSocket eviction it runs alongside) are unaffected either way.
 */
const MAX_PENDING_DELIVERIES = 1_000;
const pendingDeliveries = new Map<string, Promise<void>>();

async function deliver(
  config: KvConfig,
  key: string,
  now: number,
  fetchImpl: FetchLike,
  attempt = 0,
): Promise<void> {
  const ok = await kvPut(config, key, now, fetchImpl).catch(() => false);
  if (ok) {
    return;
  }
  if (attempt >= retryDelaysMs.length) {
    logEvent("voice.hlsEdgeRevocationWriteFailed", { key, attempts: attempt + 1 });
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
  return deliver(config, key, now, fetchImpl, attempt + 1);
}

/**
 * Writes one KV key, retrying on failure. The full attempt sequence (first
 * try plus every retry) is awaited end to end by THIS function -- what is
 * NOT awaited is this function's own caller (`writeHlsEdgeRevocationForScope`,
 * called from the synchronous `revokeHlsAccess`): the eviction path that
 * removes a viewer from a channel view must not block on a Cloudflare
 * round trip to do it, so it fires this with `void` and moves on. Never
 * throws. No-ops silently (not even a log line) when unconfigured, which
 * is the expected shape for every deployment that has not provisioned the
 * edge KV namespace -- most of them. `pendingDeliveries` is the fan-out
 * bound described above; an entry occupies its slot for the FULL
 * attempt-plus-retry lifetime, so it is what actually caps how much
 * concurrent work (network requests AND suspended backoff timers) this
 * mechanism can ever be holding at once.
 */
export async function writeHlsEdgeRevocationAt(
  key: string,
  now = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const config = kvConfig();
  if (!config) {
    return;
  }
  if (pendingDeliveries.size >= MAX_PENDING_DELIVERIES) {
    logEvent("voice.hlsEdgeRevocationQueueFull", { key, pending: pendingDeliveries.size });
    return;
  }
  const promise = deliver(config, key, now, fetchImpl);
  pendingDeliveries.set(key, promise);
  try {
    await promise;
  } finally {
    pendingDeliveries.delete(key);
  }
}

/** Per-viewer write -- see `hlsEdgeRevocationKey`. */
export async function writeHlsEdgeRevocation(
  userId: string,
  channelId: string,
  now = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  return writeHlsEdgeRevocationAt(hlsEdgeRevocationKey(userId, channelId, now), now, fetchImpl);
}

/** Channel-wide write -- see `hlsEdgeChannelRevocationKey` and the module doc comment. */
export async function writeHlsEdgeChannelRevocation(
  channelId: string,
  now = Date.now(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  return writeHlsEdgeRevocationAt(hlsEdgeChannelRevocationKey(channelId, now), now, fetchImpl);
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

/** Test-only: how many deliveries this process currently holds open, for asserting the fan-out bound. */
export function hlsEdgeRevocationPendingCountForTests(): number {
  return pendingDeliveries.size;
}
