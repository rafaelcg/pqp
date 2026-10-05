import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";
import type { RemotePeer } from "./peer-connection-manager";
import { bindRemoteVideo } from "./remote-video-binding";
import {
  recordShareFastStartQuality,
  resetShareFastStartForTests,
  setShareFastStartServer,
} from "./share-fast-start";

/**
 * `share_fast_start_quality` in the LiveKit session, against a fake room.
 *
 * The numbers that justify each rule come from the rig in
 * `client/e2e/share-fast-start/` (a real LiveKit 1.13.6 and real Chrome);
 * this suite pins the decisions so a refactor cannot quietly undo them:
 *
 *   - a viewer asks for the share's layer when the publication is first
 *     known, before the subscription, at the layer a 720-line stage wants,
 *     and hands the real ceiling back only once the stage has an element;
 *   - a presenter's share is not republished when the room crosses twenty;
 *     the top layer's ceiling moves in place;
 *   - the capture's height ceiling goes out with a width that lets it apply;
 *   - with the flag off, all three are exactly what they were.
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
  TrackPublished: "trackPublished",
  SignalConnected: "signalConnected",
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  Disconnected: "disconnected",
  ConnectionStateChanged: "connectionStateChanged",
  ConnectionQualityChanged: "connectionQualityChanged",
  MediaDevicesError: "mediaDevicesError",
};

const LOW = 0;
const MEDIUM = 1;
const HIGH = 2;

interface FakeRemotePublication {
  kind: string;
  source: string;
  track?: unknown;
  isSubscribed: boolean;
  trackInfo?: { layers: { quality: number; height: number }[] };
  requested: number[];
  setVideoQuality: (quality: number) => void;
  setEnabled: (enabled: boolean) => void;
}

interface FakeRemoteParticipant {
  identity: string;
  trackPublications: Map<string, FakeRemotePublication>;
  videoTrackPublications: Map<string, FakeRemotePublication>;
}

const published: { track: unknown; options: Record<string, unknown> }[] = [];
const unpublished: unknown[] = [];
const senderTops: (number | undefined)[] = [];
const constraintsSeen: MediaTrackConstraints[] = [];
const publications = new Map<string, { track: { sender: unknown } }>();
const rooms: FakeRoom[] = [];

function fakeSender(layers: number) {
  let params = {
    encodings: Array.from({ length: layers }, () => ({})),
  } as unknown as RTCRtpSendParameters;
  return {
    getParameters: () => params,
    setParameters: async (next: RTCRtpSendParameters) => {
      params = next;
      senderTops.push(next.encodings?.[next.encodings.length - 1]?.maxBitrate);
    },
  };
}

class FakeRoom {
  remoteParticipants = new Map<string, FakeRemoteParticipant>();
  handlers = new Map<string, (...args: unknown[]) => void>();
  localParticipant = {
    publishTrack: async (track: unknown, options: Record<string, unknown> = {}) => {
      published.push({ track, options });
      const source = options.source as string | undefined;
      if (source) {
        const rungs = (options.screenShareSimulcastLayers as unknown[] | undefined) ?? [];
        publications.set(source, {
          track: { sender: fakeSender(options.simulcast ? rungs.length + 1 : 1) },
        });
      }
    },
    unpublishTrack: async (track: unknown) => {
      unpublished.push(track);
      const entry = published.find((item) => item.track === track);
      const source = entry?.options.source as string | undefined;
      if (source) {
        publications.delete(source);
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
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args);
  }
  participant(identity: string): FakeRemoteParticipant {
    const participant: FakeRemoteParticipant = {
      identity,
      trackPublications: new Map(),
      videoTrackPublications: new Map(),
    };
    this.remoteParticipants.set(identity, participant);
    return participant;
  }
  join(identity: string) {
    const participant = this.participant(identity);
    this.emit(RoomEvent.ParticipantConnected, participant);
    return participant;
  }
}

function remotePublication(
  source: string,
  heights: number[],
  kind = Track.Kind.Video,
): FakeRemotePublication {
  return {
    kind,
    source,
    isSubscribed: false,
    trackInfo: { layers: heights.map((height, quality) => ({ quality, height })) },
    requested: [],
    setVideoQuality(quality: number) {
      this.requested.push(quality);
    },
    setEnabled() {},
  };
}

vi.mock("livekit-client", () => {
  class LocalAudioTrack {
    constructor(public track: unknown) {}
  }
  class DefaultReconnectPolicy {
    nextRetryDelayInMs() {
      return 0;
    }
  }
  class VideoPreset {
    constructor(
      public width: number,
      public height: number,
      public maxBitrate: number,
      public maxFramerate?: number,
    ) {}
  }
  return {
    Room: FakeRoom,
    RoomEvent,
    ConnectionQuality: { Excellent: "excellent", Good: "good", Poor: "poor", Lost: "lost", Unknown: "unknown" },
    Track,
    LocalAudioTrack,
    ConnectionState: { Disconnected: "disconnected" },
    VideoPreset,
    VideoQuality: { LOW, MEDIUM, HIGH },
    DefaultReconnectPolicy,
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

const SESSION: VoiceSessionInfo = {
  backend: "livekit",
  url: "ws://sfu",
  token: "t",
  room: "room",
  identity: "peer",
};

let peers: RemotePeer[] = [];

async function connect() {
  const session = await connectLiveKit({
    session: SESSION,
    lookupIdentity: () => undefined,
    onPeersChanged: (next) => {
      peers = next;
    },
    onError: () => {},
  });
  return { session, room: rooms[rooms.length - 1]! };
}

function subscribe(room: FakeRoom, participant: FakeRemoteParticipant, publication: FakeRemotePublication) {
  const track = {
    kind: publication.kind,
    mediaStreamTrack: { kind: publication.kind },
    attach: vi.fn(),
  };
  publication.track = track;
  publication.isSubscribed = true;
  participant.videoTrackPublications.set(publication.source, publication);
  room.emit(RoomEvent.TrackSubscribed, track, publication, participant);
  return track;
}

/** A 1920x1080 display capture opened with `screenCaptureOptions`' ceilings. */
function screenStream(): MediaStream {
  const settings = { width: 1920, height: 1080, frameRate: 30 };
  const track = {
    kind: "video",
    id: "screen",
    contentHint: "",
    getSettings: () => settings,
    getConstraints: () => ({ frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } }),
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      constraintsSeen.push(constraints);
      const width = constraints.width;
      const height = constraints.height;
      const widthMax = typeof width === "object" ? width.max : undefined;
      const heightMax = typeof height === "object" ? height.max : undefined;
      // What Chrome did in the probe: a height ceiling under a width ceiling
      // that still fits the old size is ignored.
      if (heightMax !== undefined && (widthMax === undefined || widthMax <= Math.ceil((heightMax * 16) / 9))) {
        settings.height = Math.min(1080, heightMax);
        settings.width = Math.round((settings.height * 16) / 9);
      }
    },
  } as unknown as MediaStreamTrack;
  return {
    id: "stream-screen",
    getTracks: () => [track],
    getAudioTracks: () => [],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function fillRoom(room: FakeRoom, total: number) {
  for (let i = room.remoteParticipants.size; i < total - 1; i += 1) {
    room.join(`p${i}`);
  }
}

beforeEach(() => {
  published.length = 0;
  unpublished.length = 0;
  senderTops.length = 0;
  constraintsSeen.length = 0;
  publications.clear();
  rooms.length = 0;
  peers = [];
});

afterEach(() => {
  resetShareFastStartForTests();
  vi.useRealTimers();
});

function flagOn() {
  setShareFastStartServer("server-1");
  recordShareFastStartQuality("server-1", true);
}

describe("viewer: the share is asked for before it is bound", () => {
  it("flag off: nothing is asked before the subscription, and the subscription asks for the ceiling", async () => {
    const { room } = await connect();
    const host = room.participant("host");
    const share = remotePublication(Track.Source.ScreenShare, [360, 720, 1080]);
    host.trackPublications.set("share", share);
    room.emit(RoomEvent.SignalConnected);
    expect(share.requested).toEqual([]);
    subscribe(room, host, share);
    expect(share.requested).toEqual([HIGH]);
  });

  it("flag on: the join response's share is asked for at the 720p layer, a camera is not", async () => {
    flagOn();
    const { room } = await connect();
    const host = room.participant("host");
    const share = remotePublication(Track.Source.ScreenShare, [360, 720, 1080]);
    const camera = remotePublication(Track.Source.Camera, [180, 360, 720]);
    host.trackPublications.set("share", share);
    host.trackPublications.set("camera", camera);
    room.emit(RoomEvent.SignalConnected);
    expect(share.requested).toEqual([MEDIUM]);
    expect(camera.requested).toEqual([]);
  });

  it("flag on: a share that starts later is asked for when it is published", async () => {
    flagOn();
    const { room } = await connect();
    const host = room.participant("host");
    const share = remotePublication(Track.Source.ScreenShare, [360, 720]);
    room.emit(RoomEvent.TrackPublished, share, host);
    expect(share.requested).toEqual([MEDIUM]);
  });

  it("flag on: an already subscribed share is left to the subscription path", async () => {
    flagOn();
    const { room } = await connect();
    const host = room.participant("host");
    const share = remotePublication(Track.Source.ScreenShare, [360, 720]);
    share.track = {};
    room.emit(RoomEvent.TrackPublished, share, host);
    expect(share.requested).toEqual([]);
  });

  it("flag on: the real ceiling waits for the stage's element, then follows it", async () => {
    flagOn();
    vi.useFakeTimers();
    const { room } = await connect();
    const host = room.participant("host");
    const share = remotePublication(Track.Source.ScreenShare, [360, 720, 1080]);
    host.trackPublications.set("share", share);
    room.emit(RoomEvent.SignalConnected);
    const track = subscribe(room, host, share);
    // No bare HIGH between the subscription and the element's measurement:
    // that is what bound the rig's viewers to the 1080p copy for a second.
    expect(share.requested).toEqual([MEDIUM]);
    const stream = peers.find((peer) => peer.screenStream)?.screenStream ?? null;
    expect(stream).not.toBeNull();
    const video = { srcObject: null } as unknown as HTMLVideoElement;
    bindRemoteVideo(video, stream);
    expect(track.attach).toHaveBeenCalledWith(video);
    expect(share.requested).toEqual([MEDIUM]);
    vi.advanceTimersByTime(300);
    expect(share.requested).toEqual([MEDIUM, HIGH]);
  });

  it("flag on: the viewer's own smaller choice is the early ask too", async () => {
    flagOn();
    const { room, session } = await connect();
    await session.setReceiveQuality("360p");
    const host = room.participant("host");
    const share = remotePublication(Track.Source.ScreenShare, [360, 720, 1080]);
    room.emit(RoomEvent.TrackPublished, share, host);
    expect(share.requested).toEqual([LOW]);
  });
});

describe("presenter: the room crossing twenty", () => {
  it("flag off: the share is republished (today's behaviour)", async () => {
    const { room, session } = await connect();
    fillRoom(room, 10);
    await session.publishScreen(screenStream());
    await settle();
    expect(published).toHaveLength(1);
    fillRoom(room, 22);
    await settle();
    expect(unpublished).toHaveLength(1);
    expect(published).toHaveLength(2);
  });

  it("flag on: nothing is republished, the top layer's ceiling moves in place", async () => {
    flagOn();
    const { room, session } = await connect();
    fillRoom(room, 10);
    await session.publishScreen(screenStream());
    await settle();
    expect(published).toHaveLength(1);
    fillRoom(room, 22);
    await settle();
    expect(unpublished).toHaveLength(0);
    expect(published).toHaveLength(1);
    expect(senderTops.at(-1)).toBe(1_500_000);
  });
});

describe("presenter: the capture really comes down", () => {
  it("flag off: the height ceiling goes out under the opening width ceiling", async () => {
    const { room, session } = await connect();
    fillRoom(room, 22);
    await session.publishScreen(screenStream());
    const last = constraintsSeen.at(-1)!;
    expect(last.height).toMatchObject({ max: 720 });
    expect(last.width).toEqual({ max: 1920 });
  });

  it("flag on: the width ceiling is scaled to the height", async () => {
    flagOn();
    const { room, session } = await connect();
    fillRoom(room, 22);
    await session.publishScreen(screenStream());
    const last = constraintsSeen.at(-1)!;
    expect(last.height).toEqual({ max: 720 });
    expect(last.width).toEqual({ max: 1280 });
    expect(last.frameRate).toEqual({ ideal: 30, max: 30 });
  });
});
