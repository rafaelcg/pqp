/**
 * "Is it throwing?" — the checks that read the actual production logs.
 *
 * WHY THIS GROUP EXISTS
 * ---------------------
 * Everything in `availability.mjs` is availability-shaped: /health answers,
 * the WebSocket upgrades, the app's own component probes are green. All of
 * that can be true while the API throws on every third request. `/health` does
 * a `SELECT 1` and returns 200; it does not know that `POST /api/messages` has
 * been 500ing for an hour. Nothing was reading the logs, so nothing would have
 * said so.
 *
 * The second check here has its own scar: `pqp-support`, the QG help bot, went
 * down three minutes after its first deploy. It exited 0 (the SIGTERM handler
 * does that on purpose), Fly's default restart policy read a clean exit as
 * "the job finished" and retired the machine, and the bot was simply absent
 * from #ajuda with nothing anywhere saying so. `[[restart]] policy = "always"`
 * fixed the cause; this check is what would have reported it.
 *
 * THE TRAP THAT SHAPES THE WHOLE FIRST CHECK
 * ------------------------------------------
 * `fly logs --no-tail` returns roughly the LAST 100 LINES. The period it
 * covers is therefore bounded by VOLUME, NOT TIME. Measured on 2026-08-23:
 *
 *     pqp-api      100 records spanning 28 minutes
 *     pqp-support   79 records spanning  7 hours
 *
 * Same command, same minute, two windows an order of magnitude apart. A check
 * written as "errors in the last 15 minutes" would silently mean "the last two
 * hours" at 03:00 and "the last ninety seconds" at peak, and its threshold
 * would mean something different every time it ran.
 *
 * So: this measures a RATE, and derives the window from the first and last
 * timestamps actually present in the output rather than assuming one. And
 * because a green reading taken from a twenty-second window is not evidence of
 * anything, a too-short window is a `skip` with the reason — never a pass.
 * (A too-short window that is *full of errors* still alerts. Refusing to
 * certify health is not the same as refusing to report a fire.)
 *
 * Each check returns { key, title, status, summary, detail?, runbook? } where
 * status is ok | fail | warn | skip, exactly as the other two groups do. `key`
 * is permanent: it is the identity of the alert issue, so renaming one orphans
 * an open incident.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const API_APP = process.env.MONITOR_FLY_APP ?? "pqp-api";
const SUPPORT_APP = process.env.MONITOR_SUPPORT_APP ?? "pqp-support";

/**
 * Thresholds.
 *
 * The fraction is the primary signal because it is the one that survives the
 * volume-bounded window: "5% of log lines are errors" means the same thing at
 * 03:00 and at peak, where "5 errors" does not.
 *
 * MIN_ERRORS is the anti-cry-wolf floor. In a 100-line buffer a single stray
 * line is 1%, and two are 2%; without an absolute floor a quiet night with one
 * blip would page. Three distinct error lines is the smallest count that is
 * not obviously noise.
 */
const WARN_FRACTION = Number(process.env.MONITOR_ERROR_WARN_FRACTION ?? 0.05);
const FAIL_FRACTION = Number(process.env.MONITOR_ERROR_FAIL_FRACTION ?? 0.15);
const MIN_ERRORS = Number(process.env.MONITOR_ERROR_MIN_COUNT ?? 3);

/**
 * Sample floors, both of which produce `skip` rather than a pass.
 *
 * MIN_RECORDS: fewer than this and the denominator is too small for a
 * percentage to mean anything.
 *
 * MIN_WINDOW_SECONDS: 100 lines inside two minutes means the app is busy
 * enough that the buffer is a snapshot, not a sample — a single burst, a
 * single deploy's boot noise, or one loud client can fill it end to end. At
 * pqp's current volume the window is ~28 minutes, so this floor should
 * essentially never fire; it exists so that the day it does, the check says
 * "I could not tell" instead of inventing a green.
 */
const MIN_RECORDS = Number(process.env.MONITOR_ERROR_MIN_RECORDS ?? 25);
const MIN_WINDOW_SECONDS = Number(process.env.MONITOR_ERROR_MIN_WINDOW_SECONDS ?? 120);

/**
 * WHAT COUNTS AS AN ERROR LINE
 * ----------------------------
 * Not `record.level`. Fly's log shipper labels everything coming out of a
 * machine's stdout AND stderr as `info` — verified on 2026-08-23 across three
 * apps and 279 records, every one of them `info`, including lines the server
 * emitted with `console.error`. So the level is consulted (it is right when
 * Fly's own infrastructure speaks) but it cannot be the only signal.
 *
 * The server has 79 `console.error` call sites and they share a shape: a
 * `[scope]` prefix and a verb. Rather than enumerate all 79 — a list that goes
 * stale the moment someone adds the eightieth — this matches the vocabulary.
 * Over-matching is the safe direction here, because everything that gets past
 * this is then put through the explicitly-listed IGNORE rules below, and every
 * ignore decision is counted and printed.
 */
const ERROR_SHAPES = [
  /\[error\]/i, // Fly's own bracketed level, as it appears in the text stream
  /\berrors?\b/i, // "[db] idle client error", "[ws] server error"
  /\bfail(ed|ure|ing)?\b/i, // "[http] request failed", "[status] sample failed"
  /\bexception\b/i,
  /\bunhandled\b|\buncaught\b/i,
  /\bE(CONNREFUSED|CONNRESET|TIMEDOUT|HOSTUNREACH|PIPE|NOTFOUND)\b/,
  /\btimed out\b/i,
];

/**
 * Lines where one occurrence is already the incident.
 *
 * CLAUDE.md pitfall #9 is exactly this: a thrown error in a WebSocket handler
 * became an unhandled rejection, which crashed the process, which restarted
 * the machine, which dropped every connected client. It was diagnosed only
 * after users complained. A rate threshold would let a single one of these
 * through — 1 line in 100 is 1% — so they bypass the rate entirely.
 */
const FATAL_SHAPES = [
  /\[process\]\s+unhandled rejection/i,
  /\[process\]\s+uncaught exception/i,
  /\bFATAL\b/,
  /\bJavaScript heap out of memory\b/i,
  /\bout of memory\b/i,
];

/**
 * THE IGNORE LIST — the noise a human already filters, written down.
 *
 * Every entry is a rule with an id and a reason, not a regex buried in a
 * condition, because an ignore rule is the one part of a monitor that can
 * silently destroy its value. The run output prints how many lines each rule
 * swallowed, so a rule that has started matching everything (or nothing) is
 * visible in the log rather than discovered after a missed incident.
 *
 * PROVENANCE, honestly: only `ws-auth-failure` and `token-rejected` were
 * observed by the author in a live buffer (2026-08-23). The other four are
 * transcribed from the operator's description of what he already skips past
 * when reading these logs by hand. They are written to be narrow, and the
 * per-rule counts in the run output are how they get confirmed or corrected —
 * a rule sitting at 0 for weeks is either fixed upstream or written wrong, and
 * either way it should be deleted rather than left as decoration.
 */
export const IGNORE_RULES = [
  {
    id: "pg-deprecation",
    pattern: /DeprecationWarning/,
    why: "The `pg` driver emits a Node DeprecationWarning once at boot. It is a library's migration notice, not a request failing, and it is emitted exactly once per machine start.",
  },
  {
    id: "proxy-invalid-authority",
    pattern: /invalid authority/i,
    why: "fly-proxy rejecting a request whose Host header is not a hostname this app serves. That is the edge refusing junk before it reaches us — the app never saw it, so it is not the app erroring.",
  },
  {
    id: "naw-blocked",
    pattern: /blocked by NAW:/,
    why: "Fly's edge BLOCKING an exploit probe (`/wp-admin`, `/.env`, and friends). This line is protection working. Counting it as an error means the check gets louder the better we are being defended, which is backwards.",
  },
  {
    id: "token-rejected",
    pattern: /\[auth\] token rejected:/,
    why: "A client presented a malformed or expired JWT and got a 401. That is the auth layer doing its job. A FLOOD of these would mean Clerk is down, which is why they are budgeted rather than blanket-ignored — see AUTH_FAILURE_RULES.",
  },
  {
    id: "ws-auth-failure",
    pattern: /ws\.authFail\b/,
    why: "The WebSocket half of the same 401. One stale automated client has been re-presenting a dead token roughly every 25 minutes; budgeted, not blanket-ignored.",
  },
  {
    id: "deploy-health-check",
    pattern: /(health check|healthcheck).*(fail|unhealthy|critical)|instance refused connection/i,
    // NOTE: conditional. See `isDeployWindow` — outside a deploy this rule does
    // not apply, because a health check failing when nothing is being released
    // is precisely the thing worth waking up for.
    conditional: "deploy",
    why: "fly.toml uses a rolling deploy on a single machine, so every legitimate release produces health-check errors for the seconds between the old machine stopping and the new one listening. Ignored ONLY when the same buffer also contains deploy markers.",
  },
];

/**
 * The two ignore rules that are budgeted rather than absolute.
 *
 * A stale client re-presenting a dead token every ~25 minutes is noise. Every
 * client in the world failing auth at once is Clerk being down, and it produces
 * the same log line. Blanket-ignoring the line loses the second case to save
 * the first, so instead: tolerate the known background rate, count the excess.
 *
 * The budget is per hour and scaled to the measured window, so it means the
 * same thing whether the buffer covered four minutes or four hours — the same
 * discipline the rate itself is built on.
 */
const AUTH_FAILURE_RULES = new Set(["token-rejected", "ws-auth-failure"]);
const AUTH_FAILURE_BUDGET_PER_HOUR = Number(
  // MEASURED, not guessed, and the first guess was wrong. The stale client
  // retries about every 25 minutes, which sounds like 2.4 lines an hour — but
  // each attempt logs TWICE, once as `[auth] token rejected` from the HTTP
  // path and once as `ws.authFail` from the socket. The live buffer on
  // 2026-08-23 held 4 lines in 31.8 minutes: 7.5/h, not 2.4/h. A budget of 8
  // would have left one line of headroom and turned one person with an expired
  // browser tab into a false alarm.
  //
  // 20/h is ~2.7x the observed background. A genuine auth outage is every
  // connecting client failing at once — dozens to hundreds per hour — so the
  // separation is still an order of magnitude.
  process.env.MONITOR_AUTHFAIL_BUDGET_PER_HOUR ?? 20,
);

/** Lines that only appear because a release is in progress. */
const DEPLOY_MARKERS = [
  /Pulling container image/i,
  /Successfully prepared image/i,
  /Machine (created and )?started in /i,
  /Preparing to run:/i,
  /Starting init \(commit:/i,
  /Sending signal SIGTERM to main child process/i,
];

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

/** True when the buffer contains evidence of a release in progress. */
export function isDeployWindow(records) {
  return records.some((r) => DEPLOY_MARKERS.some((m) => m.test(r.message ?? "")));
}

/**
 * Sort one record into `normal`, `ignored` (with the rule id) or `error`
 * (with `fatal` set when it bypasses the rate).
 *
 * Order matters and is deliberate: FATAL wins over every ignore rule. Nothing
 * on the ignore list should ever match an uncaught exception, but if a future
 * entry is written too broadly, the failure mode must be a noisy alert and not
 * a swallowed crash.
 */
export function classify(record, { deployWindow = false } = {}) {
  const message = record.message ?? "";
  const level = String(record.level ?? "").toLowerCase();

  if (FATAL_SHAPES.some((p) => p.test(message))) {
    return { kind: "error", fatal: true };
  }

  for (const rule of IGNORE_RULES) {
    if (!rule.pattern.test(message)) {
      continue;
    }
    if (rule.conditional === "deploy" && !deployWindow) {
      // A health check failing while nothing is deploying is a real fault.
      break;
    }
    return { kind: "ignored", rule: rule.id };
  }

  const looksWrong =
    level === "error" || level === "warn" || ERROR_SHAPES.some((p) => p.test(message));
  return looksWrong ? { kind: "error", fatal: false } : { kind: "normal" };
}

/**
 * The whole measurement, as a pure function of the parsed records.
 *
 * Kept separate from the flyctl call so it can be tested against captured
 * buffers — including the shapes that are rare in production and therefore
 * impossible to wait for: a crash loop, an auth flood, a deploy in flight.
 */
export function measure(records) {
  const usable = records.filter((r) => r.timestamp && typeof r.message === "string");
  if (usable.length === 0) {
    return { total: 0, errors: 0, ignored: {}, windowSeconds: 0, samples: [], fatals: [] };
  }

  const times = usable.map((r) => new Date(r.timestamp).getTime()).filter((t) => !Number.isNaN(t));
  const windowSeconds = times.length ? (Math.max(...times) - Math.min(...times)) / 1000 : 0;
  const deployWindow = isDeployWindow(usable);

  const ignored = {};
  const errorLines = [];
  const fatals = [];
  let budgetedHits = 0;

  for (const record of usable) {
    const verdict = classify(record, { deployWindow });
    if (verdict.kind === "ignored") {
      ignored[verdict.rule] = (ignored[verdict.rule] ?? 0) + 1;
      if (AUTH_FAILURE_RULES.has(verdict.rule)) {
        budgetedHits += 1;
      }
      continue;
    }
    if (verdict.kind === "error") {
      errorLines.push(record);
      if (verdict.fatal) {
        fatals.push(record);
      }
    }
  }

  // The budgeted rules: everything above the expected background rate is put
  // back and counted as an error, because an auth flood and a stale client
  // produce identical lines and only the rate tells them apart.
  const hours = Math.max(windowSeconds / 3600, 1 / 60);
  const allowance = Math.ceil(AUTH_FAILURE_BUDGET_PER_HOUR * hours);
  const overBudget = Math.max(0, budgetedHits - allowance);

  return {
    total: usable.length,
    errors: errorLines.length + overBudget,
    errorLines,
    ignored,
    authFailures: { seen: budgetedHits, allowance, overBudget },
    windowSeconds,
    deployWindow,
    fatals,
    firstAt: new Date(Math.min(...times)).toISOString(),
    lastAt: new Date(Math.max(...times)).toISOString(),
  };
}

function humanWindow(seconds) {
  if (seconds < 90) {
    return `${seconds.toFixed(0)}s`;
  }
  if (seconds < 5400) {
    return `${(seconds / 60).toFixed(1)}min`;
  }
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** Turn a measurement into a check result. Pure, so the thresholds are testable. */
export function judge(m, { app = API_APP } = {}) {
  const base = { key: "api-error-rate", title: `API error rate in the ${app} logs` };

  if (m.total === 0) {
    return {
      ...base,
      status: "skip",
      summary: `Skipped: \`fly logs -a ${app} --no-tail\` returned no parseable records.`,
      detail:
        "Either the token cannot read this app, or the app emitted nothing at all. The second is itself odd for a live API, but it is not something this check can distinguish from the first, so it does not guess.",
    };
  }

  const pct = (m.errors / m.total) * 100;
  const perMinute = m.windowSeconds > 0 ? m.errors / (m.windowSeconds / 60) : 0;
  const ignoredSummary =
    Object.entries(m.ignored)
      .map(([id, n]) => `${id}=${n}`)
      .join(" ") || "none";

  // `run.mjs` prints `detail` only for a non-ok result, so the numbers that
  // keep this check honest are repeated into the ok summary below. They have
  // to be visible on a PASS: an ignore rule that has quietly started swallowing
  // everything produces a permanent green, and the only tell is its count
  // climbing in a run log nobody has reason to open.
  const detail = [
    `window   ${humanWindow(m.windowSeconds)} (${m.firstAt} -> ${m.lastAt})`,
    `records  ${m.total} lines (fly returns ~the last 100, so the window is set by traffic, not by clock)`,
    `errors   ${m.errors} (${pct.toFixed(1)}% of lines, ${perMinute.toFixed(2)}/min)`,
    `ignored  ${ignoredSummary}`,
    `authfail seen ${m.authFailures.seen}, allowance ${m.authFailures.allowance}, counted ${m.authFailures.overBudget}`,
    `deploy   ${m.deployWindow ? "yes — release markers in this buffer, health-check noise is being ignored" : "no"}`,
    "",
    ...m.errorLines.slice(0, 12).map((r) => `  ${r.timestamp} ${String(r.message).slice(0, 220)}`),
  ].join("\n");

  const runbook = [
    `1. Read them yourself: \`fly logs -a ${app} --no-tail | grep -iE 'error|failed|exception'\`.`,
    "2. `[process] unhandled rejection` or `uncaught exception` is CLAUDE.md pitfall #9 — it crashes the process, restarts the machine and drops every connected client. Find the throw and wrap it.",
    "3. A burst that starts at a known time and stops on its own is usually a dependency: check `/status.json` and `fly mpg status <cluster>`.",
    "4. If the errors are all one route, the deploy that introduced them is in `GET /health` -> `version`.",
    `5. Noise, not a fault? Add a rule to IGNORE_RULES in scripts/monitor/errors.mjs with a reason, and a test. Do not widen a pattern without one — the per-rule counts printed above are what keeps the list honest.`,
  ].join("\n");

  if (m.fatals.length > 0) {
    return {
      ...base,
      status: "fail",
      summary: `${m.fatals.length} process-level fault(s) in the last ${humanWindow(m.windowSeconds)}: ${String(m.fatals[0].message).slice(0, 160)}`,
      detail,
      runbook,
    };
  }

  const tooFewRecords = m.total < MIN_RECORDS;
  const tooShortWindow = m.windowSeconds < MIN_WINDOW_SECONDS;
  const failing = m.errors >= MIN_ERRORS && m.errors / m.total >= FAIL_FRACTION;
  const warning = m.errors >= MIN_ERRORS && m.errors / m.total >= WARN_FRACTION;

  // A fire is reported from any window. Health is only certified from a window
  // big enough to mean something — which is the entire reason this check
  // measures the window instead of assuming it.
  if (!failing && !warning && (tooFewRecords || tooShortWindow)) {
    const why = tooFewRecords
      ? `only ${m.total} log records (need ${MIN_RECORDS})`
      : `only ${humanWindow(m.windowSeconds)} (need ${MIN_WINDOW_SECONDS}s)`;
    return {
      ...base,
      status: "skip",
      summary: `Skipped: the ~100-line buffer covered ${why}, which is not enough to certify a rate. ${m.errors} error line(s) seen, below the alert threshold.`,
      detail,
    };
  }

  if (failing) {
    return {
      ...base,
      status: "fail",
      summary: `${pct.toFixed(1)}% of log lines are errors (${m.errors} of ${m.total}) over ${humanWindow(m.windowSeconds)} — threshold ${(FAIL_FRACTION * 100).toFixed(0)}%.`,
      detail,
      runbook,
    };
  }
  if (warning) {
    return {
      ...base,
      status: "warn",
      summary: `${pct.toFixed(1)}% of log lines are errors (${m.errors} of ${m.total}) over ${humanWindow(m.windowSeconds)} — threshold ${(WARN_FRACTION * 100).toFixed(0)}%.`,
      detail,
      runbook,
    };
  }
  return {
    ...base,
    status: "ok",
    summary:
      `${m.errors} error line(s) in ${m.total} over ${humanWindow(m.windowSeconds)} ` +
      `(${pct.toFixed(1)}%, threshold ${(WARN_FRACTION * 100).toFixed(0)}%); ignored ${ignoredSummary}.`,
    detail,
  };
}

/**
 * Which token to hand flyctl.
 *
 * FLY_API_TOKEN in this repo is a DEPLOY token scoped to `pqp-api`, so it can
 * read that app's logs and nothing else — in particular not `pqp-support`. The
 * org-scoped FLY_ORG_TOKEN (created for the Postgres check) can read both, so
 * it is preferred when present. Neither being set is a `skip`, not a failure:
 * a missing credential must never look like health.
 */
function flyEnv() {
  const token = process.env.FLY_ORG_TOKEN || process.env.FLY_API_TOKEN;
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

async function checkApiErrorRate() {
  const logs = await flyLogs(API_APP);
  if (logs.skipped) {
    return NO_TOKEN("api-error-rate", `API error rate in the ${API_APP} logs`);
  }
  return judge(measure(logs.records), { app: API_APP });
}

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

  return {
    ...base,
    status: "ok",
    summary: `Machine started in ${live[0].region}, last lifecycle line is \`bot.${last.event}\` at ${last.at}.`,
    detail,
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
    // Distinguished from "the bot is down" on purpose. The deploy token is
    // scoped to pqp-api and will be refused here; that is a setup gap, and
    // reporting it as an outage would be a lie that gets muted.
    return {
      key: "support-bot-alive",
      title: `Support bot is running (${SUPPORT_APP})`,
      status: "skip",
      summary: `Skipped: could not list ${SUPPORT_APP} machines. The app-scoped deploy token cannot read this app — set FLY_ORG_TOKEN (\`fly tokens create org --name pqp-monitor\`).`,
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

export async function runErrorChecks() {
  // Sequential, like the availability group: two flyctl invocations against
  // the same API, and the monitor's own load should not be part of what it
  // measures.
  const checks = [
    ["api-error-rate", checkApiErrorRate],
    ["support-bot-alive", checkSupportBot],
  ];
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
    what: "Anything older than ~100 log lines",
    limit: "`fly logs --no-tail` buffer",
    why: "Fly's free log retention is the buffer and nothing else. An error burst that ended before this ran is gone, so a spike between two runs can be missed entirely. A real fix is log shipping to somewhere with retention, which is a paid product and a separate decision.",
    cadence: "accept it, or pay for retention",
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
    why: "This reads stdout. A route that returns 500 without a `console.error`, or a client-side failure, is invisible to it. It measures what the server says about itself, which is not the same as what users experience.",
    cadence: "n/a",
  },
];
