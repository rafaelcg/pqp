import { describe, expect, it } from "vitest";
import { railServerIndicator, withServerBauUnread } from "./rail-unread";

describe("railServerIndicator", () => {
  it("lights the pip for unread Baú posts alone, with no number", () => {
    expect(
      railServerIndicator({ totals: null, bauUnread: 3, muted: false }),
    ).toEqual({ mentions: 0, hasUnread: true, bauOnly: true });
  });

  it("is not Baú-only when a channel is unread too, and still shows no Baú count", () => {
    expect(
      railServerIndicator({
        totals: { count: 2, mentions: 0 },
        bauUnread: 5,
        muted: false,
      }),
    ).toEqual({ mentions: 0, hasUnread: true, bauOnly: false });
  });

  it("keeps the red number for mentions only, whatever the Baú holds", () => {
    expect(
      railServerIndicator({
        totals: { count: 4, mentions: 2 },
        bauUnread: 9,
        muted: false,
      }),
    ).toEqual({ mentions: 2, hasUnread: true, bauOnly: false });
  });

  it("says nothing for a muted server", () => {
    expect(
      railServerIndicator({
        totals: { count: 4, mentions: 2 },
        bauUnread: 9,
        muted: true,
      }),
    ).toEqual({ mentions: 0, hasUnread: false, bauOnly: false });
  });

  it("is quiet with nothing unread anywhere", () => {
    expect(
      railServerIndicator({ totals: { count: 0, mentions: 0 }, bauUnread: 0, muted: false }),
    ).toEqual({ mentions: 0, hasUnread: false, bauOnly: false });
    expect(
      railServerIndicator({ totals: null, bauUnread: 0, muted: false }).hasUnread,
    ).toBe(false);
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
