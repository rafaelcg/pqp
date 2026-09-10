import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";
import type { RemotePeer } from "./peer-connection-manager";
import { bindRemoteVideo } from "./remote-video-binding";
import { HIDDEN_GRACE_MS, OFFSCREEN_GRACE_MS } from "./remote-video-delivery";

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
 *      publish options. This is the path everybody takes, because the ordinary
 *      sequence is "set the quality once, then turn the camera on".
 *   2. A track already published must be moved by `setParameters` on its own
 *      sender, without being republished. Republishing would drop the picture
 *      from every subscriber for as long as renegotiation takes, and for a
 *      screen share it can put the OS picker back on screen.
 *
 * A failure in either is invisible from the UI: the menu ticks the new row, the
 * call keeps running, and the picture is simply governed by the wrong number.
 *
 * THE SCREEN'S OPTION IS `screenShareEncoding`, and the first version of this
 * suite asserted `videoEncoding` and passed. livekit-client reads the screen's
 * ceiling from its own field and ignores `videoEncoding` for that source, so
 * the suite was pinning a value the library never looked at, and every SFU
 * share went up with no ceiling. The doubles here are shaped after the real
 * option names for exactly that reason.
 *
 * Since 6 Sep 2026 the screen also goes up as simulcast layers, with a top
 * layer the room's size can hold down, and the viewer's side asks for a layer
 * by name. Those are here too, because they are the same seam.
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
    simulcast?: boolean;
    videoEncoding?: { maxBitrate?: number; maxFramerate?: number };
    screenShareEncoding?: { maxBitrate?: number; maxFramerate?: number };
    screenShareSimulcastLayers?: FakePreset[];
    videoSimulcastLayers?: FakePreset[];
    degradationPreference?: string;
    videoCodec?: string;
  };
}

class FakePreset {
  constructor(
    public width: number,
    public height: number,
    public maxBitrate: number,
    public maxFramerate?: number,
  ) {}
}

/** `setParameters` calls a publication's sender received, in order. */
const senderWrites: {
  source: string;
  maxBitrate: number | undefined;
  encodings: RTCRtpEncodingParameters[];
}[] = [];
const published: PublishedTrack[] = [];
const unpublished: { track: unknown; stop: boolean | undefined }[] = [];
/** Every `applyConstraints` the screen capture received, height max only. */
const constrained: number[] = [];
/** `Room` options the session constructed the room with. */
let roomOptions: Record<string, unknown> = {};

function fakeSender(source: string, layers: number) {
  let params: RTCRtpSendParameters = {
    encodings: Array.from({ length: layers }, () => ({})),
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
        maxBitrate: next.encodings?.[next.encodings.length - 1]?.maxBitrate,
        encodings: next.encodings ?? [],
      });
    },
  };
}

/** Publications the local participant currently holds, keyed by source. */
const publications = new Map<
  string,
  {
    track: {
      sender: unknown;
      replaceTrack?: (next: unknown) => Promise<void>;
    };
  }
>();
/** Resolves the next `publishTrack` call. Null means publish immediately. */
let releasePublish: (() => void) | null = null;
let publishHold: Promise<void> | null = null;

function holdNextPublish() {
  publishHold = new Promise((resolve) => {
    releasePublish = resolve;
  });
}

interface FakeRemotePublication {
  source: string;
  isSubscribed: boolean;
  requested: number[];
  setVideoQuality: (quality: number) => void;
  /** Every `setEnabled` the delivery rule sent, in order. */
  enabled: boolean[];
  setEnabled: (enabled: boolean) => void;
}

interface FakeRemoteParticipant {
  identity: string;
  videoTrackPublications: Map<string, FakeRemotePublication>;
}

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

const ConnectionQuality = {
  Excellent: "excellent",
  Good: "good",
  Poor: "poor",
  Lost: "lost",
  Unknown: "unknown",
};

const rooms: FakeRoom[] = [];

class FakeRoom {
  remoteParticipants = new Map<string, FakeRemoteParticipant>();
  handlers = new Map<string, (...args: unknown[]) => void>();
  localParticipant = {
    publishTrack: async (
      track: unknown,
      options: PublishedTrack["options"] = {},
    ) => {
      const hold = publishHold;
      publishHold = null;
      if (hold) {
        await hold;
      }
      published.push({ track, options });
      if (options.source) {
        // Per source, exactly as `computeVideoEncodings` reads it: a camera's
        // rungs are `videoSimulcastLayers` and a screen's are
        // `screenShareSimulcastLayers`. Counting the wrong one here would give
        // the camera a one-encoding sender and quietly stop the "only the top
        // layer moves" rule from being tested at all.
        const rungs =
          options.source === Track.Source.ScreenShare
            ? options.screenShareSimulcastLayers
            : options.videoSimulcastLayers;
        const layers = options.simulcast ? (rungs?.length ?? 0) + 1 : 1;
        publications.set(options.source, {
          track: { sender: fakeSender(options.source, layers) },
        });
      }
    },
    unpublishTrack: async (track: unknown, stop?: boolean) => {
      unpublished.push({ track, stop });
      const entry = published.find((item) => item.track === track);
      if (entry?.options.source) {
        publications.delete(entry.options.source);
      }
    },
    getTrackPublication: (source: string) => publications.get(source),
  };
  constructor(options: Record<string, unknown>) {
    roomOptions = options;
    rooms.push(this);
  }
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }
  async connect() {}
  async disconnect() {}
  /** Test helper: somebody joins the room. */
  join(identity: string): FakeRemoteParticipant {
    const participant: FakeRemoteParticipant = {
      identity,
      videoTrackPublications: new Map(),
    };
    this.remoteParticipants.set(identity, participant);
    this.handlers.get(RoomEvent.ParticipantConnected)?.(participant);
    return participant;
  }
  leave(identity: string) {
    const participant = this.remoteParticipants.get(identity);
    this.remoteParticipants.delete(identity);
    this.handlers.get(RoomEvent.ParticipantDisconnected)?.(participant);
  }
  /** Test helper: LiveKit's Excellent / Good / Poor for one participant. */
  setQuality(identity: string, quality: string) {
    const participant = this.remoteParticipants.get(identity) ?? { identity };
    this.handlers.get(RoomEvent.ConnectionQualityChanged)?.(
      quality,
      participant,
    );
  }
  /** Test helper: a participant's video publication gets subscribed. */
  subscribe(participant: FakeRemoteParticipant, source: string) {
    const publication: FakeRemotePublication = {
      source,
      isSubscribed: true,
      requested: [],
      setVideoQuality(quality: number) {
        this.requested.push(quality);
      },
      enabled: [],
      setEnabled(enabled: boolean) {
        this.enabled.push(enabled);
      },
    };
    participant.videoTrackPublications.set(`${source}-sid`, publication);
    const track = {
      kind: Track.Kind.Video,
      mediaStreamTrack: { kind: "video" },
      attach: () => {},
    };
    this.handlers.get(RoomEvent.TrackSubscribed)?.(track, publication, participant);
    return publication;
  }
  unsubscribe(participant: FakeRemoteParticipant, source: string) {
    const publication = participant.videoTrackPublications.get(`${source}-sid`);
    participant.videoTrackPublications.delete(`${source}-sid`);
    this.handlers.get(RoomEvent.TrackUnsubscribed)?.(
      { kind: Track.Kind.Video },
      publication,
      participant,
    );
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
    ConnectionQuality,
    Track,
    LocalAudioTrack,
    ConnectionState: { Disconnected: "disconnected" },
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

const {
  connectLiveKit,
  HLS_SOURCE_DROP_SAMPLES,
  HLS_SOURCE_RAISE_SAMPLES,
} = await import("./livekit-session");

function fakeTrack(kind: "audio" | "video", id: string, height = 720, frameRate = 30) {
  const settings = { width: Math.round((height * 16) / 9), height, frameRate };
  return {
    kind,
    id,
    contentHint: "",
    // The camera's ladder is solved against the capture's real size, so a
    // fake that reports none would publish the ladder for the size we asked
    // for and never exercise the rule that drops a rung.
    __settings: settings,
    getSettings: () => settings,
    getConstraints: () => ({
      frameRate: { ideal: 30, max: 30 },
      height: { max: 1080 },
    }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      const height = constraints.height;
      if (typeof height === "object" && typeof height.max === "number") {
        constrained.push(height.max);
      }
    },
  } as unknown as MediaStreamTrack;
}

function fakeStream(
  kind: "audio" | "video",
  id: string,
  height = 720,
  frameRate = 30,
): MediaStream {
  const track = fakeTrack(kind, id, height, frameRate);
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

function room(): FakeRoom {
  return rooms[rooms.length - 1]!;
}

/** Fill the room to `total` people, this one included. */
function fillRoom(total: number) {
  for (let i = room().remoteParticipants.size; i < total - 1; i += 1) {
    room().join(`p${i}`);
  }
}

/** Let the reconcile chain the join events queued settle. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  published.length = 0;
  unpublished.length = 0;
  senderWrites.length = 0;
  constrained.length = 0;
  publications.clear();
  rooms.length = 0;
  publishHold = null;
  releasePublish = null;
});

function encodingFor(source: string) {
  return published.find((entry) => entry.options.source === source)?.options;
}

function lastPublish(source: string) {
  return [...published].reverse().find((entry) => entry.options.source === source)
    ?.options;
}

function publishCalls(source: string) {
  return published.filter((entry) => entry.options.source === source).length;
}

/** A live capture resized in place, which is what a quality change does. */
function resizeCamera(height: number) {
  const entry = [...published]
    .reverse()
    .find((e) => e.options.source === Track.Source.Camera);
  const settings = (entry?.track as { __settings?: { width: number; height: number } })
    ?.__settings;
  if (settings) {
    settings.height = height;
    settings.width = Math.round((height * 16) / 9);
  }
}

function lastScreenPublish() {
  return [...published]
    .reverse()
    .find((entry) => entry.options.source === Track.Source.ScreenShare)
    ?.options;
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
    expect(encodingFor(Track.Source.Camera)?.videoCodec).toBeUndefined();
  });

  it("publishes the screen at the chosen ceiling, in the field the library reads", async () => {
    const sfu = await session();
    await sfu.setScreenMaxBitrate(4_000_000);
    await sfu.publishScreen(fakeStream("video", "screen"));

    const options = encodingFor(Track.Source.ScreenShare);
    expect(options?.screenShareEncoding?.maxBitrate).toBe(4_000_000);
    // The field the library ignores for a screen share. Setting it is how a
    // share goes up with no ceiling while every test stays green.
    expect(options?.videoEncoding).toBeUndefined();
    expect(options?.degradationPreference).toBe("maintain-framerate");
    // VP8 software encode sawtoothed on Chromium; H.264 can use hardware on
    // many Macs and is what egress already re-encodes toward for HLS.
    expect(options?.videoCodec).toBe("h264");
  });

  it("publishes a 60 fps capture at 60, so a 720p60 rung has source", async () => {
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen60", 720, 60));
    expect(
      encodingFor(Track.Source.ScreenShare)?.screenShareEncoding?.maxFramerate,
    ).toBe(60);
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
      encodingFor(Track.Source.ScreenShare)?.screenShareEncoding?.maxBitrate,
    ).toBe(4_000_000);
  });
});

describe("a quality chosen while the track is already up", () => {
  it("moves the camera's sender without republishing it", async () => {
    const sfu = await session();
    await sfu.publishCamera(fakeStream("video", "cam"));
    const publishesBefore = published.length;

    await sfu.setCameraMaxBitrate(400_000);

    expect(senderWrites.map((w) => [w.source, w.maxBitrate])).toEqual([
      [Track.Source.Camera, 400_000],
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

    expect(senderWrites.map((w) => [w.source, w.maxBitrate])).toEqual([
      [Track.Source.ScreenShare, 600_000],
    ]);
    expect(published).toHaveLength(publishesBefore);
    expect(unpublished).toHaveLength(0);
  });

  it("moves only the TOP layer of a simulcast screen", async () => {
    // The small layers are small on purpose. A 360p copy handed a 4 Mbps
    // ceiling is no longer the copy a phone wanted.
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));

    await sfu.setScreenMaxBitrate(4_000_000);

    const write = senderWrites[0]!;
    expect(write.encodings).toHaveLength(3);
    expect(write.encodings[2]?.maxBitrate).toBe(4_000_000);
    expect(write.encodings[0]?.maxBitrate).toBeUndefined();
    expect(write.encodings[1]?.maxBitrate).toBeUndefined();
  });

  it("swaps a second share in place so the HLS sid does not change", async () => {
    const replaced: unknown[] = [];
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));
    const publication = publications.get(Track.Source.ScreenShare)!;
    publication.track = {
      ...publication.track,
      replaceTrack: async (next: unknown) => {
        replaced.push(next);
      },
    };
    unpublished.length = 0;
    published.length = 0;

    await sfu.publishScreen(fakeStream("video", "screen-again"));

    expect(replaced).toHaveLength(1);
    expect(unpublished).toEqual([]);
    expect(published).toEqual([]);
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
      encodingFor(Track.Source.ScreenShare)?.screenShareEncoding?.maxBitrate,
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

describe("the screen goes up as simulcast layers", () => {
  it("publishes 360p and 720p under a 1080p top on auto", async () => {
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));

    const options = encodingFor(Track.Source.ScreenShare);
    expect(options?.simulcast).toBe(true);
    expect(
      options?.screenShareSimulcastLayers?.map((layer) => [
        layer.height,
        layer.maxBitrate,
      ]),
    ).toEqual([
      [360, 450_000],
      [720, 1_400_000],
    ]);
    // Auto's top: 1080 lines at the auto ceiling.
    expect(options?.screenShareEncoding?.maxBitrate).toBe(3_000_000);
    expect(constrained).toEqual([1080]);
  });

  // THE CAMERA IS THE OTHER HALF OF THE SAME ARGUMENT, and it was `false`
  // here until 2026-09-08: one copy of a face on the server and every viewer
  // receiving it whatever size their tile was. `adaptiveStream` cannot ask for
  // a layer nobody encodes, so a room of twenty cameras was twenty full-size
  // streams into every phone. These pin the ladder that fixed it.
  it("publishes the camera as a ladder, not as one layer", async () => {
    const sfu = await session();
    await sfu.publishCamera(fakeStream("video", "cam"));

    const options = encodingFor(Track.Source.Camera);
    expect(options?.simulcast).toBe(true);
    expect(options?.videoSimulcastLayers?.map((l) => l.height)).toEqual([
      180, 360,
    ]);
    // `videoEncoding`, not `screenShareEncoding`: the library reads a
    // different field per source and the camera's is this one.
    expect(options?.videoEncoding?.maxBitrate).toBe(1_500_000);
  });

  it("drops a rung the capture is not big enough for", async () => {
    const sfu = await session();
    await sfu.publishCamera(fakeStream("video", "cam", 360));

    expect(
      encodingFor(Track.Source.Camera)?.videoSimulcastLayers?.map(
        (l) => l.height,
      ),
    ).toEqual([180]);
  });

  it("republishes a live camera when its capture crosses a rung", async () => {
    const sfu = await session();
    await sfu.publishCamera(fakeStream("video", "cam", 360));
    expect(
      encodingFor(Track.Source.Camera)?.videoSimulcastLayers?.map(
        (l) => l.height,
      ),
    ).toEqual([180]);

    // The same track, resized in place by a quality change. Nothing
    // republishes on its own; `use-voice.ts` asks after `applyCameraQuality`.
    resizeCamera(1080);
    await sfu.reconcileCameraLadder();

    expect(
      lastPublish(Track.Source.Camera)?.videoSimulcastLayers?.map(
        (l) => l.height,
      ),
    ).toEqual([180, 360]);
  });

  it("does not republish when the ladder is unchanged", async () => {
    const sfu = await session();
    await sfu.publishCamera(fakeStream("video", "cam", 720));
    const before = publishCalls(Track.Source.Camera);

    resizeCamera(1080);
    await sfu.reconcileCameraLadder();

    expect(publishCalls(Track.Source.Camera)).toBe(before);
  });

  it("turns adaptive streaming on for the room", async () => {
    await session();
    expect(roomOptions.adaptiveStream).toBe(true);
  });

  /**
   * THE SAME PROMISE THE CAMERA NOW MAKES, RE-CHECKED FOR THE SHARE.
   *
   * Removing `SCREEN_SHARE_LIMIT.livekit` rests on a share behaving the way
   * the camera does since PR 382: a small tile receives a small layer, so
   * twelve shares are not twelve full-size streams into every phone. Shares
   * have published a ladder since the watch-party work, and this is that fact
   * stated where the count's removal depends on it, so a regression to one
   * layer fails here rather than in production.
   */
  it("offers a small share layer for a small tile, the way the camera does", async () => {
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));

    const options = encodingFor(Track.Source.ScreenShare);
    expect(options?.simulcast).toBe(true);
    // 1080p on top, two smaller copies under it for adaptiveStream to pick.
    expect(options?.screenShareSimulcastLayers?.map((l) => l.height)).toEqual([
      360, 720,
    ]);
    const smallest = options?.screenShareSimulcastLayers?.[0];
    expect(smallest?.maxBitrate).toBeLessThan(
      options?.screenShareEncoding?.maxBitrate ?? 0,
    );
  });

  it("publishes only the rungs below an explicit 720p", async () => {
    const sfu = await session();
    await sfu.setScreenQuality("720p");
    await sfu.publishScreen(fakeStream("video", "screen"));

    const options = encodingFor(Track.Source.ScreenShare);
    expect(options?.screenShareSimulcastLayers?.map((l) => l.height)).toEqual([
      360,
    ]);
    expect(options?.screenShareEncoding?.maxBitrate).toBe(2_000_000);
    expect(constrained).toEqual([720]);
  });
});

describe("the large-room cap", () => {
  it("holds the top layer at 720p and 1.5 Mbps above 20 participants", async () => {
    const sfu = await session();
    fillRoom(21);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));

    const options = encodingFor(Track.Source.ScreenShare);
    expect(constrained).toEqual([720]);
    expect(options?.screenShareEncoding?.maxBitrate).toBe(1_500_000);
    expect(options?.screenShareSimulcastLayers?.map((l) => l.height)).toEqual([
      360,
    ]);
  });

  it("does not cap a room of exactly 20", async () => {
    const sfu = await session();
    fillRoom(20);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));

    expect(constrained).toEqual([1080]);
    expect(
      encodingFor(Track.Source.ScreenShare)?.screenShareEncoding?.maxBitrate,
    ).toBe(3_000_000);
  });

  it("steps aside for an explicit 1080p", async () => {
    const sfu = await session();
    fillRoom(50);
    await settle();
    await sfu.setScreenQuality("1080p");
    await sfu.publishScreen(fakeStream("video", "screen"));

    const options = encodingFor(Track.Source.ScreenShare);
    expect(constrained).toEqual([1080]);
    expect(options?.screenShareEncoding?.maxBitrate).toBe(4_000_000);
    expect(options?.screenShareSimulcastLayers?.map((l) => l.height)).toEqual([
      360, 720,
    ]);
  });

  it("republishes a live share, without stopping the capture, when the room crosses the line", async () => {
    const sfu = await session();
    fillRoom(20);
    await settle();
    const stream = fakeStream("video", "screen");
    await sfu.publishScreen(stream);
    expect(constrained).toEqual([1080]);

    room().join("the-21st");
    await settle();

    // The same track went back up, and the capture stayed alive for it.
    expect(unpublished).toEqual([
      { track: stream.getVideoTracks()[0], stop: false },
    ]);
    expect(constrained).toEqual([1080, 720]);
    expect(lastScreenPublish()?.screenShareEncoding?.maxBitrate).toBe(
      1_500_000,
    );
    expect(lastScreenPublish()?.screenShareSimulcastLayers).toHaveLength(1);
  });

  it("lifts the cap again when the presenter picks 1080p mid-share", async () => {
    const sfu = await session();
    fillRoom(30);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));
    expect(constrained).toEqual([720]);

    await sfu.setScreenQuality("1080p");

    expect(constrained).toEqual([720, 1080]);
    expect(lastScreenPublish()?.screenShareEncoding?.maxBitrate).toBe(
      4_000_000,
    );
    expect(lastScreenPublish()?.screenShareSimulcastLayers).toHaveLength(2);
  });

  it("does not blink the share for a room change that changes nothing", async () => {
    const sfu = await session();
    fillRoom(5);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));
    const publishesBefore = published.length;

    room().join("p-extra");
    room().leave("p0");
    await settle();

    expect(published).toHaveLength(publishesBefore);
    expect(unpublished).toHaveLength(0);
  });
});

describe("the presenter as a live ladder's source", () => {
  async function setHlsUplink(
    sfu: Awaited<ReturnType<typeof session>>,
    uplinkBps: number,
    times = 1,
  ) {
    for (let i = 0; i < times; i++) {
      await sfu.setHlsSource({ ladderTopHeight: 1080, uplinkBps });
    }
  }

  it("does not raise past the large-room cap once the ladder pins the share", async () => {
    // Large room publishes 720 before egress. Raising to 1080 used to be the
    // "intended" first blink; production proved that blink is the stall loop.
    // Layers freeze; the host can still pick 1080 by name.
    const sfu = await session();
    fillRoom(50);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));
    expect(constrained).toEqual([720]);
    const publishesBefore = published.length;

    await setHlsUplink(sfu, 9_000_000, 10);

    expect(published).toHaveLength(publishesBefore);
    expect(constrained).toEqual([720]);
    expect(unpublished).toHaveLength(0);
  });

  it("keeps the layers when the stream drops briefly (egress restart gap)", async () => {
    const sfu = await session();
    fillRoom(50);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));
    await setHlsUplink(sfu, 9_000_000);
    const publishesAfterPin = published.length;
    const unpublishesAfterPin = unpublished.length;
    const writesBefore = senderWrites.length;

    await sfu.setHlsSource(null);

    expect(published).toHaveLength(publishesAfterPin);
    expect(unpublished).toHaveLength(unpublishesAfterPin);
    expect(constrained).toEqual([720]);
    const moved = senderWrites
      .slice(writesBefore)
      .filter((write) => write.source === Track.Source.ScreenShare);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved[moved.length - 1]!.maxBitrate).toBe(1_500_000);

    await sfu.setHlsSource({ ladderTopHeight: 1080, uplinkBps: 9_000_000 });
    expect(published).toHaveLength(publishesAfterPin);
    expect(constrained).toEqual([720]);
  });

  it("never drops a small-room 1080 for a weak uplink while pinned", async () => {
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));
    expect(constrained).toEqual([1080]);
    const publishesBefore = published.length;

    // Two weak ticks: not enough streak to touch capture.
    await setHlsUplink(sfu, 1_000_000, HLS_SOURCE_DROP_SAMPLES - 1);
    expect(constrained).toEqual([1080]);

    await setHlsUplink(sfu, 1_000_000);
    expect(published).toHaveLength(publishesBefore);
    expect(unpublished).toHaveLength(0);
    expect(constrained).toEqual([1080, 720]);

    // Further weak ticks must not re-constrain.
    await setHlsUplink(sfu, 1_000_000, 5);
    expect(constrained).toEqual([1080, 720]);
  });

  it("restores capture height when the uplink recovers, without a new sid", async () => {
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));
    await setHlsUplink(sfu, 1_000_000, HLS_SOURCE_DROP_SAMPLES);
    expect(constrained).toEqual([1080, 720]);
    const publishesBefore = published.length;

    await setHlsUplink(sfu, 9_000_000, HLS_SOURCE_RAISE_SAMPLES - 1);
    expect(constrained).toEqual([1080, 720]);

    await setHlsUplink(sfu, 9_000_000);
    expect(published).toHaveLength(publishesBefore);
    expect(unpublished).toHaveLength(0);
    expect(constrained).toEqual([1080, 720, 1080]);
  });

  it("does not thrash capture when the uplink keeps crossing the line", async () => {
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));
    await setHlsUplink(sfu, 9_000_000);
    const before = constrained.length;

    for (const uplinkBps of [1_000_000, 9_000_000, 1_000_000, 9_000_000]) {
      await sfu.setHlsSource({ ladderTopHeight: 1080, uplinkBps });
    }

    expect(constrained).toHaveLength(before);
    expect(unpublished).toHaveLength(0);
  });

  it("does not raise on an uplink that cannot carry it", async () => {
    const sfu = await session();
    fillRoom(50);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));
    const publishesBefore = published.length;

    await sfu.setHlsSource({ ladderTopHeight: 1080, uplinkBps: 2_000_000 });

    expect(constrained).toEqual([720]);
    expect(published).toHaveLength(publishesBefore);
  });

  /**
   * THE STALL, and it is the whole of it.
   *
   * Any height republish is a new LiveKit sid and a torn-down HLS session.
   * Uplink wobble used to cross a threshold, republish, and loop. Layers
   * freeze for the life of the broadcast; only the bitrate ceiling moves.
   */
  it("holds the layers through an uplink that keeps changing its mind", async () => {
    const sfu = await session();
    fillRoom(50);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));
    await setHlsUplink(sfu, 9_000_000);
    const publishesAfterPin = published.length;
    const unpublishesAfterPin = unpublished.length;

    for (const uplinkBps of [2_000_000, 9_000_000, 1_000_000, 9_000_000]) {
      await sfu.setHlsSource({ ladderTopHeight: 1080, uplinkBps });
    }

    expect(published).toHaveLength(publishesAfterPin);
    expect(unpublished).toHaveLength(unpublishesAfterPin);
    expect(constrained).toEqual([720]);
  });

  it("still lowers the ceiling in place while the layers are held", async () => {
    // Small room: Auto publishes 1080, pin, then weak uplink drops ceiling
    // to the large-room bitrate without a new sid.
    const sfu = await session();
    await sfu.publishScreen(fakeStream("video", "screen"));
    await sfu.setHlsSource({ ladderTopHeight: 1080, uplinkBps: 9_000_000 });
    const writesBefore = senderWrites.length;
    const publishesBefore = published.length;

    await sfu.setHlsSource({ ladderTopHeight: 1080, uplinkBps: 1_000_000 });

    expect(published).toHaveLength(publishesBefore);
    expect(unpublished).toHaveLength(0);
    const moved = senderWrites
      .slice(writesBefore)
      .filter((write) => write.source === Track.Source.ScreenShare);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved[moved.length - 1]!.maxBitrate).toBe(1_500_000);
  });

  /**
   * The host reaching for the quality menu is a deliberate act, and the pin
   * exists to stop a bandwidth estimate rebuffering an audience, not to
   * overrule a person.
   */
  it("lets the host change quality by name even while pinned", async () => {
    const sfu = await session();
    fillRoom(50);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));
    await setHlsUplink(sfu, 9_000_000);
    const publishesAfterPin = published.length;

    await sfu.setScreenQuality("1080p");

    expect(published.length).toBe(publishesAfterPin + 1);
    expect(constrained.at(-1)).toBe(1080);
  });

  it("does not blink the share for a 720p-only ladder", async () => {
    const sfu = await session();
    fillRoom(50);
    await settle();
    await sfu.publishScreen(fakeStream("video", "screen"));
    const publishesBefore = published.length;

    await sfu.setHlsSource({ ladderTopHeight: 720, uplinkBps: 9_000_000 });

    expect(published).toHaveLength(publishesBefore);
    expect(unpublished).toHaveLength(0);
  });

  it("drops a screen publish that finishes after the share was stopped", async () => {
    holdNextPublish();
    const sfu = await session();
    const sharing = sfu.publishScreen(fakeStream("video", "screen"));
    await settle();

    await sfu.unpublishScreen();
    const unpublishedAtStop = unpublished.length;
    releasePublish?.();
    await sharing;

    expect(unpublished.length).toBeGreaterThan(unpublishedAtStop);
    expect(unpublished.at(-1)?.stop).toBe(false);
    expect(publications.has(Track.Source.ScreenShare)).toBe(false);

    const publishesAfterStop = published.length;
    await sfu.setHlsSource({ ladderTopHeight: 1080, uplinkBps: 9_000_000 });
    expect(published).toHaveLength(publishesAfterStop);
  });
});

describe("ConnectionQualityChanged becomes the same three bars", () => {
  it("attaches Excellent / Good / Poor to the remote peer", async () => {
    const seen: { peerId: string; bars?: number }[][] = [];
    await connectLiveKit({
      session: SESSION,
      lookupIdentity: () => undefined,
      onPeersChanged: (peers) => {
        seen.push(
          peers.map((peer) => ({
            peerId: peer.peerId,
            bars: peer.quality?.bars,
          })),
        );
      },
      onError: () => {},
    });
    room().join("rafa");
    room().setQuality("rafa", ConnectionQuality.Poor);

    expect(seen.at(-1)).toEqual([{ peerId: "rafa", bars: 1 }]);
  });
});

describe("the layer this viewer asks for", () => {
  it("maps the four choices onto the library's three qualities", async () => {
    const sfu = await session();
    const rafa = room().join("rafa");
    const publication = room().subscribe(rafa, Track.Source.ScreenShare);
    publication.requested.length = 0;

    await sfu.setReceiveQuality("360p");
    await sfu.setReceiveQuality("720p");
    await sfu.setReceiveQuality("1080p");
    await sfu.setReceiveQuality("auto");

    // LOW, MEDIUM, HIGH, and HIGH again: under adaptive stream HIGH is "no
    // ceiling, the element decides", which is what auto means.
    expect(publication.requested).toEqual([0, 1, 2, 2]);
  });

  it("applies the standing choice to a share that arrives later", async () => {
    const sfu = await session();
    await sfu.setReceiveQuality("720p");
    const rafa = room().join("rafa");

    const publication = room().subscribe(rafa, Track.Source.ScreenShare);

    expect(publication.requested).toEqual([1]);
  });

  it("reaches camera tiles as well as the share", async () => {
    const sfu = await session();
    const rafa = room().join("rafa");
    const screen = room().subscribe(rafa, Track.Source.ScreenShare);
    const camera = room().subscribe(rafa, Track.Source.Camera);

    await sfu.setReceiveQuality("360p");

    expect(screen.requested.at(-1)).toBe(0);
    expect(camera.requested.at(-1)).toBe(0);
  });
});

/**
 * The delivery rule wired to the room: a tile binding its element through
 * `bindRemoteVideo` is what keeps a publication flowing, and the tab going
 * to the background is what pauses all of them. Audio publications never
 * pass through the rule at all; the fake room only hands video to it.
 */
describe("video nobody is drawing", () => {
  let peers: RemotePeer[] = [];
  /** A stand-in `document` whose visibility the test flips. */
  const doc = {
    visibilityState: "visible" as "visible" | "hidden",
    listeners: new Set<() => void>(),
    addEventListener(_type: string, listener: () => void) {
      this.listeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      this.listeners.delete(listener);
    },
    setVisibility(state: "visible" | "hidden") {
      this.visibilityState = state;
      for (const listener of this.listeners) {
        listener();
      }
    },
  };

  async function watchedSession() {
    return connectLiveKit({
      session: SESSION,
      lookupIdentity: () => undefined,
      onPeersChanged: (next) => {
        peers = next;
      },
      onError: () => {},
    });
  }

  function video() {
    return { srcObject: null } as unknown as HTMLVideoElement;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    peers = [];
    doc.visibilityState = "visible";
    doc.listeners.clear();
    // Not `vi.stubGlobal`: unstubbing that would also drop the file-level
    // `MediaStream` stub every other suite here relies on.
    (globalThis as { document?: unknown }).document = doc;
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    vi.useRealTimers();
  });

  it("pauses a share no tile ever bound, and resumes when one does", async () => {
    await watchedSession();
    const rafa = room().join("rafa");
    const publication = room().subscribe(rafa, Track.Source.ScreenShare);

    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS);
    expect(publication.enabled).toEqual([false]);

    const stream = peers.find((p) => p.peerId === "rafa")?.screenStream;
    expect(stream).toBeTruthy();
    bindRemoteVideo(video(), stream!);
    // The fake publication has no private `requestedDisabled`, so the
    // fallback `setEnabled(true)` is what lifts the pause.
    expect(publication.enabled).toEqual([false, true]);
  });

  it("pauses a parked camera tile a grace after its element goes, not before", async () => {
    await watchedSession();
    const rafa = room().join("rafa");
    const publication = room().subscribe(rafa, Track.Source.Camera);
    const stream = peers.find((p) => p.peerId === "rafa")?.cameraStream;
    const unbind = bindRemoteVideo(video(), stream!);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS * 2);
    expect(publication.enabled).toEqual([]);

    unbind();
    expect(publication.enabled).toEqual([]);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS);
    expect(publication.enabled).toEqual([false]);
  });

  it("hands the decision back to the library when the field is there", async () => {
    await watchedSession();
    const rafa = room().join("rafa");
    const publication = room().subscribe(rafa, Track.Source.ScreenShare) as FakeRemotePublication & {
      requestedDisabled?: boolean;
      updates: number;
      emitTrackUpdate: () => void;
    };
    publication.requestedDisabled = undefined;
    publication.updates = 0;
    publication.emitTrackUpdate = () => {
      publication.updates += 1;
    };

    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS);
    expect(publication.enabled).toEqual([false]);
    const stream = peers.find((p) => p.peerId === "rafa")?.screenStream;
    bindRemoteVideo(video(), stream!);

    // No `setEnabled(true)`: that would pin the track on and switch the
    // adaptive-stream pause off for the rest of the call.
    expect(publication.enabled).toEqual([false]);
    expect(publication.requestedDisabled).toBeUndefined();
    expect(publication.updates).toBe(1);
  });

  it("pauses every video ten seconds into the background and resumes on return", async () => {
    await watchedSession();
    const rafa = room().join("rafa");
    const screen = room().subscribe(rafa, Track.Source.ScreenShare);
    const camera = room().subscribe(rafa, Track.Source.Camera);
    const peer = peers.find((p) => p.peerId === "rafa")!;
    bindRemoteVideo(video(), peer.screenStream!);
    bindRemoteVideo(video(), peer.cameraStream!);

    doc.setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1);
    expect(screen.enabled).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(screen.enabled).toEqual([false]);
    expect(camera.enabled).toEqual([false]);

    doc.setVisibility("visible");
    expect(screen.enabled).toEqual([false, true]);
    expect(camera.enabled).toEqual([false, true]);
  });

  it("stops listening to the tab when the session ends", async () => {
    const sfu = await watchedSession();
    expect(doc.listeners.size).toBe(1);
    await sfu.disconnect();
    expect(doc.listeners.size).toBe(0);
  });

  it("forgets an unsubscribed track", async () => {
    await watchedSession();
    const rafa = room().join("rafa");
    const publication = room().subscribe(rafa, Track.Source.ScreenShare);
    room().unsubscribe(rafa, Track.Source.ScreenShare);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS * 2);
    expect(publication.enabled).toEqual([]);
  });
});
