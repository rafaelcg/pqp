import { afterEach, describe, expect, it, vi } from "vitest";
import { createManifestLoader } from "./clip";

const MANIFEST = JSON.stringify({ clips: ["share.webm", "chat.webm"] });

function manifestResponse(): Response {
  return new Response(MANIFEST, { status: 200, headers: { "content-type": "application/json" } });
}

function stubFetch() {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createManifestLoader", () => {
  it("fetches the manifest once and reuses it", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(manifestResponse());
    const load = createManifestLoader();

    expect(await load()).toBe(MANIFEST);
    expect(await load()).toBe(MANIFEST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/media/home/manifest.json");
  });

  it("shares one request between concurrent callers", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(manifestResponse());
    const load = createManifestLoader();

    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBe(MANIFEST);
    expect(b).toBe(MANIFEST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries after a network error", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(manifestResponse());
    const load = createManifestLoader();

    expect(await load()).toBeNull();
    expect(await load()).toBe(MANIFEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await load()).toBe(MANIFEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a 5xx", async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } }))
      .mockResolvedValueOnce(manifestResponse());
    const load = createManifestLoader();

    expect(await load()).toBeNull();
    expect(await load()).toBe(MANIFEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a JSON answer that does not parse", async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        new Response('{"clips": [', { status: 200, headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(manifestResponse());
    const load = createManifestLoader();

    expect(await load()).toBeNull();
    expect(await load()).toBe(MANIFEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives concurrent callers the same failed answer, then retries once", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(manifestResponse());
    const load = createManifestLoader();

    const [a, b] = await Promise.all([load(), load()]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await load()).toBe(MANIFEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches a 404 as 'no footage'", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }));
    const load = createManifestLoader();

    expect(await load()).toBeNull();
    expect(await load()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches a 200 that is not JSON (an SPA fallback) as 'no footage'", async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const load = createManifestLoader();

    expect(await load()).toBeNull();
    expect(await load()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
