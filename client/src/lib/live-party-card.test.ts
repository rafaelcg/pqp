import { describe, expect, it } from "vitest";
import { formatLiveFor } from "./live-party-card";

const at = (iso: string) => new Date(iso);

describe("formatLiveFor", () => {
  const start = "2026-09-10T20:00:00.000Z";

  it("says nothing in the first minute, and nothing without a start", () => {
    expect(formatLiveFor(start, at("2026-09-10T20:00:40.000Z"))).toBeNull();
    expect(formatLiveFor(null, at(start))).toBeNull();
    expect(formatLiveFor("not a date", at(start))).toBeNull();
  });

  it("counts minutes, then hours and minutes", () => {
    expect(formatLiveFor(start, at("2026-09-10T20:12:30.000Z"))).toBe("12 min");
    expect(formatLiveFor(start, at("2026-09-10T21:00:10.000Z"))).toBe("1h");
    expect(formatLiveFor(start, at("2026-09-10T21:05:00.000Z"))).toBe("1h 05");
    expect(formatLiveFor(start, at("2026-09-10T23:41:00.000Z"))).toBe("3h 41");
  });
});
