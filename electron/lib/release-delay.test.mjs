import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  createReleaseDelayTracker,
  clampReleaseDelayMs,
  DEFAULT_RELEASE_DELAY_MS,
  MIN_RELEASE_DELAY_MS,
  MAX_RELEASE_DELAY_MS,
} = require("./release-delay.js");

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let soonest = null;
        for (const [id, entry] of pending) {
          if (entry.at <= target && (soonest === null || entry.at < soonest.at)) {
            soonest = { id, ...entry };
          }
        }
        if (!soonest) {
          break;
        }
        pending.delete(soonest.id);
        now = soonest.at;
        soonest.fn();
      }
      now = target;
    },
  };
}

function tracker(options = {}) {
  const clock = fakeClock();
  const changes = [];
  const held = createReleaseDelayTracker((next) => changes.push(next), {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options,
  });
  return { clock, changes, held };
}

describe("createReleaseDelayTracker", () => {
  it("engages immediately on press", () => {
    const { changes, held } = tracker();
    held.press();
    assert.deepEqual(changes, [true]);
    assert.equal(held.held, true);
  });

  it("holds the mic open for the configured delay after release", () => {
    const { clock, changes, held } = tracker({ delayMs: 20 });
    held.press();
    held.release();
    assert.equal(held.held, true, "still held, the delay has not elapsed");
    clock.advance(19);
    assert.equal(held.held, true);
    clock.advance(1);
    assert.equal(held.held, false);
    assert.deepEqual(changes, [true, false]);
  });

  it("a press inside the delay window cancels the pending release", () => {
    const { clock, changes, held } = tracker({ delayMs: 500 });
    held.press();
    held.release();
    clock.advance(200);
    held.press(); // Word continues; the release must not land.
    clock.advance(500);
    assert.equal(held.held, true);
    assert.deepEqual(changes, [true]);
  });

  it("delay of 0 releases synchronously, no clipped word gets extra time", () => {
    const { changes, held } = tracker({ delayMs: 0 });
    held.press();
    held.release();
    assert.equal(held.held, false);
    assert.deepEqual(changes, [true, false]);
  });

  it("release with nothing held is a no-op", () => {
    const { changes, held } = tracker();
    held.release();
    assert.deepEqual(changes, []);
    assert.equal(held.held, false);
  });

  it("release is idempotent while a release is already pending", () => {
    const { clock, changes, held } = tracker({ delayMs: 50 });
    held.press();
    held.release();
    held.release();
    held.release();
    clock.advance(50);
    assert.deepEqual(changes, [true, false]);
  });

  it("setDelayMs changes future releases but not one already timing", () => {
    const { clock, changes, held } = tracker({ delayMs: 1000 });
    held.press();
    held.release();
    held.setDelayMs(10); // Does not shorten the release already in flight.
    clock.advance(10);
    assert.equal(held.held, true);
    clock.advance(990);
    assert.equal(held.held, false);
    assert.deepEqual(changes, [true, false]);

    held.press();
    held.release();
    clock.advance(10);
    assert.equal(held.held, false, "the new delay applies to the next release");
  });

  it("forceRelease drops a pending timer and closes immediately", () => {
    const { clock, changes, held } = tracker({ delayMs: 1000 });
    held.press();
    held.release();
    held.forceRelease();
    assert.equal(held.held, false);
    assert.deepEqual(changes, [true, false]);
    clock.advance(1000);
    // No extra change: the pending timer was really cancelled, not just
    // superseded.
    assert.deepEqual(changes, [true, false]);
  });

  it("dispose is an alias for forceRelease", () => {
    const { held, changes } = tracker({ delayMs: 1000 });
    held.press();
    held.dispose();
    assert.equal(held.held, false);
    assert.deepEqual(changes, [true, false]);
  });
});

describe("clampReleaseDelayMs", () => {
  it("keeps values inside range", () => {
    assert.equal(clampReleaseDelayMs(250), 250);
  });

  it("clamps below the minimum and above the maximum", () => {
    assert.equal(clampReleaseDelayMs(-50), MIN_RELEASE_DELAY_MS);
    assert.equal(clampReleaseDelayMs(5000), MAX_RELEASE_DELAY_MS);
  });

  it("rounds fractional input", () => {
    assert.equal(clampReleaseDelayMs(19.6), 20);
  });

  it("falls back to the default for garbage input", () => {
    for (const value of [NaN, Infinity, -Infinity, "20", null, undefined, {}]) {
      assert.equal(clampReleaseDelayMs(value), DEFAULT_RELEASE_DELAY_MS, String(value));
    }
  });
});
