import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchPartySeatSnapshot } from "./watch-party-seat-cache.js";
import {
  cachedWatchPartySeatSnapshot,
  invalidateWatchPartySeat,
  peekWatchPartySeatSnapshot,
  rememberWatchPartySeatSnapshot,
  resetWatchPartySeatCacheForTests,
  watchPartySeatForUser,
} from "./watch-party-seat-cache.js";

/**
 * The join gate's seat snapshot, without a database.
 *
 * `loadWatchPartySeat` is the SQL; this is the cache in front of it. The
 * assertion that matters is that five hundred viewers against one party do
 * not become five hundred loads, and that toggling Convidados drops the
 * snapshot so the next join cannot keep the old answer.
 */

const CHANNEL = "11111111-1111-4111-8111-111111111111";

const guestsOff: Exclude<WatchPartySeatSnapshot, null> = {
  guests: "off",
  hostUserId: "host",
  cohostIds: ["cohost"],
  acceptedGuestIds: ["guest"],
};

afterEach(() => {
  resetWatchPartySeatCacheForTests();
});

describe("watchPartySeatForUser", () => {
  it("derives host, co-host and guest from the lists, not from a per-user query", () => {
    expect(watchPartySeatForUser(guestsOff, "host")).toEqual({
      guests: "off",
      isHost: true,
      isCohost: false,
      isGuest: false,
    });
    expect(watchPartySeatForUser(guestsOff, "cohost")?.isCohost).toBe(true);
    expect(watchPartySeatForUser(guestsOff, "guest")?.isGuest).toBe(true);
    expect(watchPartySeatForUser(guestsOff, "viewer")).toEqual({
      guests: "off",
      isHost: false,
      isCohost: false,
      isGuest: false,
    });
  });

  it("treats a null snapshot as no party, which is not a closed room", () => {
    expect(watchPartySeatForUser(null, "viewer")).toBeNull();
  });
});

describe("the seat snapshot cache", () => {
  it("does not call the loader for a second viewer of the same party", async () => {
    const load = vi.fn(async () => guestsOff);
    const first = await cachedWatchPartySeatSnapshot(CHANNEL, load);
    const second = await cachedWatchPartySeatSnapshot(CHANNEL, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(watchPartySeatForUser(second, "viewer")?.guests).toBe("off");
    expect(watchPartySeatForUser(second, "host")?.isHost).toBe(true);
  });

  it("coalesces a stampede into one load", async () => {
    let release!: (snapshot: WatchPartySeatSnapshot) => void;
    const load = vi.fn(
      () =>
        new Promise<WatchPartySeatSnapshot>((resolve) => {
          release = resolve;
        }),
    );
    const a = cachedWatchPartySeatSnapshot(CHANNEL, load);
    const b = cachedWatchPartySeatSnapshot(CHANNEL, load);
    expect(load).toHaveBeenCalledTimes(1);
    release(guestsOff);
    expect(await a).toEqual(guestsOff);
    expect(await b).toEqual(guestsOff);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("invalidating Convidados drops the snapshot so the next join reloads", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(guestsOff)
      .mockResolvedValueOnce({ ...guestsOff, guests: "request" });
    expect(
      (await cachedWatchPartySeatSnapshot(CHANNEL, load))?.guests,
    ).toBe("off");
    invalidateWatchPartySeat(CHANNEL);
    expect(peekWatchPartySeatSnapshot(CHANNEL)).toBeUndefined();
    const next = await cachedWatchPartySeatSnapshot(CHANNEL, load);
    expect(next?.guests).toBe("request");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a thrown load, so a hiccup cannot stick as guests-off", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("the database is having a bad minute"))
      .mockResolvedValueOnce(guestsOff);
    await expect(cachedWatchPartySeatSnapshot(CHANNEL, load)).rejects.toThrow(
      /bad minute/,
    );
    expect(peekWatchPartySeatSnapshot(CHANNEL)).toBeUndefined();
    expect(await cachedWatchPartySeatSnapshot(CHANNEL, load)).toEqual(guestsOff);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not store a fetch that lost a race with a mutation", async () => {
    let release!: (snapshot: WatchPartySeatSnapshot) => void;
    const load = vi.fn(
      () =>
        new Promise<WatchPartySeatSnapshot>((resolve) => {
          release = resolve;
        }),
    );
    const pending = cachedWatchPartySeatSnapshot(CHANNEL, load);
    invalidateWatchPartySeat(CHANNEL);
    rememberWatchPartySeatSnapshot(CHANNEL, {
      ...guestsOff,
      guests: "request",
    });
    release(guestsOff);
    expect((await pending)?.guests).toBe("request");
    expect(peekWatchPartySeatSnapshot(CHANNEL)?.guests).toBe("request");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
