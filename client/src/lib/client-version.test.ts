import { describe, expect, it } from "vitest";
import {
  ANNOUNCE_HOUR_UTC_DEFAULT,
  ANNOUNCE_SOAK_MS,
  NO_FORCE,
  announceAtFor,
  announceHourFromEnv,
  isAnnounced,
  isCriticalBuild,
  isForcedBuild,
  isStaleBuild,
  parseForceConfig,
  parseVersionManifest,
} from "./client-version";

const running = { build: "abc123", builtAt: 1_000 };

describe("parseVersionManifest", () => {
  it("reads what a build writes", () => {
    expect(parseVersionManifest({ build: "def456", builtAt: 2_000 })).toEqual({
      build: "def456",
      builtAt: 2_000,
    });
  });

  it("keeps the build when builtAt is missing or unusable", () => {
    expect(parseVersionManifest({ build: "def456" })).toEqual({
      build: "def456",
      builtAt: null,
    });
    expect(parseVersionManifest({ build: "def456", builtAt: "soon" })?.builtAt).toBeNull();
    expect(parseVersionManifest({ build: "def456", builtAt: -5 })?.builtAt).toBeNull();
  });

  it("answers null for anything that is not a manifest, never a build", () => {
    // A deploy from before the file existed answers the path with the SPA shell;
    // a captive portal answers with whatever it likes.
    expect(parseVersionManifest(null)).toBeNull();
    expect(parseVersionManifest("<!doctype html>")).toBeNull();
    expect(parseVersionManifest({})).toBeNull();
    expect(parseVersionManifest({ build: "" })).toBeNull();
    expect(parseVersionManifest({ build: "   " })).toBeNull();
    expect(parseVersionManifest({ build: 7 })).toBeNull();
    expect(parseVersionManifest({ build: "x".repeat(200) })).toBeNull();
  });
});

describe("isStaleBuild", () => {
  it("is stale when the deployed build differs", () => {
    expect(isStaleBuild(running, { build: "def456", builtAt: 2_000 })).toBe(true);
  });

  it("is current when the builds match", () => {
    expect(isStaleBuild(running, { build: "abc123", builtAt: 1_000 })).toBe(false);
  });

  it("also moves for a rollback, where the deployed build is OLDER", () => {
    expect(isStaleBuild(running, { build: "0ld", builtAt: 1 })).toBe(true);
  });

  it("is never stale when nothing usable came back", () => {
    expect(isStaleBuild(running, null)).toBe(false);
  });

  it("never compares a dev build", () => {
    expect(isStaleBuild({ build: "dev", builtAt: 0 }, { build: "def456", builtAt: 2 })).toBe(
      false,
    );
  });
});

describe("parseForceConfig", () => {
  it("reads the operator's answer", () => {
    expect(parseForceConfig({ forceUpdate: true, minBuiltAt: 5_000 })).toEqual({
      forceUpdate: true,
      minBuiltAt: 5_000,
      interruptCalls: false,
      criticalMinBuiltAt: null,
    });
    expect(
      parseForceConfig({ interruptCalls: true, criticalMinBuiltAt: 7_000 }),
    ).toMatchObject({ interruptCalls: true, criticalMinBuiltAt: 7_000 });
    expect(parseForceConfig({ interruptCalls: "true" }).interruptCalls).toBe(false);
  });

  it("reads anything that is not plainly yes as no force", () => {
    expect(parseForceConfig(undefined)).toEqual(NO_FORCE);
    expect(parseForceConfig({})).toEqual(NO_FORCE);
    expect(parseForceConfig({ forceUpdate: "true" })).toEqual(NO_FORCE);
    expect(parseForceConfig({ forceUpdate: 1, minBuiltAt: "5" })).toEqual(NO_FORCE);
    expect(parseForceConfig({ minBuiltAt: -1 }).minBuiltAt).toBeNull();
  });
});

describe("isForcedBuild", () => {
  it("is not forced by default", () => {
    expect(isForcedBuild(running, NO_FORCE)).toBe(false);
  });

  it("is forced by the flag", () => {
    expect(isForcedBuild(running, { forceUpdate: true, minBuiltAt: null })).toBe(true);
  });

  it("is forced when it was built before the minimum, and not after", () => {
    expect(isForcedBuild(running, { forceUpdate: false, minBuiltAt: 1_001 })).toBe(true);
    expect(isForcedBuild(running, { forceUpdate: false, minBuiltAt: 1_000 })).toBe(false);
    expect(isForcedBuild(running, { forceUpdate: false, minBuiltAt: 999 })).toBe(false);
  });

  it("never forces a dev build", () => {
    expect(
      isForcedBuild({ build: "dev", builtAt: 0 }, { forceUpdate: true, minBuiltAt: 9 }),
    ).toBe(false);
  });
});

describe("isCriticalBuild", () => {
  const bundle = { build: "abc123", builtAt: 1_000 };

  it("is off by default, and a plain force is not critical", () => {
    expect(isCriticalBuild(bundle, NO_FORCE)).toBe(false);
    expect(isCriticalBuild(bundle, { ...NO_FORCE, forceUpdate: true })).toBe(false);
  });

  it("is critical when the operator lets a force interrupt calls", () => {
    expect(
      isCriticalBuild(bundle, { ...NO_FORCE, forceUpdate: true, interruptCalls: true }),
    ).toBe(true);
    expect(
      isCriticalBuild(bundle, { ...NO_FORCE, minBuiltAt: 2_000, interruptCalls: true }),
    ).toBe(true);
    // Interrupting calls without anything forced forces nothing.
    expect(isCriticalBuild(bundle, { ...NO_FORCE, interruptCalls: true })).toBe(false);
  });

  it("is critical for a bundle built before the critical minimum, and not after", () => {
    expect(isCriticalBuild(bundle, { ...NO_FORCE, criticalMinBuiltAt: 2_000 })).toBe(true);
    expect(isCriticalBuild(bundle, { ...NO_FORCE, criticalMinBuiltAt: 500 })).toBe(false);
  });

  it("never applies to a dev build", () => {
    expect(
      isCriticalBuild({ build: "dev", builtAt: 0 }, { ...NO_FORCE, criticalMinBuiltAt: 2_000 }),
    ).toBe(false);
  });
});

describe("the daily announcement", () => {
  const HOUR = 3_600_000;
  const at = (day: number, hour: number, minute = 0) =>
    Date.UTC(2026, 9, day, hour, minute);

  it("holds a build until 09:00 UTC after it went live, by default", () => {
    expect(ANNOUNCE_HOUR_UTC_DEFAULT).toBe(9);
    // Built at 15:30 on the 13th: announced at 09:00 on the 14th.
    expect(announceAtFor(at(13, 15, 30), 9)).toBe(at(14, 9));
    // Built at 02:00: announced the same morning, 09:00.
    expect(announceAtFor(at(13, 2), 9)).toBe(at(13, 9));
  });

  it("makes a build soak for an hour first, so a hotfix right behind it is the only one announced", () => {
    // Ten minutes before the slot is too soon: it waits for the next morning.
    expect(announceAtFor(at(13, 8, 50), 9)).toBe(at(14, 9));
    // An hour and a bit before the slot is enough.
    expect(announceAtFor(at(13, 7, 50), 9)).toBe(at(13, 9));
    expect(ANNOUNCE_SOAK_MS).toBe(HOUR);
  });

  it("never waits more than a day and an hour", () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 1, 30, 59]) {
        const live = at(13, h, m);
        const wait = announceAtFor(live, 9) - live;
        expect(wait).toBeGreaterThanOrEqual(ANNOUNCE_SOAK_MS);
        expect(wait).toBeLessThanOrEqual(25 * HOUR);
      }
    }
  });

  it("announces a build whose slot has long passed at once", () => {
    const live = at(10, 12);
    expect(isAnnounced(announceAtFor(live, 9), at(13, 20))).toBe(true);
  });

  it("announces once a day however many builds ship: it is the newest one that is read", () => {
    // Three builds across the day all resolve to the same morning.
    const slots = [at(13, 10), at(13, 15), at(13, 23, 50)].map((live) =>
      announceAtFor(live, 9),
    );
    expect(new Set(slots).size).toBe(1);
  });

  it("is off with no hour: the moment it went live", () => {
    expect(announceAtFor(at(13, 15), null)).toBe(at(13, 15));
  });

  it("reads the build-time hour, with `off` and bad values handled", () => {
    expect(announceHourFromEnv(undefined)).toBe(9);
    expect(announceHourFromEnv("")).toBe(9);
    expect(announceHourFromEnv("6")).toBe(6);
    expect(announceHourFromEnv("0")).toBe(0);
    expect(announceHourFromEnv("off")).toBeNull();
    expect(announceHourFromEnv("-1")).toBeNull();
    expect(announceHourFromEnv("25")).toBe(9);
    expect(announceHourFromEnv("noon")).toBe(9);
  });

  it("isAnnounced: no hold, or the hold has run out", () => {
    expect(isAnnounced(null, 5)).toBe(true);
    expect(isAnnounced(undefined, 5)).toBe(true);
    expect(isAnnounced(10, 9)).toBe(false);
    expect(isAnnounced(10, 10)).toBe(true);
  });
});
