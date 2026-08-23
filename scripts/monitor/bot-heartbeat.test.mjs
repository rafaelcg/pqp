/**
 * The check, judged against the outage it exists for.
 *
 * The first test is the real 2026-08-23 buffer, trimmed: the exact lines
 * `fly logs -a pqp-support --no-tail` returned while the bot sat deaf in a
 * 114-member community, with the machine reporting `started`. Anything that
 * passes that buffer is not a liveness check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { judgeHeartbeat, parseHeartbeats } from "./bot-heartbeat.mjs";

const rec = (timestamp, message) => ({ timestamp, message });

const beat = (timestamp, fields = "connected=1 expected=1 reconnects=0 closes=0 downForS=0") =>
  rec(timestamp, `[${timestamp}] bot.heartbeat ${fields}`);

/** The lifecycle array `judgeBot` builds, in its shape. */
const life = (at, event) => ({ at, event, message: `[${at}] bot.${event} ...` });

test("the 2026-08-23 buffer: started, ready, and deaf for hours", () => {
  const records = [
    rec("2026-08-23T17:33:32Z", "[2026-08-23T17:33:32.766Z] bot.ready userId=e5ee3d1d username=manual_bot server=QG do pqp channels=[\"#ajuda\"]"),
    rec("2026-08-23T17:33:32Z", "[2026-08-23T17:33:32.947Z] bot.start model=claude-haiku-4-5"),
  ];
  const lifecycle = [life("2026-08-23T17:33:32Z", "ready"), life("2026-08-23T17:33:32Z", "start")];

  const verdict = judgeHeartbeat({
    records,
    lifecycle,
    now: Date.parse("2026-08-23T21:07:00Z"),
  });

  assert.equal(verdict.status, "fail");
  assert.match(verdict.summary, /has not emitted a single/);
});

test("a fresh boot is not yet an outage", () => {
  const lifecycle = [life("2026-08-23T21:00:00Z", "start")];
  const verdict = judgeHeartbeat({
    records: [],
    lifecycle,
    now: Date.parse("2026-08-23T21:02:00Z"),
  });
  assert.equal(verdict.status, "skip");
});

test("a recent heartbeat with every socket up is the only thing that passes", () => {
  const verdict = judgeHeartbeat({
    records: [beat("2026-08-23T21:05:00Z")],
    now: Date.parse("2026-08-23T21:07:00Z"),
  });
  assert.equal(verdict.status, "ok");
  assert.match(verdict.summary, /Connected: 1\/1/);
});

test("a stale heartbeat fails even though the machine is started", () => {
  const verdict = judgeHeartbeat({
    records: [beat("2026-08-23T20:00:00Z")],
    now: Date.parse("2026-08-23T21:07:00Z"),
  });
  assert.equal(verdict.status, "fail");
  assert.match(verdict.summary, /stopped reporting a connection/);
});

test("running but not connected is the failure the machine state cannot see", () => {
  const verdict = judgeHeartbeat({
    records: [
      beat("2026-08-23T21:00:00Z"),
      beat("2026-08-23T21:05:00Z", "connected=0 expected=1 reconnects=0 closes=1 downForS=240"),
    ],
    now: Date.parse("2026-08-23T21:07:00Z"),
  });
  assert.equal(verdict.status, "fail");
  assert.match(verdict.summary, /0\/1/);
  assert.match(verdict.summary, /OFFLINE/);
});

test("a flapping socket that is up right now warns rather than failing", () => {
  const records = [];
  for (let i = 0; i < 8; i += 1) {
    const at = new Date(Date.parse("2026-08-23T20:00:00Z") + i * 300_000).toISOString();
    records.push(beat(at, `connected=1 expected=1 reconnects=${i} closes=${i} downForS=0`));
  }
  const verdict = judgeHeartbeat({
    records,
    now: Date.parse(records.at(-1).timestamp) + 60_000,
  });
  assert.equal(verdict.status, "warn");
  assert.match(verdict.summary, /dropped 7 times/);
});

test("an unreadable heartbeat is a skip, never a pass", () => {
  const verdict = judgeHeartbeat({
    records: [rec("2026-08-23T21:05:00Z", "[2026-08-23T21:05:00Z] bot.heartbeat")],
    now: Date.parse("2026-08-23T21:07:00Z"),
  });
  assert.equal(verdict.status, "skip");
});

test("an empty buffer establishes nothing and says so", () => {
  const verdict = judgeHeartbeat({ records: [], lifecycle: [], now: Date.now() });
  assert.equal(verdict.status, "skip");
});

test("heartbeats are parsed in time order regardless of buffer order", () => {
  const beats = parseHeartbeats([
    beat("2026-08-23T21:05:00Z", "connected=1 expected=1 closes=2"),
    beat("2026-08-23T21:00:00Z", "connected=1 expected=1 closes=1"),
  ]);
  assert.deepEqual(
    beats.map((b) => b.closes),
    [1, 2],
  );
});
