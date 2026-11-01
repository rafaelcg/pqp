import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DISABLED, IDLE, nextUpdateState } = require("./update-state.js");

const run = (events, from = IDLE) => events.reduce(nextUpdateState, from);

test("a check that finds nothing says up to date", () => {
  assert.deepEqual(run([{ type: "check" }, { type: "not-available", at: 5 }]), {
    status: "up-to-date",
    checkedAt: 5,
  });
});

test("the two clicks: available, downloading with progress, downloaded", () => {
  const available = run([{ type: "check" }, { type: "available", version: "0.9.0" }]);
  assert.deepEqual(available, { status: "available", version: "0.9.0" });
  const downloading = run([{ type: "download" }, { type: "progress", percent: 41.6 }], available);
  assert.deepEqual(downloading, { status: "downloading", version: "0.9.0", percent: 42 });
  assert.deepEqual(run([{ type: "downloaded", version: "0.9.0" }], downloading), {
    status: "downloaded",
    version: "0.9.0",
  });
});

test("a later background check never takes a downloaded update away", () => {
  const downloaded = { status: "downloaded", version: "0.9.0" };
  for (const event of [
    { type: "check" },
    { type: "not-available", at: 1 },
    { type: "available", version: "0.9.0" },
    { type: "error" },
  ]) {
    assert.equal(nextUpdateState(downloaded, event), downloaded, event.type);
  }
});

test("a newer release replaces a downloaded one as available", () => {
  const downloaded = { status: "downloaded", version: "0.9.0" };
  assert.deepEqual(nextUpdateState(downloaded, { type: "available", version: "0.9.1" }), {
    status: "available",
    version: "0.9.1",
  });
});

test("a failed download keeps the version, so the retry downloads it", () => {
  const failed = run([{ type: "error" }], { status: "downloading", version: "0.9.0", percent: 10 });
  assert.deepEqual(failed, { status: "error", context: "download", version: "0.9.0" });
  assert.deepEqual(nextUpdateState(failed, { type: "download" }), {
    status: "downloading",
    version: "0.9.0",
    percent: 0,
  });
});

test("a failed check is an error with no version, and download does nothing", () => {
  const failed = run([{ type: "check" }, { type: "error" }]);
  assert.deepEqual(failed, { status: "error", context: "check", version: null });
  assert.equal(nextUpdateState(failed, { type: "download" }), failed);
});

test("a disabled updater stays disabled", () => {
  assert.equal(run([{ type: "check" }, { type: "available", version: "1" }], DISABLED), DISABLED);
});

test("progress is clamped and ignored outside a download", () => {
  const downloading = { status: "downloading", version: "1", percent: 0 };
  assert.equal(nextUpdateState(downloading, { type: "progress", percent: 140 }).percent, 100);
  assert.equal(nextUpdateState(downloading, { type: "progress", percent: Number.NaN }).percent, 0);
  assert.equal(nextUpdateState(IDLE, { type: "progress", percent: 50 }), IDLE);
});
