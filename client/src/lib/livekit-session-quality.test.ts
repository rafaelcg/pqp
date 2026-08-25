import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";

/**
 * The SFU half of the video quality control.
 *
 * WHY THIS FILE EXISTS. The mesh path is measured end to end by
 * `e2e/video-quality.spec.ts`, which drives two real browsers and reads the
 * ceilings back off `RTCRtpSender.getParameters()`. There is no equivalent for
 * LiveKit: a headless run has no SFU to connect to, so the transport that
 * carries a *large* voice channel was the one with nothing pinned at all.
 *
 * What can be pinned without a server is the seam that actually decides the
 * outcome, and both of its halves are easy to break silently:
 *
 *   1. A track published *after* a choice must carry the chosen ceiling in its
 *      `videoEncoding`. This is the path everybody takes, because the ordinary
 *      sequence is "set the quality once, then turn the camera on".
 *   2. A track already published must be moved by `setParameters` on its own
 *      sender, without being republished. Republishing would drop the picture
 *      from every subscriber for as long as renegotiation takes, and for a
 *      screen share it can put the OS picker back on screen.
 *
 * A failure in either is invisible from the UI: the menu ticks the new row, the
 * call keeps running, and the picture is simply governed by the wrong number.
 *
 * Only the quality seam lives here. Which *source* each publication goes up
 * under, and a camera and a share coexisting on this transport, are a separate
 * question with a separate suite.
 */

// ------------------------------------------------------------------- doubles

interface PublishedTrack {
  track: unknown;
  options: {
    source?: string;
    videoEncoding?: { maxBitrate?: number; maxFramerate?: number };
    degradationPreference?: string;
  };
}

/** `setParameters` calls a publication's sender received, in order. */
const senderWrites: { source: string; maxBitrate: number | undefined }[] = [];
const published: PublishedTrack[] = [];
const unpublished: unknown[] = [];

function fakeSender(source: string) {
  let params: RTCRtpSendParameters = {
    encodings: [{}],
    transactionId: "t",
    codecs: [],
    headerExtensions: [],
    rtcp: {},
  } as unknown as RTCRtpSendParameters;
  return {
    getParameters: () => params,
    setParameters: async (next: RTCRtpSendParameters) => {
      params = next;
      senderWrites.push({
        source,
        maxBitrate: next.encodings?.[0]?.maxBitrate,
      });
    },
  };
}

/** Publications the local participant currently holds, keyed by source. */
const publications = new Map<string, { track: { sender: unknown } }>();

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

vi.mock("livekit-client", () => {
  class Room {
    remoteParticipants = new Map();
    localParticipant = {
      publishTrack: async (
        track: unknown,
        options: PublishedTrack["options"] = {},
      ) => {
        published.push({ track, options });
        if (options.source) {
          publications.set(options.source, {
            track: { sender: fakeSender(options.source) },
          });
        }
      },
      unpublishTrack: async (track: unknown) => {
        unpublished.push(track);
      },
      getTrackPublication: (source: string) => publications.get(source),
    };
    on() {
      return this;
    }
    async connect() {}
    async disconnect() {}
  }
  class LocalAudioTrack {
    constructor(public track: unknown) {}
    async mute() {}
    async unmute() {}
  }
  return {
    Room,
    RoomEvent,
    Track,
    LocalAudioTrack,
    ConnectionState: { Disconnected: "disconnected" },
  };
});

const { connectLiveKit } = await import("./livekit-session");

function fakeTrack(kind: "audio" | "video", id: string) {
  return { kind, id, contentHint: "" } as unknown as MediaStreamTrack;
}

function fakeStream(kind: "audio" | "video", id: string): MediaStream {
  const track = fakeTrack(kind, id);
  return {
    id: `stream-${id}`,
    getTracks: () => [track],
    getAudioTracks: () => (kind === "audio" ? [track] : []),
    getVideoTracks: () => (kind === "video" ? [track] : []),
  } as unknown as MediaStream;
}

const SESSION: VoiceSessionInfo = {
  backend: "livekit",
  url: "ws://sfu",
  token: "t",
  room: "room",
  identity: "peer",
};

async function session() {
  return connectLiveKit({
    session: SESSION,
    lookupIdentity: () => undefined,
    onPeersChanged: () => {},
    onError: () => {},
  });
}

beforeEach(() => {
  published.length = 0;
  unpublished.length = 0;
  senderWrites.length = 0;
  publications.clear();
});

function encodingFor(source: string) {
  return published.find((entry) => entry.options.source === source)?.options;
}

describe("a quality chosen before the track exists", () => {
  it("publishes the camera at the chosen ceiling, not the default one", async () => {
    const sfu = await session();
    // 360p's camera rung. The default is 720p's, so a publish that ignored the
    // stored value would carry 1_500_000 and look entirely healthy.
    await sfu.setCameraMaxBitrate(400_000);
    await sfu.publishCamera(fakeStream("video", "cam"));

    expect(encodingFor(Track.Source.Camera)?.videoEncoding?.maxBitrate).toBe(
      400_000,
    );
    expect(encodingFor(Track.Source.Camera)?.degradationPreference).toBe(
      "maintain-framerate",
    );
  });

  it("publishes the screen at the chosen ceiling, not the default one", async () => {
    const sfu = await session();
    await sfu.setScreenMaxBitrate(4_000_000);
    await sfu.publishScreen(fakeStream("video", "screen"));

    expect(
      encodingFor(Track.Source.ScreenShare)?.videoEncoding?.maxBitrate,
    ).toBe(4_000_000);
    expect(encodingFor(Track.Source.ScreenShare)?.degradationPreference).toBe(
      "maintain-framerate",
    );
  });

  it("gives the two sources different numbers for the same choice", async () => {
    // Same word, different cost: a talking head is a static background with a
    // moving oval, a shared screen is full-frame motion and hard edges.
    const sfu = await session();
    await sfu.setCameraMaxBitrate(2_500_000);
    await sfu.setScreenMaxBitrate(4_000_000);
    await sfu.publishCamera(fakeStream("video", "cam"));
    await sfu.publishScreen(fakeStream("video", "screen"));

    expect(encodingFor(Track.Source.Camera)?.videoEncoding?.maxBitrate).toBe(
      2_500_000,
    );
    expect(
      encodingFor(Track.Source.ScreenShare)?.videoEncoding?.maxBitrate,
    ).toBe(4_000_000);
  });
});

describe("a quality chosen while the track is already up", () => {
  it("moves the camera's sender without republishing it", async () => {
    const sfu = await session();
    await sfu.publishCamera(fakeStream("video", "cam"));
    const publishesBefore = published.length;

    await sfu.setCameraMaxBitrate(400_000);

    expect(senderWrites).toEqual([
      { source: Track.Source.Camera, maxBitrate: 400_000 },
    ]);
    // The picture must not blink: republishing drops it from every subscriber.
    expect(published).toHaveLength(publishesBefore);
    expect(unpublished).toHaveLength(0);
  });

  it("moves the screen's sender without reopening the OS picker", async () => {
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));
    const publishesBefore = published.length;

    await sfu.setScreenMaxBitrate(600_000);

    expect(senderWrites).toEqual([
      { source: Track.Source.ScreenShare, maxBitrate: 600_000 },
    ]);
    expect(published).toHaveLength(publishesBefore);
    expect(unpublished).toHaveLength(0);
  });

  it("also stores the new ceiling for the next publish after a reconnect", async () => {
    // A share republished after a WS drop must come back at the quality the
    // user chose, not at the default: the reconnect path publishes afresh.
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));
    await sfu.setScreenMaxBitrate(1_000_000);
    published.length = 0;

    await sfu.publishScreen(fakeStream("video", "screen-again"));

    expect(
      encodingFor(Track.Source.ScreenShare)?.videoEncoding?.maxBitrate,
    ).toBe(1_000_000);
  });

  it("keeps the call running when the browser refuses the new ceiling", async () => {
    // The promise the whole feature rests on: a refused ceiling costs you the
    // improvement, never the picture. Silence here is what let the camera run
    // with no ceiling at all for the life of the product, so it is warned.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sfu = await session();
    await sfu.publishCamera(fakeStream("video", "cam"));
    const publication = publications.get(Track.Source.Camera)!;
    publication.track.sender = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {
        throw new Error("nope");
      },
    };

    await expect(sfu.setCameraMaxBitrate(400_000)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does nothing at all when there is no track to move", async () => {
    const sfu = await session();
    await expect(sfu.setCameraMaxBitrate(400_000)).resolves.toBeUndefined();
    expect(senderWrites).toEqual([]);
  });
});
