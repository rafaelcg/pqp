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

describe("the stores re-ask what they hold", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    fetchLiveHlsConfigMock.mockReset();
    waitlist.resetWatchPartyWaitlistStore();
    liveHls.resetLiveHlsConfigCache();
  });

  it("the waitlist teaser goes away when the campaign flag is turned off", async () => {
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

  it("a failed re-ask keeps the answer it had", async () => {
    apiFetchMock.mockResolvedValueOnce(STATE);
    await waitlist.loadWatchPartyWaitlist(null);
    apiFetchMock.mockRejectedValueOnce(new Error("offline"));
    await waitlist.revalidateWatchPartyWaitlist();
    expect(waitlist.peekWatchPartyWaitlist(null)).toEqual(STATE);
  });

  it("an answer that lands after an account change is dropped", async () => {
    apiFetchMock.mockResolvedValueOnce(STATE);
    await waitlist.loadWatchPartyWaitlist("s1");
    let release: (value: WatchPartyWaitlistState) => void = () => {};
    apiFetchMock.mockReturnValueOnce(
      new Promise<WatchPartyWaitlistState>((resolve) => {
        release = resolve;
      }),
    );
    const pending = waitlist.revalidateWatchPartyWaitlist();
    waitlist.setWatchPartyWaitlistOwner("somebody-else");
    release({ ...STATE, campaign: false });
    await pending;
    expect(waitlist.peekWatchPartyWaitlist("s1")).toBeNull();
  });

  it("the live-hls config swaps in a changed camera size and tells its hooks", async () => {
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
    // The cached promise moved too, so a later load does not resurrect 480.
    await expect(liveHls.loadLiveHlsConfig("s1")).resolves.toEqual({
      enabled: true,
      cameraHeight: 360,
    });
  });
});
