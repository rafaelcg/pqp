/**
 * IS THE SUPPORT BOT CONNECTED — not "is its machine running".
 *
 * ── WHY MACHINE STATE IS NOT ENOUGH, STATED PLAINLY ─────────────────────────
 *
 * `fly status` answers a question about a virtual machine. The support bot's
 * job is to hold a WebSocket to `pqp-api` and answer when somebody mentions it,
 * and NOTHING about the VM's state depends on that socket. The two can and did
 * come apart:
 *
 *   2026-08-23T17:33:32Z  bot.ready, bot.start
 *   ...                   nothing, for hours
 *   machine 683d472f209678  state=started
 *   member list in the app  `manual [bot]` under OFFLINE
 *
 * The socket had dropped. `tools/ambient/src/pqp-client.js` had no reconnect
 * (correct for the ambient cast, wrong for a bot that connects once at boot),
 * `onerror` swallowed the reason, and the process never exited — so
 * `[[restart]] policy = "always"` never fired and the machine stayed `started`
 * forever. `server/src/ws/status.ts` defines `online` as "there is a live
 * socket", so the product knew the truth the whole time and the monitor did
 * not.
 *
 * The lifecycle-trail half of `judgeBot` does not close the gap either. It
 * asserts that the LAST `bot.*` line is a start rather than a stop, which
 * catches a restart loop and a clean exit. In this incident the last line WAS
 * `bot.start`. A trail of boot lines proves the bot started; nothing in it
 * expires, so it goes on proving that long after the bot stopped working.
 *
 * The only fix is a signal that is emitted continuously and says something
 * about the SOCKET. That is `bot.heartbeat`, produced by
 * `tools/support-bot/src/heartbeat.js` — every five minutes, whether or not
 * anybody asked anything, carrying `connected` and `expected`. This file reads
 * it. Two failures become visible that were not before: the line stops
 * (the process is wedged, or its logging is), and the line says
 * `connected=0 expected=1` (the process is fine and the bot is deaf).
 *
 * The event name and cadence are IMPORTED from the bot rather than restated, so
 * a rename cannot leave a check quietly matching a string nobody emits any more
 * — which would present as a permanent, ignorable `skip`.
 *
 * ── HOW THIS COMBINES WITH scripts/monitor/errors.mjs ───────────────────────
 *
 * `errors.mjs` lives on the unmerged `monitor/error-heartbeat` branch; this
 * file is on `main` and deliberately imports nothing from it, so the two can
 * land in either order. To combine, add to `judgeBot`, immediately before its
 * final `ok` return:
 *
 *     import { judgeHeartbeat } from "./bot-heartbeat.mjs";
 *     ...
 *     const beat = judgeHeartbeat({ records, lifecycle });
 *     if (beat.status !== "ok") {
 *       return { ...base, ...beat, detail: `${detail}\n${beat.detail}`, runbook };
 *     }
 *
 * Nothing else in `judgeBot` changes: the machine-state and lifecycle checks
 * stay exactly as they are and still run first, because "no machine" and "three
 * machines" are better diagnoses than "no heartbeat" for the same symptom.
 */

import {
  HEARTBEAT_EVENT,
  HEARTBEAT_INTERVAL_MS,
} from "../../tools/support-bot/src/heartbeat.js";

/**
 * How stale a heartbeat may be before it is an outage.
 *
 * Three intervals. One missed beat is a log-shipping hiccup or a monitor that
 * sampled between two of them; three in a row is fifteen minutes of a bot that
 * is not saying it is connected, which is longer than any restart takes.
 */
export const MAX_HEARTBEAT_AGE_MS = Number(
  process.env.MONITOR_HEARTBEAT_MAX_AGE_MS ?? HEARTBEAT_INTERVAL_MS * 3,
);

const FIELD = /(\w+)=(-?\d+|null)/g;

/**
 * Every heartbeat line in a `fly logs --json` buffer, oldest first.
 *
 * Records are Fly's, so the timestamp comes from Fly rather than from the line
 * body: the bot prints its own ISO timestamp too, but a check that trusted the
 * process's clock to decide whether the process is alive would be trusting the
 * thing under investigation.
 */
export function parseHeartbeats(records) {
  const beats = [];
  for (const record of records) {
    const message = String(record?.message ?? "");
    if (!message.includes(HEARTBEAT_EVENT)) {
      continue;
    }
    const fields = {};
    for (const [, key, value] of message.matchAll(FIELD)) {
      fields[key] = value === "null" ? null : Number(value);
    }
    const at = Date.parse(record.timestamp ?? "");
    if (Number.isNaN(at)) {
      continue;
    }
    beats.push({ at, message, ...fields });
  }
  return beats.sort((a, b) => a.at - b.at);
}

const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;

/**
 * Judge the connection, given the log buffer and (optionally) the lifecycle
 * lines `judgeBot` already extracted.
 *
 * Returns `{ status, summary, detail }` in the same vocabulary as every other
 * check. `ok` here means "a recent heartbeat said every socket is connected"
 * and nothing weaker.
 */
export function judgeHeartbeat({
  records = [],
  lifecycle = [],
  now = Date.now(),
  maxAgeMs = MAX_HEARTBEAT_AGE_MS,
} = {}) {
  const beats = parseHeartbeats(records);
  const last = beats.at(-1);
  const lastStart = [...lifecycle].reverse().find((l) => l.event === "start");

  if (!last) {
    // No heartbeat anywhere in the buffer. Whether that is an outage depends on
    // how old the buffer is, and the honest reading of "old boot lines and
    // nothing since" is exactly the 2026-08-23 shape: the buffer is only stale
    // BECAUSE the bot stopped writing to it.
    if (lastStart) {
      const age = now - Date.parse(lastStart.at);
      if (age > maxAgeMs) {
        return {
          status: "fail",
          summary:
            `The bot started ${minutes(age)} ago and has not emitted a single ` +
            `\`${HEARTBEAT_EVENT}\` since. Either its socket is gone and its loop is ` +
            `wedged (the 2026-08-23 outage), or the deployed build predates the ` +
            `heartbeat and is running without a reconnect at all. Both need a deploy.`,
          detail: `last start ${lastStart.at}; heartbeats found: 0`,
        };
      }
      return {
        status: "skip",
        summary: `Started ${minutes(age)} ago; too soon to expect a heartbeat.`,
        detail: `last start ${lastStart.at}`,
      };
    }
    return {
      status: "skip",
      summary:
        `No \`${HEARTBEAT_EVENT}\` and no start line in the buffer, so whether the ` +
        `bot is connected could not be established either way.`,
      detail: "heartbeats found: 0",
    };
  }

  const age = now - last.at;
  const detail = `last heartbeat ${new Date(last.at).toISOString()} (${minutes(age)} ago)\n${last.message.slice(0, 200)}`;

  if (age > maxAgeMs) {
    return {
      status: "fail",
      summary:
        `The last heartbeat is ${minutes(age)} old (limit ${minutes(maxAgeMs)}). The ` +
        `machine may still say \`started\`; the bot has stopped reporting a connection.`,
      detail,
    };
  }
  if (Number.isFinite(last.connected) && Number.isFinite(last.expected)) {
    if (last.connected < last.expected) {
      return {
        status: "fail",
        summary:
          `The bot is running and NOT connected: ${last.connected}/${last.expected} ` +
          `channel sockets are up${last.downForS ? `, down for ${last.downForS}s` : ""}. ` +
          `It is in the member list as OFFLINE and cannot hear a mention.`,
        detail,
      };
    }
  } else {
    // A heartbeat we cannot read is not evidence of health.
    return {
      status: "skip",
      summary: `A \`${HEARTBEAT_EVENT}\` line was found but had no connected/expected fields.`,
      detail,
    };
  }

  // Connected now, but flapping. Not an outage — it recovered, which is the
  // whole point of the reconnect — and still worth surfacing, because a socket
  // that drops repeatedly means every mention in the gaps went unheard.
  const window = beats.filter((b) => now - b.at <= 6 * 60 * 60_000);
  const churn = window.length > 1 ? window.at(-1).closes - window[0].closes : 0;
  if (churn >= 5) {
    return {
      status: "warn",
      summary:
        `Connected, but the socket has dropped ${churn} times inside this log ` +
        `buffer. Every mention during those gaps went unheard.`,
      detail,
    };
  }

  return {
    status: "ok",
    summary:
      `Connected: ${last.connected}/${last.expected} sockets, heartbeat ${minutes(age)} old, ` +
      `${last.reconnects ?? 0} reconnect(s) since boot.`,
    detail,
  };
}
