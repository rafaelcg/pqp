/**
 * The log reader, pinned.
 *
 * Two things here are worth testing and one of them is worth testing hard.
 *
 * The parser is worth testing because `flyctl logs --json` emits a format that
 * looks like JSON Lines and is not, and the obvious fix (split on `\n{`) breaks
 * on log messages that themselves contain JSON — which the support bot emits on
 * every boot.
 *
 * The classifier is the one with teeth. Every ignore rule is a hole punched in
 * the check by hand, and the asymmetry is brutal: a false positive is one noisy
 * issue, a false negative is an outage nobody hears about. So each rule is
 * tested twice — that it swallows the noise it was written for, and that it
 * does NOT swallow something adjacent that matters. The `deploy-health-check`
 * rule gets a third test, because it is conditional and the condition is the
 * entire reason it is safe.
 *
 * Every sample line below is either copied from a real 2026-08-23 buffer or
 * written from the operator's description of what he skips past by hand; the
 * latter are marked, because a test built on a guessed log format proves the
 * regex matches the guess and nothing more.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  IGNORE_RULES,
  classify,
  isDeployWindow,
  judge,
  judgeBot,
  measure,
  parseFlyJson,
} from "./errors.mjs";

/** A log record in the shape `flyctl logs --json` produces. */
const rec = (message, { at = "2026-08-23T19:43:07.590366357Z", level = "info" } = {}) => ({
  level,
  instance: "e827949ad1e6e8",
  message,
  region: "gru",
  timestamp: at,
});

/** N ordinary lines, spread evenly over `minutes`, starting at a fixed epoch. */
const noise = (n, minutes = 28) =>
  Array.from({ length: n }, (_, i) =>
    rec(`[pqp] ws.connect connId=${i}`, {
      at: new Date(Date.UTC(2026, 7, 23, 19, 0, 0) + (i * minutes * 60_000) / Math.max(n - 1, 1))
        .toISOString(),
    }),
  );

describe("parseFlyJson — the format flyctl actually emits", () => {
  test("reads concatenated pretty-printed objects, which is what --json gives", () => {
    // Verbatim shape from `flyctl logs -a pqp-api --no-tail --json`: no commas,
    // no array, no newline delimiter contract. `JSON.parse` on the whole string
    // throws, and that is the trap this function exists for.
    const raw = `{
    "level": "info",
    "message": "[pqp] ws.connect connId=126",
    "timestamp": "2026-08-23T19:43:07.590366357Z"
}
{
    "level": "info",
    "message": "[pqp] ws.auth connId=126",
    "timestamp": "2026-08-23T19:43:07.600267150Z"
}`;
    const records = parseFlyJson(raw);
    assert.equal(records.length, 2);
    assert.equal(records[1].message, "[pqp] ws.auth connId=126");
  });

  test("survives a message that itself contains braces and quotes", () => {
    // The support bot logs its budget as embedded JSON on every single boot:
    //   bot.start model=... budget={"date":"2026-08-23","calls":0}
    // A `\n{` split, or any brace counter that does not respect strings, tears
    // this record in half and loses the boot marker the liveness check reads.
    const raw = `{
    "message": "[2026-08-23T17:33:32.947Z] bot.start budget={\\"date\\":\\"2026-08-23\\",\\"calls\\":0}",
    "timestamp": "2026-08-23T17:33:32.950918924Z"
}`;
    const records = parseFlyJson(raw);
    assert.equal(records.length, 1);
    assert.match(records[0].message, /bot\.start/);
    assert.match(records[0].message, /"calls":0/);
  });

  test("parses JSON Lines too, so a flyctl format change does not blind the check", () => {
    const raw = '{"message":"a","timestamp":"2026-08-23T19:00:00Z"}\n{"message":"b","timestamp":"2026-08-23T19:00:01Z"}';
    assert.equal(parseFlyJson(raw).length, 2);
  });

  test("drops a malformed object instead of throwing away the whole buffer", () => {
    // flyctl writes its own diagnostics into this stream. One bad object must
    // not cost the other ninety-nine, because losing the buffer means losing
    // the check for that run.
    const raw = 'not json at all\n{"message":"good","timestamp":"2026-08-23T19:00:00Z"}\n{"broken":';
    const records = parseFlyJson(raw);
    assert.equal(records.length, 1);
    assert.equal(records[0].message, "good");
  });

  test("empty input is an empty list, not a crash", () => {
    assert.deepEqual(parseFlyJson(""), []);
  });
});

describe("classify — what counts as an error", () => {
  test("ordinary traffic is not an error", () => {
    // Observed: these three shapes are ~95% of the pqp-api buffer.
    assert.equal(classify(rec("[pqp] ws.connect connId=126")).kind, "normal");
    assert.equal(classify(rec("[pqp] ws.auth connId=126 userId=c274b08c")).kind, "normal");
    assert.equal(
      classify(rec("[pqp] voice.join peerId=3da userId=f8df9f2 voiceChannel=x")).kind,
      "normal",
    );
  });

  test("the server's own console.error shapes are errors", () => {
    // Taken from real call sites in server/src, not invented.
    for (const line of [
      "[http] request failed: TypeError: Cannot read properties of undefined",
      "[db] idle client error: Connection terminated unexpectedly",
      "[ws] server error: RangeError",
      "[status] sample failed: timeout",
      "[attachments] sweep failed: AccessDenied",
    ]) {
      assert.equal(classify(rec(line)).kind, "error", line);
    }
  });

  test("Fly's own level is honoured when it says something is wrong", () => {
    // The level is nearly always `info` — verified across 279 records from
    // three apps — so it cannot be the only signal. It is still trusted when
    // it does speak, because that is Fly's infrastructure and not our stdout.
    assert.equal(classify(rec("something the proxy said", { level: "error" })).kind, "error");
  });

  test("process-level faults are fatal, and bypass every ignore rule", () => {
    // CLAUDE.md pitfall #9: one of these crashed the whole server and dropped
    // every connected client. A rate threshold would let a single one through.
    const fatal = classify(rec("[process] unhandled rejection: Error: boom"));
    assert.equal(fatal.kind, "error");
    assert.equal(fatal.fatal, true);
    assert.equal(classify(rec("[process] uncaught exception: Error: boom")).fatal, true);
    assert.equal(classify(rec("FATAL: the wheels came off")).fatal, true);
  });
});

describe("the ignore list — each rule swallows its noise and nothing adjacent", () => {
  test("pg-deprecation: the boot-time warning, not a database failure", () => {
    assert.equal(
      // Shape per the operator's description of the boot noise, not observed
      // by the author in a live buffer.
      classify(rec("(node:1) [DEP0170] DeprecationWarning: pg is deprecating something")).rule,
      "pg-deprecation",
    );
    // The adjacent thing that must NOT be swallowed.
    assert.equal(classify(rec("[db] idle client error: Connection terminated")).kind, "error");
  });

  test("proxy-invalid-authority: the edge refusing junk before it reaches us", () => {
    assert.equal(
      classify(rec("Error: invalid authority in request", { level: "error" })).rule,
      "proxy-invalid-authority",
    );
    // Any other proxy-level error is still an error.
    assert.equal(classify(rec("could not proxy request", { level: "error" })).kind, "error");
  });

  test("naw-blocked: counting Fly's edge protection as a fault is backwards", () => {
    // Reported by the operator; the exact prefix is the load-bearing part.
    assert.equal(
      classify(rec('request blocked by NAW: "/wp-admin/setup-config.php"')).rule,
      "naw-blocked",
    );
    // If the probe were NOT blocked and our app 500ed on it, that is ours.
    assert.equal(classify(rec("[http] request failed: /wp-admin")).kind, "error");
  });

  test("ws-auth-failure and token-rejected: a 401 is the auth layer working", () => {
    // Both observed on 2026-08-23 in the live pqp-api buffer.
    assert.equal(classify(rec("[pqp] ws.authFail connId=42")).rule, "ws-auth-failure");
    assert.equal(
      classify(
        rec("[auth] token rejected: Invalid JWT form. A JWT consists of three parts"),
      ).rule,
      "token-rejected",
    );
    // A successful auth is not noise and not an error either.
    assert.equal(classify(rec("[pqp] ws.auth connId=42 userId=x")).kind, "normal");
  });

  test("deploy-health-check is ignored DURING a deploy", () => {
    const line = rec("Health check on port 3001 has failed. Your app may not be responding");
    assert.equal(classify(line, { deployWindow: true }).rule, "deploy-health-check");
  });

  test("...and is a real error when nothing is deploying", () => {
    // This is the whole reason the rule is conditional. A health check failing
    // while no release is in flight is exactly the thing worth waking up for,
    // and an unconditional version of this rule would hide it forever.
    const line = rec("Health check on port 3001 has failed. Your app may not be responding");
    assert.equal(classify(line, { deployWindow: false }).kind, "error");
  });

  test("no ignore rule may swallow a process-level fault", () => {
    // A guard against a future rule written too broadly. The failure mode of a
    // bad ignore rule must be a noisy alert, never a silent crash.
    const fault = rec("[process] uncaught exception: DeprecationWarning invalid authority NAW:");
    assert.equal(classify(fault).fatal, true);
  });

  test("every rule carries an id and a stated reason", () => {
    // The reason is what makes the list auditable. A regex with no `why` is a
    // hole in the monitor that nobody can evaluate later.
    const ids = IGNORE_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "ignore rule ids must be unique");
    for (const rule of IGNORE_RULES) {
      assert.ok(rule.pattern instanceof RegExp, `${rule.id}: pattern is not a RegExp`);
      assert.ok(rule.why && rule.why.length > 40, `${rule.id}: why is missing or too thin`);
    }
  });
});

describe("isDeployWindow", () => {
  test("recognises a release from the runner lines Fly emits", () => {
    // Verbatim from the pqp-support buffer during its 2026-08-23 redeploy.
    assert.equal(
      isDeployWindow([rec("Pulling container image registry.fly.io/pqp-api@sha256:abc")]),
      true,
    );
    assert.equal(isDeployWindow([rec("Machine created and started in 15.341s")]), true);
  });

  test("ordinary traffic is not a deploy", () => {
    assert.equal(isDeployWindow(noise(20)), false);
  });
});

describe("measure — the window comes from the data, never from the clock", () => {
  test("derives the window from the first and last timestamps", () => {
    // The trap this whole check is built around: `fly logs --no-tail` returns
    // ~100 lines, so the period is set by traffic. Measured the same minute on
    // 2026-08-23: pqp-api covered 28 minutes, pqp-support covered 7 hours.
    const m = measure(noise(100, 28));
    assert.equal(m.total, 100);
    assert.equal(Math.round(m.windowSeconds), 28 * 60);
  });

  test("the same line count over a different span yields a different window", () => {
    const dense = measure(noise(100, 1.5));
    const sparse = measure(noise(100, 420));
    assert.equal(dense.total, sparse.total);
    assert.ok(sparse.windowSeconds > dense.windowSeconds * 100);
  });

  test("counts errors and per-rule ignores separately", () => {
    const records = [
      ...noise(90),
      rec("[http] request failed: boom"),
      rec("[pqp] ws.authFail connId=1"),
      rec('blocked by NAW: "/.env"'),
    ];
    const m = measure(records);
    assert.equal(m.errors, 1);
    assert.equal(m.ignored["naw-blocked"], 1);
    assert.equal(m.ignored["ws-auth-failure"], 1);
  });

  test("an empty buffer measures nothing rather than dividing by zero", () => {
    const m = measure([]);
    assert.equal(m.total, 0);
    assert.equal(m.windowSeconds, 0);
  });
});

describe("the auth-failure budget — a stale client is noise, a flood is Clerk", () => {
  test("the known stale client stays ignored, at the rate actually measured", () => {
    // Pinned to the real 2026-08-23 reading, because the first estimate was
    // wrong in the dangerous direction. One stale client retries every ~25
    // minutes, but each attempt logs TWICE — once from the HTTP path and once
    // from the socket — so a 28-minute window holds four lines, not two. A
    // budget sized for two would have alerted on a healthy Sunday.
    const m = measure([
      ...noise(96, 28),
      rec("[auth] token rejected: Invalid JWT form.", { at: "2026-08-23T19:51:18Z" }),
      rec("[pqp] ws.authFail connId=1", { at: "2026-08-23T19:51:18Z" }),
      rec("[auth] token rejected: Invalid JWT form.", { at: "2026-08-23T20:17:59Z" }),
      rec("[pqp] ws.authFail connId=2", { at: "2026-08-23T20:17:59Z" }),
    ]);
    assert.equal(m.authFailures.seen, 4);
    assert.equal(m.authFailures.overBudget, 0);
    assert.equal(m.errors, 0);
  });

  test("every client failing auth at once is counted, and it fails", () => {
    // The case a blanket ignore would lose: Clerk down, or a bad JWKS rollover.
    // Identical log line, catastrophically different meaning, and only the rate
    // separates them.
    const flood = Array.from({ length: 60 }, (_, i) =>
      rec(`[pqp] ws.authFail connId=${i}`, {
        at: new Date(Date.UTC(2026, 7, 23, 19, 0, 0) + i * 20_000).toISOString(),
      }),
    );
    const m = measure([...noise(40, 20), ...flood]);
    assert.ok(m.authFailures.overBudget > 40, `expected a large excess, got ${m.authFailures.overBudget}`);
    assert.equal(judge(m).status, "fail");
  });
});

describe("judge — thresholds, and what a green is allowed to be made of", () => {
  test("a clean buffer over a real window passes", () => {
    const r = judge(measure(noise(100, 28)));
    assert.equal(r.status, "ok");
    // The window is in the summary because it is the number most likely to be
    // misread as "the last 15 minutes".
    assert.match(r.summary, /28\.0min/);
  });

  test("5% warns, 15% fails", () => {
    const withErrors = (n) => [
      ...noise(100 - n, 28),
      ...Array.from({ length: n }, (_, i) =>
        rec(`[http] request failed: ${i}`, {
          at: new Date(Date.UTC(2026, 7, 23, 19, 10, 0) + i * 1000).toISOString(),
        }),
      ),
    ];
    assert.equal(judge(measure(withErrors(6))).status, "warn");
    assert.equal(judge(measure(withErrors(20))).status, "fail");
  });

  test("two stray errors in a hundred lines do not fire", () => {
    // 2% is above no threshold worth having, and the absolute floor is what
    // stops a quiet night with one blip from paging. An alert that cries wolf
    // is a false negative with extra steps.
    const r = judge(
      measure([...noise(98, 28), rec("[http] request failed: a"), rec("[db] idle client error: b")]),
    );
    assert.equal(r.status, "ok");
  });

  test("ONE unhandled rejection fails, whatever the rate says", () => {
    // 1 line in 100 is 1%, far below every threshold. It is also the bug that
    // took the whole server down and dropped every client.
    const r = judge(measure([...noise(99, 28), rec("[process] unhandled rejection: Error: x")]));
    assert.equal(r.status, "fail");
    assert.match(r.summary, /process-level/);
  });

  test("a window too short to mean anything is a SKIP, not a pass", () => {
    // 100 lines in 30 seconds means the buffer is a snapshot of one busy
    // moment. Calling that green would be inventing evidence — and because
    // `skip` touches no issue state, it also cannot close a live incident.
    const r = judge(measure(noise(100, 0.5)));
    assert.equal(r.status, "skip");
    assert.match(r.summary, /not enough to certify/);
  });

  test("too few records is a SKIP for the same reason", () => {
    const r = judge(measure(noise(10, 28)));
    assert.equal(r.status, "skip");
    assert.match(r.summary, /10 log records/);
  });

  test("but a short window FULL of errors still alerts", () => {
    // Refusing to certify health is not the same as refusing to report a fire.
    // If the skip guard swallowed this, the check would go quiet exactly when
    // the API is melting, which is when traffic is densest.
    const burst = [
      ...noise(50, 0.4),
      ...Array.from({ length: 50 }, (_, i) =>
        rec(`[http] request failed: ${i}`, {
          at: new Date(Date.UTC(2026, 7, 23, 19, 0, 10) + i * 200).toISOString(),
        }),
      ),
    ];
    const r = judge(measure(burst));
    assert.equal(r.status, "fail");
  });

  test("an unreadable buffer is a skip that says so", () => {
    const r = judge(measure([]));
    assert.equal(r.status, "skip");
    assert.match(r.summary, /no parseable records/);
  });

  test("the detail always states the window and the per-rule ignore counts", () => {
    // These two numbers are how a wrong ignore rule gets noticed. If they were
    // only printed on failure, a rule that had started swallowing everything
    // would be invisible for exactly as long as it was doing damage.
    const r = judge(
      measure([...noise(99, 28), rec('blocked by NAW: "/.env"', { at: "2026-08-23T19:10:00Z" })]),
    );
    assert.match(r.detail, /window\s+28\.0min/);
    assert.match(r.detail, /ignored\s+naw-blocked=1/);
  });
});

describe("judgeBot — is the support bot actually there", () => {
  const started = [{ id: "683d472f209678", state: "started", region: "gru" }];
  const boot = [
    rec("[2026-08-23T17:33:32.766Z] bot.ready userId=e5ee3d1d username=manual_bot", {
      at: "2026-08-23T17:33:32.943975502Z",
    }),
    rec('[2026-08-23T17:33:32.947Z] bot.start model=claude-haiku-4-5 budget={"calls":0}', {
      at: "2026-08-23T17:33:32.950918924Z",
    }),
  ];

  test("started machine with a start as its last lifecycle line is healthy", () => {
    const r = judgeBot({ machines: started, records: boot });
    assert.equal(r.status, "ok");
  });

  test("a stopped machine fails — this is the incident that happened", () => {
    // 2026-08-23: the SIGTERM handler exited 0 on purpose, Fly read a clean
    // exit as "the job finished" and retired the machine. The bot was absent
    // from #ajuda for hours and nothing said so.
    const r = judgeBot({ machines: [{ id: "x", state: "stopped", region: "gru" }], records: boot });
    assert.equal(r.status, "fail");
    assert.match(r.summary, /`stopped`/);
  });

  test("no machine at all fails", () => {
    assert.equal(judgeBot({ machines: [], records: [] }).status, "fail");
    // A destroyed machine is not a machine.
    assert.equal(
      judgeBot({ machines: [{ id: "x", state: "destroyed", region: "gru" }], records: [] }).status,
      "fail",
    );
  });

  test("two machines fail — they would answer every mention twice", () => {
    const r = judgeBot({
      machines: [
        { id: "a", state: "started", region: "gru" },
        { id: "b", state: "started", region: "gru" },
      ],
      records: boot,
    });
    assert.equal(r.status, "fail");
    assert.match(r.summary, /twice/);
  });

  test("bot.done with the machine still started fails", () => {
    // `fly status` says started; the process inside has left. Machine state
    // alone would call this healthy, which is why the lifecycle trail exists.
    const r = judgeBot({
      machines: started,
      records: [...boot, rec('[..] bot.done budget={"calls":0}', { at: "2026-08-23T17:40:00Z" })],
    });
    assert.equal(r.status, "fail");
    assert.match(r.summary, /left #ajuda/);
  });

  test("the kill switch warns rather than failing", () => {
    // Deliberately off is a real state to be in, and paging about a decision
    // someone just made is how alerts get muted. But #ajuda has no bot, and
    // that is worth one line in a run log.
    const r = judgeBot({
      machines: started,
      records: [...boot, rec("[..] bot.halted reason=kill-switch", { at: "2026-08-23T17:40:00Z" })],
    });
    assert.equal(r.status, "warn");
  });

  test("a restart loop warns, even though the machine reports started", () => {
    // `policy = "always"` bringing it back faster than it can stay up looks
    // identical to healthy from `fly status`.
    const loops = Array.from({ length: 4 }, (_, i) =>
      rec(`[..] bot.start attempt=${i}`, {
        at: new Date(Date.UTC(2026, 7, 23, 17, 0, 0) + i * 120_000).toISOString(),
      }),
    );
    const r = judgeBot({ machines: started, records: loops });
    assert.equal(r.status, "warn");
    assert.match(r.summary, /restart loop/);
  });

  test("a long-running bot whose boot lines aged out is a skip, not a pass", () => {
    // The buffer is ~100 lines. A bot that has been up for a week and answered
    // a hundred questions has no `bot.start` left in it. That is not evidence
    // of health, and it is not evidence of failure either.
    const r = judgeBot({ machines: started, records: noise(20) });
    assert.equal(r.status, "skip");
  });

  test("silence is NOT treated as death", () => {
    // #ajuda is quiet most days and the bot only logs when it answers. An
    // alert on "no output for two hours" would fire nightly and be muted
    // within a week.
    const old = boot.map((r) => ({ ...r, timestamp: "2026-08-20T03:00:00Z" }));
    assert.equal(judgeBot({ machines: started, records: old }).status, "ok");
  });
});
