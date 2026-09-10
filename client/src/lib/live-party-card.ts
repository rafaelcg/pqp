/**
 * How long a party has been on air, for the sidebar card. Pure.
 *
 * Minutes under an hour, then hours and minutes, and nothing at all before
 * the first minute is up: "0 min" on a show that just started reads as a
 * bug. `now` is a parameter so the card can tick on its own timer and a
 * test can pin an instant.
 */
export function formatLiveFor(
  wentLiveAt: string | null | undefined,
  now: Date,
): string | null {
  if (!wentLiveAt) {
    return null;
  }
  const started = Date.parse(wentLiveAt);
  if (!Number.isFinite(started)) {
    return null;
  }
  const minutes = Math.floor((now.getTime() - started) / 60_000);
  if (minutes < 1) {
    return null;
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${String(rest).padStart(2, "0")}`;
}
