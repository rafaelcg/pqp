import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";
import type { RemotePeer } from "./peer-connection-manager";

/**
 * "Às vezes quando mexe nas configs uma pessoa para de ouvir a outra do nada,
 * aí tem que sair da call e entrar de novo" (QG, 2026-10-20, a LiveKit room).
 *
 * Every microphone setting that needs a new capture (noise mode, echo
 * cancellation, automatic gain, the input device) ends in `swapPipeline`
 * (`use-voice.ts`), which on an SFU room is `replaceTrack`: unpublish the old
 * clone, publish a new one. Both halves of that went wrong, and both were
 * reproduced in a real browser against a real LiveKit server (1.13.10) with
 * two dev accounts and `getStats()` on each side before writing these.
 *
 * THE LISTENER'S HALF. The new publication's `TrackSubscribed` reaches every
 * other participant BEFORE the old one's `TrackUnsubscribed`, every time. The
 * session's stream maps are keyed by person, and the unsubscribe handler
 * cleared the slot by person, so it deleted the stream the new subscription
 * had just filed. Measured: packets kept arriving (200 per 4 s) with
 * `totalAudioEnergy` flat at 0 and the `<audio>` element's `srcObject` null,
 * for as long as the call lasted. One noise-mode change made the person who
 * changed it inaudible to the whole room.
 *
 * THE PUBLISHER'S HALF. Several changes in a row (which is what somebody
 * trying every option does) ran `replaceTrack` calls concurrently. The later
 * call's `unpublishTrack` of the same old clone returns at once (the real SDK
 * removes the publication synchronously on the first call and finds nothing on
 * the second), so the later call published first and the earlier one, still
 * negotiating, finished last: it took the live clone down and left its own
 * clone of an already-stopped track. Measured: zero outbound audio packets
 * after two of five bursts, until the next change.
 *
 * The doubles below keep exactly those two shapes: the event order, and an
 * `unpublishTrack` that drops the publication before it awaits.
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

interface FakeTrack {
  kind: "audio";
  id: string;
  enabled: boolean;
  readyState: "live" | "ended";
  getConstraints: () => Record<string, never>;
  applyConstraints: () => Promise<void>;
  clone: () => FakeTrack;
  stop: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

function makeTrack(id: string, readyState: "live" | "ended" = "live"): FakeTrack {
  let clones = 0;
  const self: FakeTrack = {
    kind: "audio",
    id,
    enabled: true,
    readyState,
    getConstraints: () => ({}),
    applyConstraints: async () => {},
    // A real clone of an ended track is born ended.
    clone: () => makeTrack(`${id}-clone-${clones++}`, self.readyState),
    stop: () => {
      self.readyState = "ended";
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return self;
}

class LocalAudioTrack {
  isMuted = false;
  constructor(public mediaStreamTrack: FakeTrack) {}
  async mute() {
    this.isMuted = true;
  }
  async unmute() {
    this.isMuted = false;
  }
  stop() {
    this.mediaStreamTrack.stop();
  }
}

/** What the media server currently holds for the local participant. */
const registered = new Set<LocalAudioTrack>();

/** A gate the next `unpublishTrack` that finds a publication waits on. */
let unpublishGate: Promise<void> | null = null;
/** A gate the next `publishTrack` waits on before it registers. */
let publishGate: Promise<void> | null = null;

function gate(set: (p: Promise<void>) => void): () => void {
  let release!: () => void;
  set(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return release;
}

interface FakePublication {
  source: string;
  trackSid: string;
  trackName?: string;
  setEnabled: () => void;
  setVideoQuality: () => void;
  setSubscribed: () => void;
}

class FakeRoom {
  state = "connected";
  remoteParticipants = new Map<string, { identity: string }>();
  handlers = new Map<string, (...args: unknown[]) => void>();
  localParticipant = {
    publishTrack: async (track: LocalAudioTrack) => {
      const held = publishGate;
      publishGate = null;
      await Promise.resolve();
      if (held) {
        await held;
      }
      registered.add(track);
    },
    // The real `unpublishTrack` (livekit-client 2.21.0): it looks the
    // publication up and drops it from its maps synchronously, then awaits
    // the negotiation. A second call for the same track finds nothing and
    // returns at once, which is what let a later replace overtake an earlier
    // one.
    unpublishTrack: async (track: LocalAudioTrack) => {
      if (!registered.has(track)) {
        return;
      }
      registered.delete(track);
      track.stop();
      const held = unpublishGate;
      unpublishGate = null;
      if (held) {
        await held;
      }
    },
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

  join(identity: string) {
    const participant = { identity };
    this.remoteParticipants.set(identity, participant);
    this.handlers.get(RoomEvent.ParticipantConnected)?.(participant);
    return participant;
  }

  publication(source: string, trackSid: string): FakePublication {
    return {
      source,
      trackSid,
      setEnabled: () => {},
      setVideoQuality: () => {},
      setSubscribed: () => {},
    };
  }

  subscribe(
    participant: { identity: string },
    pub: FakePublication,
    kind: "audio" | "video",
  ) {
    const mediaStreamTrack = { kind, id: `${pub.trackSid}-track` };
    this.handlers.get(RoomEvent.TrackSubscribed)?.(
      { kind, mediaStreamTrack, attach: () => {} },
      pub,
      participant,
    );
    return mediaStreamTrack;
  }

  unsubscribe(
    participant: { identity: string },
    pub: FakePublication,
    kind: "audio" | "video",
  ) {
    this.handlers.get(RoomEvent.TrackUnsubscribed)?.(
      { kind, mediaStreamTrack: { kind, id: `${pub.trackSid}-track` } },
      pub,
      participant,
    );
  }
}

const rooms: FakeRoom[] = [];

class FakePreset {
  constructor(
    public width: number,
    public height: number,
    public maxBitrate: number,
    public maxFramerate?: number,
  ) {}
}

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent,
  Track,
  LocalAudioTrack,
  ConnectionState: { Disconnected: "disconnected", Connected: "connected" },
  VideoPreset: FakePreset,
  VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
  DefaultReconnectPolicy: class {
    nextRetryDelayInMs() {
      return 0;
    }
  },
}));

vi.stubGlobal(
  "MediaStream",
  class {
    constructor(public tracks: unknown[] = []) {}
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
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
  identity: "me",
};

let peers: RemotePeer[] = [];

async function session() {
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

function micStream(track: FakeTrack): MediaStream {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

/** Let every pending promise chain run to its next real wait. */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function tracksOf(stream: MediaStream | null | undefined): unknown[] {
  return stream ? (stream as unknown as { tracks: unknown[] }).tracks : [];
}

beforeEach(() => {
  rooms.length = 0;
  registered.clear();
  unpublishGate = null;
  publishGate = null;
  peers = [];
});

describe("a listener keeps hearing somebody who changes their microphone", () => {
  it("keeps the new voice when the old one's unsubscribe arrives after it", async () => {
    await session();
    const alice = room().join("alice");
    const before = room().publication(Track.Source.Microphone, "TR_old");
    room().subscribe(alice, before, "audio");
    expect(peers[0]?.stream).not.toBeNull();

    // Alice switched noise mode: a new publication, then the old one goes.
    // LiveKit delivers them to us in THIS order.
    const after = room().publication(Track.Source.Microphone, "TR_new");
    const fresh = room().subscribe(alice, after, "audio");
    room().unsubscribe(alice, before, "audio");

    const voice = peers.find((peer) => peer.peerId === "alice")!;
    expect(voice.stream).not.toBeNull();
    expect(tracksOf(voice.stream)).toEqual([fresh]);
  });

  it("still forgets the voice when it is the one that went away", async () => {
    await session();
    const alice = room().join("alice");
    const only = room().publication(Track.Source.Microphone, "TR_only");
    room().subscribe(alice, only, "audio");
    room().unsubscribe(alice, only, "audio");
    expect(peers.find((peer) => peer.peerId === "alice")?.stream).toBeNull();
  });

  it("holds for a camera and a screen share republished the same way", async () => {
    await session();
    const alice = room().join("alice");
    const camOld = room().publication(Track.Source.Camera, "TR_cam_old");
    const shareOld = room().publication(Track.Source.ScreenShare, "TR_share_old");
    const shareAudioOld = room().publication(
      Track.Source.ScreenShareAudio,
      "TR_share_audio_old",
    );
    room().subscribe(alice, camOld, "video");
    room().subscribe(alice, shareOld, "video");
    room().subscribe(alice, shareAudioOld, "audio");

    // The camera ladder and the screen plan republish in place too.
    const cam = room().subscribe(
      alice,
      room().publication(Track.Source.Camera, "TR_cam_new"),
      "video",
    );
    const share = room().subscribe(
      alice,
      room().publication(Track.Source.ScreenShare, "TR_share_new"),
      "video",
    );
    const shareAudio = room().subscribe(
      alice,
      room().publication(Track.Source.ScreenShareAudio, "TR_share_audio_new"),
      "audio",
    );
    room().unsubscribe(alice, camOld, "video");
    room().unsubscribe(alice, shareOld, "video");
    room().unsubscribe(alice, shareAudioOld, "audio");

    const peer = peers.find((one) => one.peerId === "alice")!;
    expect(tracksOf(peer.cameraStream)).toEqual([cam]);
    expect(tracksOf(peer.screenStream)).toEqual([share]);
    expect(tracksOf(peer.screenAudioStream)).toEqual([shareAudio]);
  });
});

describe("the room keeps hearing somebody who changes settings several times in a row", () => {
  it("leaves the LAST microphone asked for live on the wire", async () => {
    const sfu = await session();
    await sfu.publish(micStream(makeTrack("first")));
    expect(registered.size).toBe(1);

    // Change one: its unpublish of the current clone is still negotiating.
    const releaseUnpublish = gate((p) => {
      unpublishGate = p;
    });
    const one = makeTrack("one");
    const replaceOne = sfu.replaceTrack(micStream(one));
    await settle();

    // Change two, a moment later. `swapPipeline` stops the pipeline it
    // replaces before it hands the new one over, so change one's track is
    // already dead by the time change two's publish starts.
    one.stop();
    const releasePublish = gate((p) => {
      publishGate = p;
    });
    const two = makeTrack("two");
    const replaceTwo = sfu.replaceTrack(micStream(two));
    await settle();

    releaseUnpublish();
    await settle();
    releasePublish();
    await Promise.all([replaceOne, replaceTwo]);
    await settle();

    const live = [...registered].filter(
      (track) => track.mediaStreamTrack.readyState === "live",
    );
    expect(live.map((track) => track.mediaStreamTrack.id)).toEqual([
      "two-clone-0",
    ]);
  });
});
