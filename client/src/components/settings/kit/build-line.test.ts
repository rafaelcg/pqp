import { afterEach, describe, expect, it } from "vitest";
import { formatBuildLine } from "@/components/settings/kit/build-line";

// 2026-10-31T12:00:00Z
const BUILT_AT = Date.UTC(2026, 9, 31, 12);
const BUILD = "675806e1234567890";
const DESKTOP_LINE_NO_VERSION = "pqp desktop · 2026.10.31 · 675806e";

const win = globalThis as { window?: unknown };
const originalWindow = win.window;

afterEach(() => {
  win.window = originalWindow;
});

describe("formatBuildLine", () => {
  it("says the shell version in the desktop app", () => {
    expect(
      formatBuildLine({ build: BUILD, builtAt: BUILT_AT, desktop: true, shellVersion: "0.2.9" }),
    ).toBe("pqp desktop 0.2.9 · 2026.10.31 · 675806e");
  });

  it("keeps a prerelease suffix", () => {
    expect(
      formatBuildLine({ build: BUILD, builtAt: BUILT_AT, desktop: true, shellVersion: "0.3.0-beta.1" }),
    ).toBe("pqp desktop 0.3.0-beta.1 · 2026.10.31 · 675806e");
  });

  it("falls back to plain pqp desktop when the shell reports no version", () => {
    for (const shellVersion of [null, undefined, ""]) {
      expect(
        formatBuildLine({ build: BUILD, builtAt: BUILT_AT, desktop: true, shellVersion }),
      ).toBe(DESKTOP_LINE_NO_VERSION);
    }
  });

  it("omits a version that is not shaped like a semver, without throwing", () => {
    for (const shellVersion of ["garbage", "0.2", "0.2.9 · evil", "<b>1.2.3</b>", "v0.2.9", "1.2.3\n"]) {
      expect(
        formatBuildLine({ build: BUILD, builtAt: BUILT_AT, desktop: true, shellVersion }),
      ).toBe(DESKTOP_LINE_NO_VERSION);
    }
    expect(
      formatBuildLine({
        build: BUILD,
        builtAt: BUILT_AT,
        desktop: true,
        shellVersion: 42 as unknown as string,
      }),
    ).toBe(DESKTOP_LINE_NO_VERSION);
  });

  it("leaves the web line exactly as it was, even when handed a version", () => {
    const web = { build: "a1b2c3d4e5", builtAt: Date.UTC(2026, 9, 3), desktop: false };
    expect(formatBuildLine(web)).toBe("pqp web · 2026.10.03 · a1b2c3d");
    expect(formatBuildLine({ ...web, shellVersion: "0.2.9" })).toBe("pqp web · 2026.10.03 · a1b2c3d");
  });

  it("says dev for a dev build, with the shell version on desktop", () => {
    expect(formatBuildLine({ build: "dev", builtAt: 0, desktop: false })).toBe("pqp web · dev");
    expect(formatBuildLine({ build: "dev", builtAt: 0, desktop: true, shellVersion: "0.2.9" })).toBe(
      "pqp desktop 0.2.9 · dev",
    );
  });

  it("reads the version from the desktop bridge by default", () => {
    win.window = { pqpDesktop: { isElectron: true, capabilities: { version: "0.2.9" } } };
    expect(formatBuildLine({ build: BUILD, builtAt: BUILT_AT })).toBe(
      "pqp desktop 0.2.9 · 2026.10.31 · 675806e",
    );
    // An old shell with no capabilities object at all.
    win.window = { pqpDesktop: { isElectron: true } };
    expect(formatBuildLine({ build: BUILD, builtAt: BUILT_AT })).toBe(DESKTOP_LINE_NO_VERSION);
    // A malformed value from the bridge.
    win.window = { pqpDesktop: { isElectron: true, capabilities: { version: { x: 1 } } } };
    expect(formatBuildLine({ build: BUILD, builtAt: BUILT_AT })).toBe(DESKTOP_LINE_NO_VERSION);
  });
});
