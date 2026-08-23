/**
 * The line that proves the bot is CONNECTED, not merely running.
 *
 * ── WHY A HEARTBEAT AT ALL ──────────────────────────────────────────────────
 *
 * Because every other signal this service produces is a signal about its
 * PROCESS, and the failure mode is a healthy process with a dead socket. On
 * 2026-08-23 the Fly machine was `started`, the lifecycle log trail ended
 * cleanly on `bot.start`, and the bot was deaf. Both of the things a monitor
 * could read said fine.
 *
 * The reason nothing periodic existed before is a good one, and it is written
 * down in the monitor: the bot logs when it answers a question and is otherwise
 * silent, #ajuda is quiet most days, so "no output for two hours" was the
 * normal, healthy state and alerting on it would have trained everyone to
 * ignore the check. That argument dies the moment there is a line the bot emits
 * whether or not anybody asks it anything — which is this one. Absence of this
 * line is now unambiguous.
 *
 * ── THE FIELDS ARE A CONTRACT ───────────────────────────────────────────────
 *
 * `scripts/monitor/bot-heartbeat.mjs` imports `HEARTBEAT_EVENT` and
 * `HEARTBEAT_INTERVAL_MS` from this file rather than restating them, so the
 * producer and the consumer of the line cannot drift apart in a rename. The
 * field names below are parsed there; treat them as public.
 *
 *   connected  sockets with a live, open connection right now
 *   expected   sockets that should be open (one per watched channel)
 *   reconnects how many times a dropped socket has been recovered
 *   closes     how many times a socket has dropped
 *   downForS   length of the CURRENT outage, 0 when everything is up
 *   idleForS   since the last inbound frame — diagnostics, never alerted on,
 *              because a quiet channel is legitimately quiet
 *   uptimeS    since this process started
 *
 * ── CADENCE ─────────────────────────────────────────────────────────────────
 *
 * Five minutes. Fly's free log retention is `fly logs --no-tail`'s ~100-line
 * buffer and nothing else, so cadence is a direct trade against how far back
 * the buffer reaches: at 12 lines an hour the buffer still covers roughly eight
 * hours, which leaves room for the boot lines and any answers the bot posted.
 * Faster would buy detection latency the monitor's own cron (every few minutes
 * at best) cannot use, and would pay for it by shortening the history any
 * incident is read from.
 */

export const HEARTBEAT_EVENT = "bot.heartbeat";

/** Five minutes. See the cadence note above before changing it. */
export const HEARTBEAT_INTERVAL_MS = Number(
  process.env.SUPPORT_HEARTBEAT_MS ?? 300_000,
);

/**
 * Roll a set of `ResilientSocket`s up into one line's worth of fields.
 *
 * Pure, so the monitor's tests and this module's tests can agree on what a
 * healthy line looks like without starting anything.
 */
export function heartbeatFields(sockets, { now = Date.now(), startedAt = 0 } = {}) {
  // An ARRAY, not an iterator. Passing `map.values()` here would report a full
  // house on the first beat and zero connected on every beat after it, which is
  // the single worst thing a liveness signal can do: page for an outage that is
  // not happening, until somebody mutes it and stops reading the real ones.
  if (!Array.isArray(sockets)) {
    throw new TypeError("heartbeatFields: pass an array of sockets");
  }
  const states = sockets.map((s) => s.state());
  const open = states.filter((s) => s.open);
  const downSince = states.map((s) => s.downSince).filter(Boolean);
  const lastFrameAt = Math.max(0, ...states.map((s) => s.lastFrameAt));
  return {
    connected: open.length,
    expected: states.length,
    reconnects: states.reduce((sum, s) => sum + s.reconnects, 0),
    closes: states.reduce((sum, s) => sum + s.closes, 0),
    downForS: downSince.length ? Math.round((now - Math.min(...downSince)) / 1000) : 0,
    idleForS: lastFrameAt ? Math.round((now - lastFrameAt) / 1000) : null,
    uptimeS: startedAt ? Math.round((now - startedAt) / 1000) : null,
  };
}

/**
 * Start beating. Returns a stop function.
 *
 * The first beat is emitted IMMEDIATELY rather than one interval later, so a
 * freshly booted machine has published its connected state within a second of
 * `bot.start` and the monitor never has to distinguish "young" from "wedged".
 * The timer is unref'd: a heartbeat must never be the thing keeping a process
 * that wants to exit alive.
 */
export function startHeartbeat({
  /** An array. See the guard in `heartbeatFields`. */
  sockets,
  log,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  startedAt = Date.now(),
  now = () => Date.now(),
}) {
  const beat = () => {
    log(HEARTBEAT_EVENT, heartbeatFields(sockets, { now: now(), startedAt }));
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
