/**
 * The Jam's steps as browser history entries: wall, then a song, then the
 * studio. Back goes up one step instead of leaving the app, and from the studio
 * it asks the same "Descartar esse take?" the arrow in the studio asks.
 *
 * An entry the Jam pushed carries `{ jamStep }` in the router's location state.
 * That flag is what says "the entry below this one is the previous Jam step",
 * so closing a step in the app can go BACK (`navigate(-1)`) instead of
 * stacking another entry, and it survives a reload, which keeps `history.state`.
 * An entry with no flag (a link pasted into a new tab, a reload of a fresh
 * visit) has nothing of ours below it: closing there replaces the address, as
 * the forum's post does, and never takes the person out of the app.
 *
 * The address bar already carries the song (`/channel/<jam>/song/<id>`); the
 * studio has no address of its own, so its entry repeats the song's (or the
 * wall's) path with `{ jamStep: "studio" }`.
 */

export type JamHistoryStep = "song" | "studio";

/** The router state an entry of this step carries. */
export function jamHistoryState(step: JamHistoryStep): { jamStep: JamHistoryStep } {
  return { jamStep: step };
}

/** Which Jam step the entry holding this router state was pushed for, if any. */
export function jamStepOf(state: unknown): JamHistoryStep | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const step = (state as { jamStep?: unknown }).jamStep;
  return step === "song" || step === "studio" ? step : null;
}

/** How the app is asked to put a song in the address bar. */
export type JamRouteMode =
  /** Rewrite the current entry (a link, a deep link: the old behaviour). */
  | "replace"
  /** A new entry for the song, flagged as a Jam step (a tile opened it from the wall). */
  | "push"
  /** Rewrite the current entry and keep it flagged as a Jam step (another song, or a new song just posted). */
  | "swap"
  /** The state only: the pane takes the entry off with `navigate(-1)` itself. */
  | "pop";
