/**
 * The log reader, pinned.
 *
 * The parser is worth testing because `flyctl logs --json` emits a format that
 * looks like JSON Lines and is not, and the obvious fix (split on `\n{`) breaks
 * on log messages that themselves contain JSON — which the support bot emits on
 * every boot. `judgeBot` is the support-bot check itself.
 *
 * (The API error-rate classifier and its tests were removed with the Fly
 * rollback on 2026-10-22; see the header of errors.mjs.)
 *
 * Every sample line below is either copied from a real 2026-08-23 buffer or
 * written from the operator's description of what he skips past by hand; the
 * latter are marked, because a test built on a guessed log format proves the
 * regex matches the guess and nothing more.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { judgeBot, parseFlyJson } from "./errors.mjs";

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

  // `boot` is the 2026-08-23 incident verbatim: ready, start, and nothing after
  // it. Every machine-and-lifecycle check calls that healthy, which is exactly
  // why the bot sat deaf for three and a half hours. It is a FAILING fixture
  // now, deliberately, and `beating` is what healthy actually looks like.
  const beating = [
    ...boot,
    rec("[2026-08-23T17:38:32.950Z] bot.heartbeat connected=1 expected=1 reconnects=0 closes=0 downForS=0 uptimeS=300", {
      at: new Date(Date.now() - 60_000).toISOString(),
    }),
  ];

  test("a started machine whose bot is still holding its socket is healthy", () => {
    const r = judgeBot({ machines: started, records: beating });
    assert.equal(r.status, "ok");
  });

  test("ready + start with no heartbeat is the 2026-08-23 incident, and fails", () => {
    // The regression this whole check exists for. If this ever goes green
    // again, the monitor has gone back to proving the bot booted once.
    const r = judgeBot({ machines: started, records: boot });
    assert.notEqual(r.status, "ok");
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
    // Silence in ANSWERS, not silence in heartbeats: the heartbeat is what
    // separates "nobody asked anything tonight" from "the socket is gone".
    const quiet = beating.map((r) =>
      r.message.includes("bot.heartbeat")
        ? r
        : { ...r, timestamp: "2026-08-20T03:00:00Z" },
    );
    assert.equal(judgeBot({ machines: started, records: quiet }).status, "ok");
  });
});
