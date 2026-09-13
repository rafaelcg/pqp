import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";
import type { RemotePeer } from "./peer-connection-manager";

/**
 * A camera and a screen share, up at the same time, on the SFU.
 *
 * WHY THIS FILE EXISTS. On 5 Sep 2026 a presenter in a 200-person watch party
 * had her screen share and her camera on together. Her own UI said the camera
 * was on; the room reported not being able to see it. The share was fine.
 *
 * That shape has two very different explanations and only one of them is a
 * media bug: either the second video track never really went up (or went up
 * over the first), or it went up, arrived, was drawn, and was drawn somewhere
 * nobody looked. It turned out to be the second — the camera tile was in the
 * participant rail, off-screen, in a strip that could not be scrolled to it —
 * and the layout is being fixed on its own. What that leaves is a media path
 * everybody now believes is sound and nothing pins, on the transport that
 * carries the big rooms.
 *
 * So this is the suite `livekit-session-quality.test.ts` says in its header is
 * somebody else's job: which SOURCE each publication goes up under, and a
 * camera and a share coexisting. Both halves are asserted, because both are
 * silent when broken:
 *
 *   - Sending, one video sender reused for both would look exactly like the
 *     report: the presenter's UI is local state and says "camera on" either
 *     way.
 *   - Receiving, a filter that admits `ScreenShare` and drops `Camera` would
 *     also look exactly like the report, and one exists on purpose in the
 *     Android client (`livekitSubscribesTo`, which draws no camera tiles). The
 *     web has never had one. These tests are what keeps it that way.
 *
 * The doubles are shaped after `livekit-client` 2.21.0's real option names for
 * the same reason the quality suite's are: asserting a field the library never
 * reads is how the screen share went up with no ceiling for weeks.
 */

// ------------------------------------------------------------------- doubles

interface PublishedTrack {
  track: unknown;
  source: string | undefined;
  /** The publication name. Only `mic-archive` means anything (pitfall 14). */
  name: string | undefined;
}

/** Every publish, in order, so "the camera replaced the screen" is visible. */
const published: PublishedTrack[] = [];
/** Every unpublish, in order, with the exact track object it was given. */
const unpublished: unknown[] = [];
/** The full option bag of every publish, for the fields only one track sets. */
const publishOptions: Record<string, unknown>[] = [];

class FakePreset {
  constructor(
    public width: number,
    public height: number,
    public maxBitrate: number,
    public maxFramerate?: number,
  ) {}
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

interface FakeRemotePublication {
  source: string;
  isSubscribed: boolean;
  setVideoQuality: (quality: number) => void;
  setEnabled: (enabled: boolean) => void;
}

interface FakeRemoteParticipant {
  identity: string;
  name?: string;
  videoTrackPublications: Map<string, FakeRemotePublication>;
}

/** Local publications the participant currently holds, keyed by source. */
const publications = new Map<string, { track: { sender: unknown } }>();

const rooms: FakeRoom[] = [];

class FakeRoom {
  state = "connected";
  remoteParticipants = new Map<string, FakeRemoteParticipant>();
  handlers = new Map<string, (...args: unknown[]) => void>();
  localParticipant = {
    publishTrack: async (
      track: unknown,
      options: { source?: string; name?: string; dtx?: boolean; red?: boolean } = {},
    ) => {
      published.push({ track, source: options.source, name: options.name });
      publishOptions.push(options);
      if (options.source) {
        publications.set(options.source, {
          track: { sender: { getParameters: () => ({}), setParameters: async () => {} } },
        });
      }
    },
    unpublishTrack: async (track: unknown) => {
      unpublished.push(track);
      for (const [source, entry] of publications) {
        if ((entry as unknown as { raw?: unknown }).raw === track) {
          publications.delete(source);
        }
      }
    },
    getTrackPublication: (source: string) => publications.get(source),
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

  /** Test helper: somebody joins. */
  join(identity: string): FakeRemoteParticipant {
    const participant: FakeRemoteParticipant = {
      identity,
      videoTrackPublications: new Map(),
    };
    this.remoteParticipants.set(identity, participant);
    this.handlers.get(RoomEvent.ParticipantConnected)?.(participant);
    return participant;
  }

  /** Test helper: one of their video publications is subscribed. */
  subscribeVideo(participant: FakeRemoteParticipant, source: string) {
    const publication: FakeRemotePublication = {
      source,
      isSubscribed: true,
      setVideoQuality: () => {},
      setEnabled: () => {},
    };
    participant.videoTrackPublications.set(`${source}-sid`, publication);
    const track = {
      kind: Track.Kind.Video,
      mediaStreamTrack: { kind: "video", id: `${participant.identity}:${source}` },
      attach: () => {},
    };
    this.handlers.get(RoomEvent.TrackSubscribed)?.(track, publication, participant);
    return publication;
  }

  /**
   * Test helper: one of their AUDIO publications is subscribed. `trackName` is
   * what tells the host's real microphone from the watch-party archive; both
   * arrive tagged `Microphone`, which is the whole reason this matters.
   */
  subscribeAudio(
    participant: FakeRemoteParticipant,
    source: string,
    trackName = "",
  ) {
    const publication = {
      source,
      trackName,
      isSubscribed: true,
      subscribedCalls: [] as boolean[],
      setSubscribed(subscribed: boolean) {
        this.subscribedCalls.push(subscribed);
        this.isSubscribed = subscribed;
      },
      setEnabled: () => {},
    };
    const track = {
      kind: Track.Kind.Audio,
      mediaStreamTrack: {
        kind: "audio",
        id: `${participant.identity}:${trackName || source}`,
      },
      attach: () => {},
    };
    this.handlers.get(RoomEvent.TrackSubscribed)?.(track, publication, participant);
    return publication;
  }

  unsubscribeVideo(participant: FakeRemoteParticipant, source: string) {
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

function fakeVideoTrack(id: string): MediaStreamTrack {
  return {
    kind: "video",
    id,
    contentHint: "",
    getConstraints: () => ({ height: { max: 1080 } }),
    applyConstraints: async () => {},
  } as unknown as MediaStreamTrack;
}

function videoStream(id: string): { stream: MediaStream; track: MediaStreamTrack } {
  const track = fakeVideoTrack(id);
  return {
    track,
    stream: {
      id: `stream-${id}`,
      getTracks: () => [track],
      getAudioTracks: () => [],
      getVideoTracks: () => [track],
    } as unknown as MediaStream,
  };
}

const SESSION: VoiceSessionInfo = {
  backend: "livekit",
  url: "ws://sfu",
  token: "t",
  room: "room",
  identity: "presenter",
};

let peers: RemotePeer[] = [];

async function session() {
  peers = [];
  return connectLiveKit({
    session: SESSION,
    lookupIdentity: () => undefined,
    onPeersChanged: (next) => {
      peers = next;
    },
    onError: () => {},
  });
}

function room(): FakeRoom {
  return rooms[rooms.length - 1]!;
}

function sourcesPublished() {
  return published.map((entry) => entry.source);
}

beforeEach(() => {
  published.length = 0;
  publishOptions.length = 0;
  unpublished.length = 0;
  publications.clear();
  rooms.length = 0;
  peers = [];
});

describe("publishing a camera and a screen share together", () => {
  it("puts both on the wire, each under its own source", async () => {
    const sfu = await session();
    const screen = videoStream("screen");
    const camera = videoStream("camera");

    await sfu.publishScreen(screen.stream);
    await sfu.publishCamera(camera.stream);

    expect(sourcesPublished()).toEqual([
      Track.Source.ScreenShare,
      Track.Source.Camera,
    ]);
    // The one that would look exactly like the 5 Sep report: a second publish
    // that quietly withdrew the first, or reused its sender.
    expect(unpublished).toEqual([]);
    expect(published[0]!.track).toBe(screen.track);
    expect(published[1]!.track).toBe(camera.track);
  });

  it("does the same in the other order", async () => {
    const sfu = await session();
    const camera = videoStream("camera");
    const screen = videoStream("screen");

    await sfu.publishCamera(camera.stream);
    await sfu.publishScreen(screen.stream);

    expect(sourcesPublished()).toEqual([
      Track.Source.Camera,
      Track.Source.ScreenShare,
    ]);
    expect(unpublished).toEqual([]);
  });

  it("stops the share without taking the camera down with it", async () => {
    const sfu = await session();
    const screen = videoStream("screen");
    const camera = videoStream("camera");
    await sfu.publishScreen(screen.stream);
    await sfu.publishCamera(camera.stream);

    await sfu.unpublishScreen();

    expect(unpublished).toEqual([screen.track]);
  });

  it("stops the camera without taking the share down with it", async () => {
    const sfu = await session();
    const screen = videoStream("screen");
    const camera = videoStream("camera");
    await sfu.publishScreen(screen.stream);
    await sfu.publishCamera(camera.stream);

    await sfu.unpublishCamera();

    expect(unpublished).toEqual([camera.track]);
  });

  /**
   * The share is republished whenever the room crosses the large-room line
   * (`reconcileScreenPlan`), and that is an unpublish and a publish of a live
   * video track while a second video track is up. The camera must not be what
   * comes back down, and must not be republished either: a republish is a
   * blink for every subscriber.
   */
  it("republishes only the share when the room crosses the large-room line", async () => {
    const sfu = await session();
    await sfu.publishScreen(videoStream("screen").stream);
    await sfu.publishCamera(videoStream("camera").stream);
    published.length = 0;
    unpublished.length = 0;

    for (let i = 0; i < 25; i += 1) {
      room().join(`viewer-${i}`);
    }
    await settle();

    expect(sourcesPublished().every((source) => source === Track.Source.ScreenShare))
      .toBe(true);
    expect(unpublished).not.toContain(
      published.find((entry) => entry.source === Track.Source.Camera)?.track,
    );
  });
});

describe("receiving a camera and a screen share from the same person", () => {
  it("files both, and neither displaces the other", async () => {
    await session();
    const presenter = room().join("presenter-2");

    room().subscribeVideo(presenter, Track.Source.ScreenShare);
    room().subscribeVideo(presenter, Track.Source.Camera);

    const peer = peers.find((p) => p.peerId === "presenter-2")!;
    expect(peer.screenStream).not.toBeNull();
    expect(peer.cameraStream).not.toBeNull();
    expect(peer.cameraStream).not.toBe(peer.screenStream);
  });

  /**
   * THE EXACT SHAPE THAT WAS REPORTED. A camera that arrives at a viewer who
   * is already watching that person's share has to be filed, not dropped. The
   * Android client deliberately refuses cameras on this transport
   * (`livekitSubscribesTo`); the web never has, and nothing said so out loud.
   */
  it("admits a camera that starts while that person's share is already up", async () => {
    await session();
    const presenter = room().join("presenter-2");
    room().subscribeVideo(presenter, Track.Source.ScreenShare);

    room().subscribeVideo(presenter, Track.Source.Camera);

    expect(peers.find((p) => p.peerId === "presenter-2")!.cameraStream).not.toBeNull();
  });

  it("keeps the camera when the share ends", async () => {
    await session();
    const presenter = room().join("presenter-2");
    room().subscribeVideo(presenter, Track.Source.ScreenShare);
    room().subscribeVideo(presenter, Track.Source.Camera);

    room().unsubscribeVideo(presenter, Track.Source.ScreenShare);

    const peer = peers.find((p) => p.peerId === "presenter-2")!;
    expect(peer.screenStream).toBeNull();
    expect(peer.cameraStream).not.toBeNull();
  });

  it("keeps the share when the camera goes off", async () => {
    await session();
    const presenter = room().join("presenter-2");
    room().subscribeVideo(presenter, Track.Source.ScreenShare);
    room().subscribeVideo(presenter, Track.Source.Camera);

    room().unsubscribeVideo(presenter, Track.Source.Camera);

    const peer = peers.find((p) => p.peerId === "presenter-2")!;
    expect(peer.cameraStream).toBeNull();
    expect(peer.screenStream).not.toBeNull();
  });
});

/**
 * The microphone, which is the source this file was missing and the one that
 * cost the most.
 *
 * Every publication the web client makes carries a source EXCEPT the mic:
 * `new LocalAudioTrack(raw)` starts at `Track.Source.Unknown` and
 * `publishTrack` only overwrites that when `source` is passed. A real
 * production room, sampled on 2026-09-09 during a live watch party, showed the
 * host's microphone as `source = 0` (UNKNOWN) beside a screen share correctly
 * tagged `3`.
 *
 * That is not cosmetic. `liveKitPublishGrant` (server/src/voice/backends.ts)
 * sends `canPublishSources: ["microphone"]` to anyone holding SPEAK and not
 * STREAM, and LiveKit treats a non-empty list as an allowlist that UNKNOWN is
 * not in (`VideoGrant.GetCanPublishSource` in livekit/protocol). In a
 * `watch_party` channel the stream bit is START_WATCH_PARTY, which no ordinary
 * member holds, so an invited speaker got exactly that grant and the media
 * server refused their microphone. Their own app showed them unmuted.
 */
describe("publishing the microphone", () => {
  it("tags it as the microphone, which is what a SPEAK-only grant allows", async () => {
    const sfu = await session();

    await sfu.publish(audioStream("mic").stream);

    expect(sourcesPublished()).toEqual([Track.Source.Microphone]);
    // Stated separately because the failure was not a WRONG source, it was no
    // source at all, and a list comparison that happened to be `[undefined]`
    // reads like a missing publish rather than an untagged one.
    expect(published[0]!.source).not.toBeUndefined();
  });

  it("keeps tagging it when the capture is replaced", async () => {
    const sfu = await session();

    await sfu.publish(audioStream("mic-1").stream);
    await sfu.replaceTrack(audioStream("mic-2").stream);

    expect(sourcesPublished()).toEqual([
      Track.Source.Microphone,
      Track.Source.Microphone,
    ]);
  });

  it("puts a mic, a camera and a share up under three different sources", async () => {
    const sfu = await session();

    await sfu.publish(audioStream("mic").stream);
    await sfu.publishCamera(videoStream("camera").stream);
    await sfu.publishScreen(videoStream("screen").stream);

    expect(sourcesPublished()).toEqual([
      Track.Source.Microphone,
      Track.Source.Camera,
      Track.Source.ScreenShare,
    ]);
  });
});

/**
 * THE ONE TRACK NOBODY PLAYS: the watch-party voice archive.
 *
 * A host on a deployment with `LIVE_HLS_MIC_ARCHIVE` on publishes their
 * processed microphone a SECOND time, under the name `mic-archive`, so the
 * server can write the voice to its own file beside the HLS segments. It is
 * published as a `Microphone` because a publish grant is an allowlist of
 * SOURCES (pitfall 14) and an invented one would be refused by the media
 * server while the host's app showed it live — so the name is the only thing
 * that tells the archive from the voice.
 *
 * Which makes the receive rule load-bearing rather than a saving. To every
 * other client this looks exactly like the presenter's microphone: filed, it
 * would OVERWRITE their real voice stream with a duplicate of the same person;
 * left subscribed, it would cost every viewer in a 200-person party a second
 * audio stream they can never hear. Both halves are asserted here, because
 * both are silent when broken — the same reason the source assertions above
 * exist at all.
 */
describe("the watch-party mic archive", () => {
  it("publishes it as a microphone, named, beside the real one", async () => {
    const sfu = await session();

    await sfu.publish(audioStream("mic").stream);
    await sfu.publishMicArchive(audioStream("mic-archive").stream);

    // Two microphones on the wire, which is the point: the room hears the
    // first, the egress records the second.
    expect(sourcesPublished()).toEqual([
      Track.Source.Microphone,
      Track.Source.Microphone,
    ]);
    // The real mic is NOT named, so the name can never be ambiguous.
    expect(published[0]!.name).toBeUndefined();
    expect(published[1]!.name).toBe("mic-archive");
    // And the first publication is not withdrawn to make room for it.
    expect(unpublished).toEqual([]);
  });

  it("turns off the two things that make live speech cheaper and a file worse", async () => {
    const sfu = await session();

    await sfu.publishMicArchive(audioStream("mic-archive").stream);

    // DTX cuts the stream during silence, which an editor lining the voice up
    // against the film reads as drift. RED spends the host's uplink — which
    // is already carrying the share — on redundancy for a listener who does
    // not exist. The live microphone keeps both; this one must not.
    expect(publishOptions[0]).toMatchObject({ dtx: false, red: false });
  });

  it("withdraws it without touching the live microphone", async () => {
    const sfu = await session();
    const mic = audioStream("mic");
    const archive = audioStream("mic-archive");
    await sfu.publish(mic.stream);
    await sfu.publishMicArchive(archive.stream);

    await sfu.unpublishMicArchive();

    expect(unpublished).toHaveLength(1);
    // The LocalAudioTrack wrapper, not the raw track: what matters is that it
    // is the archive's and not the live mic's.
    expect((unpublished[0] as { track: unknown }).track).toBe(archive.track);
    // Idempotent: a share that ends twice must not throw.
    await sfu.unpublishMicArchive();
    expect(unpublished).toHaveLength(1);
  });

  it("never delivers a mic-archive publication, and unsubscribes from it", async () => {
    await session();
    const presenter = room().join("presenter-2");

    const voice = room().subscribeAudio(presenter, Track.Source.Microphone);
    const archive = room().subscribeAudio(
      presenter,
      Track.Source.Microphone,
      "mic-archive",
    );

    const peer = peers.find((p) => p.peerId === "presenter-2")!;
    // The voice that arrived FIRST is still the one on the roster: the
    // archive did not displace it. This is the failure that would have been
    // invisible — the presenter would still be audible, just twice.
    expect(peer.stream).not.toBeNull();
    expect(
      (peer.stream!.getTracks()[0] as unknown as { id: string }).id,
    ).toBe("presenter-2:microphone");
    // And the bytes are refused rather than merely dropped on the floor.
    expect(archive.subscribedCalls).toEqual([false]);
    expect(voice.subscribedCalls).toEqual([]);
  });

  /**
   * The order the host actually produces: the archive goes up a beat AFTER
   * the mix, so on a viewer who joined late it can be the first of the two
   * microphones to arrive. It must not become their voice.
   */
  it("does not become the presenter's voice when it arrives first", async () => {
    await session();
    const presenter = room().join("presenter-2");

    room().subscribeAudio(presenter, Track.Source.Microphone, "mic-archive");

    expect(peers.find((p) => p.peerId === "presenter-2")!.stream).toBeNull();
  });
});

function fakeAudioTrack(id: string): MediaStreamTrack {
  return {
    kind: "audio",
    id,
    enabled: true,
    getConstraints: () => ({}),
    applyConstraints: async () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaStreamTrack;
}

function audioStream(id: string): {
  stream: MediaStream;
  track: MediaStreamTrack;
} {
  const track = fakeAudioTrack(id);
  return {
    track,
    stream: {
      id: `stream-${id}`,
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
    } as unknown as MediaStream,
  };
}

/** Let the reconcile chain the join events queued settle. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
