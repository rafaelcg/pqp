import { beforeEach, describe, expect, it } from "vitest";
import {
  collectWatchNowStreams,
  dismissedWatchNow,
  dismissWatchNow,
  pruneWatchNowDismissed,
  readDismissed,
  resetWatchNowDismissedForTests,
  ShareClock,
  visibleWatchNowStreams,
  watchNowAge,
  watchNowLiveKeys,
  withObservedStart,
  type WatchNowInput,
  type WatchNowParty,
  type WatchNowPeer,
} from "./watch-now";

const ME = "me";
const ALBERTO = "alberto";
const BIA = "bia";
const VOICE = "voice-1";
const OTHER_VOICE = "voice-2";
const PARTY_CHANNEL = "party-1";
const CONVERSATION = "conversation-1";

function peer(userId: string, sharingScreen = false): WatchNowPeer {
  return { userId, displayName: userId.toUpperCase(), sharingScreen };
}

function input(overrides: Partial<WatchNowInput> = {}): WatchNowInput {
  return {
    viewerId: ME,
    scope: {
      kind: "server",
      channels: [
        { id: VOICE, name: "filminho", type: "voice" },
        { id: OTHER_VOICE, name: "papo", type: "voice" },
        { id: "text-1", name: "general", type: "text" },
        { id: PARTY_CHANNEL, name: "watch-party", type: "watch_party" },
      ],
    },
    occupancy: {},
    parties: {},
    channelLive: {},
    blocked: new Set(),
    canConnect: () => true,
    seatedChannelId: null,
    ...overrides,
  };
}

const livePartyOf = (host = ALBERTO): WatchNowParty => ({
  channelId: PARTY_CHANNEL,
  name: "Cinemoon",
  state: "live",
  hostUserId: host,
  hostDisplayName: "Alberto",
  wentLiveAt: "2026-10-04T22:00:00.000Z",
});

describe("collectWatchNowStreams: a share in a voice channel", () => {
  it("names who and where, and counts the room besides the sharer", () => {
    const streams = collectWatchNowStreams(
      input({
        occupancy: {
          [VOICE]: [peer(ALBERTO, true), peer("c"), peer("d"), peer("e")],
        },
      }),
    );
    expect(streams).toEqual([
      expect.objectContaining({
        key: `${VOICE}:${ALBERTO}`,
        kind: "voice",
        place: "filminho",
        sharerName: "ALBERTO",
        watching: 3,
        inRoom: false,
        startedAt: null,
      }),
    ]);
  });

  it("says nothing for a room nobody is sharing in", () => {
    expect(
      collectWatchNowStreams(
        input({ occupancy: { [VOICE]: [peer("a"), peer("b")] } }),
      ),
    ).toEqual([]);
  });

  it("never shows the viewer their own share, even beside somebody else's", () => {
    const streams = collectWatchNowStreams(
      input({
        occupancy: { [VOICE]: [peer(ME, true), peer(ALBERTO, true)] },
      }),
    );
    expect(streams).toEqual([]);
  });

  it("drops a sharer the viewer blocked, and keeps another sharer in the same room", () => {
    expect(
      collectWatchNowStreams(
        input({
          occupancy: { [VOICE]: [peer(ALBERTO, true)] },
          blocked: new Set([ALBERTO]),
        }),
      ),
    ).toEqual([]);
    const streams = collectWatchNowStreams(
      input({
        occupancy: { [VOICE]: [peer(ALBERTO, true), peer(BIA, true)] },
        blocked: new Set([ALBERTO]),
      }),
    );
    expect(streams.map((stream) => stream.sharerUserId)).toEqual([BIA]);
  });

  it("offers nothing where the viewer cannot CONNECT, so no button can only fail", () => {
    const streams = collectWatchNowStreams(
      input({
        occupancy: {
          [VOICE]: [peer(ALBERTO, true)],
          [OTHER_VOICE]: [peer(BIA, true)],
        },
        canConnect: (channelId) => channelId !== VOICE,
      }),
    );
    expect(streams.map((stream) => stream.channelId)).toEqual([OTHER_VOICE]);
  });

  it("derives nothing from a room that is not in the open server's channel list", () => {
    // A private channel the viewer cannot view never reaches `occupancy`; one
    // from another server reaches it but is not in this server's channels.
    const streams = collectWatchNowStreams(
      input({ occupancy: { "someone-elses-channel": [peer(ALBERTO, true)] } }),
    );
    expect(streams).toEqual([]);
  });

  it("marks a stream the viewer is already seated in", () => {
    const [stream] = collectWatchNowStreams(
      input({
        occupancy: { [VOICE]: [peer(ALBERTO, true), peer(ME)] },
        seatedChannelId: VOICE,
      }),
    );
    expect(stream).toMatchObject({ inRoom: true, watching: 1 });
  });

  it("keys on the person: a different sharer in the same room is a different stream", () => {
    const a = collectWatchNowStreams(
      input({ occupancy: { [VOICE]: [peer(ALBERTO, true)] } }),
    );
    const b = collectWatchNowStreams(
      input({ occupancy: { [VOICE]: [peer(BIA, true)] } }),
    );
    expect(a[0]!.key).not.toBe(b[0]!.key);
  });

  it("takes the start from the server's stream when it states one", () => {
    const [stream] = collectWatchNowStreams(
      input({
        occupancy: { [VOICE]: [peer(ALBERTO, true)] },
        channelLive: { [VOICE]: { watching: 0, stream: { startedAt: 1234 } } },
      }),
    );
    expect(stream!.startedAt).toBe(1234);
  });
});

describe("collectWatchNowStreams: a watch party", () => {
  it("is a stream only while the party is live", () => {
    for (const state of ["draft", "scheduled", "ended", "cancelled"]) {
      expect(
        collectWatchNowStreams(
          input({
            parties: { [PARTY_CHANNEL]: { ...livePartyOf(), state } },
            occupancy: { [PARTY_CHANNEL]: [peer(ALBERTO, true)] },
          }),
        ),
      ).toEqual([]);
    }
  });

  it("names the party, counts the room plus the playlist audience, dates it from wentLiveAt", () => {
    const [stream] = collectWatchNowStreams(
      input({
        parties: { [PARTY_CHANNEL]: livePartyOf() },
        occupancy: { [PARTY_CHANNEL]: [peer(ALBERTO, true), peer("x")] },
        // `watching` is already the server's `viewers` when it sent one.
        channelLive: { [PARTY_CHANNEL]: { watching: 37, stream: null } },
      }),
    );
    expect(stream).toMatchObject({
      kind: "party",
      place: "Cinemoon",
      sharerName: "Alberto",
      watching: 38,
      startedAt: Date.parse("2026-10-04T22:00:00.000Z"),
    });
  });

  it("is still a stream when the host is on the stage with no roster entry yet", () => {
    const [stream] = collectWatchNowStreams(
      input({
        parties: { [PARTY_CHANNEL]: livePartyOf() },
        channelLive: { [PARTY_CHANNEL]: { watching: 5, stream: null } },
      }),
    );
    expect(stream).toMatchObject({ watching: 5 });
  });

  it("is not offered to its own host, to a viewer who blocked the host, or without CONNECT", () => {
    const base = {
      parties: { [PARTY_CHANNEL]: livePartyOf() },
      occupancy: { [PARTY_CHANNEL]: [peer(ALBERTO, true)] },
    };
    expect(
      collectWatchNowStreams(input({ ...base, viewerId: ALBERTO })),
    ).toEqual([]);
    expect(
      collectWatchNowStreams(input({ ...base, blocked: new Set([ALBERTO]) })),
    ).toEqual([]);
    expect(
      collectWatchNowStreams(input({ ...base, canConnect: () => false })),
    ).toEqual([]);
  });
});

describe("collectWatchNowStreams: a conversation's call", () => {
  it("shows a share in the call this conversation holds", () => {
    const [stream] = collectWatchNowStreams(
      input({
        scope: { kind: "conversation", channelId: CONVERSATION },
        occupancy: { [CONVERSATION]: [peer(ALBERTO, true), peer(ME)] },
      }),
    );
    expect(stream).toMatchObject({ kind: "call", place: null, inRoom: false });
  });

  it("shows nothing for a call nobody is sharing in", () => {
    expect(
      collectWatchNowStreams(
        input({
          scope: { kind: "conversation", channelId: CONVERSATION },
          occupancy: { [CONVERSATION]: [peer(ALBERTO)] },
        }),
      ),
    ).toEqual([]);
  });
});

describe("visibleWatchNowStreams", () => {
  const streams = collectWatchNowStreams(
    input({
      occupancy: {
        [VOICE]: [peer(ALBERTO, true), peer("a"), peer("b")],
        [OTHER_VOICE]: [peer(BIA, true), peer("c"), peer("d"), peer("e"), peer("f")],
      },
    }),
  );

  it("puts the bigger audience first", () => {
    const visible = visibleWatchNowStreams(streams, {
      openChannelId: null,
      dismissed: new Set(),
    });
    expect(visible.map((stream) => stream.channelId)).toEqual([OTHER_VOICE, VOICE]);
  });

  it("keeps a share in the open voice channel until the person is seated in it: the lobby asks for a microphone, the strip does not", () => {
    // Open but not joined: still offered.
    expect(
      visibleWatchNowStreams(streams, {
        openChannelId: OTHER_VOICE,
        dismissed: new Set(),
      }).map((stream) => stream.channelId),
    ).toEqual([OTHER_VOICE, VOICE]);
    // Open and seated: the stage is the picture, nothing to point at.
    const seated = streams.map((stream) =>
      stream.channelId === OTHER_VOICE ? { ...stream, inRoom: true } : stream,
    );
    expect(
      visibleWatchNowStreams(seated, {
        openChannelId: OTHER_VOICE,
        dismissed: new Set(),
      }).map((stream) => stream.channelId),
    ).toEqual([VOICE]);
    // Seated in it but looking at a text channel: the way back stays.
    expect(
      visibleWatchNowStreams(seated, {
        openChannelId: "text-1",
        dismissed: new Set(),
      }).map((stream) => [stream.channelId, stream.inRoom]),
    ).toEqual([
      [OTHER_VOICE, true],
      [VOICE, false],
    ]);
  });

  it("drops a watch party whose channel is open (opening it is watching) and a call once joined", () => {
    const party = {
      ...streams[0]!,
      kind: "party" as const,
      channelId: PARTY_CHANNEL,
      key: `${PARTY_CHANNEL}:${ALBERTO}`,
    };
    expect(
      visibleWatchNowStreams([party], { openChannelId: PARTY_CHANNEL, dismissed: new Set() }),
    ).toEqual([]);
    expect(
      visibleWatchNowStreams([party], { openChannelId: VOICE, dismissed: new Set() }),
    ).toHaveLength(1);
    const call = {
      ...streams[0]!,
      kind: "call" as const,
      channelId: CONVERSATION,
      key: `${CONVERSATION}:${ALBERTO}`,
    };
    // The conversation IS the open channel, and its strip still shows until joined.
    expect(
      visibleWatchNowStreams([call], { openChannelId: CONVERSATION, dismissed: new Set() }),
    ).toHaveLength(1);
    expect(
      visibleWatchNowStreams([{ ...call, inRoom: true }], {
        openChannelId: CONVERSATION,
        dismissed: new Set(),
      }),
    ).toEqual([]);
  });

  it("leaves out what the person dismissed", () => {
    expect(
      visibleWatchNowStreams(streams, {
        openChannelId: null,
        dismissed: new Set([`${OTHER_VOICE}:${BIA}`]),
      }).map((stream) => stream.channelId),
    ).toEqual([VOICE]);
  });

  it("orders ties by earliest known start, unknown last, then name", () => {
    const tied = [
      { ...streams[0]!, watching: 2, startedAt: null, place: "z" },
      { ...streams[1]!, watching: 2, startedAt: 500, place: "a" },
    ];
    expect(
      visibleWatchNowStreams(tied, { openChannelId: null, dismissed: new Set() }).map(
        (stream) => stream.place,
      ),
    ).toEqual(["a", "z"]);
  });
});

describe("ShareClock: how long, without lying", () => {
  it("says nothing about a share already running when the tab loaded", () => {
    const clock = new ShareClock(1_000, 20_000);
    clock.observe(["k"], 5_000);
    expect(clock.startedAt("k")).toBeNull();
    // And it stays unknown however long the tab then watches it.
    clock.observe(["k"], 100_000);
    expect(clock.startedAt("k")).toBeNull();
  });

  it("dates a share it saw begin after the rosters had settled", () => {
    const clock = new ShareClock(1_000, 20_000);
    clock.observe([], 30_000);
    clock.observe(["k"], 61_000);
    expect(clock.startedAt("k")).toBe(61_000);
    clock.observe(["k"], 90_000);
    expect(clock.startedAt("k")).toBe(61_000);
  });

  it("forgets a share that ended, so the next one is dated afresh", () => {
    const clock = new ShareClock(0, 20_000);
    clock.observe(["k"], 40_000);
    clock.observe([], 50_000);
    clock.observe(["k"], 70_000);
    expect(clock.startedAt("k")).toBe(70_000);
  });

  it("reports settled only after the grace", () => {
    const clock = new ShareClock(0, 20_000);
    expect(clock.settled(19_999)).toBe(false);
    expect(clock.settled(20_000)).toBe(true);
  });

  it("fills a start in only where the data had none", () => {
    const clock = new ShareClock(0, 0);
    clock.observe(["a", "b"], 10);
    const out = withObservedStart(
      [
        { key: "a", startedAt: null },
        { key: "b", startedAt: 99 },
      ] as never,
      clock,
    );
    expect(out.map((stream) => stream.startedAt)).toEqual([10, 99]);
  });
});

describe("watchNowLiveKeys", () => {
  it("covers every channel's sharers, not only the open server's", () => {
    expect(
      watchNowLiveKeys(
        {
          [VOICE]: [peer(ALBERTO, true), peer("x")],
          "elsewhere": [peer(BIA, true)],
        },
        { [PARTY_CHANNEL]: livePartyOf() },
      ).sort(),
    ).toEqual(
      [
        `${VOICE}:${ALBERTO}`,
        `elsewhere:${BIA}`,
        `${PARTY_CHANNEL}:${ALBERTO}`,
      ].sort(),
    );
  });
});

describe("watchNowAge", () => {
  const now = 10_000_000;
  it("is unknown without a start and never negative", () => {
    expect(watchNowAge(null, now)).toBeNull();
    expect(watchNowAge(now + 60_000, now)).toBeNull();
  });
  it("walks now, minutes, hours", () => {
    expect(watchNowAge(now - 20_000, now)).toEqual({ unit: "now" });
    expect(watchNowAge(now - 12 * 60_000, now)).toEqual({ unit: "minutes", value: 12 });
    expect(watchNowAge(now - 89 * 60_000, now)).toEqual({ unit: "minutes", value: 89 });
    expect(watchNowAge(now - 150 * 60_000, now)).toEqual({ unit: "hours", value: 2 });
  });
});

describe("dismissal: remembered until the stream ends", () => {
  beforeEach(() => {
    resetWatchNowDismissedForTests();
    try {
      window.sessionStorage.clear();
    } catch {
      // node environment: no storage, in-memory only.
    }
  });

  it("holds a dismissal and forgets it when the stream is gone", () => {
    dismissWatchNow("k1");
    dismissWatchNow("k2");
    expect([...dismissedWatchNow()].sort()).toEqual(["k1", "k2"]);
    pruneWatchNowDismissed(["k2"]);
    expect([...dismissedWatchNow()]).toEqual(["k2"]);
    pruneWatchNowDismissed([]);
    expect(dismissedWatchNow().size).toBe(0);
  });

  it("does not forget a dismissal on an empty roster that has not settled", () => {
    dismissWatchNow("k1");
    pruneWatchNowDismissed([], { settled: false });
    expect([...dismissedWatchNow()]).toEqual(["k1"]);
    // Unless this tab watched that stream be live: then its end is known.
    pruneWatchNowDismissed([], { settled: false, seenLive: new Set(["k1"]) });
    expect(dismissedWatchNow().size).toBe(0);
  });

  it("reads hostile or missing storage as nothing dismissed", () => {
    expect(readDismissed(null).size).toBe(0);
    expect(readDismissed({ getItem: () => "not json", setItem: () => {} }).size).toBe(0);
    expect(readDismissed({ getItem: () => '{"a":1}', setItem: () => {} }).size).toBe(0);
    expect(
      readDismissed({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {},
      }).size,
    ).toBe(0);
    expect([...readDismissed({ getItem: () => '["a",3,"b"]', setItem: () => {} })]).toEqual([
      "a",
      "b",
    ]);
  });
});
