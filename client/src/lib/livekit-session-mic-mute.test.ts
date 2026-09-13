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

class FakeRoom {
  state = "connected";
  remoteParticipants = new Map<string, unknown>();
  handlers = new Map<string, (...args: unknown[]) => void>();
  localParticipant = {
    publishTrack: async (track: FakeTrack, options: { source?: string } = {}) => {
      if (failNextPublish) {
        failNextPublish = false;
        throw new Error("not allowed yet");
      }
      published.push({ track, source: options.source });
    },
    unpublishTrack: async (track: LocalAudioTrack) => {
      unpublishCalls.push(track);
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
    fireEnded: () => {
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
});

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
});
