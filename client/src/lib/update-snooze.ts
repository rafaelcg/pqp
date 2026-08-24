/**
 * How long "Later" postpones the update notice.
 *
 * WHY THIS FILE EXISTS AT ALL. `registerType: "prompt"` means a waiting build
 * never takes over on its own: no `skipWaiting`, no `clientsClaim`, so even a
 * hard reload keeps serving the precached bundle until every tab of the origin
 * is closed. That is the right default for a client holding a live WebSocket,
 * an unsent draft and possibly a call. It is the wrong default when paired with
 * a dismissal that lasts forever, because the two together mean one click of
 * "Later" can strand somebody on an old build for as long as they keep a tab
 * open, which for a chat app is days.
 *
 * That combination shipped a real consequence on 24 Aug 2026: a screen-share
 * fix went live at 01:11Z and a user hit the bug it fixes at ~04:00Z. The fix
 * is receiver-side, so the person seeing the broken behaviour is exactly the
 * person who needed the new bundle and had no way to know.
 *
 * So "Later" now means later. Twenty minutes is long enough that the notice is
 * not nagging somebody through a call, and short enough that a fix reaches an
 * open session the same afternoon rather than the next time they reboot.
 */
export const UPDATE_SNOOZE_MS = 20 * 60 * 1000;

/**
 * Whether a snoozed notice is due again.
 *
 * `snoozedAt` is null when the notice has never been dismissed. Time is passed
 * in rather than read here so the caller owns the clock and this stays a pure
 * function; the component feeds it `Date.now()`.
 */
export function isSnoozeExpired(
  snoozedAt: number | null,
  now: number,
  snoozeMs: number = UPDATE_SNOOZE_MS,
): boolean {
  if (snoozedAt === null) {
    return true;
  }
  return now - snoozedAt >= snoozeMs;
}

/**
 * Milliseconds until a snoozed notice should reappear, for scheduling a timer.
 *
 * Clamped at zero so a clock that jumped backwards (a laptop waking up, an NTP
 * correction) produces an immediate re-show rather than a negative delay that
 * `setTimeout` would fire instantly anyway but that reads as a bug.
 */
export function snoozeRemainingMs(
  snoozedAt: number | null,
  now: number,
  snoozeMs: number = UPDATE_SNOOZE_MS,
): number {
  if (snoozedAt === null) {
    return 0;
  }
  return Math.max(0, snoozedAt + snoozeMs - now);
}
