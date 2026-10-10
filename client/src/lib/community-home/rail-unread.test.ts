import { describe, expect, it } from "vitest";
import {
  bauIsFresh,
  formatBauBadge,
  railServerIndicator,
  withServerBauNewest,
  withServerBauUnread,
} from "./rail-unread";

describe("railServerIndicator", () => {
  it("shows the Baú as a lime count when nothing else holds the corner", () => {
    expect(
      railServerIndicator({ totals: null, bauUnread: 3, muted: false }),
    ).toEqual({
      mentions: 0,
      hasUnread: true,
      bauOnly: true,
      bauCue: "count",
      bauCount: 3,
    });
  });

  it("still counts, not rings, when a plain channel is unread too", () => {
    expect(
      railServerIndicator({
        totals: { count: 2, mentions: 0 },
        bauUnread: 5,
        muted: false,
      }),
    ).toEqual({
      mentions: 0,
      hasUnread: true,
      bauOnly: false,
      bauCue: "count",
      bauCount: 5,
    });
  });

  it("gives the corner to mentions and moves the Baú to the ring", () => {
    expect(
      railServerIndicator({
        totals: { count: 4, mentions: 2 },
        bauUnread: 9,
        muted: false,
      }),
    ).toEqual({
      mentions: 2,
      hasUnread: true,
      bauOnly: false,
      bauCue: "ring",
      bauCount: 9,
    });
  });

  it("says nothing for a muted server", () => {
    expect(
      railServerIndicator({
        totals: { count: 4, mentions: 2 },
        bauUnread: 9,
        muted: true,
      }),
    ).toEqual({
      mentions: 0,
      hasUnread: false,
      bauOnly: false,
      bauCue: "none",
      bauCount: 0,
    });
  });

  it("is quiet with nothing unread anywhere", () => {
    const quiet = railServerIndicator({
      totals: { count: 0, mentions: 0 },
      bauUnread: 0,
      muted: false,
    });
    expect(quiet).toEqual({
      mentions: 0,
      hasUnread: false,
      bauOnly: false,
      bauCue: "none",
      bauCount: 0,
    });
    expect(
      railServerIndicator({ totals: null, bauUnread: 0, muted: false }).hasUnread,
    ).toBe(false);
  });

  it("mentions without any Baú unread never ring", () => {
    expect(
      railServerIndicator({
        totals: { count: 1, mentions: 1 },
        bauUnread: 0,
        muted: false,
      }).bauCue,
    ).toBe("none");
  });
});

describe("formatBauBadge", () => {
  it("shows the number up to 9 and caps after", () => {
    expect(formatBauBadge(1)).toBe("1");
    expect(formatBauBadge(9)).toBe("9");
    expect(formatBauBadge(10)).toBe("9+");
    expect(formatBauBadge(250)).toBe("9+");
  });
});

describe("bauIsFresh", () => {
  const now = Date.parse("2026-10-10T12:00:00.000Z");
  it("is fresh under 24 hours", () => {
    expect(bauIsFresh("2026-10-10T11:59:00.000Z", now)).toBe(true);
    expect(bauIsFresh("2026-10-09T12:00:01.000Z", now)).toBe(true);
  });
  it("is not fresh at 24 hours or older", () => {
    expect(bauIsFresh("2026-10-09T12:00:00.000Z", now)).toBe(false);
    expect(bauIsFresh("2026-09-01T00:00:00.000Z", now)).toBe(false);
  });
  it("is not fresh when the age is unknown", () => {
    expect(bauIsFresh(null, now)).toBe(false);
    expect(bauIsFresh(undefined, now)).toBe(false);
    expect(bauIsFresh("not a date", now)).toBe(false);
  });
  it("tolerates a clock slightly behind the server", () => {
    expect(bauIsFresh("2026-10-10T12:00:05.000Z", now)).toBe(true);
  });
});

describe("withServerBauNewest", () => {
  it("sets, clears and keeps identity when unchanged", () => {
    const a = withServerBauNewest({}, "s1", "2026-10-10T10:00:00.000Z");
    expect(a).toEqual({ s1: "2026-10-10T10:00:00.000Z" });
    expect(withServerBauNewest(a, "s1", "2026-10-10T10:00:00.000Z")).toBe(a);
    expect(withServerBauNewest(a, "s1", null)).toEqual({});
    expect(withServerBauNewest({}, "s9", undefined)).toEqual({});
  });
});

describe("withServerBauUnread", () => {
  it("sets, replaces and clears one server without touching the others", () => {
    const a = withServerBauUnread({}, "s1", 2);
    expect(a).toEqual({ s1: 2 });
    const b = withServerBauUnread(a, "s2", 1);
    expect(b).toEqual({ s1: 2, s2: 1 });
    const c = withServerBauUnread(b, "s1", 0);
    expect(c).toEqual({ s2: 1 });
    expect(a).toEqual({ s1: 2 });
  });

  it("returns the same object when nothing changed", () => {
    const map = { s1: 2 };
    expect(withServerBauUnread(map, "s1", 2)).toBe(map);
    expect(withServerBauUnread(map, "s9", 0)).toBe(map);
  });
});
