import { describe, expect, it } from "vitest";
import { createServerOrderSaver } from "./server-order-saver";

function setup(initial = ["a", "b", "c"]) {
  const sent: string[][] = [];
  const settle: Array<{ resolve: (v: string[]) => void; reject: () => void }> = [];
  const confirmed: Array<{ stored: string[]; latest: boolean }> = [];
  const failed: string[][] = [];
  let resyncs = 0;
  const saver = createServerOrderSaver({
    save: (ids) => {
      sent.push(ids);
      return new Promise<string[]>((resolve, reject) => settle.push({ resolve, reject: () => reject(new Error("no")) }));
    },
    current: () => initial,
    onConfirmed: (stored, latest) => confirmed.push({ stored, latest }),
    onFailed: (to) => failed.push(to),
    onResync: () => {
      resyncs += 1;
    },
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { saver, sent, settle, confirmed, failed, resyncs: () => resyncs, tick };
}

describe("createServerOrderSaver", () => {
  it("sends one request at a time and only the newest wanted order after it", async () => {
    const t = setup();
    t.saver.request(["b", "a", "c"]);
    t.saver.request(["b", "c", "a"]);
    t.saver.request(["c", "b", "a"]);
    expect(t.sent).toEqual([["b", "a", "c"]]);
    t.settle[0]!.resolve(["b", "a", "c"]);
    await t.tick();
    // The two moves made while the first was in the air are ONE request, the newest.
    expect(t.sent).toEqual([["b", "a", "c"], ["c", "b", "a"]]);
    expect(t.confirmed[0]).toEqual({ stored: ["b", "a", "c"], latest: false });
    t.settle[1]!.resolve(["c", "b", "a"]);
    await t.tick();
    expect(t.confirmed[1]).toEqual({ stored: ["c", "b", "a"], latest: true });
  });

  it("a failure goes back to the last confirmed order, not an intermediate one", async () => {
    const t = setup(["a", "b", "c"]);
    t.saver.request(["b", "a", "c"]);
    t.saver.request(["c", "b", "a"]);
    t.settle[0]!.reject();
    await t.tick();
    // Nothing was ever confirmed: back to where the burst started, and the
    // queued order is dropped rather than sent behind a refusal.
    expect(t.failed).toEqual([["a", "b", "c"]]);
    expect(t.sent).toHaveLength(1);
  });

  it("after a success, a later failure goes back to what the server confirmed", async () => {
    const t = setup(["a", "b", "c"]);
    t.saver.request(["b", "a", "c"]);
    t.saver.request(["c", "b", "a"]);
    t.settle[0]!.resolve(["b", "a", "c"]);
    await t.tick();
    t.settle[1]!.reject();
    await t.tick();
    expect(t.failed).toEqual([["b", "a", "c"]]);
  });

  it("holds a frame from another tab while saving and asks to re-read afterwards", async () => {
    const t = setup();
    expect(t.saver.noteRemote()).toBe(false);
    t.saver.request(["b", "a", "c"]);
    expect(t.saver.noteRemote()).toBe(true);
    expect(t.resyncs()).toBe(0);
    t.settle[0]!.resolve(["b", "a", "c"]);
    await t.tick();
    expect(t.resyncs()).toBe(1);
    // Idle again: frames apply straight away.
    expect(t.saver.noteRemote()).toBe(false);
  });

  it("starts a fresh burst from the current order once idle", async () => {
    const t = setup(["a", "b", "c"]);
    t.saver.request(["b", "a", "c"]);
    t.settle[0]!.resolve(["b", "a", "c"]);
    await t.tick();
    t.saver.request(["c", "b", "a"]);
    t.settle[1]!.reject();
    await t.tick();
    expect(t.failed).toEqual([["a", "b", "c"]]);
  });
});
