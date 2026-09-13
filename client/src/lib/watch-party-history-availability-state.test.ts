import { describe, expect, it } from "vitest";
import {
  unconfirmedChannels,
  visibleHistoryChannels,
  withConfirmedHistory,
  EMPTY_HISTORY_CONFIRMED_MAP,
} from "./watch-party-history-availability-state";

const cinema = { id: "chan-cinema", name: "cinema" };
const premiere = { id: "chan-premiere", name: "premiere" };

describe("visibleHistoryChannels", () => {
  it("is empty against an empty confirmed map", () => {
    expect(
      visibleHistoryChannels([cinema, premiere], EMPTY_HISTORY_CONFIRMED_MAP),
    ).toEqual([]);
  });

  it("returns only the candidates that are confirmed", () => {
    expect(
      visibleHistoryChannels([cinema, premiere], { [cinema.id]: true }),
    ).toEqual([cinema]);
  });

  // The whole fix for review's "previous server's channels stay visible"
  // finding: a confirmed entry for a channel that is NOT among the current
  // candidates (a stale map entry left over from a server the viewer just
  // switched away from) must never come back, no matter what the map holds.
  it("never returns a confirmed channel that is not a current candidate", () => {
    const staleFromAnotherServer = {
      [cinema.id]: true as const,
      [premiere.id]: true as const,
    };
    expect(
      visibleHistoryChannels([premiere], staleFromAnotherServer),
    ).toEqual([premiere]);
    expect(visibleHistoryChannels([], staleFromAnotherServer)).toEqual([]);
  });
});

describe("unconfirmedChannels", () => {
  it("treats every candidate as unconfirmed against an empty map", () => {
    expect(
      unconfirmedChannels([cinema, premiere], EMPTY_HISTORY_CONFIRMED_MAP),
    ).toEqual([cinema, premiere]);
  });

  it("drops a channel once it is confirmed", () => {
    expect(
      unconfirmedChannels([cinema, premiere], { [cinema.id]: true }),
    ).toEqual([premiere]);
  });

  // A channel that was checked and found empty, or whose check failed, is
  // NOT distinguishable from "never checked" -- both must be retried. This
  // is what makes the transient-failure and first-broadcast bugs the same
  // fix: neither one ever gets an explicit `false` written for it.
  it("keeps asking about a channel with no confirmed entry, forever", () => {
    expect(unconfirmedChannels([cinema], {})).toEqual([cinema]);
    expect(unconfirmedChannels([cinema], {})).toEqual([cinema]);
  });
});

describe("withConfirmedHistory", () => {
  it("adds the given ids as confirmed, leaving the rest of the map alone", () => {
    const next = withConfirmedHistory({ [premiere.id]: true }, [cinema.id]);
    expect(next).toEqual({ [premiere.id]: true, [cinema.id]: true });
  });

  it("returns the same map reference when there is nothing to add", () => {
    const before = { [cinema.id]: true } as const;
    expect(withConfirmedHistory(before, [])).toBe(before);
  });

  it("has no way to record a negative result", () => {
    // There is no `false`/`remove` argument on purpose -- a failed or empty
    // check must contribute nothing, never a permanent negative. Typescript
    // enforces the shape; this just documents the intent for a reader.
    const next = withConfirmedHistory(EMPTY_HISTORY_CONFIRMED_MAP, [
      cinema.id,
    ]);
    expect(Object.values(next).every((value) => value === true)).toBe(true);
  });
});
