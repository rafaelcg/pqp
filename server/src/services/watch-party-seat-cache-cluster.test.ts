import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The watch-party seat snapshot (`services/watch-party-seat-cache.ts`), across
 * two "instances" — the multi-process shape `docs/plans/ALWAYS_ON.md` moves
 * to next, with `CLUSTER_BUS=postgres` carrying cross-process events.
 *
 * `watch-party-seat.test.ts` next door already pins this cache's single-process
 * behaviour, including that it has NO TTL: it answers from memory until
 * something explicitly drops it. That is fine on one process, because
 * `broadcastWatchParty` sees every mutation and drops it there. Behind a load
 * balancer with no session affinity it is not: a mutation handled on instance
 * A only ever cleared A's copy, so B could go on answering "voice on" (or a
 * removed co-host, or a still-live stage invite) for as long as the party ran
 * — the exact shape PR #593 fixed for the age gate, except with no TTL at all
 * to bound it. This file pins the fix: `invalidateWatchPartySeat` and
 * `rememberWatchPartySeatSnapshot` publish over the bus, so a sibling instance
 * drops its own copy on the same event and its next
 * `cachedWatchPartySeatSnapshot` call is a fresh load.
 *
 * Unlike `permission-caches-cluster.test.ts`, this module has no database of
 * its own — the loader is whatever the caller passes in — so the two
 * "instances" here need nothing but two module graphs sharing one in-memory
 * bus hub, no Postgres involved.
 */

type CacheModule = typeof import("./watch-party-seat-cache.js");
type BusModule = typeof import("../lib/bus.js");

interface Instance {
  cache: CacheModule;
  bus: BusModule;
}

const { createMemoryHub } = await import("../lib/bus.js");
let hub = createMemoryHub();

async function bootInstance(
  { withBus = true }: { withBus?: boolean } = {},
): Promise<Instance> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const cache = (await import("./watch-party-seat-cache.js")) as CacheModule;
  if (withBus) {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  }
  return { bus, cache };
}

const CHANNEL = "22222222-2222-4222-8222-222222222222";

const voiceOn = {
  guests: "invite" as const,
  hostUserId: "host",
  cohostIds: ["cohost"],
  acceptedGuestIds: ["guest"],
};

describe("watch-party seat cache across two instances", () => {
  beforeEach(() => {
    hub = createMemoryHub();
  });

  it("drops a sibling instance's stale snapshot when a mutation invalidates it", async () => {
    const a = await bootInstance();
    const b = await bootInstance();

    // Both instances warm their own copy with the pre-mutation answer —
    // modelling two API processes behind a load balancer, each having
    // served a `join-voice-room` for this channel already.
    const load = async () => voiceOn;
    expect(await a.cache.cachedWatchPartySeatSnapshot(CHANNEL, load)).toEqual(
      voiceOn,
    );
    expect(await b.cache.cachedWatchPartySeatSnapshot(CHANNEL, load)).toEqual(
      voiceOn,
    );
    expect(b.cache.peekWatchPartySeatSnapshot(CHANNEL)).toEqual(voiceOn);

    // The host turns Voz off. The write lands on instance A, which is the
    // only one that ran `broadcastWatchParty` for it.
    a.cache.invalidateWatchPartySeat(CHANNEL);

    // Instance B must not still be answering from its now-stale cache entry
    // — this is the property PR #593 pinned for the age gate, applied here.
    expect(b.cache.peekWatchPartySeatSnapshot(CHANNEL)).toBeUndefined();
  });

  it("propagates a planted terminal snapshot (party ended) as an invalidation, not a stale replica", async () => {
    const a = await bootInstance();
    const b = await bootInstance();

    const load = async () => voiceOn;
    await a.cache.cachedWatchPartySeatSnapshot(CHANNEL, load);
    await b.cache.cachedWatchPartySeatSnapshot(CHANNEL, load);

    // The party ends. `broadcastWatchParty` already knows the answer is
    // "none" and plants it directly rather than re-querying.
    a.cache.rememberWatchPartySeatSnapshot(CHANNEL, null);
    expect(a.cache.peekWatchPartySeatSnapshot(CHANNEL)).toBeNull();

    // B does not receive A's planted value over the wire — it receives an
    // invalidation and would reload on its own next call, which is what
    // matters: it must not keep serving the ended party's old "voice on"
    // snapshot forever.
    expect(b.cache.peekWatchPartySeatSnapshot(CHANNEL)).toBeUndefined();
  });

  it("leaves a sibling instance's cache untouched with no bus transport installed", async () => {
    const a = await bootInstance();
    const b = await bootInstance({ withBus: false });

    const load = async () => voiceOn;
    await a.cache.cachedWatchPartySeatSnapshot(CHANNEL, load);
    await b.cache.cachedWatchPartySeatSnapshot(CHANNEL, load);

    a.cache.invalidateWatchPartySeat(CHANNEL);

    // With no transport installed on B, `isBusEnabled()` is false there and
    // `publishToCluster` on A returns before building a frame — the
    // documented single-instance degradation: B's cache is unaware of a
    // mutation it never heard about.
    expect(b.cache.peekWatchPartySeatSnapshot(CHANNEL)).toEqual(voiceOn);
  });
});
