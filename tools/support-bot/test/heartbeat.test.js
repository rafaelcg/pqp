/**
 * The heartbeat, which is only worth anything if it is honest about being down.
 *
 * The failure this guards against is not "the line is missing"; it is "the line
 * is present and says healthy while the bot is deaf", which is the exact
 * situation that produced it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HEARTBEAT_EVENT,
  heartbeatFields,
  startHeartbeat,
} from "../src/heartbeat.js";

const NOW = 1_700_000_000_000;

function fake(state) {
  return {
    state: () => ({
      channel: "#ajuda",
      open: true,
      reconnects: 0,
      closes: 0,
      downSince: 0,
      lastFrameAt: 0,
      lastReadyAt: 0,
      ...state,
    }),
  };
}

test("a healthy socket reports connected == expected", () => {
  const fields = heartbeatFields([fake({ lastFrameAt: NOW - 30_000 })], {
    now: NOW,
    startedAt: NOW - 600_000,
  });
  assert.equal(fields.connected, 1);
  assert.equal(fields.expected, 1);
  assert.equal(fields.downForS, 0);
  assert.equal(fields.idleForS, 30);
  assert.equal(fields.uptimeS, 600);
});

test("a down socket reports it, with the length of the current outage", () => {
  const fields = heartbeatFields([fake({ open: false, downSince: NOW - 90_000, closes: 1 })], {
    now: NOW,
  });
  assert.equal(fields.connected, 0);
  assert.equal(fields.expected, 1);
  assert.equal(fields.downForS, 90);
  assert.equal(fields.closes, 1);
});

test("a partial outage across channels is visible", () => {
  const fields = heartbeatFields(
    [fake({}), fake({ open: false, downSince: NOW - 5_000, reconnects: 2 })],
    { now: NOW },
  );
  assert.equal(fields.connected, 1);
  assert.equal(fields.expected, 2);
  assert.equal(fields.reconnects, 2);
});

test("an iterator is refused rather than silently reported as empty", () => {
  const map = new Map([["c1", fake({})]]);
  assert.throws(() => heartbeatFields(map.values(), { now: NOW }), /array/);
});

test("the first beat is immediate, and it repeats", async () => {
  const lines = [];
  const stop = startHeartbeat({
    sockets: [fake({})],
    log: (event, fields) => lines.push({ event, ...fields }),
    intervalMs: 10,
  });
  // Immediately, not one interval later: a machine that just booted must have
  // published its connected state before any monitor looks at it.
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, HEARTBEAT_EVENT);
  await new Promise((r) => setTimeout(r, 45));
  stop();
  const after = lines.length;
  assert.ok(after >= 3, `expected repeated beats, got ${after}`);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lines.length, after, "stop() actually stops it");
});
