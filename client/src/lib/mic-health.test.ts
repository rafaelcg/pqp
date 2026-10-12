import { describe, expect, it, vi } from "vitest";
import {
  createMicRecoveryBudget,
  watchMicHealth,
  type WatchableMicContext,
  type WatchableMicTrack,
} from "./mic-health";

function target() {
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, fn: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  };
  const off = (type: string, fn: () => void) => listeners.get(type)?.delete(fn);
  const fire = (type: string) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn();
  };
  const track: WatchableMicTrack & { readyState: string } = {
    readyState: "live",
    addEventListener: on,
    removeEventListener: off,
  };
  let resumeResult: "run" | "reject" | "hang" = "run";
  const context: WatchableMicContext = {
    state: "running",
    addEventListener: on,
    removeEventListener: off,
    resume: () => {
      if (resumeResult === "run") {
        context.state = "running";
        return Promise.resolve();
      }
      if (resumeResult === "reject") return Promise.reject(new Error("refused"));
      return new Promise<void>(() => {});
    },
  };
  return {
    track,
    context,
    fire,
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    setResume: (next: typeof resumeResult) => {
      resumeResult = next;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("watchMicHealth", () => {
  it("reports a capture that ended on its own, once", () => {
    const t = target();
    const onFault = vi.fn();
    watchMicHealth({ tracks: [t.track], context: t.context }, onFault);
    t.fire("ended");
    t.fire("ended");
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault).toHaveBeenCalledWith("capture-ended");
    // And it stopped listening.
    expect(t.listenerCount()).toBe(0);
  });

  it("reports a capture that was already dead when the watch began", async () => {
    const t = target();
    t.track.readyState = "ended";
    const onFault = vi.fn();
    watchMicHealth({ tracks: [t.track], context: t.context }, onFault);
    await flush();
    expect(onFault).toHaveBeenCalledWith("capture-ended");
  });

  it("resumes a suspended context and says nothing when it runs again", async () => {
    const t = target();
    const onFault = vi.fn();
    watchMicHealth({ tracks: [t.track], context: t.context }, onFault);
    t.context.state = "suspended";
    t.fire("statechange");
    await flush();
    expect(t.context.state).toBe("running");
    expect(onFault).not.toHaveBeenCalled();
  });

  it("reports a context whose resume is refused", async () => {
    const t = target();
    t.setResume("reject");
    const onFault = vi.fn();
    watchMicHealth({ tracks: [t.track], context: t.context }, onFault);
    t.context.state = "suspended";
    t.fire("statechange");
    await flush();
    expect(onFault).toHaveBeenCalledWith("context-stalled");
  });

  it("reports a context whose resume never settles, after the timeout", () => {
    const t = target();
    t.setResume("hang");
    const onFault = vi.fn();
    let timer: (() => void) | null = null;
    watchMicHealth({ tracks: [t.track], context: t.context }, onFault, {
      setTimer: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    t.context.state = "suspended";
    t.fire("statechange");
    expect(onFault).not.toHaveBeenCalled();
    timer!();
    expect(onFault).toHaveBeenCalledWith("context-stalled");
  });

  it("ignores our own teardown and an engine interruption", async () => {
    const t = target();
    const onFault = vi.fn();
    watchMicHealth({ tracks: [t.track], context: t.context }, onFault);
    t.context.state = "interrupted";
    t.fire("statechange");
    t.context.state = "closed";
    t.fire("statechange");
    await flush();
    expect(onFault).not.toHaveBeenCalled();
  });

  it("does nothing after dispose", () => {
    const t = target();
    const onFault = vi.fn();
    const dispose = watchMicHealth({ tracks: [t.track], context: t.context }, onFault);
    dispose();
    dispose();
    t.fire("ended");
    expect(onFault).not.toHaveBeenCalled();
    expect(t.listenerCount()).toBe(0);
  });

  it("tolerates tracks and contexts that cannot be listened to", () => {
    expect(() =>
      watchMicHealth({ tracks: [{}], context: { state: "running" } }, vi.fn())(),
    ).not.toThrow();
  });
});

describe("createMicRecoveryBudget", () => {
  it("allows a few reopens per window, then refuses until the window moves on", () => {
    const budget = createMicRecoveryBudget(3, 1_000);
    expect(budget.take(0)).toBe(true);
    expect(budget.take(10)).toBe(true);
    expect(budget.take(20)).toBe(true);
    expect(budget.take(30)).toBe(false);
    expect(budget.take(1_001)).toBe(true);
  });
});
