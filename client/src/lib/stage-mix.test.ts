import { describe, expect, it, vi } from "vitest";
import {
  createStageMix,
  shouldPublishStageMix,
  stageMixInputUserIds,
  STAGE_MIX_TRACK_NAME,
} from "./stage-mix";
import type { AudioContextLike, AudioNodeLike, GainNodeLike } from "./screen-mix";

// Same shape as `screen-mix.test.ts`'s fakes, kept independent rather than
// imported: the two mixes are deliberately separate buses (see this file's
// module doc), and sharing test fakes would be the one place they touch.

class FakeTrack {
  kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }
}
class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}
vi.stubGlobal("MediaStream", FakeStream);

function fakeContext(): { context: AudioContextLike; connections: string[] } {
  const connections: string[] = [];
  let counter = 0;
  const node = (name: string): AudioNodeLike & { name: string } => ({
    name,
    connect: () => {
      connections.push(name);
    },
    disconnect: () => {
      const idx = connections.lastIndexOf(name);
      if (idx !== -1) {
        connections.splice(idx, 1);
      }
    },
  });
  const audioParam = (initial = 0) => ({
    value: initial,
    setTargetAtTime(target: number) {
      this.value = target;
    },
  });
  const mixed = new FakeTrack("audio");
  return {
    connections,
    context: {
      createMediaStreamSource: () => node(`src${counter++}`),
      createMediaStreamDestination: () => ({
        ...node("dest"),
        stream: new FakeStream([mixed]) as unknown as MediaStream,
      }),
      createGain: (): GainNodeLike => ({ ...node(`gain${counter++}`), gain: audioParam(1) }),
      createDynamicsCompressor: () => ({
        ...node("compressor"),
        threshold: audioParam(),
        knee: audioParam(),
        ratio: audioParam(),
        attack: audioParam(),
        release: audioParam(),
      }),
      currentTime: 0,
      close: vi.fn(),
    },
  };
}

describe("createStageMix", () => {
  it("starts with the presenter's own mic and no guests", () => {
    const { context } = fakeContext();
    const mic = new FakeStream([new FakeTrack("audio")]) as unknown as MediaStream;
    const mix = createStageMix(mic, () => context);
    expect(mix.guestCount()).toBe(0);
    mix.close();
  });

  it("adds a guest branch, and counts it", () => {
    const { context } = fakeContext();
    const mix = createStageMix(null, () => context);
    const guestMic = new FakeStream([new FakeTrack("audio")]) as unknown as MediaStream;
    mix.setGuestTrack("guest-1", guestMic);
    expect(mix.guestCount()).toBe(1);
    mix.close();
  });

  it("drops a guest branch on null, without touching another guest's", () => {
    const { context } = fakeContext();
    const mix = createStageMix(null, () => context);
    const trackA = new FakeStream([new FakeTrack("audio")]) as unknown as MediaStream;
    const trackB = new FakeStream([new FakeTrack("audio")]) as unknown as MediaStream;
    mix.setGuestTrack("a", trackA);
    mix.setGuestTrack("b", trackB);
    expect(mix.guestCount()).toBe(2);
    mix.setGuestTrack("a", null);
    expect(mix.guestCount()).toBe(1);
    mix.close();
  });

  it("replaces a guest's branch (reconnect) rather than stacking a second one", () => {
    const { context } = fakeContext();
    const mix = createStageMix(null, () => context);
    const first = new FakeStream([new FakeTrack("audio")]) as unknown as MediaStream;
    const second = new FakeStream([new FakeTrack("audio")]) as unknown as MediaStream;
    mix.setGuestTrack("guest-1", first);
    mix.setGuestTrack("guest-1", second);
    expect(mix.guestCount()).toBe(1);
    mix.close();
  });

  it("ignores a stream with no audio track", () => {
    const { context } = fakeContext();
    const mix = createStageMix(null, () => context);
    mix.setGuestTrack("guest-1", new FakeStream([]) as unknown as MediaStream);
    expect(mix.guestCount()).toBe(0);
    mix.close();
  });

  it("publishes the destination's track under a stable name elsewhere in the codebase", () => {
    expect(STAGE_MIX_TRACK_NAME).toBe("stage-mix");
  });
});

describe("stageMixInputUserIds", () => {
  it("is empty when guests are off, whatever the roster says", () => {
    expect(
      stageMixInputUserIds({
        guestsMode: "off",
        onAirUserIds: ["g1", "g2"],
        ownUserId: "host",
      }),
    ).toEqual([]);
  });

  it("puts the presenter first, then every guest", () => {
    expect(
      stageMixInputUserIds({
        guestsMode: "request",
        onAirUserIds: ["g1", "g2"],
        ownUserId: "host",
      }),
    ).toEqual(["host", "g1", "g2"]);
  });

  it("never lists the presenter twice, even if they are somehow in onAir", () => {
    expect(
      stageMixInputUserIds({
        guestsMode: "invite",
        onAirUserIds: ["host", "g1"],
        ownUserId: "host",
      }),
    ).toEqual(["host", "g1"]);
  });

  it("is just the presenter when nobody has been accepted yet", () => {
    expect(
      stageMixInputUserIds({
        guestsMode: "request",
        onAirUserIds: [],
        ownUserId: "host",
      }),
    ).toEqual(["host"]);
  });
});

describe("shouldPublishStageMix", () => {
  it("never publishes with guests off", () => {
    expect(
      shouldPublishStageMix({ guestsMode: "off", isPresenting: true, hasMic: true }),
    ).toBe(false);
  });

  it("never publishes for a non-presenter", () => {
    expect(
      shouldPublishStageMix({ guestsMode: "request", isPresenting: false, hasMic: true }),
    ).toBe(false);
  });

  it("never publishes with no microphone to send", () => {
    expect(
      shouldPublishStageMix({ guestsMode: "request", isPresenting: true, hasMic: false }),
    ).toBe(false);
  });

  it("publishes from the first second guests are on, before anyone has joined", () => {
    expect(
      shouldPublishStageMix({ guestsMode: "invite", isPresenting: true, hasMic: true }),
    ).toBe(true);
  });
});
