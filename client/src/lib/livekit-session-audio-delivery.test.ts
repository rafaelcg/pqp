import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";

/**
 * The listener's audio plan, from the session's side of the seam.
 *
 * `remote-audio-delivery.test.ts` pins the rule. This pins the wiring, which
 * is the half that has gone wrong silently before in this file's neighbours:
 * a publication registered under the wrong source would silence the wrong
 * sound, and a publication never registered would quietly save nothing while
 * every test above it still passed.
 *
 * The doubles copy `livekit-client` 2.21.0's real names. `setEnabled` on a
 * remote publication is the one call being asserted, because it is the whole
 * mechanism: verified against the library, it is not gated on track kind and
 * sends `UpdateTrackSettings { disabled }` for an audio publication the same
 * way it does for video.
 */

const Track = {
  Kind: { Video: "video", Audio: "audio" },
  Source: {
    Camera: "camera",
    ScreenShare: "screen_share",
    ScreenShareAudio: "screen_share_audio",
    Microphone: "microphone",
  },
};

const RoomEvent = {
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  Disconnected: "disconnected",
  ConnectionStateChanged: "connectionStateChanged",
  ConnectionQualityChanged: "connectionQualityChanged",
  MediaDevicesError: "mediaDevicesError",
};

interface FakePublication {
  source: string;
  isSubscribed: boolean;
  calls: boolean[];
  setEnabled: (enabled: boolean) => void;
  setVideoQuality: (quality: number) => void;
}

interface FakeParticipant {
  identity: string;
  videoTrackPublications: Map<string, FakePublication>;
}

class FakePreset {
  constructor(
    public width: number,
    public height: number,
    public maxBitrate: number,
    public maxFramerate?: number,
  ) {}
}

const rooms: FakeRoom[] = [];

class FakeRoom {
  state = "connected";
  remoteParticipants = new Map<string, FakeParticipant>();
  handlers = new Map<string, (...args: unknown[]) => void>();
  localParticipant = {
    publishTrack: async () => {},
    unpublishTrack: async () => {},
    getTrackPublication: () => undefined,
  };
  constructor() {
    rooms.push(this);
  }
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }
  async connect() {}
  async disconnect() {}

  join(identity: string): FakeParticipant {
    const participant: FakeParticipant = {
      identity,
      videoTrackPublications: new Map(),
    };
    this.remoteParticipants.set(identity, participant);
    this.handlers.get(RoomEvent.ParticipantConnected)?.(participant);
    return participant;
  }

  /** Test helper: one of their tracks is subscribed. */
  subscribe(
    participant: FakeParticipant,
    kind: "audio" | "video",
    source: string,
  ): FakePublication {
    const calls: boolean[] = [];
    const publication: FakePublication = {
      source,
      isSubscribed: true,
      calls,
      setEnabled: (enabled) => calls.push(enabled),
      setVideoQuality: () => {},
    };
    if (kind === "video") {
      participant.videoTrackPublications.set(`${source}-sid`, publication);
    }
    this.handlers.get(RoomEvent.TrackSubscribed)?.(
      {
        kind,
        mediaStreamTrack: { kind, id: `${participant.identity}:${source}` },
        attach: () => {},
      },
      publication,
      participant,
    );
    return publication;
  }

  unsubscribe(participant: FakeParticipant, publication: FakePublication) {
    this.handlers.get(RoomEvent.TrackUnsubscribed)?.(
      { kind: Track.Kind.Audio },
      publication,
      participant,
    );
  }
}

vi.mock("livekit-client", () => {
  class LocalAudioTrack {
    constructor(public track: unknown) {}
    isMuted = false;
    async mute() {
      this.isMuted = true;
    }
    async unmute() {
      this.isMuted = false;
    }
  }
  return {
    Room: FakeRoom,
    RoomEvent,
    Track,
    LocalAudioTrack,
    ConnectionState: { Disconnected: "disconnected", Connected: "connected" },
    VideoPreset: FakePreset,
    VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
  };
});

vi.stubGlobal(
  "MediaStream",
  class {
    constructor(public tracks: unknown[] = []) {}
    getTracks() {
      return this.tracks;
    }
  },
);

const { connectLiveKit } = await import("./livekit-session");
const { AUDIO_SILENCE_GRACE_MS } = await import("./remote-audio-delivery");

const SESSION: VoiceSessionInfo = {
  backend: "livekit",
  url: "ws://sfu",
  token: "t",
  room: "room",
  identity: "me",
};

async function session() {
  return connectLiveKit({
    session: SESSION,
    lookupIdentity: () => undefined,
    onPeersChanged: () => {},
    onError: () => {},
  });
}

function room(): FakeRoom {
  return rooms[rooms.length - 1]!;
}

beforeEach(() => {
  rooms.length = 0;
  vi.useFakeTimers();
  return () => vi.useRealTimers();
});

describe("the listener's audio plan reaches the SFU", () => {
  it("stops every remote sound while deafened, and starts them again", async () => {
    const sfu = await session();
    const alice = room().join("alice");
    const voice = room().subscribe(alice, "audio", Track.Source.Microphone);
    const share = room().subscribe(
      alice,
      "audio",
      Track.Source.ScreenShareAudio,
    );

    sfu.setAudioDelivery({
      deafened: true,
      silentVoicePeerIds: [],
      silentScreenPeerIds: [],
    });
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS);
    expect(voice.calls).toEqual([false]);
    expect(share.calls).toEqual([false]);

    sfu.setAudioDelivery({
      deafened: false,
      silentVoicePeerIds: [],
      silentScreenPeerIds: [],
    });
    expect(voice.calls).toEqual([false, true]);
    expect(share.calls).toEqual([false, true]);
  });

  it("tells the two sources apart", async () => {
    const sfu = await session();
    const alice = room().join("alice");
    const voice = room().subscribe(alice, "audio", Track.Source.Microphone);
    const share = room().subscribe(
      alice,
      "audio",
      Track.Source.ScreenShareAudio,
    );

    sfu.setAudioDelivery({
      deafened: false,
      silentVoicePeerIds: [],
      silentScreenPeerIds: ["alice"],
    });
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS);
    expect(voice.calls).toEqual([]);
    expect(share.calls).toEqual([false]);
  });

  it("never touches a video publication", async () => {
    const sfu = await session();
    const alice = room().join("alice");
    const camera = room().subscribe(alice, "video", Track.Source.Camera);
    const before = camera.calls.length;

    sfu.setAudioDelivery({
      deafened: true,
      silentVoicePeerIds: ["alice"],
      silentScreenPeerIds: ["alice"],
    });
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS);
    // The video module owns this publication; the audio plan must not be a
    // second, invisible hand on the same switch.
    expect(camera.calls.length).toBe(before);
  });

  it("silences one person without touching another", async () => {
    const sfu = await session();
    const alice = room().join("alice");
    const bob = room().join("bob");
    const aliceVoice = room().subscribe(alice, "audio", Track.Source.Microphone);
    const bobVoice = room().subscribe(bob, "audio", Track.Source.Microphone);

    sfu.setAudioDelivery({
      deafened: false,
      silentVoicePeerIds: ["alice"],
      silentScreenPeerIds: [],
    });
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS);
    expect(aliceVoice.calls).toEqual([false]);
    expect(bobVoice.calls).toEqual([]);
  });

  it("applies a standing plan to a track that arrives later", async () => {
    const sfu = await session();
    sfu.setAudioDelivery({
      deafened: false,
      silentVoicePeerIds: ["alice"],
      silentScreenPeerIds: [],
    });
    const alice = room().join("alice");
    const voice = room().subscribe(alice, "audio", Track.Source.Microphone);
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS);
    expect(voice.calls).toEqual([false]);
  });

  it("forgets a publication that goes away", async () => {
    const sfu = await session();
    const alice = room().join("alice");
    const voice = room().subscribe(alice, "audio", Track.Source.Microphone);
    room().unsubscribe(alice, voice);

    sfu.setAudioDelivery({
      deafened: true,
      silentVoicePeerIds: [],
      silentScreenPeerIds: [],
    });
    vi.advanceTimersByTime(AUDIO_SILENCE_GRACE_MS);
    expect(voice.calls).toEqual([]);
  });
});
