/**
 * The gate, pinned — the same protection `google-ads-tag.test.ts` gives the
 * Google tag. pqp is AGPL and self-hosted, and Faro must send a self-hoster's
 * users nowhere. The one property that guarantees it is one line long: with no
 * `VITE_FARO_URL`, `initFaro` calls no initializer, so there is no network
 * request and no `window` global. If that regresses, a self-host starts
 * reporting to our collector, so it gets its own test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { dropNoisyItems, initFaro, resetFaroForTests, resolveFaroConfig } from "./faro";

afterEach(() => {
  resetFaroForTests();
});

describe("resolveFaroConfig", () => {
  it("is null when no collector URL is configured", () => {
    expect(resolveFaroConfig({})).toBeNull();
    expect(resolveFaroConfig({ VITE_FARO_URL: "" })).toBeNull();
    expect(resolveFaroConfig({ VITE_FARO_URL: "   " })).toBeNull();
    // A name or version alone never turns it on: the URL is the whole gate.
    expect(
      resolveFaroConfig({ VITE_FARO_APP_NAME: "pqp-web", VITE_FARO_APP_VERSION: "abc" }),
    ).toBeNull();
  });

  it("builds config from the URL, with sensible defaults", () => {
    expect(
      resolveFaroConfig({ VITE_FARO_URL: "https://collector.example/collect/x" }),
    ).toEqual({
      url: "https://collector.example/collect/x",
      appName: "pqp-web",
      appVersion: "dev",
      environment: "production",
    });
  });

  it("takes the app name and version when given", () => {
    expect(
      resolveFaroConfig({
        VITE_FARO_URL: "https://collector.example/collect/x",
        VITE_FARO_APP_NAME: "pqp-web",
        VITE_FARO_APP_VERSION: "deadbeef",
      }),
    ).toEqual({
      url: "https://collector.example/collect/x",
      appName: "pqp-web",
      appVersion: "deadbeef",
      environment: "production",
    });
  });
});

describe("initFaro", () => {
  it("initialises NOTHING when the collector URL is unset (a self-host build)", () => {
    const initialize = vi.fn();
    const result = initFaro({ env: {}, initialize });
    expect(result).toBeNull();
    expect(initialize).not.toHaveBeenCalled();
  });

  it("initialises with the resolved config when the URL is set", () => {
    const fakeFaro = { api: {} } as unknown as ReturnType<typeof initFaro>;
    const initialize = vi.fn().mockReturnValue(fakeFaro);
    const result = initFaro({
      env: {
        VITE_FARO_URL: "https://collector.example/collect/x",
        VITE_FARO_APP_NAME: "pqp-web",
        VITE_FARO_APP_VERSION: "deadbeef",
      },
      initialize: initialize as never,
    });
    expect(result).toBe(fakeFaro);
    expect(initialize).toHaveBeenCalledTimes(1);
    const config = initialize.mock.calls[0]![0] as {
      url: string;
      app: { name: string; version: string; environment: string };
      instrumentations: unknown[];
      user?: unknown;
    };
    expect(config.url).toBe("https://collector.example/collect/x");
    expect(config.app).toEqual({
      name: "pqp-web",
      version: "deadbeef",
      environment: "production",
    });
    expect(config.instrumentations.length).toBeGreaterThan(0);
    // The volume guard is wired in.
    expect((config as { beforeSend?: unknown }).beforeSend).toBe(dropNoisyItems);
    // No user identity is ever attached (PII posture).
    expect(config.user).toBeUndefined();
  });

  it("is idempotent: a second call does not initialise again", () => {
    const initialize = vi.fn().mockReturnValue({} as never);
    const env = { VITE_FARO_URL: "https://collector.example/collect/x" };
    initFaro({ env, initialize: initialize as never });
    initFaro({ env, initialize: initialize as never });
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});

describe("dropNoisyItems", () => {
  it("drops per-request resource timing events", () => {
    expect(
      dropNoisyItems({ type: "event", payload: { name: "faro.performance.resource" } }),
    ).toBeNull();
  });

  it("keeps everything the dashboards and alerts rely on", () => {
    const keep = [
      { type: "event", payload: { name: "faro.performance.navigation" } },
      { type: "event", payload: { name: "session_start" } },
      { type: "event", payload: { name: "something_custom" } },
      { type: "exception", payload: { type: "Error", value: "boom" } },
      { type: "log", payload: { message: "console error" } },
      { type: "measurement", payload: { type: "web-vitals", values: { lcp: 1 } } },
    ];
    for (const item of keep) {
      expect(dropNoisyItems(item)).toBe(item);
    }
  });
});
