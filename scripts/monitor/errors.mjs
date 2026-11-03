/**
 * "Is it throwing?" Today this group is one check: is the support bot alive.
 *
 * HISTORY (read this before adding a check). This file used to carry
 * `api-error-rate`, which read `fly logs` for `pqp-api`. Production left Fly
 * for the Vultr box on 2026-09-17 and the Fly apps were destroyed on
 * 2026-10-22, so that check, its classifier and its ignore list were removed.
 * Log errors on the box are owned by Grafana Loki alerts, which see every line
 * and keep 14 days (docs/MONITORING.md, "Logs in Grafana Cloud"); a GitHub
 * runner has no SSH and no secret that reaches the box.
 *
 * What runs is `support-bot-alive`: `pqp-support`, the QG help bot, is still a
 * Fly app, so its machine state and `bot.heartbeat` trail are real. It needs
 * `FLY_ORG_TOKEN` and skips without it.
 *
 * WHY THIS CHECK EXISTS
 * ---------------------
 * `pqp-support` went down three minutes after its first deploy. It exited 0
 * (the SIGTERM handler does that on purpose), Fly's default restart policy read
 * a clean exit as "the job finished" and retired the machine, and the bot was
 * simply absent from #ajuda with nothing anywhere saying so.
 * `[[restart]] policy = "always"` fixed the cause; this check is what would
 * have reported it. `fly logs --no-tail` returns roughly the LAST 100 LINES, so
 * the window it covers is bounded by volume, not time; the heartbeat judge
 * (`bot-heartbeat.mjs`) is written with that in mind.
 *
 * Each check returns { key, title, status, summary, detail?, runbook? } where
 * status is ok | fail | warn | skip, exactly as the other groups do. `key` is
 * permanent: it is the identity of the alert issue, so renaming one orphans an
 * open incident.
 */

import { judgeHeartbeat } from "./bot-heartbeat.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SUPPORT_APP = process.env.MONITOR_SUPPORT_APP ?? "pqp-support";

/**
 * Parse what `flyctl logs --json` actually emits.
 *
 * It is NOT JSON Lines. It is a stream of pretty-printed JSON objects
 * concatenated with no separator, so `JSON.parse` on the whole thing fails and
 * splitting on newlines gives fragments. Splitting on a `\n{` boundary works
 * for the current formatting and breaks the moment flyctl reflows its output
 * or a log message contains a line starting with `{`, which application JSON
 * logs routinely do.
 *
 * So this scans brace depth while respecting string literals and escapes. It
 * costs twenty lines and it also parses JSON Lines correctly, which is what
 * flyctl would most plausibly switch to.
 */
export function parseFlyJson(raw) {
  const records = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = raw.slice(start, i + 1);
        try {
          records.push(JSON.parse(slice));
        } catch {
          // A truncated or malformed object is dropped rather than thrown on.
          // `flyctl` writes its own diagnostics into this stream on failure,
          // and one bad object must not cost us the other ninety-nine.
        }
        start = -1;
      } else if (depth < 0) {
        // Stray closing brace in non-JSON preamble; resynchronise.
        depth = 0;
      }
    }
  }
  return records;
}

/**
 * Which token to hand flyctl.
 *
 * The org-scoped FLY_ORG_TOKEN is the only credential this reads: an
 * app-scoped deploy token cannot read `pqp-support`. It not being set is a
 * `skip`, not a failure: a missing credential must never look like health.
 */
function flyEnv() {
  const token = process.env.FLY_ORG_TOKEN;
  if (!token) {
    return process.env.MONITOR_FLY_LOCAL ? { ...process.env } : null;
  }
  return { ...process.env, FLY_API_TOKEN: token };
}

async function flyLogs(app) {
  const env = flyEnv();
  if (!env) {
    return { skipped: true };
  }
  const { stdout } = await exec("flyctl", ["logs", "--app", app, "--no-tail", "--json"], {
    env,
    maxBuffer: 32 * 1024 * 1024,
    // flyctl streams from a websocket and has been seen to sit idle at the end
    // of the buffer. A monitor that hangs reports nothing at all, which is
    // worse than reporting that it could not read.
    timeout: 90_000,
  });
  return { skipped: false, records: parseFlyJson(stdout) };
}

const NO_TOKEN = (key, title) => ({
  key,
  title,
  status: "skip",
  summary:
    "Skipped: no Fly token. This needs FLY_ORG_TOKEN (org-scoped — the app-scoped deploy token cannot read pqp-support). Set MONITOR_FLY_LOCAL=1 to use your own `fly auth` session when running by hand.",
});

/**
 * IS THE SUPPORT BOT ACTUALLY RUNNING?
 * ------------------------------------
 * Two signals, because neither is sufficient alone.
 *
 * The MACHINE STATE catches the incident that happened: a clean exit that Fly
 * read as "job finished", leaving the machine `stopped` and staying stopped.
 *
 * The LIFECYCLE TRAIL catches what machine state cannot. `started` means the
 * VM is up, not that the bot inside it is connected — and with
 * `[[restart]] policy = "always"` a bot that halts on every boot (the kill
 * switch, a bad token, a missing channel) presents as a permanently `started`
 * machine in a restart loop. So the last lifecycle line the bot logged has to
 * be a start, not a stop.
 *
 * What it deliberately does NOT do is check log recency. The bot logs when it
 * answers a question and is otherwise silent; #ajuda is quiet most days, so
 * "no output for two hours" is the normal, healthy state and alerting on it
 * would train everyone to ignore this.
 */
export function judgeBot({ machines, records }) {
  const base = { key: "support-bot-alive", title: `Support bot is running (${SUPPORT_APP})` };
  const runbook = [
    `1. \`fly status -a ${SUPPORT_APP}\` and \`fly logs -a ${SUPPORT_APP} --no-tail\`.`,
    `2. Stopped machine: \`fly machine start <id> -a ${SUPPORT_APP}\`. If it stopped itself after exiting 0, confirm \`[[restart]] policy = "always"\` is still in tools/support-bot/fly.toml — that is the bug this check exists for.`,
    "3. `bot.halted reason=kill-switch` means it was switched off on purpose: `fly secrets unset SUPPORT_BOT_KILL_SWITCH` (and check AMBIENT_KILL_SWITCH, which stops this one too).",
    "4. A restart loop with no `bot.ready` between starts is usually the character token or a renamed channel — `bot.ready` logs the server and channels it resolved.",
    "5. Never run two: they answer every mention twice and race on the budget ledger. `fly scale count 1 -a pqp-support`.",
  ].join("\n");

  const live = machines.filter((m) => m.state !== "destroyed");
  const summaryOfMachines = live.map((m) => `${m.id} ${m.state} ${m.region}`).join("; ") || "none";

  const lifecycle = records
    .filter((r) => /\bbot\.(ready|start|done|halted)\b/.test(r.message ?? ""))
    .map((r) => ({
      at: r.timestamp,
      event: /\bbot\.(ready|start|done|halted)\b/.exec(r.message)[1],
      message: r.message,
    }));
  const last = lifecycle.at(-1);

  const detail = [
    `machines  ${summaryOfMachines}`,
    `lifecycle ${lifecycle.length ? lifecycle.map((l) => l.event).join(" -> ") : "no bot.* lines in the buffer"}`,
    last ? `last      ${last.at} ${String(last.message).slice(0, 200)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (live.length === 0) {
    return {
      ...base,
      status: "fail",
      summary: `No machine at all for ${SUPPORT_APP}. The bot is absent from #ajuda and nothing else would say so.`,
      detail,
      runbook,
    };
  }
  if (live.length > 1) {
    return {
      ...base,
      status: "fail",
      summary: `${live.length} machines for ${SUPPORT_APP}; there must be exactly one. Two bots answer every mention twice and race on the budget ledger.`,
      detail,
      runbook,
    };
  }
  if (live[0].state !== "started") {
    return {
      ...base,
      status: "fail",
      summary: `The ${SUPPORT_APP} machine is \`${live[0].state}\`, not \`started\`. This is the exact shape of the 2026-08-23 incident: a clean exit that Fly retired.`,
      detail,
      runbook,
    };
  }

  // Machine is up. Now: is the bot inside it actually working?
  if (!last) {
    // Plausible and benign — the bot has been running long enough that its
    // boot lines have aged out of a ~100-line buffer. Not a pass, though:
    // this check has not seen evidence either way.
    return {
      ...base,
      status: "skip",
      summary: `The machine is started, but the log buffer contains no bot.* lifecycle line, so whether the bot inside it is connected could not be established.`,
      detail,
    };
  }
  if (last.event === "halted") {
    return {
      ...base,
      status: "warn",
      summary: `The bot is halted by its kill switch. Deliberate, probably — but #ajuda has no bot right now and that is the thing worth knowing.`,
      detail,
      runbook,
    };
  }
  if (last.event === "done") {
    return {
      ...base,
      status: "fail",
      summary: `The bot logged \`bot.done\` and has not started since, while its machine still reports \`started\`. It has left #ajuda.`,
      detail,
      runbook,
    };
  }

  // A restart loop: several boots inside a short buffer. Fly restarting
  // forever looks identical to healthy from `fly status`.
  const starts = lifecycle.filter((l) => l.event === "start");
  if (starts.length >= 3) {
    const span =
      (new Date(starts.at(-1).at).getTime() - new Date(starts[0].at).getTime()) / 60_000;
    if (span < 15) {
      return {
        ...base,
        status: "warn",
        summary: `${starts.length} bot starts in ${span.toFixed(1)} minutes — a restart loop. \`policy = "always"\` is bringing it back faster than it can stay up.`,
        detail,
        runbook,
      };
    }
  }

  // THE LIFECYCLE TRAIL CANNOT CLOSE THIS OUT, so the heartbeat runs last.
  //
  // Everything above answers a question about the machine or about boot: is a
  // VM up, was the last lifecycle line a start rather than a stop, is it
  // looping. On 2026-08-23 every one of those said healthy for three and a half
  // hours while the bot sat deaf in a 114-member community: the process was
  // alive, the machine was `started`, and the last line really was `bot.start`.
  // Nothing in a boot line expires, so it goes on proving the bot started long
  // after it stopped working.
  //
  // `judgeHeartbeat` is the only check here that reads a signal which is
  // emitted continuously and says something about the SOCKET. It goes after the
  // others because "no machine" and "three machines" are better diagnoses of
  // the same silence, and it should not mask them.
  const beat = judgeHeartbeat({ records, lifecycle });
  if (beat.status !== "ok") {
    return { ...base, ...beat, detail: `${detail}\n${beat.detail}`, runbook };
  }

  return {
    ...base,
    status: "ok",
    summary: `Machine started in ${live[0].region}, socket up (${beat.summary}).`,
    detail: `${detail}\n${beat.detail}`,
  };
}

/**
 * One reading. Retried by `checkSupportBot` below, for the same reason every
 * probe in `availability.mjs` is: a release restarts this machine, so during
 * the seconds between the old machine stopping and the new one booting, an
 * honest reading of "not started" is indistinguishable from the outage this
 * check exists to catch. A deploy takes ~15s; the retry spacing outlasts it.
 */
async function readSupportBot() {
  const env = flyEnv();
  let machines;
  try {
    const { stdout } = await exec(
      "flyctl",
      ["machines", "list", "--app", SUPPORT_APP, "--json"],
      { env, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
    );
    machines = JSON.parse(stdout);
  } catch (error) {
    // Distinguished from "the bot is down" on purpose. An app-scoped
    // token would be refused here; that is a setup gap, and
    // reporting it as an outage would be a lie that gets muted.
    return {
      key: "support-bot-alive",
      title: `Support bot is running (${SUPPORT_APP})`,
      status: "skip",
      summary: `Skipped: could not list ${SUPPORT_APP} machines. An app-scoped token cannot read this app — set FLY_ORG_TOKEN (\`fly tokens create org --name pqp-monitor\`).`,
      detail: String(error.message).slice(0, 400),
    };
  }
  const logs = await flyLogs(SUPPORT_APP);
  return judgeBot({ machines, records: logs.records ?? [] });
}

async function checkSupportBot() {
  if (!flyEnv()) {
    return NO_TOKEN("support-bot-alive", `Support bot is running (${SUPPORT_APP})`);
  }
  const attempts = Number(process.env.MONITOR_BOT_ATTEMPTS ?? 2);
  const delayMs = Number(process.env.MONITOR_RETRY_DELAY_MS ?? 20_000);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await readSupportBot();
    // `skip` is not retried: a missing or refused token will be missing and
    // refused twenty seconds later too, and burning the delay on it only makes
    // the workflow slower.
    if (last.status === "ok" || last.status === "skip") {
      return last;
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return last;
}

/**
 * Issue keys this group no longer reports (see the header). `run.mjs` closes
 * any that are still open, so #695 does not sit red against a log buffer
 * nobody has written to since the cutover.
 */
export function retiredErrorKeys() {
  return ["api-error-rate"];
}

export async function runErrorChecks() {
  // Sequential, like the availability group, so the monitor's own load is not
  // part of what it measures.
  const checks = [["support-bot-alive", checkSupportBot]];
  const results = [];
  for (const [key, check] of checks) {
    try {
      results.push(await check());
    } catch (error) {
      // A check that throws is a bug in the check, not an outage. `skip` is
      // visible in the run log, opens nothing, and cannot close a live
      // incident.
      results.push({ key, title: key, status: "skip", summary: `Check threw: ${error.message}` });
    }
  }
  return results;
}

/**
 * Printed at the end of every run, like the limits group's list. An honest gap
 * beats a dashboard that implies coverage it does not have.
 */
export const ERRORS_NOT_AUTOMATED = [
  {
    what: "Error rate in the API and worker logs (Vultr box)",
    limit: "Grafana Loki alerts, not this workflow",
    why: "The box has no SSH key or token a GitHub runner can use, and /ready and /status.json carry no error counters. The pqp-api-logs rules (error lines, Connection terminated, no ws.connect) read every line in Loki. GET /api/admin/metrics would carry counters, but its token is not a repo secret (it lives on the pqp-admin Worker). Add ADMIN_METRICS_TOKEN as a repo secret to bring a counter check here.",
    cadence: "Grafana owns it; confirm the rules are routed after any Alloy or Loki change",
  },
  {
    what: "pqp-ambient error rate and liveness",
    limit: "n/a",
    why: "The same two checks would fit the ambient runner unchanged, and it is deliberately not wired up yet: it is a house-cast toy, its silence costs nothing, and one more alert key on day one is one more thing to learn to ignore. Add it here when it starts mattering.",
    cadence: "revisit if the cast becomes load-bearing",
  },
  {
    what: "Errors the server never logs",
    limit: "n/a",
    why: "Support-bot liveness reads the bot's own stdout. A route that returns 500 without a `console.error`, or a client-side failure, is invisible to log-based checks anywhere, Loki included. Faro (frontend) covers the browser half.",
    cadence: "n/a",
  },
];
