import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  probeCommunitiesEnabled,
  resetCommunitiesProbe,
  RETRY_AFTER_MS,
} from "./use-communities-enabled";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("probeCommunitiesEnabled", () => {
  beforeEach(() => {
    resetCommunitiesProbe();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks the public endpoint, with no auth", async () => {
    const fetchMock = vi.fn(async () => json(200, { enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    await probeCommunitiesEnabled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/public\/communities\/config$/);
    expect(JSON.stringify(init)).not.toMatch(/authorization/i);
  });

  it("200 true shows, 200 false hides, and both are cached", async () => {
    const fetchMock = vi.fn(async () => json(200, { enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeCommunitiesEnabled()).toBe(true);
    expect(await probeCommunitiesEnabled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resetCommunitiesProbe();
    const off = vi.fn(async () => json(200, { enabled: false }));
    vi.stubGlobal("fetch", off);
    expect(await probeCommunitiesEnabled()).toBe(false);
    await probeCommunitiesEnabled();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["401", () => json(401, { error: "unauthorized" })],
    ["404", () => json(404, { error: "not found" })],
    ["malformed body", () => json(200, { enabled: "yes" })],
  ])("hides on %s", async (_name, make) => {
    vi.stubGlobal("fetch", vi.fn(async () => make()));
    expect(await probeCommunitiesEnabled()).toBe(false);
  });

  it("hides on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("net"))));
    expect(await probeCommunitiesEnabled()).toBe(false);
  });

  it("does not cache a failure for the page load: retries after a short backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("net"))
      .mockResolvedValue(json(200, { enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeCommunitiesEnabled()).toBe(false);
    // Inside the window: no new request.
    expect(await probeCommunitiesEnabled()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RETRY_AFTER_MS + 1);
    expect(await probeCommunitiesEnabled()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
