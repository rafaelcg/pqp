import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchPartyWaitlistState } from "@pqp/shared";

/**
 * A runtime flag flipped on the dashboard has to reach a tab that is already
 * open. These pin the three halves: the pass is throttled, the live-hls
 * config store swaps in a changed answer, and the waitlist store does too
 * (which is what takes the teaser down without a reload).
 */

const apiFetchMock = vi.hoisted(() => vi.fn());
const fetchLiveHlsConfigMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  fetchLiveHlsConfig: (...args: unknown[]) => fetchLiveHlsConfigMock(...args),
}));

const refresh = await import("./config-refresh");
const waitlist = await import("./watch-party-waitlist");
const liveHls = await import("@/hooks/use-live-hls-config");

const STATE: WatchPartyWaitlistState = {
  campaign: true,
  canRequest: true,
  available: false,
  entry: null,
};

describe("requestConfigRefresh", () => {
  beforeEach(() => {
    refresh.resetConfigRefreshForTests();
  });

  it("runs every registered store, at most once per gap", () => {
    const a = vi.fn();
    const b = vi.fn();
    refresh.onConfigRefresh(a);
    const stopB = refresh.onConfigRefresh(b);
    const t0 = 10_000_000;
    expect(refresh.requestConfigRefresh({ now: t0 })).toBe(true);
    expect(refresh.requestConfigRefresh({ now: t0 + 1_000 })).toBe(false);
    expect(a).toHaveBeenCalledTimes(1);
    stopB();
    expect(
      refresh.requestConfigRefresh({ now: t0 + refresh.CONFIG_REFRESH_MIN_GAP_MS }),
    ).toBe(true);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("one store throwing does not stop the next", () => {
    const after = vi.fn();
    refresh.onConfigRefresh(() => {
      throw new Error("boom");
    });
    refresh.onConfigRefresh(after);
    refresh.requestConfigRefresh({ force: true });
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("the stores re-ask what is on screen", () => {
  const releases: (() => void)[] = [];

  beforeEach(() => {
    while (releases.length > 0) {
      releases.pop()!();
    }
    apiFetchMock.mockReset();
    fetchLiveHlsConfigMock.mockReset();
    waitlist.resetWatchPartyWaitlistStore();
    liveHls.resetLiveHlsConfigCache();
  });

  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("the waitlist teaser goes away when the campaign flag is turned off", async () => {
    releases.push(waitlist.watchWatchPartyWaitlist("s1"));
    apiFetchMock.mockResolvedValueOnce(STATE);
    await waitlist.loadWatchPartyWaitlist("s1");
    expect(
      waitlist.shouldOfferWatchPartyTeaser({
        hlsEnabled: false,
        state: waitlist.peekWatchPartyWaitlist("s1"),
      }),
    ).toBe(true);

    apiFetchMock.mockResolvedValueOnce({ ...STATE, campaign: false });
    await waitlist.revalidateWatchPartyWaitlist();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/api/watch-party/waitlist?serverId=s1");
    expect(
      waitlist.shouldOfferWatchPartyTeaser({
        hlsEnabled: false,
        state: waitlist.peekWatchPartyWaitlist("s1"),
      }),
    ).toBe(false);
  });

  it("re-asks only what is watched; the rest is re-asked on its next read", async () => {
    for (let i = 0; i < 20; i += 1) {
      apiFetchMock.mockResolvedValueOnce(STATE);
      await waitlist.loadWatchPartyWaitlist(`old-${i}`);
    }
    releases.push(waitlist.watchWatchPartyWaitlist("old-3"));
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue(STATE);
    await waitlist.revalidateWatchPartyWaitlist();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    // A server visited earlier: its answer is handed over at once and
    // re-asked behind it, exactly once.
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValueOnce({ ...STATE, campaign: false });
    expect(await waitlist.loadWatchPartyWaitlist("old-7")).toEqual(STATE);
    await vi.waitFor(() =>
      expect(waitlist.peekWatchPartyWaitlist("old-7")?.campaign).toBe(false),
    );
    await waitlist.loadWatchPartyWaitlist("old-7");
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed re-ask keeps the answer it had", async () => {
    releases.push(waitlist.watchWatchPartyWaitlist("s1"));
    apiFetchMock.mockResolvedValueOnce(STATE);
    await waitlist.loadWatchPartyWaitlist("s1");
    apiFetchMock.mockRejectedValueOnce(new Error("offline"));
    await waitlist.revalidateWatchPartyWaitlist();
    expect(waitlist.peekWatchPartyWaitlist("s1")).toEqual(STATE);
  });

  it("a re-ask that lands after a join, a forget or an account change is dropped", async () => {
    releases.push(waitlist.watchWatchPartyWaitlist("s1"));
    apiFetchMock.mockResolvedValueOnce(STATE);
    await waitlist.loadWatchPartyWaitlist("s1");

    // A join lands while the re-ask is out.
    let slow = deferred<WatchPartyWaitlistState>();
    apiFetchMock.mockReturnValueOnce(slow.promise);
    let pending = waitlist.revalidateWatchPartyWaitlist();
    const entry = {
      serverId: "s1",
      kind: "request",
      status: "waiting",
      audienceBucket: null,
      note: null,
      streamChannel: null,
      createdAt: "2026-09-26T00:00:00.000Z",
      decidedAt: null,
    } as const;
    waitlist.rememberWatchPartyWaitlistEntry("s1", entry);
    slow.resolve(STATE);
    await pending;
    expect(waitlist.peekWatchPartyWaitlist("s1")?.entry).toEqual(entry);

    // An approval acknowledged (forget) while the re-ask is out.
    slow = deferred<WatchPartyWaitlistState>();
    apiFetchMock.mockReturnValueOnce(slow.promise);
    pending = waitlist.revalidateWatchPartyWaitlist();
    waitlist.forgetWatchPartyWaitlist("s1");
    slow.resolve(STATE);
    await pending;
    expect(waitlist.peekWatchPartyWaitlist("s1")).toBeNull();

    // Another account signs in while the re-ask is out.
    apiFetchMock.mockResolvedValueOnce(STATE);
    await waitlist.loadWatchPartyWaitlist("s1");
    slow = deferred<WatchPartyWaitlistState>();
    apiFetchMock.mockReturnValueOnce(slow.promise);
    pending = waitlist.revalidateWatchPartyWaitlist();
    waitlist.setWatchPartyWaitlistOwner("somebody-else");
    slow.resolve({ ...STATE, campaign: false });
    await pending;
    expect(waitlist.peekWatchPartyWaitlist("s1")).toBeNull();
  });

  it("the live-hls config swaps in a changed camera size and tells its hooks", async () => {
    const onChange = vi.fn();
    releases.push(liveHls.watchLiveHlsConfig("s1", onChange));
    fetchLiveHlsConfigMock.mockResolvedValueOnce({ enabled: true, cameraHeight: 480 });
    await liveHls.loadLiveHlsConfig("s1");
    fetchLiveHlsConfigMock.mockResolvedValueOnce({ enabled: true, delaySeconds: 1 });
    await liveHls.loadLiveHlsConfig();

    fetchLiveHlsConfigMock.mockImplementation(async (serverId?: string) =>
      serverId === "s1"
        ? { enabled: true, cameraHeight: 360 }
        : { enabled: true, delaySeconds: 1 },
    );
    await liveHls.revalidateLiveHlsConfig();
    expect(fetchLiveHlsConfigMock.mock.calls.slice(-2).sort()).toEqual([[undefined], ["s1"]]);
    expect(liveHls.settledLiveHlsConfig("s1")).toEqual({ enabled: true, cameraHeight: 360 });
    expect(onChange).toHaveBeenCalledTimes(1);
    // The cached promise moved too, so a later load does not resurrect 480.
    await expect(liveHls.loadLiveHlsConfig("s1")).resolves.toEqual({
      enabled: true,
      cameraHeight: 360,
    });
  });

  it("live-hls: only watched servers are re-asked, and one request per key at a time, so an older pass can never land last", async () => {
    for (let i = 0; i < 20; i += 1) {
      fetchLiveHlsConfigMock.mockResolvedValueOnce({ enabled: false });
      await liveHls.loadLiveHlsConfig(`old-${i}`);
    }
    releases.push(liveHls.watchLiveHlsConfig("old-3", () => {}));
    fetchLiveHlsConfigMock.mockClear();

    const first = deferred<{ enabled: boolean }>();
    fetchLiveHlsConfigMock.mockReturnValueOnce(first.promise);
    const a = liveHls.revalidateLiveHlsConfig();
    // A second pass while the first is out asks nothing for that key.
    const b = liveHls.revalidateLiveHlsConfig();
    expect(fetchLiveHlsConfigMock).toHaveBeenCalledTimes(1);
    first.resolve({ enabled: true });
    await Promise.all([a, b]);
    expect(liveHls.settledLiveHlsConfig("old-3")).toEqual({ enabled: true });


    // An unwatched server's old answer still draws the first frame, and its
    // next load asks again rather than trusting it.
    expect(liveHls.settledLiveHlsConfig("old-7")).toEqual({ enabled: false });
    fetchLiveHlsConfigMock.mockResolvedValueOnce({ enabled: true });
    await expect(liveHls.loadLiveHlsConfig("old-7")).resolves.toEqual({ enabled: true });
  });
});
