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
 * not become five hundred loads, and that toggling Voz drops the snapshot
 * so the next join cannot keep the old answer.
 */

const CHANNEL = "11111111-1111-4111-8111-111111111111";

const voiceOff: Exclude<WatchPartySeatSnapshot, null> = {
  voiceEnabled: false,
  hostUserId: "host",
  cohostIds: ["cohost"],
  invitedIds: ["guest"],
};

afterEach(() => {
  resetWatchPartySeatCacheForTests();
});

describe("watchPartySeatForUser", () => {
  it("derives host, co-host and invite from the lists, not from a per-user query", () => {
    expect(watchPartySeatForUser(voiceOff, "host")).toEqual({
      voiceEnabled: false,
      isHost: true,
      isCohost: false,
      isInvited: false,
    });
    expect(watchPartySeatForUser(voiceOff, "cohost")?.isCohost).toBe(true);
    expect(watchPartySeatForUser(voiceOff, "guest")?.isInvited).toBe(true);
    expect(watchPartySeatForUser(voiceOff, "viewer")).toEqual({
      voiceEnabled: false,
      isHost: false,
      isCohost: false,
      isInvited: false,
    });
  });

  it("treats a null snapshot as no party, which is not a closed room", () => {
    expect(watchPartySeatForUser(null, "viewer")).toBeNull();
  });
});

describe("the seat snapshot cache", () => {
  it("does not call the loader for a second viewer of the same party", async () => {
    const load = vi.fn(async () => voiceOff);
    const first = await cachedWatchPartySeatSnapshot(CHANNEL, load);
    const second = await cachedWatchPartySeatSnapshot(CHANNEL, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(watchPartySeatForUser(second, "viewer")?.voiceEnabled).toBe(false);
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
    release(voiceOff);
    expect(await a).toEqual(voiceOff);
    expect(await b).toEqual(voiceOff);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("invalidating Voz drops the snapshot so the next join reloads", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(voiceOff)
      .mockResolvedValueOnce({ ...voiceOff, voiceEnabled: true });
    expect(
      (await cachedWatchPartySeatSnapshot(CHANNEL, load))?.voiceEnabled,
    ).toBe(false);
    invalidateWatchPartySeat(CHANNEL);
    expect(peekWatchPartySeatSnapshot(CHANNEL)).toBeUndefined();
    const next = await cachedWatchPartySeatSnapshot(CHANNEL, load);
    expect(next?.voiceEnabled).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a thrown load, so a hiccup cannot stick as voice-off", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("the database is having a bad minute"))
      .mockResolvedValueOnce(voiceOff);
    await expect(cachedWatchPartySeatSnapshot(CHANNEL, load)).rejects.toThrow(
      /bad minute/,
    );
    expect(peekWatchPartySeatSnapshot(CHANNEL)).toBeUndefined();
    expect(await cachedWatchPartySeatSnapshot(CHANNEL, load)).toEqual(voiceOff);
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
      ...voiceOff,
      voiceEnabled: true,
    });
    release(voiceOff);
    expect((await pending)?.voiceEnabled).toBe(true);
    expect(peekWatchPartySeatSnapshot(CHANNEL)?.voiceEnabled).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
