import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUSH_SKIP_KINDS,
  PUSH_SKIP_LOG_MAX_PER_SECOND,
  PUSH_SKIP_LOG_WINDOW_MS,
  PUSH_SKIP_REASONS,
  notePushSkipped,
  notePushSkippedMany,
  pushSkippedSnapshot,
  resetPushSkips,
} from "./push-skips.js";

/**
 * The "why not" counters: every key present from boot, every skip counted, and
 * the log line rate limited per person, kind and reason without the counter
 * losing anything to the suppression.
 */
describe("push skip counters", () => {
  let lines: string[];

  beforeEach(() => {
    resetPushSkips();
    lines = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      if (typeof line === "string" && line.includes("push.skipped")) {
        lines.push(line);
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts with every kind and reason at zero", () => {
    const snapshot = pushSkippedSnapshot();
    expect(Object.keys(snapshot)).toEqual([...PUSH_SKIP_KINDS]);
    for (const kind of PUSH_SKIP_KINDS) {
      expect(Object.keys(snapshot[kind])).toEqual([...PUSH_SKIP_REASONS]);
      expect(Object.values(snapshot[kind]).every((n) => n === 0)).toBe(true);
    }
  });

  it("counts per kind and reason", () => {
    notePushSkipped("message", "live_socket", "u1");
    notePushSkipped("message", "live_socket", "u2");
    notePushSkipped("call", "dnd", "u1");
    notePushSkippedMany("stream", "no_subscription", ["a", "b", "c"]);

    const snapshot = pushSkippedSnapshot();
    expect(snapshot.message.live_socket).toBe(2);
    expect(snapshot.call.dnd).toBe(1);
    expect(snapshot.stream.no_subscription).toBe(3);
    expect(snapshot.message.dnd).toBe(0);
  });

  it("logs once per person, kind and reason per window, and still counts every one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));

    for (let i = 0; i < 5; i += 1) {
      notePushSkipped("message", "live_socket", "rafa", { channelId: "dm1" });
    }
    // Another person, another reason: each gets its own line.
    notePushSkipped("message", "live_socket", "andre");
    notePushSkipped("message", "dnd", "rafa");

    expect(pushSkippedSnapshot().message.live_socket).toBe(6);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "[pqp] push.skipped kind=message reason=live_socket userId=rafa channelId=dm1",
    );

    vi.setSystemTime(Date.now() + PUSH_SKIP_LOG_WINDOW_MS);
    notePushSkipped("message", "live_socket", "rafa", { channelId: "dm1" });
    expect(lines).toHaveLength(4);
    // The four the window swallowed are reported on the next line.
    expect(lines[3]).toContain("suppressed=4");
  });

  it("caps the whole log per second for one large fan-out, and says how much it dropped", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));

    const crowd = Array.from({ length: 500 }, (_, i) => `member-${i}`);
    notePushSkippedMany("stream", "live_socket", crowd, { channelId: "party" });

    expect(pushSkippedSnapshot().stream.live_socket).toBe(500);
    expect(lines).toHaveLength(PUSH_SKIP_LOG_MAX_PER_SECOND);

    vi.setSystemTime(Date.now() + 1_000);
    notePushSkipped("message", "dnd", "somebody");
    expect(lines).toHaveLength(PUSH_SKIP_LOG_MAX_PER_SECOND + 1);
    expect(lines.at(-1)).toContain(`dropped=${500 - PUSH_SKIP_LOG_MAX_PER_SECOND}`);
  });

  it("a person whose line was dropped by the cap logs on their next skip", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    const crowd = Array.from({ length: PUSH_SKIP_LOG_MAX_PER_SECOND + 1 }, (_, i) => `m${i}`);
    notePushSkippedMany("message", "live_socket", crowd);
    const last = crowd.at(-1)!;
    expect(lines.some((line) => line.includes(`userId=${last} `) || line.endsWith(`userId=${last}`))).toBe(false);

    vi.setSystemTime(Date.now() + 1_000);
    notePushSkipped("message", "live_socket", last);
    expect(lines.at(-1)).toContain(`userId=${last}`);
  });
});
