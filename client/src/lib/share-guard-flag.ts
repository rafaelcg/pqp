import { fetchShareConfig } from "./api";

/**
 * `share_high_motion_guard` as the client learns it: one boolean on
 * `GET /api/share/config?serverId=`, per server, read before a share starts.
 *
 * Same contract as the native share audio flag, and for the same reason it
 * must never slow the picker: a server whose answer is known replies at once
 * from the cache, however old (the refresh runs behind it), and a server
 * nobody has asked about waits `ENSURE_BUDGET_MS` and no longer. Unanswered is
 * OFF for this share and asked again for the next one, so an API that is down,
 * slow, or older than the flag leaves the share exactly as it was before the
 * guard existed.
 */

const TTL_MS = 10 * 60_000;
const ENSURE_BUDGET_MS = 1_500;

const cache = new Map<string, { at: number; value: boolean }>();
const refreshing = new Set<string>();

export function resetShareGuardFlagForTests(): void {
  cache.clear();
  refreshing.clear();
}

function ask(serverId: string | null): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ENSURE_BUDGET_MS);
    fetchShareConfig(serverId)
      .then((config) => {
        clearTimeout(timer);
        const value = config.shareHighMotionGuard === true;
        cache.set(serverId ?? "", { at: Date.now(), value });
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

/** Warm the answer when somebody enters a call, off the share-start path. */
export function prefetchShareGuardFlag(serverId?: string | null): void {
  const key = serverId ?? "";
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return;
  }
  if (refreshing.has(key)) {
    return;
  }
  refreshing.add(key);
  void ask(serverId ?? null).finally(() => refreshing.delete(key));
}

/** Whether THIS share runs under the guard. Decided before the picker opens and carried on the intent. */
export async function ensureShareGuardFlag(
  serverId?: string | null,
): Promise<boolean> {
  const key = serverId ?? "";
  const cached = cache.get(key);
  if (cached) {
    if (Date.now() - cached.at >= TTL_MS && !refreshing.has(key)) {
      refreshing.add(key);
      void ask(serverId ?? null).finally(() => refreshing.delete(key));
    }
    return cached.value;
  }
  return (await ask(serverId ?? null)) === true;
}
