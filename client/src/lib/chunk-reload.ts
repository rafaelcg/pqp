/**
 * Recovery for a browser tab left open across a Cloudflare Pages deploy.
 *
 * Every deploy replaces the hashed assets and Pages deletes the old ones, so
 * a tab that has been open since before the deploy 404s the instant it needs
 * a chunk it has not already fetched: a lazy route, a `React.lazy` component,
 * anything `import()`ed on demand. Two different failure shapes reach here,
 * both funnelled through one function so the decision (reload now, wait, or
 * give up) is made in exactly one place rather than scattered across every
 * call site that could hit a stale chunk:
 *
 *  - a failed `<link rel="modulepreload">` Vite injects for prefetching,
 *    which dispatches `vite:preloadError` on `window` and never touches
 *    React's render tree at all (see `main.tsx`);
 *  - a failed dynamic `import()` itself, which is what `React.lazy` uses
 *    under the hood, and which throws during render and is caught by an
 *    error boundary (see `components/error-boundary.tsx`).
 *
 * A single reload almost always fixes it, because the fresh `index.html` that
 * reload fetches points at the CURRENT deploy's asset hashes. The 30-second
 * guard is what stops a genuinely broken deploy (or a flaky connection) from
 * reloading forever: after one attempt inside the window, the error is left
 * to surface normally instead of retrying blind.
 */

const STORAGE_KEY = "pqp:stale-chunk-reload-at";
const COOLDOWN_MS = 30_000;

const CHUNK_ERROR_PATTERNS = [
  // Vite/Chromium's own wording for a dynamic import() that 404s.
  /failed to fetch dynamically imported module/i,
  // Safari/WebKit's wording for the same failure.
  /error loading dynamically imported module/i,
  // Firefox's wording for the same failure.
  /importing a module script failed/i,
];

function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "";
}

/** Whether `error` looks like a deploy-rotated-the-assets chunk-load failure. */
export function isChunkLoadError(error: unknown): boolean {
  const message = errorMessage(error);
  if (!message) {
    return false;
  }
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** `sessionStorage` throws in some locked-down contexts (private mode, iframes). */
function defaultStorage(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readReloadedAt(storage: StorageLike | null): number | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeReloadedAt(storage: StorageLike | null, value: number): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage full / disabled: worst case is one extra reload attempt on a
    // future failure, never a loop within this same call.
  }
}

/**
 * True while a reload already taken for this reason is still within its
 * cooldown, i.e. reloading again would not help and risks a loop.
 */
export function reloadedRecently(
  nowMs: number,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  const at = readReloadedAt(storage);
  if (at === null) {
    return false;
  }
  return nowMs - at < COOLDOWN_MS;
}

export type ChunkErrorAction = "reloaded" | "deferred" | "ignored";

export interface ChunkErrorRecoveryOptions {
  /** Test seam. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Test seam. Defaults to `sessionStorage`, guarded against throwing. Pass
   * `null` to disable persistence entirely (the guard then never fires).
   */
  storage?: StorageLike | null;
  /** Whether this tab is in an active voice call right now. Defaults to false. */
  isInCall?: () => boolean;
  /** Test seam. Defaults to `() => window.location.reload()`. */
  reload?: () => void;
  /** Called instead of reloading when `isInCall()` is true. */
  onDeferred?: () => void;
}

/**
 * The single decision point every chunk-load failure funnels through.
 *
 * - not a chunk-load error at all: does nothing and returns `"ignored"`,
 *   and the caller should let the error surface like any other bug;
 * - a reload for this reason already happened in the last 30s: also
 *   `"ignored"`, so a genuinely broken deploy surfaces its real error
 *   instead of reloading forever;
 * - the tab is in an active call: never reload out from under it. Calls
 *   `onDeferred` (a toast/banner asking the person to reload when they're
 *   done) and returns `"deferred"`;
 * - otherwise: marks the reload so the guard above can see it, reloads, and
 *   returns `"reloaded"`.
 */
export function recoverFromChunkLoadError(
  error: unknown,
  options: ChunkErrorRecoveryOptions = {},
): ChunkErrorAction {
  if (!isChunkLoadError(error)) {
    return "ignored";
  }

  const now = options.now ?? Date.now;
  const storage =
    options.storage !== undefined ? options.storage : defaultStorage();
  const nowMs = now();

  if (reloadedRecently(nowMs, storage)) {
    return "ignored";
  }

  if (options.isInCall?.()) {
    options.onDeferred?.();
    return "deferred";
  }

  writeReloadedAt(storage, nowMs);
  const reload = options.reload ?? (() => window.location.reload());
  reload();
  return "reloaded";
}
