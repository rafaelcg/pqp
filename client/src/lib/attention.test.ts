import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTENTION_BACKGROUND_GRACE_MS,
  createAttentionTracker,
} from "@/lib/attention";

describe("createAttentionTracker", () => {
  let foreground: boolean;
  let sent: boolean[];

  const make = () =>
    createAttentionTracker({
      send: (value) => sent.push(value),
      isForeground: () => foreground,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    foreground = true;
    sent = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the current state when the socket connects, and not before", () => {
    const tracker = make();
    expect(sent).toEqual([]);

    tracker.setConnected(true);
    expect(sent).toEqual([true]);
  });

  it("reports background only after the grace", () => {
    const tracker = make();
    tracker.setConnected(true);

    foreground = false;
    tracker.evaluate();
    vi.advanceTimersByTime(ATTENTION_BACKGROUND_GRACE_MS - 1);
    expect(sent).toEqual([true]);

    vi.advanceTimersByTime(1);
    expect(sent).toEqual([true, false]);
    expect(tracker.declared).toBe(false);
  });

  it("cancels the report when the window comes back inside the grace", () => {
    const tracker = make();
    tracker.setConnected(true);

    foreground = false;
    tracker.evaluate();
    vi.advanceTimersByTime(30_000);
    foreground = true;
    tracker.evaluate();
    vi.advanceTimersByTime(ATTENTION_BACKGROUND_GRACE_MS);

    // Nothing new: it never stopped being foreground as far as the server knows.
    expect(sent).toEqual([true]);
  });

  it("re-checks when the grace ends (focus moved into an iframe, no event back)", () => {
    const tracker = make();
    tracker.setConnected(true);

    foreground = false;
    tracker.evaluate();
    // The document regained focus without the window firing `focus`.
    foreground = true;
    vi.advanceTimersByTime(ATTENTION_BACKGROUND_GRACE_MS);

    expect(sent).toEqual([true]);
  });

  it("reports coming back at once", () => {
    const tracker = make();
    tracker.setConnected(true);
    foreground = false;
    tracker.evaluate();
    vi.advanceTimersByTime(ATTENTION_BACKGROUND_GRACE_MS);

    foreground = true;
    tracker.evaluate();
    expect(sent).toEqual([true, false, true]);
  });

  it("does not repeat itself on extra events", () => {
    const tracker = make();
    tracker.setConnected(true);
    tracker.evaluate();
    tracker.evaluate();
    foreground = false;
    tracker.evaluate();
    tracker.evaluate();
    vi.advanceTimersByTime(ATTENTION_BACKGROUND_GRACE_MS * 3);
    tracker.evaluate();

    expect(sent).toEqual([true, false]);
  });

  it("re-announces background on a reconnect, because the new socket knows nothing", () => {
    const tracker = make();
    tracker.setConnected(true);
    foreground = false;
    tracker.evaluate();
    vi.advanceTimersByTime(ATTENTION_BACKGROUND_GRACE_MS);

    tracker.setConnected(false);
    tracker.setConnected(true);
    expect(sent).toEqual([true, false, false]);
  });

  it("a window that opens in the background says so on connect, with no grace", () => {
    foreground = false;
    const tracker = make();
    tracker.setConnected(true);

    expect(sent).toEqual([false]);
  });

  it("changes while disconnected are sent on the next connect, once", () => {
    const tracker = make();
    tracker.setConnected(true);
    tracker.setConnected(false);

    foreground = false;
    tracker.evaluate();
    vi.advanceTimersByTime(ATTENTION_BACKGROUND_GRACE_MS);
    expect(sent).toEqual([true]);

    tracker.setConnected(true);
    expect(sent).toEqual([true, false]);
  });

  it("stops its timer on dispose", () => {
    const tracker = make();
    tracker.setConnected(true);
    foreground = false;
    tracker.evaluate();
    tracker.dispose();
    vi.advanceTimersByTime(ATTENTION_BACKGROUND_GRACE_MS);

    expect(sent).toEqual([true]);
  });

  it("a send that throws is not counted as reported, and the next event retries it", () => {
    let failNext = false;
    const tracker = createAttentionTracker({
      send: (value) => {
        if (failNext) {
          failNext = false;
          throw new Error("socket closing");
        }
        sent.push(value);
      },
      isForeground: () => foreground,
    });
    tracker.setConnected(true);

    foreground = false;
    tracker.evaluate();
    failNext = true;
    vi.advanceTimersByTime(ATTENTION_BACKGROUND_GRACE_MS);
    expect(sent).toEqual([true]);
    expect(tracker.declared).toBe(false);

    // Any later event (another blur, a visibilitychange) sends it.
    tracker.evaluate();
    expect(sent).toEqual([true, false]);
    tracker.evaluate();
    expect(sent).toEqual([true, false]);
  });
});
