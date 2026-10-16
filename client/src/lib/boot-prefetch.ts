/**
 * Reads the page address already says the app is about to need, started in
 * parallel with the first `/api/me` instead of after it.
 *
 * A reload of `/app/server/<sid>/channel/<cid>` (every refresh of an open
 * channel, every shared link, every push tap) used to walk a chain: `me`, then
 * `servers`, then `channels`, then `messages`, each waiting for the one before
 * it although the address names both ids. On a link with a 180 ms round trip
 * and a CORS preflight in front of every call, that is about 365 ms a hop.
 * The two reads that need only the address are started with `me` and picked up
 * by `fetchChannels` / `fetchMessages` when the app asks the same question a
 * moment later.
 *
 * WHAT KEEPS THIS HONEST
 *  - **Single use.** An entry is handed to the first caller and removed. Every
 *    later read, after a send, a reconnect, a mutation, goes to the network.
 *  - **Short.** An entry older than `BOOT_PREFETCH_TTL_MS` is ignored, so a
 *    read that never got asked for cannot answer a question asked minutes
 *    later (create a channel, then list channels).
 *  - **Same credentials, same server checks.** The read is an ordinary
 *    authenticated call made by the signed-in session; if the account is not
 *    allowed (not a member, age gate, wrong account) it fails exactly as the
 *    direct call would, and a failed entry is never handed on: the caller
 *    makes its own request.
 *  - **Cleared with the session.** `clearBootPrefetch` runs when the shell
 *    unmounts (sign-out, account switch), so nothing outlives the account that
 *    started it.
 *
 * Pure bookkeeping, no network and no imports from `api.ts`, so the two sides
 * cannot form a cycle.
 */

/** Longest an unclaimed read may wait to be picked up. */
export const BOOT_PREFETCH_TTL_MS = 10_000;

interface Entry {
  promise: Promise<unknown>;
  at: number;
}

const entries = new Map<string, Entry>();

export function channelsPrefetchKey(serverId: string): string {
  return `channels:${serverId}`;
}

export function messagesPrefetchKey(channelId: string): string {
  return `messages:${channelId}`;
}

/** Remember a read that is already in flight. Replaces an older one for the key. */
export function putBootPrefetch(
  key: string,
  promise: Promise<unknown>,
  now = Date.now(),
): void {
  // Nobody may be waiting on it (an age-gated account, a server it left): a
  // rejection must not surface as an unhandled one.
  promise.catch(() => {});
  entries.set(key, { promise, at: now });
}

/**
 * The in-flight read for `key`, once. Null when there is none, when it is older
 * than the TTL, or when it was already taken. The caller must fall back to the
 * network when the returned promise rejects.
 */
export function takeBootPrefetch<T>(
  key: string,
  now = Date.now(),
): Promise<T> | null {
  const entry = entries.get(key);
  if (!entry) {
    return null;
  }
  entries.delete(key);
  if (now - entry.at > BOOT_PREFETCH_TTL_MS) {
    return null;
  }
  return entry.promise as Promise<T>;
}

/**
 * Use the prefetched read when there is one, and the network when there is not
 * or when the prefetched read failed (a transient error on the speculative call
 * must not become the answer to the real one).
 */
export function takeOrFetch<T>(
  key: string,
  network: () => Promise<T>,
): Promise<T> {
  const prefetched = takeBootPrefetch<T>(key);
  return prefetched ? prefetched.catch(() => network()) : network();
}

/** Forget everything: the session that started these reads is over. */
export function clearBootPrefetch(): void {
  entries.clear();
}
