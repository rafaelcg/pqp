import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";

/**
 * The SFU half of the "Video you receive" and "Video you send" readouts.
 *
 * WHY THIS FILE EXISTS. Both readouts read `sampleVoiceStats()`, whose registry
 * held only mesh `RTCPeerConnection`s. A LiveKit room therefore sampled as
 * empty, and a viewer at a 100-person watch party opened the quality menu over
 * a playing screen share and read "nobody is sending you video right now". The
 * fix registers the LiveKit session as a sampler of its own, and this pins the
 * seam: subscribed video publications become receiver rows with the right role
 * and name, local publications become sender rows carrying the ceiling this
 * session applied, and a disconnected session contributes nothing.
 */

// ------------------------------------------------------------------- doubles

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
  MediaDevicesError: "mediaDevicesError",
};

const ConnectionState = { Connected: "connected", Disconnected: "disconnected" };

interface FakeRemotePublication {
  source: string;
  trackSid: string;
  isSubscribed: boolean;
  isMuted: boolean;
  videoTrack?: { getReceiverStats: () => Promise<unknown> };
}

interface FakeRemoteParticipant {
  identity: string;
  name?: string;
  videoTrackPublications: Map<string, FakeRemotePublication>;
}

/** The rooms constructed so far; the test reaches into the newest one. */
const rooms: FakeRoom[] = [];

class FakeRoom {
  state = ConnectionState.Connected;
  remoteParticipants = new Map<string, FakeRemoteParticipant>();
  localPublications = new Map<
    string,
    { videoTrack?: { getSenderStats: () => Promise<unknown[]> } }
  >();
  localParticipant = {
    publishTrack: async (
      _track: unknown,
      options: { source?: string } = {},
    ) => {
      if (options.source) {
        this.localPublications.set(options.source, {});
      }
    },
    unpublishTrack: async () => {},
    getTrackPublication: (source: string) =>
      this.localPublications.get(source),
  };
  constructor() {
    rooms.push(this);
  }
  on() {
    return this;
  }
  async connect() {}
  async disconnect() {
    this.state = ConnectionState.Disconnected;
  }
}

vi.mock("livekit-client", () => {
  class LocalAudioTrack {
    constructor(public track: unknown) {}
    async mute() {}
    async unmute() {}
  }
  return {
    Room: FakeRoom,
    RoomEvent,
    Track,
    LocalAudioTrack,
    ConnectionState,
  };
});

const { connectLiveKit } = await import("./livekit-session");
const { sampleVoiceStats } = await import("./voice-stats-probe");

const SESSION: VoiceSessionInfo = {
  backend: "livekit",
  url: "ws://sfu",
  token: "t",
  room: "room",
  identity: "me",
};

const NAMES: Record<string, string> = { rafa: "Rafael" };

/** Sessions opened by the current test, torn down whether or not it passed. */
const open: { disconnect(): Promise<void> }[] = [];

async function session() {
  const sfu = await connectLiveKit({
    session: SESSION,
    lookupIdentity: (peerId) =>
      NAMES[peerId]
        ? { userId: peerId, displayName: NAMES[peerId], avatarUrl: null }
        : undefined,
    onPeersChanged: () => {},
    onError: () => {},
  });
  open.push(sfu);
  return sfu;
}

function newestRoom(): FakeRoom {
  return rooms[rooms.length - 1]!;
}

function remote(
  identity: string,
  publications: FakeRemotePublication[],
  name?: string,
): FakeRemoteParticipant {
  return {
    identity,
    name,
    videoTrackPublications: new Map(
      publications.map((pub) => [pub.trackSid, pub]),
    ),
  };
}

function screenPublication(
  over: Partial<FakeRemotePublication> = {},
): FakeRemotePublication {
  return {
    source: Track.Source.ScreenShare,
    trackSid: "TR_screen",
    isSubscribed: true,
    isMuted: false,
    videoTrack: {
      getReceiverStats: async () => ({
        type: "video",
        timestamp: 1_000,
        bytesReceived: 250_000,
        framesDecoded: 60,
        frameWidth: 1920,
        frameHeight: 1080,
        decoderImplementation: "libvpx",
      }),
    },
    ...over,
  };
}

beforeEach(() => {
  rooms.length = 0;
});

afterEach(async () => {
  // A failed assertion must not leave a sampler registered for the next test.
  for (const sfu of open.splice(0)) {
    await sfu.disconnect();
  }
});

describe("what an SFU viewer is receiving", () => {
  it("reports a subscribed screen share as that person's screen", async () => {
    await session();
    newestRoom().remoteParticipants.set(
      "rafa",
      remote("rafa", [screenPublication()]),
    );

    const snapshot = await sampleVoiceStats();

    expect(snapshot.receivers).toHaveLength(1);
    expect(snapshot.receivers[0]).toMatchObject({
      peerId: "rafa",
      displayName: "Rafael",
      role: "screen",
      width: 1920,
      height: 1080,
      framesDecoded: 60,
      decoder: "libvpx",
      attached: true,
    });
  });

  it("is present before the decoder has anything to say", async () => {
    // The first second of every stream. The old filter dropped this row, and
    // with it the only evidence that video was arriving at all.
    await session();
    newestRoom().remoteParticipants.set(
      "rafa",
      remote("rafa", [
        screenPublication({
          videoTrack: { getReceiverStats: async () => undefined },
        }),
      ]),
    );

    const snapshot = await sampleVoiceStats();

    expect(snapshot.receivers).toHaveLength(1);
    expect(snapshot.receivers[0]).toMatchObject({
      role: "screen",
      width: null,
      framesDecoded: null,
      attached: true,
    });
  });

  it("labels a camera as a camera and falls back to the room name", async () => {
    await session();
    newestRoom().remoteParticipants.set(
      "stranger",
      remote(
        "stranger",
        [
          screenPublication({
            source: Track.Source.Camera,
            trackSid: "TR_cam",
          }),
        ],
        "Guest",
      ),
    );

    const snapshot = await sampleVoiceStats();

    expect(snapshot.receivers[0]).toMatchObject({
      peerId: "stranger",
      displayName: "Guest",
      role: "camera",
    });
  });

  it("skips publications that are not flowing to this client", async () => {
    await session();
    newestRoom().remoteParticipants.set(
      "rafa",
      remote("rafa", [
        screenPublication({ trackSid: "a", isSubscribed: false }),
        screenPublication({ trackSid: "b", isMuted: true }),
        screenPublication({ trackSid: "c", videoTrack: undefined }),
      ]),
    );

    const snapshot = await sampleVoiceStats();

    expect(snapshot.receivers).toEqual([]);
  });

  it("measures the bitrate and frame rate across two samples", async () => {
    await session();
    let tick = 0;
    newestRoom().remoteParticipants.set(
      "rafa",
      remote("rafa", [
        screenPublication({
          // Its own id: byte marks are keyed by track and shared across
          // sessions, so reusing TR_screen would measure against an earlier
          // test's reading and call the first sample a rate.
          trackSid: "TR_rate",
          videoTrack: {
            getReceiverStats: async () => {
              tick += 1;
              return {
                type: "video",
                timestamp: tick * 2_000,
                bytesReceived: tick * 500_000,
                framesDecoded: tick * 60,
                frameWidth: 1280,
                frameHeight: 720,
              };
            },
          },
        }),
      ]),
    );

    const first = await sampleVoiceStats();
    expect(first.receivers[0]?.kbps).toBeNull();
    const second = await sampleVoiceStats();
    // 500 kB in 2 s is 2000 kbps; 60 frames in 2 s is 30 fps.
    expect(second.receivers[0]?.kbps).toBe(2000);
    expect(second.receivers[0]?.fps).toBe(30);
  });

  it("contributes nothing once the session is gone", async () => {
    const sfu = await session();
    newestRoom().remoteParticipants.set(
      "rafa",
      remote("rafa", [screenPublication()]),
    );
    await sfu.disconnect();

    const snapshot = await sampleVoiceStats();

    expect(snapshot.receivers).toEqual([]);
    expect(snapshot.senders).toEqual([]);
  });
});

describe("what an SFU presenter is sending", () => {
  function fakeStream(): MediaStream {
    const track = { kind: "video", id: "screen" } as unknown as MediaStreamTrack;
    return {
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
      getTracks: () => [track],
    } as unknown as MediaStream;
  }

  it("reports the share with the ceiling this session applied", async () => {
    const sfu = await session();
    await sfu.setScreenMaxBitrate(4_000_000);
    await sfu.publishScreen(fakeStream());
    newestRoom().localPublications.get(Track.Source.ScreenShare)!.videoTrack = {
      getSenderStats: async () => [
        {
          type: "video",
          timestamp: 1_000,
          bytesSent: 1_000_000,
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 30,
          framesSent: 900,
          targetBitrate: 3_950_000,
          qualityLimitationReason: "bandwidth",
          rid: "",
        },
      ],
    };

    const snapshot = await sampleVoiceStats();

    expect(snapshot.senders).toHaveLength(1);
    expect(snapshot.senders[0]).toMatchObject({
      peerId: "me",
      role: "screen",
      width: 1920,
      height: 1080,
      fps: 30,
      targetKbps: 3950,
      ceilingKbps: 4000,
      limitedBy: "bandwidth",
      framesSent: 900,
    });
  });

  it("reports nothing while no video is published", async () => {
    await session();
    const snapshot = await sampleVoiceStats();
    expect(snapshot.senders).toEqual([]);
  });
});
