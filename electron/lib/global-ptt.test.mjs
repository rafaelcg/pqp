import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const {
  createHoldTracker,
  isAcceptableAccelerator,
  FIRST_REPEAT_GRACE_MS,
  REPEAT_GAP_MS,
} = require("./global-ptt.js");

/**
 * A hand-driven clock: `globalShortcut` gives us key-down pulses and nothing
 * else, so the release is a timer, and the timer is what these pin.
 */
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

function tracker() {
  const clock = fakeClock();
  const changes = [];
  const held = createHoldTracker((next) => changes.push(next), {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, changes, held };
}

describe("createHoldTracker", () => {
  it("engages on the first press and lets go after the initial-repeat grace on a tap", () => {
    const { clock, changes, held } = tracker();
    held.press();
    assert.deepEqual(changes, [true]);
    clock.advance(FIRST_REPEAT_GRACE_MS - 1);
    assert.equal(held.held, true);
    clock.advance(1);
    assert.equal(held.held, false);
    assert.deepEqual(changes, [true, false]);
  });

  it("stays held while repeats keep arriving, then releases one repeat gap after they stop", () => {
    const { clock, changes, held } = tracker();
    held.press();
    clock.advance(500);
    // Auto-repeat begins: 40 ms apart, well inside the gap.
    for (let i = 0; i < 50; i += 1) {
      clock.advance(40);
      held.press();
    }
    assert.equal(held.held, true);
    assert.equal(held.sawRepeat, true);
    assert.deepEqual(changes, [true]);
    clock.advance(REPEAT_GAP_MS - 1);
    assert.equal(held.held, true);
    clock.advance(1);
    assert.equal(held.held, false);
    assert.deepEqual(changes, [true, false]);
  });

  it("a press after a release is a fresh engage with the long grace again", () => {
    const { clock, changes, held } = tracker();
    held.press();
    clock.advance(FIRST_REPEAT_GRACE_MS);
    held.press();
    assert.deepEqual(changes, [true, false, true]);
    clock.advance(REPEAT_GAP_MS + 1);
    // Not released yet: the second press is a new tap, not a repeat of the
    // first, so it gets the initial-delay allowance.
    assert.equal(held.held, true);
  });

  it("release is idempotent and cancels the pending timer", () => {
    const { clock, changes, held } = tracker();
    held.release();
    assert.deepEqual(changes, []);
    held.press();
    held.release();
    held.release();
    clock.advance(FIRST_REPEAT_GRACE_MS * 2);
    assert.deepEqual(changes, [true, false]);
  });
});

describe("isAcceptableAccelerator", () => {
  it("accepts what the client produces", () => {
    for (const value of [
      "`",
      "T",
      "Control+Shift+V",
      "Alt+F13",
      "Super+num0",
      "Space",
      "Capslock",
      "numadd",
      "Control+Alt+Shift+Super+9",
    ]) {
      assert.equal(isAcceptableAccelerator(value), true, value);
    }
  });

  it("refuses modifiers alone, wrong casing, media keys and anything odd", () => {
    for (const value of [
      "",
      "Control",
      "Control+",
      "CommandOrControl+M",
      "t",
      "MediaPlayPause",
      "VolumeUp",
      "Control+Shift+Alt",
      "F25",
      "Escape",
      "Tab",
      "Return",
      42,
      null,
    ]) {
      assert.equal(isAcceptableAccelerator(value), false, String(value));
    }
  });
});
