import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShutterGesture } from "./shutter-gesture";

function setup(state: { canRecord?: boolean; recording?: boolean; disabled?: boolean } = {}) {
  const calls: string[] = [];
  const gesture = createShutterGesture({
    onPhoto: () => calls.push("photo"),
    onRecordStart: () => calls.push("start"),
    onRecordStop: () => calls.push("stop"),
  });
  gesture.setState({ canRecord: true, recording: false, disabled: false, ...state });
  return { gesture, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("shutter gesture", () => {
  it("a quick press is a photo, taken on release", () => {
    const { gesture, calls } = setup();
    gesture.press();
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(100);
    gesture.release();
    expect(calls).toEqual(["photo"]);
  });

  it("a held press starts recording at the threshold and stops on release", () => {
    const { gesture, calls } = setup();
    gesture.press();
    vi.advanceTimersByTime(400);
    expect(calls).toEqual(["start"]);
    gesture.release();
    expect(calls).toEqual(["start", "stop"]);
  });

  it("takes no photo after a hold", () => {
    const { gesture, calls } = setup();
    gesture.press();
    vi.advanceTimersByTime(2000);
    gesture.release();
    expect(calls).not.toContain("photo");
  });

  it("reports one gesture once, however many sources say it", () => {
    const { gesture, calls } = setup();
    gesture.press();
    gesture.press();
    gesture.release();
    gesture.release();
    expect(calls).toEqual(["photo"]);
  });

  it("ignores everything while disabled", () => {
    const { gesture, calls } = setup({ disabled: true });
    gesture.press();
    vi.advanceTimersByTime(1000);
    gesture.release();
    expect(calls).toEqual([]);
  });

  it("with recording unavailable, every press is a photo on release, however long", () => {
    const { gesture, calls } = setup({ canRecord: false });
    gesture.press();
    vi.advanceTimersByTime(2000);
    gesture.release();
    expect(calls).toEqual(["photo"]);
  });

  it("while a clip started by the record button runs, the next press only ends it", () => {
    const { gesture, calls } = setup({ recording: true });
    gesture.press();
    expect(calls).toEqual(["stop"]);
    gesture.release();
    expect(calls).toEqual(["stop"]);
  });

  it("dispose drops a pending hold so nothing starts after unmount", () => {
    const { gesture, calls } = setup();
    gesture.press();
    gesture.dispose();
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);
  });
});
