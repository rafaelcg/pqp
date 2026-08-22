import { beforeEach, describe, expect, it } from "vitest";
import type { ClientRelayMessage } from "@pqp/shared";
import {
  createPeerConnectionManager,
  type RemotePeer,
} from "./peer-connection-manager";

/**
 * The mesh side of screen-share audio.
 *
 * Two things can go wrong here and neither shows up in a type check. Sending:
 * the system-audio track has to reach every peer connection and be withdrawn
 * again, without a second offer racing the first. Receiving: a peer sharing a
 * tab with sound is suddenly sending *two* audio tracks, and filing the wrong
 * one as their microphone would silence them for everybody.
 *
 * The fake below is a hand-rolled `RTCPeerConnection` with only the surface
 * this module touches. Nothing here needs a browser: the manager's decisions
 * are all made before any media moves.
 */

interface FakeTrack {
  kind: "audio" | "video";
  id: string;
  onended: (() => void) | null;
}

function track(kind: "audio" | "video", id: string): FakeTrack {
  return { kind, id, onended: null };
}

interface FakeSender {
  track: FakeTrack | null;
  replaceTrack: (next: FakeTrack | null) => Promise<void>;
}

function fakeStream(id: string, tracks: FakeTrack[]) {
  return {
    id,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: unknown = null;
  onicecandidate: ((event: unknown) => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  senders: FakeSender[] = [];
  added: { track: FakeTrack; streamId: string }[] = [];
  removed: FakeSender[] = [];

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack(t: FakeTrack, stream: { id: string }): FakeSender {
    const sender: FakeSender = {
      track: t,
      replaceTrack: async (next) => {
        sender.track = next;
      },
    };
    this.senders.push(sender);
    this.added.push({ track: t, streamId: stream.id });
    return sender;
  }

  removeTrack(sender: FakeSender) {
    this.removed.push(sender);
    this.senders = this.senders.filter((s) => s !== sender);
  }

  getSenders() {
    return this.senders;
  }

  // No transceiver ever lacks a mid here, so the deferred-renegotiation retry
  // loop stays out of these tests.
  getTransceivers() {
    return [];
  }

  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async createAnswer() {
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription(description?: { type: string; sdp?: string }) {
    this.localDescription = {
      type: description?.type ?? "offer",
      sdp: description?.sdp ?? "offer-sdp",
    };
  }

  async setRemoteDescription(description: unknown) {
    this.remoteDescription = description;
  }

  async addIceCandidate() {}

  setConfiguration() {}

  close() {}
}

/** Local id sorts above the remote one, so this side drives the offers. */
const LOCAL = "peer-b";
const REMOTE = "peer-a";

function setup() {
  const sent: ClientRelayMessage[] = [];
  let peers: RemotePeer[] = [];
  const manager = createPeerConnectionManager(
    LOCAL,
    (message) => sent.push(message),
    [],
  );
  manager.onPeerStateChange((next) => {
    peers = next;
  });
  return {
    manager,
    sent,
    offers: () => sent.filter((m) => m.type === "offer"),
    peers: () => peers,
    pc: () => FakePeerConnection.instances[0]!,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakePeerConnection.instances = [];
  (globalThis as unknown as Record<string, unknown>).RTCPeerConnection =
    FakePeerConnection;
});

describe("publishing a screen share with audio", () => {
  it("adds both tracks under one renegotiation", async () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await settle();
    const offersBefore = ctx.offers().length;

    const capture = fakeStream("cap", [
      track("video", "v"),
      track("audio", "a"),
    ]);
    await ctx.manager.setLocalScreenStream(capture);

    expect(ctx.pc().added.map((entry) => entry.track.kind)).toEqual([
      "video",
      "audio",
    ]);
    // Both tracks share the capture's msid, which is what the receiving side
    // matches the announced id against.
    expect(ctx.pc().added.every((entry) => entry.streamId === "cap")).toBe(true);
    // One offer, not two: a second offer while the first answer is in flight
    // is glare, and perfect negotiation resolves glare by dropping it.
    expect(ctx.offers().length - offersBefore).toBe(1);
  });

  it("withdraws both tracks when the share stops", async () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await settle();
    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "v"), track("audio", "a")]),
    );
    const offersBefore = ctx.offers().length;

    await ctx.manager.setLocalScreenStream(null);

    expect(ctx.pc().removed).toHaveLength(2);
    expect(ctx.pc().senders).toHaveLength(0);
    expect(ctx.offers().length - offersBefore).toBe(1);
  });

  it("is unchanged for a capture with no audio track", async () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await settle();

    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "v")]),
    );

    expect(ctx.pc().added.map((entry) => entry.track.kind)).toEqual(["video"]);
  });

  it("gives a peer that joins mid-share both tracks straight away", async () => {
    const ctx = setup();
    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "v"), track("audio", "a")]),
    );
    ctx.manager.connectToPeer(REMOTE);
    await settle();

    expect(ctx.pc().added.map((entry) => entry.track.kind)).toEqual([
      "video",
      "audio",
    ]);
  });

  it("swaps the microphone without touching the screen-audio sender", async () => {
    const ctx = setup();
    ctx.manager.setLocalStream(fakeStream("mic", [track("audio", "mic-1")]));
    ctx.manager.connectToPeer(REMOTE);
    await settle();
    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "v"), track("audio", "sys")]),
    );

    await ctx.manager.replaceLocalTrack(
      fakeStream("mic-2", [track("audio", "mic-2")]),
    );

    const kinds = ctx.pc().senders.map((s) => s.track?.id);
    expect(kinds).toContain("mic-2");
    // The film is still going to the film sender.
    expect(kinds).toContain("sys");
  });
});

describe("receiving a peer's screen audio", () => {
  function arrive(
    pc: FakePeerConnection,
    kind: "audio" | "video",
    streamId: string,
  ) {
    const incoming = track(kind, `${streamId}:${kind}`);
    pc.ontrack?.({
      track: incoming,
      streams: [fakeStream(streamId, [incoming])],
    });
    return incoming;
  }

  it("files the announced stream as screen audio and leaves the voice alone", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    arrive(ctx.pc(), "audio", "their-mic");
    ctx.manager.setPeerScreenAudioStreamId(REMOTE, "their-screen");
    arrive(ctx.pc(), "audio", "their-screen");

    const peer = ctx.peers()[0]!;
    expect(peer.stream?.id).toBe("their-mic");
    expect(peer.screenAudioStream?.id).toBe("their-screen");
  });

  it("classifies a track that arrives before the roster says what it is", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    arrive(ctx.pc(), "audio", "their-mic");
    // Track first, announcement second: the two race on every real call.
    arrive(ctx.pc(), "audio", "their-screen");
    expect(ctx.peers()[0]!.stream?.id).toBe("their-mic");

    ctx.manager.setPeerScreenAudioStreamId(REMOTE, "their-screen");

    const peer = ctx.peers()[0]!;
    expect(peer.stream?.id).toBe("their-mic");
    expect(peer.screenAudioStream?.id).toBe("their-screen");
  });

  it("drops the screen audio when the share ends", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    arrive(ctx.pc(), "audio", "their-mic");
    ctx.manager.setPeerScreenAudioStreamId(REMOTE, "their-screen");
    arrive(ctx.pc(), "audio", "their-screen");

    ctx.manager.setPeerScreenAudioStreamId(REMOTE, null);

    const peer = ctx.peers()[0]!;
    expect(peer.screenAudioStream).toBeNull();
    // The presenter is still in the call and still audible.
    expect(peer.stream?.id).toBe("their-mic");
  });

  it("drops it on the sender ending the track too", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    arrive(ctx.pc(), "audio", "their-mic");
    ctx.manager.setPeerScreenAudioStreamId(REMOTE, "their-screen");
    const incoming = arrive(ctx.pc(), "audio", "their-screen");

    incoming.onended?.();

    expect(ctx.peers()[0]!.screenAudioStream).toBeNull();
    expect(ctx.peers()[0]!.stream?.id).toBe("their-mic");
  });

  it("keeps the voice slot when a peer sends screen audio it never announced", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    arrive(ctx.pc(), "audio", "their-mic");
    // An older client, or an announcement lost on the way: the unexpected
    // track is ignored rather than allowed to take the microphone's place.
    arrive(ctx.pc(), "audio", "mystery");

    expect(ctx.peers()[0]!.stream?.id).toBe("their-mic");
    expect(ctx.peers()[0]!.screenAudioStream).toBeNull();
  });
});
