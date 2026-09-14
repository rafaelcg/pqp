import { describe, expect, it } from "vitest";
import {
  groupWatchPartyHistory,
  isShortBroadcast,
  SHORT_BROADCAST_SECONDS,
} from "./watch-party-history-grouping";
import type { WatchPartyHistoryEntry } from "@/lib/watch-party-history-api";

function entry(
  overrides: Partial<WatchPartyHistoryEntry> = {},
): WatchPartyHistoryEntry {
  return {
    sessionId: "1",
    title: "Party",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(600_000).toISOString(),
    durationSeconds: 600,
    presenter: null,
    replayAvailable: true,
    keepReplay: false,
    ...overrides,
  };
}

describe("isShortBroadcast", () => {
  it("is false for a still-live broadcast (no duration to judge)", () => {
    expect(isShortBroadcast(entry({ durationSeconds: null }))).toBe(false);
  });

  it("is false at exactly the threshold", () => {
    expect(
      isShortBroadcast(entry({ durationSeconds: SHORT_BROADCAST_SECONDS })),
    ).toBe(false);
  });

  it("is true just under the threshold", () => {
    expect(
      isShortBroadcast(entry({ durationSeconds: SHORT_BROADCAST_SECONDS - 1 })),
    ).toBe(true);
  });
});

describe("groupWatchPartyHistory", () => {
  it("an ordinary available broadcast is not folded", () => {
    const a = entry({ sessionId: "a" });
    const { available, folded } = groupWatchPartyHistory([a]);
    expect(available).toEqual([a]);
    expect(folded).toEqual([]);
  });

  it("folds an unavailable broadcast, labelled 'unavailable'", () => {
    const a = entry({ sessionId: "a", replayAvailable: false });
    const { available, folded } = groupWatchPartyHistory([a]);
    expect(available).toEqual([]);
    expect(folded).toEqual([{ entry: a, reason: "unavailable" }]);
  });

  it("folds a sub-minute broadcast even while its recording is still available, labelled 'short'", () => {
    const a = entry({
      sessionId: "a",
      durationSeconds: 12,
      replayAvailable: true,
    });
    const { available, folded } = groupWatchPartyHistory([a]);
    expect(available).toEqual([]);
    expect(folded).toEqual([{ entry: a, reason: "short" }]);
  });

  it("a broadcast that is both short and unavailable is labelled 'short', not 'unavailable'", () => {
    const a = entry({
      sessionId: "a",
      durationSeconds: 5,
      replayAvailable: false,
    });
    const { folded } = groupWatchPartyHistory([a]);
    expect(folded).toEqual([{ entry: a, reason: "short" }]);
  });

  it("a still-live broadcast never folds, even though it is never replayAvailable", () => {
    const a = entry({
      sessionId: "a",
      endedAt: null,
      durationSeconds: null,
      replayAvailable: false,
    });
    const { available, folded } = groupWatchPartyHistory([a]);
    // It is happening right now, not "old" -- folding it under the
    // accordion would read exactly like an expired recording.
    expect(available).toEqual([a]);
    expect(folded).toEqual([]);
  });

  it("preserves order within each bucket and separates counts correctly", () => {
    const newest = entry({ sessionId: "3", startedAt: "3" });
    const short = entry({ sessionId: "2", startedAt: "2", durationSeconds: 3 });
    const oldestUnavailable = entry({
      sessionId: "1",
      startedAt: "1",
      replayAvailable: false,
    });
    const { available, folded } = groupWatchPartyHistory([
      newest,
      short,
      oldestUnavailable,
    ]);
    expect(available).toEqual([newest]);
    expect(folded.map((f) => f.entry.sessionId)).toEqual(["2", "1"]);
  });
});
