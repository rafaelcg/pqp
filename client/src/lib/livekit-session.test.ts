import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A camera and a screen share at the same time, on the SFU path.
 *
 * The mesh tells the two apart by stream id, which is delicate enough to have
 * its own suite in `peer-connection-manager.test.ts`. LiveKit does not: every
 * publication carries a source, so the whole feature rests on four things
 * staying honest — publishing under the right source, keeping the received
 * tracks in separate maps, and unpublishing exactly one of them. All four are
 * silent when wrong, and all four produce the same user-visible outcome as the
 * mesh bug: one of the two pictures disappears.
 *
 * `livekit-client` is mocked rather than run. Nothing here needs a real SFU:
 * the decisions this module makes are all made before any media moves.
 */

const RoomEvent = {
  TrackSubscribed: "trackSubscribed",
  TrackUnsubscribed: "trackUnsubscribed",
  ParticipantConnected: "participantConnected",
  ParticipantDisconnected: "participantDisconnected",
  Disconnected: "disconnected",
  ConnectionStateChanged: "connectionStateChanged",
  MediaDevicesError: "mediaDevicesError",
} as const;

const Track = {
  Kind: { Video: "video", Audio: "audio" },
  Source: {
    Camera: "camera",
    Microphone: "microphone",
    ScreenShare: "screen_share",
    ScreenShareAudio: "screen_share_audio",
  },
} as const;

type Handler = (...args: unknown[]) => void;

interface PublishRecord {
  track: { id: string };
  source: string;
}

class FakeRoom {
  static instances: FakeRoom[] = [];

  handlers = new Map<string, Handler[]>();
  remoteParticipants = new Map<string, { identity: string; name: string }>();
  published: PublishRecord[] = [];
  unpublished: { id: string }[] = [];
  localParticipant = {
    publishTrack: async (
      track: { id: string },
      options: { source: string },
    ) => {
      this.published.push({ track, source: options.source });
    },
    unpublishTrack: async (track: { id: string }) => {
      this.unpublished.push(track);
    },
    getTrackPublication: () => undefined,
  };

  constructor() {
    FakeRoom.instances.push(this);
  }

  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  async connect() {}
  async disconnect() {}
}

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent,
  Track,
  LocalAudioTrack: class {
    constructor(public track: unknown) {}
  },
  ConnectionState: { Disconnected: "disconnected" },
}));

const { connectLiveKit } = await import("./livekit-session");

/** Enough of a `MediaStream` to say which track ended up in which slot. */
class FakeMediaStream {
  id: string;
  constructor(private tracks: { id: string }[]) {
    this.id = tracks[0]?.id ?? "empty";
  }
  getTracks() {
    return this.tracks;
  }
}

function fakeCapture(id: string, kinds: ("video" | "audio")[] = ["video"]) {
  const tracks = kinds.map((kind) => ({ id: `${id}:${kind}`, kind }));
  return {
    id,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

const SESSION = {
  backend: "livekit" as const,
  url: "ws://sfu",
  token: "token",
  room: "room",
  identity: "me",
};

const REMOTE = "peer-a";

interface RemoteSlots {
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
}

async function connect() {
  let peers: RemoteSlots[] = [];
  const session = await connectLiveKit({
    session: SESSION,
    lookupIdentity: () => undefined,
    onPeersChanged: (next) => {
      peers = next;
    },
    onError: () => {},
  });
  const room = FakeRoom.instances[0]!;
  return { session, room, peer: () => peers[0] };
}

/** One track arriving from a remote participant, under a stated source. */
function subscribe(
  room: FakeRoom,
  kind: string,
  source: string,
  trackId: string,
) {
  room.remoteParticipants.set(REMOTE, { identity: REMOTE, name: "Ana" });
  room.emit(
    RoomEvent.TrackSubscribed,
    { kind, mediaStreamTrack: { id: trackId } },
    { source },
    { identity: REMOTE, name: "Ana" },
  );
}

function unsubscribe(
  room: FakeRoom,
  kind: string,
  source: string,
  trackId: string,
) {
  room.emit(
    RoomEvent.TrackUnsubscribed,
    { kind, mediaStreamTrack: { id: trackId } },
    { source },
    { identity: REMOTE, name: "Ana" },
  );
}

beforeEach(() => {
  FakeRoom.instances = [];
  (globalThis as unknown as Record<string, unknown>).MediaStream =
    FakeMediaStream;
});

describe("publishing a camera and a screen share at once", () => {
  it("sends each under its own source, share first", async () => {
    const { session, room } = await connect();

    await session.publishScreen(fakeCapture("cap"));
    await session.publishCamera(fakeCapture("cam"));

    expect(room.published.map((entry) => [entry.track.id, entry.source])).toEqual(
      [
        ["cap:video", Track.Source.ScreenShare],
        ["cam:video", Track.Source.Camera],
      ],
    );
    // Neither publish may withdraw the other: they are two live pictures, not
    // two attempts at one.
    expect(room.unpublished).toEqual([]);
  });

  it("sends each under its own source, camera first", async () => {
    const { session, room } = await connect();

    await session.publishCamera(fakeCapture("cam"));
    await session.publishScreen(fakeCapture("cap", ["video", "audio"]));

    expect(room.published.map((entry) => [entry.track.id, entry.source])).toEqual(
      [
        ["cam:video", Track.Source.Camera],
        ["cap:video", Track.Source.ScreenShare],
        ["cap:audio", Track.Source.ScreenShareAudio],
      ],
    );
    expect(room.unpublished).toEqual([]);
  });

  it("stops the share without taking the camera down", async () => {
    const { session, room } = await connect();
    await session.publishCamera(fakeCapture("cam"));
    await session.publishScreen(fakeCapture("cap", ["video", "audio"]));

    await session.unpublishScreen();

    expect(room.unpublished.map((track) => track.id)).toEqual([
      "cap:audio",
      "cap:video",
    ]);
  });

  it("stops the camera without taking the share down", async () => {
    const { session, room } = await connect();
    await session.publishCamera(fakeCapture("cam"));
    await session.publishScreen(fakeCapture("cap", ["video", "audio"]));

    await session.unpublishCamera();

    expect(room.unpublished.map((track) => track.id)).toEqual(["cam:video"]);
  });
});

describe("receiving a camera and a screen share at once", () => {
  it("files them in their own slots, share first", async () => {
    const { room, peer } = await connect();

    subscribe(room, Track.Kind.Video, Track.Source.ScreenShare, "their-cap");
    subscribe(room, Track.Kind.Video, Track.Source.Camera, "their-cam");

    expect(peer()!.screenStream?.id).toBe("their-cap");
    expect(peer()!.cameraStream?.id).toBe("their-cam");
  });

  it("files them in their own slots, camera first", async () => {
    const { room, peer } = await connect();

    subscribe(room, Track.Kind.Video, Track.Source.Camera, "their-cam");
    subscribe(room, Track.Kind.Video, Track.Source.ScreenShare, "their-cap");

    expect(peer()!.cameraStream?.id).toBe("their-cam");
    expect(peer()!.screenStream?.id).toBe("their-cap");
  });

  it("keeps the camera when their share ends", async () => {
    const { room, peer } = await connect();
    subscribe(room, Track.Kind.Video, Track.Source.Camera, "their-cam");
    subscribe(room, Track.Kind.Video, Track.Source.ScreenShare, "their-cap");

    unsubscribe(room, Track.Kind.Video, Track.Source.ScreenShare, "their-cap");

    expect(peer()!.screenStream).toBeNull();
    expect(peer()!.cameraStream?.id).toBe("their-cam");
  });

  it("keeps the share when their camera goes off", async () => {
    const { room, peer } = await connect();
    subscribe(room, Track.Kind.Video, Track.Source.Camera, "their-cam");
    subscribe(room, Track.Kind.Video, Track.Source.ScreenShare, "their-cap");

    unsubscribe(room, Track.Kind.Video, Track.Source.Camera, "their-cam");

    expect(peer()!.cameraStream).toBeNull();
    expect(peer()!.screenStream?.id).toBe("their-cap");
  });
});
