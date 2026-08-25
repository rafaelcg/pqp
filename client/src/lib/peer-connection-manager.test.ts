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

  it("does not hand the microphone to the screen-audio sender", async () => {
    const ctx = setup();
    // The case above cannot actually fail: the microphone sender was added
    // first, so a lookup by kind alone finds it anyway. Here the share is the
    // only audio on the connection, which is the arrangement where picking by
    // kind picks the presentation and sends the voice into the film.
    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "v"), track("audio", "sys")]),
    );
    ctx.manager.connectToPeer(REMOTE);
    await settle();

    await ctx.manager.replaceLocalTrack(
      fakeStream("mic", [track("audio", "mic-1")]),
    );

    const ids = ctx.pc().senders.map((s) => s.track?.id);
    expect(ids).toContain("sys");
    expect(ids).toContain("mic-1");
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

/**
 * The re-share, reported verbatim as "tried to reshare and the share was all
 * black".
 *
 * A screen share is the one incoming stream this manager identifies
 * negatively — video from a peer that is not their announced camera — so
 * unlike the camera and the screen audio, nothing about a share *ending* is
 * announced. The receiver's own track is not the answer either: the sender's
 * `removeTrack` mutes it rather than ending it, so `onended` does not fire.
 *
 * That leaves the dead capture in `videoStreams`, and `classifyVideo` is
 * first-wins, so the *next* share renders behind a stream with no frames in
 * it. Everything below is that sequence.
 */
describe("receiving a peer's screen share", () => {
  function arriveVideo(pc: FakePeerConnection, streamId: string) {
    const incoming = track("video", `${streamId}:video`);
    pc.ontrack?.({
      track: incoming,
      streams: [fakeStream(streamId, [incoming])],
    });
    return incoming;
  }

  it("shows the second share, not the dead first one", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-1");
    expect(ctx.peers()[0]!.screenStream?.id).toBe("share-1");

    // They press Stop. No `onended` here on purpose: that is exactly what the
    // real receiver does not get.
    ctx.manager.setPeerSharingScreen(REMOTE, false);
    expect(ctx.peers()[0]!.screenStream).toBeNull();

    // They share again. A fresh capture, so a fresh stream id.
    arriveVideo(ctx.pc(), "share-2");
    expect(ctx.peers()[0]!.screenStream?.id).toBe("share-2");
  });

  it("keeps the camera when a share ends", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    ctx.manager.setPeerCameraStreamId(REMOTE, "their-cam");
    arriveVideo(ctx.pc(), "their-cam");
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-1");

    ctx.manager.setPeerSharingScreen(REMOTE, false);

    const peer = ctx.peers()[0]!;
    expect(peer.screenStream).toBeNull();
    expect(peer.cameraStream?.id).toBe("their-cam");
  });

  it("does not drop a live share on a roster frame that repeats itself", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-1");

    // Every roster frame carries every participant, so "still sharing" is the
    // common case and must cost nothing.
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    ctx.manager.setPeerSharingScreen(REMOTE, true);

    expect(ctx.peers()[0]!.screenStream?.id).toBe("share-1");
  });

  it("survives a stop the roster announces before the track ever arrived", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    // Roster first, no media yet: the two race on every real call.
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    ctx.manager.setPeerSharingScreen(REMOTE, false);
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-1");

    expect(ctx.peers()[0]!.screenStream?.id).toBe("share-1");
  });
});

/**
 * A camera and a screen share, live at the same time, from one peer.
 *
 * This is the arrangement the product is advertised on ("voz, texto, tela e
 * câmera"), and it is also the exact collision that produced the black
 * re-share: two video tracks from a single peer connection, told apart by
 * nothing but the announced `cameraStreamId`. Everything above tests one of
 * them at a time; this tests them overlapping, in both orders, because the
 * order is what decides insertion order in `videoStreams` and `classifyVideo`
 * is first-wins.
 *
 * The receiving half is where a mistake is invisible: a `<video>` bound to the
 * wrong stream still has an `srcObject` and still reports a `readyState`, so
 * the only honest assertion is which MediaStream landed in which slot.
 */
describe("a camera and a screen share at the same time", () => {
  function arriveVideo(pc: FakePeerConnection, streamId: string) {
    const incoming = track("video", `${streamId}:video`);
    pc.ontrack?.({
      track: incoming,
      streams: [fakeStream(streamId, [incoming])],
    });
    return incoming;
  }

  // --- sending ------------------------------------------------------------

  it("publishes both, each under its own stream id, camera first", async () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await settle();

    await ctx.manager.setLocalCameraStream(
      fakeStream("cam", [track("video", "cam-v")]),
    );
    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "cap-v"), track("audio", "cap-a")]),
    );

    // Two distinct msids is the whole disambiguation mechanism: the receiver
    // matches the announced `cameraStreamId` against these ids and calls the
    // rest screen. Publishing both under one stream would make them
    // indistinguishable on the wire.
    expect(
      ctx.pc().added.map((entry) => [entry.track.id, entry.streamId]),
    ).toEqual([
      ["cam-v", "cam"],
      ["cap-v", "cap"],
      ["cap-a", "cap"],
    ]);
  });

  it("publishes both in the other order too", async () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await settle();

    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "cap-v")]),
    );
    await ctx.manager.setLocalCameraStream(
      fakeStream("cam", [track("video", "cam-v")]),
    );

    expect(
      ctx.pc().added.map((entry) => [entry.track.id, entry.streamId]),
    ).toEqual([
      ["cap-v", "cap"],
      ["cam-v", "cam"],
    ]);
  });

  it("stops the share without taking the camera off the wire", async () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await settle();
    await ctx.manager.setLocalCameraStream(
      fakeStream("cam", [track("video", "cam-v")]),
    );
    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "cap-v"), track("audio", "cap-a")]),
    );

    await ctx.manager.setLocalScreenStream(null);

    // Senders are looked up by role, never by `track.kind` — both video
    // senders are video, and a lookup by kind would remove whichever came
    // first, which here is the camera.
    expect(ctx.pc().senders.map((s) => s.track?.id)).toEqual(["cam-v"]);
  });

  it("stops the camera without taking the share off the wire", async () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await settle();
    await ctx.manager.setLocalCameraStream(
      fakeStream("cam", [track("video", "cam-v")]),
    );
    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "cap-v"), track("audio", "cap-a")]),
    );

    await ctx.manager.setLocalCameraStream(null);

    expect(ctx.pc().senders.map((s) => s.track?.id)).toEqual([
      "cap-v",
      "cap-a",
    ]);
  });

  it("gives a peer that joins mid-call both, still apart", async () => {
    const ctx = setup();
    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "cap-v"), track("audio", "cap-a")]),
    );
    await ctx.manager.setLocalCameraStream(
      fakeStream("cam", [track("video", "cam-v")]),
    );

    ctx.manager.connectToPeer(REMOTE);
    await settle();

    expect(
      ctx.pc().added.map((entry) => [entry.track.id, entry.streamId]),
    ).toEqual([
      ["cap-v", "cap"],
      ["cap-a", "cap"],
      ["cam-v", "cam"],
    ]);
  });

  // --- receiving ----------------------------------------------------------

  it("keeps a peer's camera and share in their own slots, camera first", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    ctx.manager.setPeerCameraStreamId(REMOTE, "their-cam");
    arriveVideo(ctx.pc(), "their-cam");
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-1");

    const peer = ctx.peers()[0]!;
    expect(peer.cameraStream?.id).toBe("their-cam");
    expect(peer.screenStream?.id).toBe("share-1");
  });

  it("does the same when the share started first", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-1");
    ctx.manager.setPeerCameraStreamId(REMOTE, "their-cam");
    arriveVideo(ctx.pc(), "their-cam");

    const peer = ctx.peers()[0]!;
    expect(peer.cameraStream?.id).toBe("their-cam");
    expect(peer.screenStream?.id).toBe("share-1");
  });

  it("does not let a camera track arriving ahead of its roster frame take the share", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-1");
    // The camera is announced before its track in `toggleCamera`, but the two
    // still race across a reconnect. Until the announcement lands the camera
    // is just "video that is not the camera" — and the screen slot being
    // first-wins is what stops it evicting the live share.
    arriveVideo(ctx.pc(), "their-cam");
    expect(ctx.peers()[0]!.screenStream?.id).toBe("share-1");

    ctx.manager.setPeerCameraStreamId(REMOTE, "their-cam");

    const peer = ctx.peers()[0]!;
    expect(peer.cameraStream?.id).toBe("their-cam");
    expect(peer.screenStream?.id).toBe("share-1");
  });

  it("does not hand the screen slot to a camera that just turned off", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    ctx.manager.setPeerCameraStreamId(REMOTE, "their-cam");
    arriveVideo(ctx.pc(), "their-cam");
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-1");

    // Camera off, share still going. The dead camera stream has to be dropped
    // rather than left in the map: it was inserted first, so a reclassified
    // one would win the screen slot outright and the live share would vanish
    // behind a frozen webcam frame.
    ctx.manager.setPeerCameraStreamId(REMOTE, null);

    const peer = ctx.peers()[0]!;
    expect(peer.cameraStream).toBeNull();
    expect(peer.screenStream?.id).toBe("share-1");
  });

  it("shows a re-share behind a camera that never went off", () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    ctx.manager.setPeerCameraStreamId(REMOTE, "their-cam");
    arriveVideo(ctx.pc(), "their-cam");
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-1");

    // Stop and share again, with the camera untouched throughout. No
    // `onended` on the stop, because that is what the real receiver gets.
    ctx.manager.setPeerSharingScreen(REMOTE, false);
    ctx.manager.setPeerSharingScreen(REMOTE, true);
    arriveVideo(ctx.pc(), "share-2");

    const peer = ctx.peers()[0]!;
    expect(peer.screenStream?.id).toBe("share-2");
    expect(peer.cameraStream?.id).toBe("their-cam");
  });
});
