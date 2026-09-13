import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";

/**
 * The watch-party mic double, 2026-09-12.
 *
 * `docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md` item B5: "agora ta
 * duplicado a voz dela" at 00:31, "audio duplicado" again at 20:42. While
 * "Meu mic vai no stream" is on, the host's microphone reaches the seatless
 * audience through the screen share's mixed audio track
 * (`client/src/lib/screen-mix.ts`), and the *separate* microphone publication
 * is supposed to stay off for good — `use-voice.ts`'s
 * `publicationShouldBeMuted()` already says so unconditionally whenever a
 * mix is live.
 *
 * What that check cannot see: `livekit-client` 2.21's `mute()`/`unmute()`
 * work by flipping `_mediaStreamTrack.enabled` on whatever track this
 * publication was built from (`LocalTrack.prototype.mute`, confirmed against
 * the installed package). `use-voice.ts` hands the mic's processed stream to
 * BOTH this publication and the screen-mix tap, undisguised — the exact same
 * `MediaStreamTrack` object — because the mix is deliberately built to gate
 * on that same "mute" bit ("it taps the pipeline's output, after the mute
 * gate", `docs/WATCH_PARTY.md`). So the button's own unmute handler
 * (`applyMuteToPipeline`) re-enables that shared track for the mix's sake,
 * and because it is the identical object, it just as surely reopens this
 * publication — LiveKit's own mute flag never gets consulted again, because
 * nothing told it to. The room hears the host twice: once live through the
 * mix, once through the SFU's microphone publication.
 *
 * The fix publishes a CLONE, not the caller's track (`publish()` in
 * `livekit-session.ts`). A clone starts with the same `.enabled`, but
 * `mute()`/`unmute()` only ever touch the clone from then on — flipping the
 * original track (exactly what a watch-party mix does on every mute toggle)
 * cannot reach it.
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

/** Every publish the fake room's `localParticipant` was asked for, in order. */
const published: { track: FakeTrack; source: string | undefined }[] = [];

/** Every `unpublishTrack` call, in order — the real SDK stops the track by default. */
const unpublishCalls: LocalAudioTrack[] = [];

/** Set from a test to make the next `publishTrack` reject, as an unmet grant does. */
let failNextPublish = false;

/** Set from a test to make the next `unpublishTrack` reject. */
let failNextUnpublish = false;

/** Set from a test to hold the next `publishTrack` call in flight until released. */
let publishGate: Promise<void> | null = null;

class FakeRoom {
  state = "connected";
  remoteParticipants = new Map<string, unknown>();
  handlers = new Map<string, (...args: unknown[]) => void>();
  localParticipant = {
    publishTrack: async (track: FakeTrack, options: { source?: string } = {}) => {
      // Consumed on read, not just checked: a gate set for ONE in-flight
      // call must not also hold up a second `publish()` that starts and
      // completes while the first is still pending — that concurrency is
      // exactly what the "replaced while in flight" test below depends on.
      const gate = publishGate;
      publishGate = null;
      if (gate) {
        await gate;
      }
      if (failNextPublish) {
        failNextPublish = false;
        throw new Error("not allowed yet");
      }
      published.push({ track, source: options.source });
    },
    unpublishTrack: async (track: LocalAudioTrack) => {
      unpublishCalls.push(track);
      if (failNextUnpublish) {
        failNextUnpublish = false;
        throw new Error("SFU unreachable");
      }
      // The real `unpublishTrack`: no publication is found (and nothing is
      // stopped) unless `publishTrack` for this exact object already
      // resolved — that gap is what the "still in flight" race depends on.
      const isRegistered = published.some(
        (p) => (p.track as unknown as LocalAudioTrack) === track,
      );
      if (!isRegistered) {
        return;
      }
      // The real `unpublishTrack` stops the track by default
      // (`stopOnUnpublish` defaults to true) whenever it finds a live
      // publication for it.
      track.stop();
    },
    getTrackPublication: () => undefined,
  };
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }
  async connect() {}
  async disconnect() {}
}

/**
 * The real `LocalTrack.prototype.mute`/`unmute` shape (livekit-client
 * 2.21.0, `dist/livekit-client.esm.mjs`): flip the wrapped
 * `MediaStreamTrack`'s own `.enabled`, nothing else. A fake that just sets an
 * internal `isMuted` flag (as the sources/quality suites' doubles do, for
 * their own unrelated purposes) would never have caught this bug — it exists
 * entirely in what the real library does to the underlying track object.
 */
class LocalAudioTrack {
  constructor(public track: FakeTrack) {}
  get mediaStreamTrack() {
    return this.track;
  }
  get isMuted() {
    return !this.track.enabled;
  }
  async mute() {
    this.track.enabled = false;
  }
  async unmute() {
    this.track.enabled = true;
  }
  stop() {
    this.track.stop();
  }
}

class FakeVideoPreset {
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
  VideoPreset: FakeVideoPreset,
  VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
  // Real shape (nextRetryDelayInMs), never exercised in these tests — no
  // reconnect scenario runs here, only `new DefaultReconnectPolicy()`.
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
  },
);

const { connectLiveKit } = await import("./livekit-session");

interface FakeTrack {
  kind: "audio";
  id: string;
  enabled: boolean;
  stopped: boolean;
  readyState: "live" | "ended";
  getConstraints: () => Record<string, never>;
  applyConstraints: () => Promise<void>;
  clone: () => FakeTrack;
  stop: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  /** Test hook: simulate the browser firing `ended` on this exact track object. */
  fireEnded: () => void;
}

/** Every clone `fakeMicTrack`'s tracks produced, in creation order. */
const clones: FakeTrack[] = [];

function makeTrack(id: string, enabled: boolean): FakeTrack {
  const listeners = new Map<string, Set<() => void>>();
  const self: FakeTrack = {
    kind: "audio",
    id,
    enabled,
    stopped: false,
    readyState: "live",
    getConstraints: () => ({}),
    applyConstraints: async () => {},
    // A real `MediaStreamTrack.clone()`: a new object, independent
    // `.enabled`/`.stopped`/listeners from the moment it is made, same
    // starting value, and stopping one sibling never touches the other.
    clone: () => {
      const clone = makeTrack(`${id}-clone-${clones.length}`, self.enabled);
      clones.push(clone);
      return clone;
    },
    stop: () => {
      self.stopped = true;
      self.readyState = "ended";
    },
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    // A real "ended" (device unplugged, permission revoked) sets
    // `readyState` before the event fires, which is what lets code that
    // checks the flag *after* the fact (rather than only listening) notice
    // an event it missed.
    fireEnded: () => {
      self.readyState = "ended";
      for (const listener of Array.from(listeners.get("ended") ?? [])) {
        listener();
      }
    },
  };
  return self;
}

/** A microphone track exactly like `pipeline.processedStream`'s: clonable. */
function fakeMicTrack(id: string): FakeTrack {
  return makeTrack(id, true);
}

function micStream(track: FakeTrack): MediaStream {
  return {
    id: `stream-${track.id}`,
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
}

const SESSION: VoiceSessionInfo = {
  backend: "livekit",
  url: "ws://sfu",
  token: "t",
  room: "room",
  identity: "host",
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
  unpublishCalls.length = 0;
  clones.length = 0;
  failNextPublish = false;
  failNextUnpublish = false;
  publishGate = null;
});

/** Holds the next `publishTrack` call until the returned function is called. */
function gatePublish(): () => void {
  let release!: () => void;
  publishGate = new Promise((resolve) => {
    release = resolve;
  });
  return release;
}

describe("the standalone microphone publication while a watch-party mix is live", () => {
  it("does not reopen when the caller re-enables its own copy of the track", async () => {
    const sfu = await session();
    const original = fakeMicTrack("mic");

    await sfu.publish(micStream(original));
    await sfu.setMuted(true);

    const wrapped = (published[0]!.track as unknown as LocalAudioTrack).track;
    // The publication got a DIFFERENT object than the caller's — the whole
    // point of the fix.
    expect(wrapped).not.toBe(original);
    expect(wrapped.enabled).toBe(false);

    // This is exactly what `applyMuteToPipeline` does on every unmute: flip
    // the ORIGINAL track back on, because a live screen-share mix taps that
    // same object to decide how loud the mic is in the stream. Before the
    // fix this line reopened the SFU publication too, because `wrapped` and
    // `original` were the same object.
    original.enabled = true;

    expect(wrapped.enabled).toBe(false);
  });

  it("toggling mute twice leaves the published track muted throughout", async () => {
    const sfu = await session();
    const original = fakeMicTrack("mic");
    await sfu.publish(micStream(original));
    const wrapped = (published[0]!.track as unknown as LocalAudioTrack).track;

    // Mute, as `applyMute()` does when the button is pressed while sharing.
    await sfu.setMuted(true);
    original.enabled = true; // the mix reopening its own tap
    expect(wrapped.enabled).toBe(false);

    // Unmute — `publicationShouldBeMuted()` still says "stay off" while the
    // mix is live, so `use-voice.ts` never calls `setMuted(false)` here; a
    // watch-party mute toggle is button-press-driven and does not reach the
    // SFU side at all in that state. Confirm that leaving it alone (as the
    // app does) keeps the publication muted even though the shared track the
    // mix reads from is live again.
    original.enabled = true;
    expect(wrapped.enabled).toBe(false);

    // Mute again.
    await sfu.setMuted(true);
    original.enabled = false;
    expect(wrapped.enabled).toBe(false);
  });
});

/**
 * Farol review on #528: a clone does not share the source's lifecycle, only
 * its starting `.enabled` value (deliberately — see the block comment atop
 * `publish()` in `livekit-session.ts`). Two gaps that leaves: a clone that
 * `publishTrack` never registers (so `unpublishTrack` cannot find and stop
 * it later) and a clone that keeps running after its source track ends
 * outside `publish()`'s own replace/mute/disconnect paths.
 */
describe("the standalone microphone publication's clone lifecycle", () => {
  it("stops the clone if publishTrack rejects, so a retried publish cannot leak it", async () => {
    const sfu = await session();
    const original = fakeMicTrack("mic");
    failNextPublish = true;

    await expect(sfu.publish(micStream(original))).rejects.toThrow();

    // publishTrack never registered a publication for this clone, so
    // `unpublishTrack` would have found nothing to stop — `publish()` has to
    // stop it itself.
    expect(clones).toHaveLength(1);
    expect(clones[0]!.stopped).toBe(true);
    expect(published).toHaveLength(0);

    // `publishMicWhenAllowed` (use-voice.ts) retries this exact call up to
    // five times while a grant is still propagating; the retry must succeed
    // cleanly rather than trip over the dead clone from the first attempt.
    await sfu.publish(micStream(original));
    expect(published).toHaveLength(1);
    expect(clones).toHaveLength(2);
    expect(clones[1]!.stopped).toBe(false);
  });

  it("drops the clone when the source track ends before a replacement publishes", async () => {
    const sfu = await session();
    const original = fakeMicTrack("mic");
    await sfu.publish(micStream(original));
    const clone = clones[0]!;
    expect(clone.stopped).toBe(false);

    // `stopMicPipeline` (use-voice.ts) stops the raw capture directly on a
    // device swap, ahead of the `replaceTrack` call that would otherwise
    // unpublish this clone through the normal path.
    original.fireEnded();

    expect(unpublishCalls).toHaveLength(1);
    expect(clone.stopped).toBe(true);

    // A stray `setMuted` after the source has ended must not resurrect
    // anything or throw — there is no live publication left to touch.
    await expect(sfu.setMuted(true)).resolves.toBeUndefined();
  });

  it("does not strand an orphaned publication when the source ends while publishTrack is still in flight", async () => {
    const sfu = await session();
    const original = fakeMicTrack("mic");
    const release = gatePublish();

    const publishPromise = sfu.publish(micStream(original));
    // The source ends before `publishTrack` has resolved and registered a
    // publication for the clone: listening for "ended" from the very start
    // of `publish()` would try to `unpublishTrack` a publication that does
    // not exist yet (a no-op) and null out `published` regardless — so by
    // the time `publishTrack` DOES resolve below, this call would have gone
    // on to leave a live publication in the room with nothing left
    // referencing it to ever clean it up.
    original.fireEnded();
    expect(unpublishCalls).toHaveLength(0);

    release();
    await publishPromise;

    expect(published).toHaveLength(1);
    // The already-ended source must be noticed and cleaned up the moment
    // `publish()` can safely do it, not silently left running.
    expect(unpublishCalls).toHaveLength(1);
    expect(clones[0]!.stopped).toBe(true);
  });

  it("unpublishes itself if another publish() wins the shared pointer while it is still in flight", async () => {
    const sfu = await session();
    const trackA = fakeMicTrack("mic-a");
    const trackB = fakeMicTrack("mic-b");
    const release = gatePublish();

    // A's publishTrack is now blocked. A second publish — a device swap
    // landing mid-retry, or a fast mute/unmute cycle — runs to completion
    // in the meantime and becomes the room's current publication.
    const publishA = sfu.publish(micStream(trackA));
    await sfu.publish(micStream(trackB));
    expect(clones).toHaveLength(2);
    const cloneA = clones[0]!;
    const cloneB = clones[1]!;

    release();
    await publishA;

    // A's publishTrack DID succeed once unblocked — LiveKit now holds a
    // real, live sender for cloneA — but B already won the shared pointer
    // first. A has to tear its own publication down rather than leave two
    // live microphones on the wire with only one of them tracked. (B's own
    // opening `if (published) unpublishTrack(...)` also targets cloneA
    // here, harmlessly, since A had not registered a publication yet at
    // that point — the real SDK no-ops on an unregistered track too.)
    expect(published).toHaveLength(2);
    expect(unpublishCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      unpublishCalls.every((t) => t.mediaStreamTrack === cloneA),
    ).toBe(true);
    expect(cloneA.stopped).toBe(true);
    // B's publication is left alone.
    expect(cloneB.stopped).toBe(false);
  });

  it("still stops the clone when the source ends and unpublishTrack rejects", async () => {
    const sfu = await session();
    const original = fakeMicTrack("mic");
    await sfu.publish(micStream(original));
    const clone = clones[0]!;

    failNextUnpublish = true;
    original.fireEnded();
    // `onSourceEnded`'s cleanup runs in a detached async IIFE, not inline
    // with `fireEnded()` — give its rejected `unpublishTrack` a turn to
    // settle before asserting on its result.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unpublishCalls).toHaveLength(1);
    // The unpublish rejected, so LiveKit's own stop-on-success never ran —
    // `publish()` has to stop the clone itself instead of losing the only
    // handle to a publication that is still live on the SFU.
    expect(clone.stopped).toBe(true);
  });
});
