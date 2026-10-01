import { applyUpdate } from "@/lib/apply-update";

/**
 * Taking an update when a failure is NOT allowed to strand anybody: the forced
 * screen has no close button, so a button that fails and stays disabled is a
 * person locked out of the product. `applyUpdate` (`lib/apply-update.ts`) is the
 * first rung, and it can fail in ways that leave the page exactly where it was:
 * it can reject, it can hang, and it ends by asking for a reload that a browser
 * can refuse or that a stalled navigation never completes. A resolved promise
 * proves nothing, so this does not trust one: after every rung it waits to see
 * the page actually LEAVE (`pagehide`), and a page that is still here is a rung
 * that did not work.
 *
 * The rungs, each heavier than the one before:
 *
 *  0. `applyUpdate`: make the new worker active, reload.
 *  1. Delete every cache, then navigate to the same URL with a cache-busting
 *     query. A navigation with a fresh URL cannot be answered by a cached copy
 *     of the old one.
 *  2. Unregister every service worker, delete every cache, navigate as above.
 *     LAST RESORT: it also drops the push subscription (which belongs to the
 *     registration and can only be recreated from a click), so it is only for a
 *     person who has already failed twice.
 *
 * A single click walks the rungs with a backoff between them. If every rung
 * fails the result is `failed`, the button comes back, and the NEXT click starts
 * on a heavier rung than the last one ended on (the level is remembered in
 * `sessionStorage` for this build), so repeated clicks escalate and never repeat
 * the same failing thing. Nothing here reloads on its own: every rung is a
 * person's click, which is what keeps this from ever being a reload loop (the
 * automatic path has its own guard, `autoReloadAllowed` in `update-policy.ts`).
 *
 * OFFLINE is answered at once and touches nothing: with no network the caches
 * are the only copy of the app, and a navigation would land on an error page.
 */

export type LadderResult =
  | { ok: true }
  | { ok: false; reason: "offline" | "failed" };

/** How long a rung may run before it counts as failed. */
export const RUNG_BUDGET_MS = 20_000;
/** After a rung has asked the page to leave, how long to wait to see it go. */
export const LEAVE_WAIT_MS = 8_000;
/** Pauses between rungs of ONE click. */
export const BACKOFF_MS = [1_000, 3_000];
export const LAST_RUNG = 2;
/** The remembered level goes stale; a new session of trouble starts at the top. */
export const LEVEL_TTL_MS = 15 * 60_000;

const LEVEL_KEY = "pqp:update-ladder";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface LadderDeps {
  applyUpdate: (target: string | null) => Promise<unknown>;
  purgeAndNavigate: () => Promise<void>;
  unregisterPurgeAndNavigate: () => Promise<void>;
  online: () => boolean;
  /** True once the page has started to unload (`pagehide`). */
  leaving: () => boolean;
  /**
   * Forget an earlier departure. A page restored from the back/forward cache
   * keeps its JavaScript state, `pagehide`'s flag included, and only a
   * navigation begun by THIS rung may count as the page leaving.
   */
  resetLeaving: () => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  storage: StorageLike | null;
}

/** The same URL with a query that no cache has seen, and the hash kept. */
export function cacheBustedUrl(href: string, now: number): string {
  const url = new URL(href);
  url.searchParams.set("_pqp", String(now));
  return url.toString();
}

/** Remove the cache-buster once it has done its job, so it is not bookmarked or shared. */
export function withoutCacheBuster(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("_pqp")) {
    return null;
  }
  url.searchParams.delete("_pqp");
  return url.toString();
}

interface Remembered {
  target: string;
  level: number;
  at: number;
}

function readLevel(deps: LadderDeps, target: string | null): number {
  if (!deps.storage) {
    return 0;
  }
  try {
    const parsed = JSON.parse(deps.storage.getItem(LEVEL_KEY) ?? "null") as
      | Partial<Remembered>
      | null;
    if (
      parsed &&
      parsed.target === (target ?? "") &&
      typeof parsed.level === "number" &&
      typeof parsed.at === "number" &&
      deps.now() - parsed.at < LEVEL_TTL_MS
    ) {
      return Math.min(Math.max(0, parsed.level), LAST_RUNG);
    }
  } catch {
    // Unreadable: start at the top.
  }
  return 0;
}

function writeLevel(deps: LadderDeps, target: string | null, level: number): void {
  try {
    deps.storage?.setItem(
      LEVEL_KEY,
      JSON.stringify({ target: target ?? "", level, at: deps.now() }),
    );
  } catch {
    // Storage off: the click still walks the ladder, it just cannot remember.
  }
}

/** Race `work` against a budget; a rung that rejects, throws or hangs is a failed rung. */
async function runRung(work: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("rung timed out")), RUNG_BUDGET_MS);
  });
  try {
    await Promise.race([work(), budget]);
  } finally {
    clearTimeout(timer);
  }
}

async function pageLeft(deps: LadderDeps): Promise<boolean> {
  const deadline = deps.now() + LEAVE_WAIT_MS;
  while (deps.now() < deadline) {
    if (deps.leaving()) {
      return true;
    }
    await deps.sleep(250);
  }
  return deps.leaving();
}

export async function runUpdateLadder(
  target: string | null,
  deps: LadderDeps = browserLadderDeps(),
): Promise<LadderResult> {
  if (!deps.online()) {
    return { ok: false, reason: "offline" };
  }
  const start = readLevel(deps, target);
  for (let rung = start, step = 0; rung <= LAST_RUNG; rung += 1, step += 1) {
    // Remembered BEFORE the rung runs: a rung that takes the page away never
    // gets to write anything after it.
    writeLevel(deps, target, Math.min(rung + 1, LAST_RUNG));
    deps.resetLeaving();
    try {
      await runRung(() =>
        rung === 0
          ? deps.applyUpdate(target)
          : rung === 1
            ? deps.purgeAndNavigate()
            : deps.unregisterPurgeAndNavigate(),
      );
    } catch {
      // Rejected, threw or timed out: this rung did not work. Go on.
    }
    if (await pageLeft(deps)) {
      return { ok: true };
    }
    if (!deps.online()) {
      return { ok: false, reason: "offline" };
    }
    const pause = BACKOFF_MS[step];
    if (pause !== undefined && rung < LAST_RUNG) {
      await deps.sleep(pause);
    }
  }
  return { ok: false, reason: "failed" };
}

// --------------------------------------------------------------- the browser

function browserStorage(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let leaving = false;
let leavingWatched = false;

function watchLeaving(): void {
  if (leavingWatched || typeof window === "undefined") {
    return;
  }
  leavingWatched = true;
  // `pagehide` fires for a navigation away and for a reload; `beforeunload`
  // covers browsers that are late with the first.
  window.addEventListener("pagehide", () => {
    leaving = true;
  });
  window.addEventListener("beforeunload", () => {
    leaving = true;
  });
  // Restored from the back/forward cache: the page is here, not leaving.
  window.addEventListener("pageshow", () => {
    leaving = false;
  });
}

async function deleteEveryCache(): Promise<void> {
  if (typeof caches === "undefined") {
    return;
  }
  const keys = await caches.keys();
  await Promise.allSettled(keys.map((key) => caches.delete(key)));
}

export function browserLadderDeps(): LadderDeps {
  watchLeaving();
  return {
    applyUpdate,
    purgeAndNavigate: async () => {
      await deleteEveryCache();
      window.location.replace(cacheBustedUrl(window.location.href, Date.now()));
    },
    unregisterPurgeAndNavigate: async () => {
      try {
        const registrations =
          (await navigator.serviceWorker?.getRegistrations()) ?? [];
        await Promise.allSettled(registrations.map((r) => r.unregister()));
      } catch {
        // Go on to the caches and the navigation regardless.
      }
      await deleteEveryCache();
      window.location.replace(cacheBustedUrl(window.location.href, Date.now()));
    },
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    leaving: () => leaving,
    resetLeaving: () => {
      leaving = false;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    storage: browserStorage(),
  };
}
