import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";
import type { HlsSourceInput } from "@/lib/video-quality";

/**
 * THE CAMERA IS HELD SMALL WHILE THIS MACHINE FEEDS THE WATCH PARTY, AND GIVEN
 * BACK WHEN IT STOPS.
 *
 * Measured on staging 2026-09-12: a presenter turned their camera on during a
 * live party and it went up at 720p with three simulcast layers, roughly
 * 1.5 Mbit/s, while their 3.5 Mbit/s H.264 share was what 500 people were
 * watching. The two bid against the same bandwidth estimate on the same
 * uplink, the client raised the "your upload is not keeping up" warning, and
 * the SHARE lost: 640x360 at 17 fps. Nothing capped the camera because nothing
 * knew it was a watch party.
 *
 * `effectiveCameraQuality` is the decision and `video-quality.test.ts` pins it.
 * What is pinned here is the wiring, which is the half that can silently not
 * run: the cap has to arrive when `voice-stream` says an egress is live, come
 * off when it says the session ended, survive a quality picked mid-party
 * without eating the person's choice, and apply to a camera opened AFTER the
 * party started (captured small, not captured big and shrunk a tick later).
 *
 * Cherry-picked from the older draft PR #490 (`feat/watch-party-presenter-
 * camera-cap`), which conflicted with main by the time this branch needed the
 * same wiring for the voice-track split. This PR supersedes #490.
 */

vi.mock("@/lib/sounds", () => ({
  playCue: () => {},
  stopAllSoundLoops: () => {},
  whenCueSettled: async () => {},
}));

/**
 * What `GET /api/live-hls/config` says. Null is a fetch that fails, which is
 * also what every test before the 480p cap ran against: the 360p cap.
 */
const liveHlsConfig = vi.hoisted(() => ({ cameraHeight: null as number | null }));
vi.mock("@/hooks/use-live-hls-config", () => ({
  loadLiveHlsConfig: async () => {
    if (liveHlsConfig.cameraHeight === null) {
      throw new Error("offline");
    }
    return {
      enabled: true,
      delaySeconds: 10,
      voiceTrack: false,
      micArchive: false,
      cameraHeight: liveHlsConfig.cameraHeight,
    };
  },
}));

vi.mock("@/lib/voice-leave-beacon", () => ({
  beaconVoiceLeave: () => {},
}));

vi.mock("@/lib/peer-connection-manager", () => ({
  getDefaultIceServers: () => [],
  createPeerConnectionManager: vi.fn(() => ({
    setLocalStream: () => {},
    measureUplinkBps: async () => null,
    setLocalScreenStream: async () => {},
    setLocalCameraStream: async () => {},
    setCameraMaxBitrate: () => {},
    setScreenQuality: () => {},
    setPeerCameraStreamId: () => {},
    setPeerScreenAudioStreamId: () => {},
    setPeerSharingScreen: () => {},
    onPeerStateChange: () => {},
    connectToPeer: () => {},
    setPeerIdentity: () => {},
    removePeer: () => {},
    handleOffer: async () => {},
    handleAnswer: async () => {},
    handleIceCandidate: async () => {},
    retryPeer: async () => {},
    replaceLocalTrack: async () => {},
    setIceServers: () => {},
    dispose: () => {},
  })),
}));

/** Every camera ceiling the SFU session was handed, in order. */
const cameraCeilings: number[] = [];
/** Every `setHlsSource` the SFU session was handed, in order. */
const hlsSources: (HlsSourceInput | null)[] = [];
let ladderReconciles = 0;
/**
 * When set, `setCameraMaxBitrate` hangs on this promise before resolving —
 * lets a test hold one call's SFU round trip open while a LATER,
 * overlapping call runs to completion, to pin the generation guard in
 * `applyWatchPartyCameraCap`.
 */
let cameraBitrateGate: Promise<void> | null = null;

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({
    publish: async () => {},
    replaceTrack: async () => {},
    setMuted: async () => {},
    publishScreen: async () => {},
    unpublishScreen: async () => {},
    unpublishScreenAudio: async () => {},
    publishCamera: async () => {},
    setCameraMaxBitrate: async (bitrate: number) => {
      cameraCeilings.push(bitrate);
      // ONE-SHOT: only the very next call is held. A later, overlapping call
      // (the race the gate exists to construct) must run to completion.
      const gate = cameraBitrateGate;
      cameraBitrateGate = null;
      if (gate) {
        await gate;
      }
    },
    reconcileCameraLadder: async () => {
      ladderReconciles += 1;
    },
    setScreenMaxBitrate: async () => {},
    setScreenQuality: async () => {},
    setScreenHlsPublishHeight: () => {},
    setReceiveQuality: async () => {},
    setHlsSource: async (next: HlsSourceInput | null) => {
      hlsSources.push(next);
    },
    setAudioDelivery: () => {},
    unpublishCamera: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
  })),
}));

const { createVoiceController } = await import("./use-voice");
const { connectLiveKit } = await import("@/lib/livekit-session");

// ------------------------------------------------------------------ browser

/**
 * What was handed to `setInterval`, never run on its own: the 2 s
 * `refreshHlsSource` sampler is the only one this suite cares about, and a
 * test that needs a tick runs it by hand.
 */
const intervalCallbacks: (() => void)[] = [];

/** What `getUserMedia` was asked for, so a capture size can be read back. */
const cameraRequests: MediaTrackConstraints[] = [];
/** What `applyConstraints` moved a live capture to, in order. */
const appliedConstraints: MediaTrackConstraints[] = [];

function fakeTrack(kind: "audio" | "video") {
  return {
    kind,
    id: `${kind}-track`,
    enabled: true,
    contentHint: "",
    onended: null as null | (() => void),
    stop: () => {},
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      appliedConstraints.push(constraints);
    },
    getSettings: () => ({}),
  };
}

function fakeStream(label: string, kind: "audio" | "video" = "audio") {
  const tracks = [fakeTrack(kind)];
  return {
    id: `stream-${label}`,
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    addTrack: () => {},
    removeTrack: () => {},
  } as unknown as MediaStream;
}

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  // The 2 s `setHlsSource` sampler would otherwise keep the suite awake. Every
  // assertion below drives the state change directly, which is the path a
  // `voice-stream` frame takes.
  g.setInterval = (fn: () => void, ms?: number) => {
    // The HLS source sampler only (`HLS_SOURCE_SAMPLE_MS`); the screen
    // publish watchdog runs on its own period and is not this suite's.
    if (ms === 2_000) {
      intervalCallbacks.push(fn);
    }
    return 1;
  };
  g.clearInterval = () => {};
  g.window = {
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        if (constraints.video) {
          cameraRequests.push(constraints.video as MediaTrackConstraints);
          return fakeStream("camera", "video");
        }
        return fakeStream("mic");
      },
      getDisplayMedia: async () => fakeStream("screen", "video"),
    },
  });
  g.AudioContext = class {
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => {} };
    }
    createAnalyser() {
      return { fftSize: 0, smoothingTimeConstant: 0, connect: () => {} };
    }
    createMediaStreamDestination() {
      return { stream: fakeStream("processed") };
    }
    close() {
      return Promise.resolve();
    }
  };
}

// ---------------------------------------------------------------- signaling

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000bb";
const ME = "00000000-0000-4000-8000-0000000000cc";

function participant(peerId: string, extra = {}) {
  return {
    peerId,
    userId: ME,
    displayName: "Host",
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    serverMuted: false,
    ...extra,
  };
}

function welcome(): VoiceSignalingMessage {
  return {
    type: "welcome",
    peerId: PEER,
    voiceChannelId: CHANNEL,
    self: participant(PEER),
    peers: [],
    transport: "livekit",
  };
}

/** The server saying an egress is (or is no longer) transcoding this channel. */
function voiceStream(
  topHeight: number | null,
  presenterPeerId: string = PEER,
): VoiceSignalingMessage {
  return {
    type: "voice-stream",
    channelId: CHANNEL,
    stream:
      topHeight === null
        ? null
        : {
            hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/1`,
            startedAt: 1,
            presenterPeerId,
            delaySeconds: 10,
            topHeight,
            topFramerate: 60,
            hasAudio: true,
          },
  } as VoiceSignalingMessage;
}

/**
 * The same frame an LL session sends. A remux session is a CMAF PASSTHROUGH,
 * so it never transcodes a ladder and never states a `topHeight`
 * (`server/src/voice/hls-remux.ts` builds the stream with `mode` and
 * `partTargetMs` and nothing about size).
 */
function llVoiceStream(presenterPeerId: string = PEER): VoiceSignalingMessage {
  return {
    type: "voice-stream",
    channelId: CHANNEL,
    stream: {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/1?mode=ll`,
      startedAt: 1,
      presenterPeerId,
      delaySeconds: 4,
      mode: "ll",
      partTargetMs: 500,
    },
  } as VoiceSignalingMessage;
}

function createTransport() {
  const sent: { type: string; [key: string]: unknown }[] = [];
  const transport: RealtimeTransport = {
    connect: () => {},
    disconnect: () => {},
    sendChat: () => {},
    sendVoice: (message) => sent.push(message),
    onMessage: () => {},
    onReady: () => {},
    onError: () => {},
    onClose: () => {},
    onAuthUnavailable: () => {},
    onStatusChange: () => {},
    getStatus: () => "online",
    isConnected: () => true,
    retryNow: () => {},
    getLastClose: () => null,
    getUnauthorizedStreak: () => 0,
  };
  return { transport, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** In a LiveKit room, sharing a screen. The shape a watch-party host is in. */
async function presentingHost() {
  const { transport, sent } = createTransport();
  const voice = createVoiceController(transport);
  voice.setSessionProvider(async () => ({
    backend: "livekit" as const,
    url: "ws://sfu",
    token: "t",
    room: CHANNEL,
    identity: PEER,
  }));
  await voice.join(CHANNEL);
  voice.handleSignaling(welcome());
  await settle();
  await settle();
  expect(voice.getState().usingSfu).toBe(true);
  await voice.startScreenShare();
  await settle();
  expect(voice.getState().isSharingScreen).toBe(true);
  return { voice, sent };
}

/** `cameraProfileFor("360p").maxBitrate` and `("auto")`, spelt out on purpose. */
const CAP_BPS = 400_000;
const AUTO_BPS = 1_500_000;

beforeEach(() => {
  installBrowserStubs();
  cameraCeilings.length = 0;
  hlsSources.length = 0;
  cameraRequests.length = 0;
  appliedConstraints.length = 0;
  ladderReconciles = 0;
  cameraBitrateGate = null;
  liveHlsConfig.cameraHeight = null;
  intervalCallbacks.length = 0;
  vi.mocked(connectLiveKit).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the presenter's camera while a watch party is transcoding", () => {
  it("holds a live camera at 360p when the egress goes up, and gives it back", async () => {
    const { voice } = await presentingHost();
    await voice.toggleCamera();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);

    voice.handleSignaling(voiceStream(1080));
    await settle();

    expect(cameraCeilings.at(-1)).toBe(CAP_BPS);
    // The capture itself moved too, not only the encoder's allowance: a
    // ceiling alone buys a blocky 720p rather than a clean 360p, which is the
    // lesson already written into `video-quality.ts`.
    expect(appliedConstraints.at(-1)).toMatchObject({
      height: { ideal: 360 },
    });
    // The simulcast ladder was solved against the old capture size.
    expect(ladderReconciles).toBeGreaterThan(0);

    voice.handleSignaling(voiceStream(null));
    await settle();

    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);
    expect(appliedConstraints.at(-1)).toMatchObject({
      height: { ideal: 720 },
    });
  });

  it("holds the camera at 480p instead where the deployment allows it", async () => {
    // `LIVE_HLS_CAMERA_480` on (the default): the camera slot is encoded at
    // 480p, so the presenter publishes 480p (700 kbit/s) rather than 360p.
    liveHlsConfig.cameraHeight = 480;
    const { voice } = await presentingHost();
    await settle();
    await voice.toggleCamera();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);

    voice.handleSignaling(voiceStream(1080));
    await settle();

    expect(cameraCeilings.at(-1)).toBe(700_000);
    expect(appliedConstraints.at(-1)).toMatchObject({ height: { ideal: 480 } });
  });

  it("treats a low-latency party as live even though it states no ladder top", async () => {
    // MEASURED IN PRODUCTION, 2026-09-17. An LL presenter's screen share had
    // TWO active outbound encodings for a whole 21 minute party (rid=q 640x360
    // at 423 kbps beside rid=h 1280x720 at 3.2 Mbit/s), because this wiring
    // read "no `topHeight`" as "no egress is running": the session was handed
    // `setHlsSource(null)`, so the share was never pinned, its 360p rung was
    // never deactivated, and the camera was never capped either. The remux
    // subscribes to the top layer only, so that rung was pure waste on the
    // presenter's home uplink, and a second stream of keyframes.
    const { voice } = await presentingHost();
    await voice.toggleCamera();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);

    voice.handleSignaling(llVoiceStream());
    await settle();

    expect(hlsSources.at(-1)).not.toBeNull();
    expect(hlsSources.at(-1)?.ladderTopHeight).toBeGreaterThan(0);
    expect(cameraCeilings.at(-1)).toBe(CAP_BPS);
  });

  it("captures a camera opened mid-party small rather than shrinking it after", async () => {
    const { voice } = await presentingHost();
    voice.handleSignaling(voiceStream(1080));
    await settle();

    await voice.toggleCamera();
    await settle();

    // The FIRST thing the hardware was asked for. Opening at 720p and
    // applying 360p a tick later is a visible pop and a wasted republish.
    expect(cameraRequests).toHaveLength(1);
    expect(cameraRequests[0]).toMatchObject({ height: { ideal: 360 } });
  });

  it("stores a quality picked mid-party without publishing it", async () => {
    const { voice } = await presentingHost();
    await voice.toggleCamera();
    await settle();
    voice.handleSignaling(voiceStream(1080));
    await settle();

    await voice.setVideoQuality("1080p");
    await settle();

    // The choice is theirs and it survives; what goes on the wire is the
    // choice under the cap, and the menu never appears to move on its own.
    expect(voice.getVideoQuality()).toBe("1080p");
    expect(cameraCeilings.at(-1)).toBe(CAP_BPS);

    voice.handleSignaling(voiceStream(null));
    await settle();

    // 1080p's own ceiling, because that is what they picked while capped.
    expect(cameraCeilings.at(-1)).toBe(2_500_000);
  });

  it("leaves a presenter who already picked 360p exactly where they were", async () => {
    const { voice } = await presentingHost();
    await voice.setVideoQuality("360p");
    await voice.toggleCamera();
    await settle();
    const before = cameraCeilings.length;

    voice.handleSignaling(voiceStream(1080));
    await settle();

    // Nothing to do, so nothing is done: the cap never raises, and a no-op
    // republish mid-party is a stutter for every viewer of the camera.
    expect(cameraCeilings.slice(before)).toEqual([]);
    expect(ladderReconciles).toBe(0);
  });

  it("does nothing for somebody else's share in the same party", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    voice.setSessionProvider(async () => ({
      backend: "livekit" as const,
      url: "ws://sfu",
      token: "t",
      room: CHANNEL,
      identity: PEER,
    }));
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome());
    await settle();
    await settle();
    await voice.toggleCamera();
    await settle();
    const before = cameraCeilings.length;

    // Everyone in the room gets this frame. Only the machine whose share is
    // the ladder's source pays for it.
    voice.handleSignaling(voiceStream(1080, "someone-else"));
    await settle();

    expect(cameraCeilings.slice(before)).toEqual([]);
  });

  it("keeps the camera capped through a quick screen re-share, and lifts it when the session ends", async () => {
    // Production rehearsal C, 2026-09-25: the presenter stopped the screen
    // and shared again two seconds later. The sampler saw "not sharing",
    // lifted the cap, and the camera was republished at full size; the
    // re-share capped it again, a second republish. Each republish is a new
    // camera track and a camera egress restart: 3.1 s cut from the camera
    // recording. The server holds the session for a presenter who stopped
    // sharing (still naming this peer), so the cap holds with it.
    const { voice } = await presentingHost();
    await voice.toggleCamera();
    await settle();
    voice.handleSignaling(llVoiceStream());
    await settle();
    expect(cameraCeilings.at(-1)).toBe(CAP_BPS);
    const republishes = ladderReconciles;

    await voice.stopScreenShare();
    await settle();
    // The 2 s sampler's tick, which is what used to lift the cap.
    for (const tick of intervalCallbacks.splice(0)) {
      tick();
    }
    await settle();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(CAP_BPS);
    expect(ladderReconciles).toBe(republishes);

    await voice.startScreenShare();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(CAP_BPS);
    expect(ladderReconciles).toBe(republishes);

    // The session really ended: the camera gets its size back.
    await voice.stopScreenShare();
    voice.handleSignaling(voiceStream(null));
    await settle();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);
  });

  it("at 480p too: a quick re-share never republishes the camera", async () => {
    // The same property with the 480p cap: the re-share's own
    // `startScreenShare` asks the config again, and an answer that has not
    // changed must move nothing.
    liveHlsConfig.cameraHeight = 480;
    const { voice } = await presentingHost();
    await settle();
    await voice.toggleCamera();
    await settle();
    voice.handleSignaling(llVoiceStream());
    await settle();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(700_000);
    const republishes = ladderReconciles;
    const ceilings = cameraCeilings.length;

    await voice.stopScreenShare();
    await settle();
    for (const tick of intervalCallbacks.splice(0)) {
      tick();
    }
    await settle();
    await settle();
    await voice.startScreenShare();
    await settle();
    await settle();

    expect(ladderReconciles).toBe(republishes);
    expect(cameraCeilings.length).toBe(ceilings);
  });

  /**
   * THE RACE A FAROL REVIEW CAUGHT: two overlapping `refreshHlsSource` calls
   * — one entering the capped state, one right behind it leaving it — can
   * interleave so the SLOWER (capping) call resumes from its own await
   * AFTER the faster (uncapping) one has already finished, and reapplies
   * 360p on top of a camera and SFU that are correctly back at "auto". The
   * generation guard in `applyWatchPartyCameraCap` exists to stop exactly
   * that: a superseded call must back off rather than resume.
   */
  it("a capping call stuck on its own SFU round trip does not clobber a faster uncap that landed after it", async () => {
    const { voice } = await presentingHost();
    await voice.toggleCamera();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);

    let releaseGate: () => void = () => {};
    cameraBitrateGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    // Egress starts: this call's setCameraMaxBitrate(CAP_BPS) hangs on the
    // gate before it can go on to touch the capture or the ladder.
    voice.handleSignaling(voiceStream(1080));
    await settle();
    expect(cameraCeilings.at(-1)).toBe(CAP_BPS);

    // Egress ends before the stuck call resumes. Its own setCameraMaxBitrate
    // call is not gated (the gate is one-shot and already spent), so this
    // one runs to completion: the camera and the SFU are correctly "auto"
    // again.
    voice.handleSignaling(voiceStream(null));
    await settle();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);
    expect(appliedConstraints.at(-1)).toMatchObject({
      height: { ideal: 720 },
    });

    // Now let the stuck capping call resume. Without the generation guard it
    // would re-apply 360p here, on top of a camera the audience (and the
    // stored `videoQuality`) both already agree is back at auto.
    releaseGate();
    await settle();
    await settle();

    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);
    expect(appliedConstraints.at(-1)).toMatchObject({
      height: { ideal: 720 },
    });
    // The stuck call must not have republished the simulcast ladder either:
    // that read the STALE 360p capture, which no longer exists.
    expect(ladderReconciles).toBe(1);
  });
});

describe("the presenter's screen pin after a page reload or a re-share", () => {
  /**
   * PRODUCTION REHEARSAL E, 2026-09-25. Before the presenter reloaded, the LL
   * share went out at 1120x720 with no quality limitation. After the reload
   * it went out at 280x180 for the rest of the show: the screen sender was
   * back on `maintain-framerate` with no `scaleResolutionDownBy`, so the
   * ingest pin (#475) was never applied to the new page's share.
   *
   * The pin follows `setHlsSource`, and `setHlsSource` was only ever called
   * from the `voice-stream` handler and from the 2 s sampler that handler
   * arms. A reloaded page is told the stream when it JOINS, before it shares,
   * so that one call answered "not sharing" and armed nothing; and nothing
   * the share itself does (or the SFU coming up) asked again. A re-share on
   * the same page was the same hole with no frame at all: the server's
   * stream has not changed, so it sends nothing.
   */
  it("a reloaded presenter told the stream before sharing still feeds the egress once the share is up", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    voice.setSessionProvider(async () => ({
      backend: "livekit" as const,
      url: "ws://sfu",
      token: "t",
      room: CHANNEL,
      identity: PEER,
    }));
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome());
    // What the server hands a joiner: the live session, still naming the
    // page that was reloaded away (the return hold, #817).
    voice.handleSignaling(llVoiceStream("peer-before-the-reload"));
    await settle();
    await settle();
    expect(voice.getState().usingSfu).toBe(true);
    expect(hlsSources.filter((source) => source !== null)).toEqual([]);

    await voice.startScreenShare();
    await settle();
    await settle();

    expect(voice.getState().isSharingScreen).toBe(true);
    expect(hlsSources.at(-1)?.ladderTopHeight).toBeGreaterThan(0);
    // And the sampler is armed, which is what repairs the pin every 2 s.
    expect(intervalCallbacks.length).toBeGreaterThan(0);
  });

  it("the stream frame landing before the SFU is up still pins the share once it is", async () => {
    // The other order a reload can take: the frame is handled while this
    // page is not on the SFU yet, so it answers "no egress to feed", and
    // the SFU coming up is not a frame.
    let releaseSfu: () => void = () => {};
    const sfuGate = new Promise<void>((resolve) => {
      releaseSfu = resolve;
    });
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    voice.setSessionProvider(async () => {
      await sfuGate;
      return {
        backend: "livekit" as const,
        url: "ws://sfu",
        token: "t",
        room: CHANNEL,
        identity: PEER,
      };
    });
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome());
    voice.handleSignaling(llVoiceStream());
    await settle();
    expect(voice.getState().usingSfu).toBe(false);

    releaseSfu();
    await settle();
    await settle();
    await settle();
    expect(voice.getState().usingSfu).toBe(true);
    await voice.startScreenShare();
    await settle();
    await settle();

    expect(hlsSources.at(-1)?.ladderTopHeight).toBeGreaterThan(0);
  });

  it("a re-share on the same page is pinned again with no frame from the server", async () => {
    const { voice } = await presentingHost();
    voice.handleSignaling(llVoiceStream());
    await settle();
    await settle();
    expect(hlsSources.at(-1)?.ladderTopHeight).toBeGreaterThan(0);

    await voice.stopScreenShare();
    await settle();
    // The sampler's tick while nothing is shared: the source comes off.
    for (const tick of intervalCallbacks.splice(0)) {
      tick();
    }
    await settle();
    await settle();
    expect(hlsSources.at(-1)).toBeNull();

    // Same peer, same session: the server has nothing new to say.
    await voice.startScreenShare();
    await settle();
    await settle();

    expect(hlsSources.at(-1)?.ladderTopHeight).toBeGreaterThan(0);
    expect(intervalCallbacks.length).toBeGreaterThan(0);
  });
});
