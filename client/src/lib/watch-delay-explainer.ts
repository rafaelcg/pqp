/**
 * The one-line delay explainer shown the first time a person watches a
 * stream, and never again once dismissed.
 *
 * Post-mortem item C1 (`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`):
 * "delay do cão", "30 segundos atrasado pra todos?" x10 — the delay itself is
 * the product (everyone sees the same moment together), but nothing on
 * screen said that, so it read as breakage and drove people into the voice
 * call for "lower delay". The persistent badge (`voice.hls.delayBadge`) says
 * the number always; this note says once, in words, that it is normal.
 */

const STORAGE_KEY = "pqp:watch-delay-explainer-seen";

export function hasSeenWatchDelayExplainer(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Storage unavailable (private mode, quota): default to "already seen"
    // rather than nagging every single watch of the session.
    return true;
  }
}

export function markWatchDelayExplainerSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Not persisted, but the in-memory dismissal for this mount still holds.
  }
}

/** Test seam: forget the stored flag so the next read hits storage again. */
export function resetWatchDelayExplainerForTests(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
