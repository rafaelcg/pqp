import { afterEach, describe, expect, it } from "vitest";
import {
  clientUpdateConfig,
  parseMinBuiltAt,
} from "./client-update-config.js";
import { resetFeatureFlagsForTests } from "./flags.js";

describe("clientUpdateConfig", () => {
  afterEach(() => {
    delete process.env.CLIENT_FORCE_UPDATE;
    delete process.env.CLIENT_MIN_BUILT_AT;
    delete process.env.CLIENT_FORCE_UPDATE_IN_CALL;
    delete process.env.CLIENT_CRITICAL_MIN_BUILT_AT;
    resetFeatureFlagsForTests();
  });

  it("forces nobody by default", () => {
    expect(clientUpdateConfig()).toEqual({
      forceUpdate: false,
      minBuiltAt: null,
      interruptCalls: false,
      criticalMinBuiltAt: null,
    });
  });

  it("reads the two levers that reach a page in a call", () => {
    process.env.CLIENT_FORCE_UPDATE_IN_CALL = "true";
    process.env.CLIENT_CRITICAL_MIN_BUILT_AT = "2026-10-10T12:00:00Z";
    expect(clientUpdateConfig()).toMatchObject({
      interruptCalls: true,
      criticalMinBuiltAt: Date.UTC(2026, 9, 10, 12),
    });
    process.env.CLIENT_FORCE_UPDATE_IN_CALL = "yes";
    expect(clientUpdateConfig().interruptCalls).toBe(false);
  });

  it("follows CLIENT_FORCE_UPDATE as its environment default, exact word only", () => {
    process.env.CLIENT_FORCE_UPDATE = "true";
    expect(clientUpdateConfig().forceUpdate).toBe(true);
    process.env.CLIENT_FORCE_UPDATE = "TRUE";
    expect(clientUpdateConfig().forceUpdate).toBe(false);
    process.env.CLIENT_FORCE_UPDATE = "1";
    expect(clientUpdateConfig().forceUpdate).toBe(false);
  });

  it("reads the minimum build time per request", () => {
    process.env.CLIENT_MIN_BUILT_AT = "2026-09-30T12:00:00Z";
    expect(clientUpdateConfig().minBuiltAt).toBe(Date.UTC(2026, 8, 30, 12));
    process.env.CLIENT_MIN_BUILT_AT = "";
    expect(clientUpdateConfig().minBuiltAt).toBeNull();
  });
});

describe("parseMinBuiltAt", () => {
  it("accepts an ISO date, epoch milliseconds and epoch seconds", () => {
    const ms = Date.UTC(2026, 8, 30, 12);
    expect(parseMinBuiltAt("2026-09-30T12:00:00Z")).toBe(ms);
    expect(parseMinBuiltAt(String(ms))).toBe(ms);
    expect(parseMinBuiltAt(String(ms / 1000))).toBe(ms);
  });

  it("answers null for nothing usable instead of a date that forces everybody", () => {
    expect(parseMinBuiltAt(undefined)).toBeNull();
    expect(parseMinBuiltAt("")).toBeNull();
    expect(parseMinBuiltAt("   ")).toBeNull();
    expect(parseMinBuiltAt("yesterday")).toBeNull();
  });
});
