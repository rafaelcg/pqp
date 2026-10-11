import { describe, expect, it } from "vitest";
import {
  NO_FORCE,
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
