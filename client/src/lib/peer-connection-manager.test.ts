import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  /**
   * Stable unless a test says otherwise.
   *
   * A plain field rather than something derived from the descriptions below,
   * because most tests here never answer the offer they trigger and would sit
   * in `have-local-offer` for the rest of their lives. The tests that are
   * *about* the state machine set it by hand, which is also the honest way to
   * say what they reproduce: a connection that happened to be busy at the
   * moment somebody clicked a button.
   */
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
    // No argument means "whatever this state calls for", which is the entire
    // reason the manager uses that form: the browser decides, so the decision
    // cannot be made from stale information.
    const type =
      description?.type ??
      (this.signalingState === "have-remote-offer" ? "answer" : "offer");
    if (type === "offer" && this.signalingState !== "stable") {
      // Chrome's own words, copied from a real failure. This is what reached a
      // user's screen in Portuguese-language pqp on 23 Aug 2026, in English,
      // because the rejection travelled out of `setLocalScreenStream` and into
      // the error banner.
      const err = new Error(
        "Failed to execute 'setLocalDescription' on 'RTCPeerConnection': " +
          "Failed to set local offer sdp: Called in wrong state: " +
          this.signalingState,
      );
      err.name = "InvalidStateError";
      throw err;
    }
    this.localDescription = {
      type,
      sdp: description?.sdp ?? `${type}-sdp`,
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
 * "Quando tento compartilhar áudio de tela, dá esse bug:
 *  Failed to execute 'setLocalDescription' on 'RTCPeerConnection': Failed to
 *  set local offer sdp: ..." — reported through the in-app form on 23 Aug
 *  2026, the day after screen-share audio shipped.
 *
 * The sentence is Chrome's, and the only reason a user ever read it is that
 * `setLocalScreenStream` used to offer unconditionally. An offer is legal only
 * from a settled connection, and nothing about the moment somebody clicks
 * "share my screen" respects that: the pair may be halfway through answering
 * an offer of its own, or restarting ICE after a network blip. The rejection
 * escaped the manager, `startScreenShare` caught it, ran
 * `stopScreenShareInternal`, and printed Chrome's English at a Portuguese
 * speaker. The capture was destroyed by its own timing.
 *
 * Why these tests need a fake with a state machine in it: the one above cannot
 * fail. `setLocalDescription` always resolved, so every other test in this
 * file passed against the broken code and would pass against it again.
 */
describe("starting a screen share while the connection is busy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Connected, then caught mid-exchange. */
  async function busy() {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await vi.advanceTimersByTimeAsync(0);
    ctx.pc().signalingState = "have-remote-offer";
    return ctx;
  }

  const capture = () =>
    fakeStream("cap", [track("video", "v"), track("audio", "a")]);

  /**
   * The peer answers, which is the only evidence they actually received the
   * offer. Perfect negotiation resolves glare by dropping one side's offer
   * unanswered, so "we sent it" and "they have it" are different facts and the
   * retry loop is right to keep going until the second one is true.
   */
  async function acknowledge(ctx: ReturnType<typeof setup>) {
    await ctx.manager.handleAnswer(REMOTE, "answer-sdp");
  }

  it("does not reject, whatever the connection is doing", async () => {
    const ctx = await busy();

    // The assertion is the absence of a rejection. `startScreenShare` has no
    // other handler: anything thrown here becomes the error banner and takes
    // the capture down with it.
    await expect(
      ctx.manager.setLocalScreenStream(capture()),
    ).resolves.toBeUndefined();
  });

  it("still puts both tracks on the connection", async () => {
    const ctx = await busy();

    await ctx.manager.setLocalScreenStream(capture());

    // Deferring the *offer* is the fix. Deferring the tracks would be a
    // different bug wearing the same clothes.
    expect(ctx.pc().added.map((entry) => entry.track.kind)).toEqual([
      "video",
      "audio",
    ]);
  });

  it("sends the offer once the connection settles", async () => {
    const ctx = await busy();
    const offersBefore = ctx.offers().length;
    await ctx.manager.setLocalScreenStream(capture());
    expect(ctx.offers().length - offersBefore).toBe(0);

    ctx.pc().signalingState = "stable";
    await vi.advanceTimersByTimeAsync(1000);

    // Without this the share is on the wire for nobody: the tracks exist, no
    // m-line carries them, and the presenter watches their own preview and
    // assumes it worked.
    expect(ctx.offers().length - offersBefore).toBe(1);
  });

  it("keeps trying while the connection stays busy", async () => {
    const ctx = await busy();
    const offersBefore = ctx.offers().length;
    await ctx.manager.setLocalScreenStream(capture());

    // A first retry that lands in another exchange must not be the last one.
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx.offers().length - offersBefore).toBe(0);

    ctx.pc().signalingState = "stable";
    await vi.advanceTimersByTimeAsync(2000);

    expect(ctx.offers().length - offersBefore).toBeGreaterThanOrEqual(1);
  });

  it("tells the peer a share stopped, even when the stop had to wait", async () => {
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await vi.advanceTimersByTimeAsync(0);
    await ctx.manager.setLocalScreenStream(capture());
    const offersBefore = ctx.offers().length;

    ctx.pc().signalingState = "have-remote-offer";
    await expect(
      ctx.manager.setLocalScreenStream(null),
    ).resolves.toBeUndefined();

    ctx.pc().signalingState = "stable";
    await vi.advanceTimersByTimeAsync(1000);

    // A removal leaves no sender behind, so nothing on the connection can be
    // inspected to notice the debt. Only our own record of it survives, and a
    // peer never told the share stopped keeps rendering a frozen frame.
    expect(ctx.offers().length - offersBefore).toBe(1);
  });

  it("stops offering once the peer has been told", async () => {
    const ctx = await busy();
    await ctx.manager.setLocalScreenStream(capture());
    ctx.pc().signalingState = "stable";
    await vi.advanceTimersByTimeAsync(1000);
    await acknowledge(ctx);
    const offersAfterFirst = ctx.offers().length;

    // The retry loop re-arms itself, so a debt already paid has to read as
    // paid or the pair renegotiates in a circle for the rest of the call.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ctx.offers().length).toBe(offersAfterFirst);
  });

  it("turns a camera on without rejecting either", async () => {
    const ctx = await busy();

    // Same fault, same shape, different button: `setLocalCameraStream` offered
    // unconditionally too. A conversation call is where this is most likely,
    // because both sides are toggling video at once.
    await expect(
      ctx.manager.setLocalCameraStream(fakeStream("cam", [track("video", "c")])),
    ).resolves.toBeUndefined();

    ctx.pc().signalingState = "stable";
    await vi.advanceTimersByTimeAsync(1000);

    expect(ctx.pc().added.map((entry) => entry.track.kind)).toEqual(["video"]);
    expect(ctx.offers().length).toBeGreaterThan(0);
  });
});

/**
 * The escape hatch under the fix.
 *
 * The offer is now applied with `setLocalDescription()` and no argument, which
 * is what removes the gap a stale offer could fall into. Every browser that
 * can already run this manager supports it, but "already supports it" is a
 * belief, and being wrong about it would mean nobody can join a call at all —
 * a much larger bug than the one being fixed. So the old two-step form is kept
 * for anything that answers the no-argument call with a TypeError.
 */
describe("a browser that still wants the offer handed to it", () => {
  class OldPeerConnection extends FakePeerConnection {
    override async setLocalDescription(description?: {
      type: string;
      sdp?: string;
    }) {
      if (description === undefined) {
        // What a pre-2020 implementation does: refuse the call itself, before
        // any SDP exists. A TypeError, never a DOMException.
        throw new TypeError(
          "Failed to execute 'setLocalDescription' on 'RTCPeerConnection': " +
            "1 argument required, but only 0 present.",
        );
      }
      return super.setLocalDescription(description);
    }
  }

  it("falls back to createOffer instead of losing the call", async () => {
    (globalThis as unknown as Record<string, unknown>).RTCPeerConnection =
      OldPeerConnection;
    const ctx = setup();

    ctx.manager.connectToPeer(REMOTE);
    await settle();

    expect(ctx.offers()).toHaveLength(1);
    expect(ctx.pc().localDescription?.type).toBe("offer");
  });

  it("keeps working for the offers after it", async () => {
    (globalThis as unknown as Record<string, unknown>).RTCPeerConnection =
      OldPeerConnection;
    const ctx = setup();
    ctx.manager.connectToPeer(REMOTE);
    await settle();
    const offersBefore = ctx.offers().length;

    // The probe costs one failed call, once. A share that had to pay it again
    // on every renegotiation would be a slow leak rather than a broken call,
    // which is exactly the kind of thing nobody notices.
    await ctx.manager.setLocalScreenStream(
      fakeStream("cap", [track("video", "v"), track("audio", "a")]),
    );

    expect(ctx.offers().length - offersBefore).toBe(1);
  });
});
