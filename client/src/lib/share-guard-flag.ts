import { fetchShareConfig } from "./api";
import { recordShareFastStartQuality } from "./share-fast-start";
import { recordSharePopout } from "./share-popout-flag";

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
 *
 * `share_game_capture_hint` (`shareGameCaptureHint`) rides on the same answer
 * and the same cache: one request per server tells the share both.
 *
 * So does `share_fast_start_quality` (`shareFastStartQuality`), which the
 * viewer needs as well as the presenter: every answer is handed to
 * `share-fast-start.ts` as it arrives, and the call reads it from there.
 * Unanswered is off, like the rest.
 *
 * And so does `share_popout` (`sharePopout`), handed to `share-popout-flag.ts`
 * the same way: it decides where the call's picture is drawn.
 */

const TTL_MS = 10 * 60_000;
const ENSURE_BUDGET_MS = 1_500;

interface ShareFlags {
  guard: boolean;
  gameCaptureHint: boolean;
}

const OFF: ShareFlags = { guard: false, gameCaptureHint: false };

const cache = new Map<string, { at: number; value: ShareFlags }>();
const refreshing = new Set<string>();
/**
 * The latest request asked per server. Two can be in flight for one server
 * (a prefetch at join and a share starting before it answered); if the
 * operator flips a flag between them, the older one can land last. Only the
 * newest request's answer is stored, so a stale "on" never overwrites a
 * fresher "off" in the cache or in the stores fed from here.
 */
const latestAsk = new Map<string, number>();
let askSeq = 0;

export function resetShareGuardFlagForTests(): void {
  cache.clear();
  refreshing.clear();
  latestAsk.clear();
}

function ask(serverId: string | null): Promise<ShareFlags | null> {
  const key = serverId ?? "";
  const seq = ++askSeq;
  latestAsk.set(key, seq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ENSURE_BUDGET_MS);
    fetchShareConfig(serverId)
      .then((config) => {
        clearTimeout(timer);
        const value: ShareFlags = {
          guard: config.shareHighMotionGuard === true,
          gameCaptureHint: config.shareGameCaptureHint === true,
        };
        if (latestAsk.get(key) !== seq) {
          // Superseded: this caller still gets the answer it asked for, but
          // the shared state keeps the newer one.
          resolve(value);
          return;
        }
        cache.set(key, { at: Date.now(), value });
        recordShareFastStartQuality(serverId, config.shareFastStartQuality === true);
        recordSharePopout(serverId, config.sharePopout === true);
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

async function ensureShareFlags(serverId?: string | null): Promise<ShareFlags> {
  const key = serverId ?? "";
  const cached = cache.get(key);
  if (cached) {
    if (Date.now() - cached.at >= TTL_MS && !refreshing.has(key)) {
      refreshing.add(key);
      void ask(serverId ?? null).finally(() => refreshing.delete(key));
    }
    return cached.value;
  }
  return (await ask(serverId ?? null)) ?? OFF;
}

/** Whether THIS share runs under the guard. Decided before the picker opens and carried on the intent. */
export async function ensureShareGuardFlag(
  serverId?: string | null,
): Promise<boolean> {
  return (await ensureShareFlags(serverId)).guard;
}

/**
 * Whether THIS share is watched for a dead picture (`share_game_capture_hint`).
 * Same contract as the guard: decided before the picker opens, carried on the
 * intent, off when unanswered.
 */
export async function ensureShareGameCaptureHintFlag(
  serverId?: string | null,
): Promise<boolean> {
  return (await ensureShareFlags(serverId)).gameCaptureHint;
}
