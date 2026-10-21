import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicAppsConfigSchema } from "@pqp/shared";
import type { AppAvailabilityRow } from "./availability.js";
import {
  LOCADORA_ROW_MISS_MS,
  LOCADORA_ROW_TTL_MS,
  publicAppsConfig,
  resetPublicAppsConfigCache,
} from "./public-config.js";

/**
 * The guest half of `GET /api/public/apps/config`: `guest` is true only when
 * BOTH flags, an apps origin and a released Locadora hold, the app's slice is
 * built from the stored manifest, and the one database read is memoised and
 * fails to "no guest".
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(path.join(here, "catalog.json"), "utf8")) as {
  apps: Array<{ manifest: { id: string; version: string } }>;
};
const locadora = catalog.apps.filter((entry) => entry.manifest.id === "pqp-locadora").at(-1)!.manifest;

function row(patch: Partial<AppAvailabilityRow> = {}): AppAvailabilityRow {
  return {
    id: "pqp-locadora",
    status: "live",
    current_version: locadora.version,
    global_enabled: true,
    community_unlocked: false,
    manifest: locadora,
    operator_enabled: null,
    owner_enabled: null,
    ...patch,
  };
}

const ENV = ["APPS_LANDING", "LOCADORA_GUEST", "LOCADORA_SAVES_ANNOUNCED", "APPS_ORIGIN"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  process.env.APPS_LANDING = "true";
  process.env.LOCADORA_GUEST = "true";
  delete process.env.LOCADORA_SAVES_ANNOUNCED;
  process.env.APPS_ORIGIN = "https://apps.example";
  resetPublicAppsConfigCache();
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("publicAppsConfig", () => {
  it("offers the guest player with the built manifest's bundle and asset hashes", async () => {
    const config = await publicAppsConfig({ readRow: async () => row() });
    expect(publicAppsConfigSchema.parse(config)).toEqual(config);
    expect(config.guest).toBe(true);
    expect(config.locadora?.origin).toBe("https://apps.example");
    expect(config.locadora?.app.entry.url).toBe(`https://apps.example/pqp-locadora/${locadora.version}/index.html`);
    expect(config.locadora?.app.capabilities.deviceStore).toEqual({ allowed: true, maxBytes: 536870912 });
    for (const asset of config.locadora?.app.assets ?? []) {
      expect(asset.url.startsWith(`https://apps.example/pqp-locadora/${locadora.version}/`)).toBe(true);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // nothing about a person, a server or a session
    expect(JSON.stringify(config)).not.toMatch(/serverId|userId|sessionId|token/);
  });

  it("is off with either flag off or no origin, and then never reads the database", async () => {
    const readRow = vi.fn(async () => row());
    for (const [key, value] of [
      ["APPS_LANDING", "false"],
      ["LOCADORA_GUEST", "false"],
      ["APPS_ORIGIN", ""],
    ] as const) {
      process.env.APPS_LANDING = "true";
      process.env.LOCADORA_GUEST = "true";
      process.env.APPS_ORIGIN = "https://apps.example";
      process.env[key] = value;
      const config = await publicAppsConfig({ readRow });
      expect(config.guest, key).toBe(false);
      expect(config.locadora, key).toBeNull();
    }
    expect(readRow).not.toHaveBeenCalled();
  });

  it("needs Locadora released: live, a current version, the operator's master switch, a valid manifest", async () => {
    for (const patch of [
      { status: "draft" as const },
      { status: "retired" as const },
      { current_version: null },
      { global_enabled: false },
      { manifest: { ...locadora, version: "not a version" } },
      { manifest: null },
    ]) {
      resetPublicAppsConfigCache();
      const config = await publicAppsConfig({ readRow: async () => row(patch) });
      expect(config.guest, JSON.stringify(patch).slice(0, 40)).toBe(false);
    }
    resetPublicAppsConfigCache();
    expect((await publicAppsConfig({ readRow: async () => null })).guest).toBe(false);
  });

  it("a failed read is no guest, briefly, and a good one is kept for a minute", async () => {
    const failing = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const start = Date.now();
    expect((await publicAppsConfig({ readRow: failing, now: start })).guest).toBe(false);
    const ok = vi.fn(async () => row());
    expect((await publicAppsConfig({ readRow: ok, now: start + 1 })).guest).toBe(false);
    expect(ok).not.toHaveBeenCalled();
    expect((await publicAppsConfig({ readRow: ok, now: start + LOCADORA_ROW_MISS_MS + 1_000 })).guest).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
    const later = vi.fn(async () => row({ global_enabled: false }));
    expect((await publicAppsConfig({ readRow: later, now: Date.now() + 5 })).guest).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect((await publicAppsConfig({ readRow: later, now: Date.now() + LOCADORA_ROW_TTL_MS + 1 })).guest).toBe(false);
  });

  it("concurrent callers share one read", async () => {
    let release = () => {};
    const readRow = vi.fn(
      () =>
        new Promise<AppAvailabilityRow>((resolve) => {
          release = () => resolve(row());
        }),
    );
    const all = Promise.all(Array.from({ length: 20 }, () => publicAppsConfig({ readRow })));
    await Promise.resolve();
    release();
    const answers = await all;
    expect(readRow).toHaveBeenCalledTimes(1);
    expect(answers.every((answer) => answer.guest)).toBe(true);
  });

  it("the cloud-saves line is its own flag and never turns guest play on", async () => {
    process.env.LOCADORA_SAVES_ANNOUNCED = "true";
    process.env.LOCADORA_GUEST = "false";
    const config = await publicAppsConfig({ readRow: async () => row() });
    expect(config).toEqual({ enabled: true, guest: false, cloudSaves: true, locadora: null });
  });
});
