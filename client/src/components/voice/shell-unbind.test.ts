import { describe, expect, it } from "vitest";
import { createShellUnbindTracker } from "./shell-unbind";

/** Flush the microtasks a rejected promise's `.catch` runs in. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const timers: Array<() => void> = [];
  const gaveUp: unknown[] = [];
  const tracker = createShellUnbindTracker({
    setTimer: (fn) => {
      timers.push(fn);
    },
    onGiveUp: (err) => gaveUp.push(err),
    delaysMs: [10, 20],
  });
  const runTimers = async () => {
    while (timers.length) {
      timers.shift()!();
      await settle();
    }
  };
  return { tracker, gaveUp, runTimers };
}

describe("shell unbind", () => {
  it("does nothing more when the shell accepts", async () => {
    const { tracker, gaveUp, runTimers } = harness();
    let calls = 0;
    tracker.unbind(() => {
      calls += 1;
      return Promise.resolve();
    });
    await settle();
    await runTimers();
    expect(calls).toBe(1);
    expect(gaveUp).toEqual([]);
  });

  it("retries a refused unbind until it goes through", async () => {
    const { tracker, gaveUp, runTimers } = harness();
    let calls = 0;
    tracker.unbind(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error("ipc")) : Promise.resolve();
    });
    await settle();
    await runTimers();
    expect(calls).toBe(3);
    expect(gaveUp).toEqual([]);
  });

  it("reports, rather than swallows, a shell that never lets go", async () => {
    const { tracker, gaveUp, runTimers } = harness();
    let calls = 0;
    tracker.unbind(() => {
      calls += 1;
      return Promise.reject(new Error("stuck"));
    });
    await settle();
    await runTimers();
    expect(calls).toBe(3); // first try + two retries
    expect(gaveUp).toHaveLength(1);
  });

  it("a retry never undoes a newer bind", async () => {
    const { tracker, gaveUp, runTimers } = harness();
    let unbinds = 0;
    tracker.unbind(() => {
      unbinds += 1;
      return Promise.reject(new Error("ipc"));
    });
    await settle();
    // The setting is switched back on before the retry fires.
    tracker.nextRequest();
    await runTimers();
    expect(unbinds).toBe(1);
    expect(gaveUp).toEqual([]);
  });

  it("a send that throws synchronously is retried like a rejection", async () => {
    const { tracker, runTimers } = harness();
    let calls = 0;
    tracker.unbind(() => {
      calls += 1;
      if (calls === 1) {
        throw new Error("sync");
      }
      return Promise.resolve();
    });
    await settle();
    await runTimers();
    expect(calls).toBe(2);
  });
});
