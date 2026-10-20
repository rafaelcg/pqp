import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACQUISITION_KEY,
  peekAcquisition,
  stashAcquisition,
  takeAcquisition,
} from "./acquisition";
import {
  APPS_DOOR_VIEW_EVENT,
  APPS_LANDING_REF,
  LOCADORA_LANDING_REF,
  appsCtaHref,
  appsDocsUrlFrom,
  cachedAppsLanding,
  probeAppsLanding,
  rememberAppsRef,
  resetAppsLandingProbe,
  RETRY_AFTER_MS,
  trackAppsDoorView,
} from "./apps-landing";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe("probeAppsLanding", () => {
  beforeEach(() => {
    resetAppsLandingProbe();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks the public endpoint, with no credential", async () => {
    const fetchMock = vi.fn(async () => json(200, { enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    await probeAppsLanding();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/public\/apps\/config$/);
    expect(JSON.stringify(init)).not.toMatch(/authorization/i);
  });

  it("200 true is on, 200 false is off, and both are cached", async () => {
    const on = vi.fn(async () => json(200, { enabled: true }));
    vi.stubGlobal("fetch", on);
    expect(cachedAppsLanding()).toBeNull();
    expect(await probeAppsLanding()).toBe(true);
    expect(await probeAppsLanding()).toBe(true);
    expect(cachedAppsLanding()).toBe(true);
    expect(on).toHaveBeenCalledTimes(1);

    resetAppsLandingProbe();
    const off = vi.fn(async () => json(200, { enabled: false }));
    vi.stubGlobal("fetch", off);
    expect(await probeAppsLanding()).toBe(false);
    expect(cachedAppsLanding()).toBe(false);
    await probeAppsLanding();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["401", () => json(401, { error: "unauthorized" })],
    ["404 (an API that has no such route)", () => json(404, { error: "not found" })],
    ["500", () => json(500, { error: "boom" })],
    ["a body with no boolean", () => json(200, { enabled: "true" })],
    ["a non-JSON body", () => new Response("<html>", { status: 200 })],
  ])("fails closed on %s, and does not cache the failure forever", async (_name, reply) => {
    const fetchMock = vi.fn(async () => reply());
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeAppsLanding()).toBe(false);
    expect(cachedAppsLanding()).toBeNull();
    // Inside the retry window: no second request.
    expect(await probeAppsLanding()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // After it: asked again, and a good answer wins.
    vi.advanceTimersByTime(RETRY_AFTER_MS + 1);
    fetchMock.mockImplementation(async () => json(200, { enabled: true }));
    expect(await probeAppsLanding()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a network error is off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    expect(await probeAppsLanding()).toBe(false);
  });

  it("shares one request between concurrent callers", async () => {
    const fetchMock = vi.fn(async () => json(200, { enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([probeAppsLanding(), probeAppsLanding(), probeAppsLanding()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the docs link, hosted-only like the donation links", () => {
  it("is absent when the variable is empty, blank or missing", () => {
    expect(appsDocsUrlFrom({})).toBeNull();
    expect(appsDocsUrlFrom({ VITE_APPS_DOCS_URL: "" })).toBeNull();
    expect(appsDocsUrlFrom({ VITE_APPS_DOCS_URL: "   " })).toBeNull();
    expect(appsDocsUrlFrom({ VITE_APPS_DOCS_URL: undefined })).toBeNull();
  });

  it("keeps an absolute http(s) URL", () => {
    expect(appsDocsUrlFrom({ VITE_APPS_DOCS_URL: " https://docs.pqp.gg/apps " })).toBe(
      "https://docs.pqp.gg/apps",
    );
  });

  it("refuses anything that is not a web URL, because it ends up in an href", () => {
    for (const bad of ["javascript:alert(1)", "/relative", "docs.pqp.gg", "data:text/html,x", "ftp://x.test"]) {
      expect(appsDocsUrlFrom({ VITE_APPS_DOCS_URL: bad }), bad).toBeNull();
    }
  });
});

describe("the sign-up tag", () => {
  it("rides the /app URL as the belt", () => {
    expect(appsCtaHref(APPS_LANDING_REF)).toBe("/app?ref=apps-landing");
    expect(appsCtaHref(LOCADORA_LANDING_REF)).toBe("/app?ref=locadora-landing");
  });

  it("is stashed as the site's own ref, with the page it came from, and consumed once", () => {
    const storage = memoryStorage();
    rememberAppsRef(LOCADORA_LANDING_REF, "/apps/locadora", storage, 1_000);
    const stored = peekAcquisition(storage, 1_000);
    expect(stored).toMatchObject({ ref: "locadora-landing", landing: "/apps" });
    // Sent to the API once, then gone.
    expect(takeAcquisition(storage, 1_000)).toMatchObject({ ref: "locadora-landing" });
    expect(storage.getItem(ACQUISITION_KEY)).toBeNull();
  });

  it("replaces a plain visit (just a landing) but never an earlier explicit campaign", () => {
    const plain = memoryStorage();
    stashAcquisition(plain, { landing: "/apps" }, 500, true);
    rememberAppsRef(APPS_LANDING_REF, "/apps", plain, 1_000);
    expect(peekAcquisition(plain, 1_000)).toMatchObject({ ref: "apps-landing" });

    const campaign = memoryStorage();
    stashAcquisition(campaign, { source: "google", medium: "cpc", landing: "/" }, 500);
    rememberAppsRef(APPS_LANDING_REF, "/apps", campaign, 1_000);
    const kept = peekAcquisition(campaign, 1_000);
    expect(kept).toMatchObject({ source: "google" });
    expect(kept?.ref).toBeUndefined();
  });

  it("does nothing, and does not throw, with storage denied", () => {
    expect(() => rememberAppsRef(APPS_LANDING_REF, "/apps", null)).not.toThrow();
  });
});

describe("measurement", () => {
  it("is exactly one closed event, with no properties", () => {
    const track = vi.fn();
    vi.stubGlobal("window", { umami: { track } });
    trackAppsDoorView();
    vi.unstubAllGlobals();
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(APPS_DOOR_VIEW_EVENT, undefined);
    expect(APPS_DOOR_VIEW_EVENT).toBe("apps_door_view");
  });

  it("is inert without the hosted tag", () => {
    vi.stubGlobal("window", {});
    expect(() => trackAppsDoorView()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
