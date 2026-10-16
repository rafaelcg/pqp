import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BOOT_PREFETCH_TTL_MS,
  clearBootPrefetch,
  putBootPrefetch,
  takeBootPrefetch,
  takeOrFetch,
} from "./boot-prefetch";
import {
  fetchChannels,
  fetchMessages,
  prefetchBootReads,
  setAuthTokenProvider,
} from "./api";
import { parseAppRoute } from "./app-route";

const SID = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";

describe("boot prefetch store", () => {
  afterEach(() => clearBootPrefetch());

  it("hands an entry out once", async () => {
    putBootPrefetch("k", Promise.resolve(1));
    expect(await takeBootPrefetch<number>("k")).toBe(1);
    expect(takeBootPrefetch("k")).toBeNull();
  });

  it("ignores an entry older than the TTL, and still removes it", () => {
    putBootPrefetch("k", Promise.resolve(1), 1_000);
    expect(takeBootPrefetch("k", 1_000 + BOOT_PREFETCH_TTL_MS + 1)).toBeNull();
    expect(takeBootPrefetch("k", 1_001)).toBeNull();
  });

  it("falls back to the network when the speculative read failed", async () => {
    putBootPrefetch("k", Promise.reject(new Error("blip")));
    const network = vi.fn(async () => "fresh");
    expect(await takeOrFetch("k", network)).toBe("fresh");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("uses the prefetched answer without touching the network", async () => {
    putBootPrefetch("k", Promise.resolve("early"));
    const network = vi.fn(async () => "fresh");
    expect(await takeOrFetch("k", network)).toBe("early");
    expect(network).not.toHaveBeenCalled();
    // The second ask is a real read.
    expect(await takeOrFetch("k", network)).toBe("fresh");
  });

  it("forgets everything when the session ends", () => {
    putBootPrefetch("a", Promise.resolve(1));
    putBootPrefetch("b", Promise.resolve(2));
    clearBootPrefetch();
    expect(takeBootPrefetch("a")).toBeNull();
    expect(takeBootPrefetch("b")).toBeNull();
  });
});

describe("prefetchBootReads through the api client", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const urls = () => fetchSpy.mock.calls.map((call) => String(call[0]));
  // The client resolves its token before it calls fetch, so a started read shows
  // up one macrotask later.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    clearBootPrefetch();
    setAuthTokenProvider(async () => "token");
    fetchSpy = vi.fn(async (url: string) => {
      const body = String(url).includes("/messages")
        ? { messages: [], hasMore: false }
        : { channels: [] };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
  });

  afterEach(() => {
    clearBootPrefetch();
    vi.unstubAllGlobals();
  });

  it("starts the channel list and the newest page the address names, once each", async () => {
    prefetchBootReads(parseAppRoute(`/app/server/${SID}/channel/${CID}`));
    await flush();
    expect(urls().sort()).toEqual(
      [
        `/api/channels/${CID}/messages`,
        `/api/servers/${SID}/channels`,
      ].sort(),
    );

    // The app's own asks a moment later do not go to the network again...
    await fetchChannels(SID);
    await fetchMessages(CID);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // ...but the next ones do: an entry is single use.
    await fetchChannels(SID);
    await fetchMessages(CID);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("never answers a page of older history from the prefetch", async () => {
    prefetchBootReads(parseAppRoute(`/app/server/${SID}/channel/${CID}`));
    await flush();
    await fetchMessages(CID, { before: "cursor" });
    expect(urls().filter((url) => url.includes("before=cursor"))).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("starts only the channel list for a server link with no channel", async () => {
    prefetchBootReads(parseAppRoute(`/app/server/${SID}`));
    await flush();
    expect(urls()).toEqual([`/api/servers/${SID}/channels`]);
  });

  it("starts nothing for a link to one message, a conversation, or no link", async () => {
    prefetchBootReads(
      parseAppRoute(`/app/server/${SID}/channel/${CID}/message/abc`),
    );
    await flush();
    // The channel list is still wanted; the newest page is not.
    expect(urls()).toEqual([`/api/servers/${SID}/channels`]);
    fetchSpy.mockClear();
    prefetchBootReads(parseAppRoute(`/app/dm/${CID}`));
    prefetchBootReads(parseAppRoute("/app"));
    prefetchBootReads(null);
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the bootstrap asks before it waits", () => {
  // `init()` lives inside a 14k-line component, so the property that matters
  // (the reads that do not need `/api/me` are STARTED before it is awaited) is
  // pinned on the source, the way `heartbeat.test.ts` pins the entry point.
  const source = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
  const start = source.indexOf("async function init()");
  const init = source.slice(
    start,
    source.indexOf("The automatic first load (bootstrapAttempt === 0)", start),
  );
  const at = (needle: string) => {
    const index = init.indexOf(needle);
    expect(index, `${needle} is in init()`).toBeGreaterThan(-1);
    return index;
  };

  it("starts ICE, the voice backend, the servers and the address reads before awaiting me", () => {
    const meAwait = at("await fetchMe()");
    expect(at("fetchIceServers()")).toBeLessThan(meAwait);
    expect(at("fetchVoiceBackend()")).toBeLessThan(meAwait);
    expect(at("fetchServers()")).toBeLessThan(meAwait);
    expect(at("prefetchBootReads(")).toBeLessThan(meAwait);
  });

  it("does not start a second, serial read of any of them after me", () => {
    const meAwait = at("await fetchMe()");
    const after = init.slice(meAwait);
    for (const call of ["fetchIceServers()", "fetchVoiceBackend()", "fetchServers()"]) {
      expect(after.includes(call), `${call} only before me`).toBe(false);
    }
  });

  it("clears what it read ahead of time when the shell unmounts", () => {
    expect(source).toContain("clearBootPrefetch()");
  });
});
