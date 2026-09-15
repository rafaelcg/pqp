import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * "VOZ SEPARADA": THE PRESENTER'S MIC STAYS OUT OF THE FILM'S OWN AUDIO.
 *
 * `LIVE_HLS_VOICE_TRACK` (`docs/plans/WATCH_PARTY_SEPARATE_TRACKS.md`) lets a
 * presenter keep their voice off the screen-share mix entirely, so it can
 * ride the camera/voice egress instead. What matters here is the wiring in
 * `use-voice.ts`, not the audio graph itself (`lib/screen-mix.test.ts` owns
 * that): whether the mix is ever handed the mic stream, and whether the
 * presenter's ordinary microphone publication is muted (as it always was,
 * "junto") or left open (new, "separada" — it is the only path left that
 * carries the voice to anyone at all).
 *
 * `createScreenMix` is mocked rather than driven through a fake `AudioContext`
 * the way `screen-mix.test.ts` does: the question here is which stream
 * `use-voice.ts` PASSES to the mix, never what the mix does with it.
 */

const screenMixInstances: {
  setMic: ReturnType<typeof vi.fn>;
  initialMic: MediaStream | null;
}[] = [];

vi.mock("@/lib/screen-mix", () => ({
  createScreenMix: vi.fn((display: MediaStream, mic: MediaStream | null) => {
    const setMic = vi.fn();
    screenMixInstances.push({ setMic, initialMic: mic });
    return {
      stream: display,
      setMic,
      micIn: () => mic !== null,
      setMicGain: () => {},
      setDisplayGain: () => {},
      micLevelDb: () => null,
      micArchiveStream: () => null,
      outputLevelDb: () => null,
      close: () => {},
    };
  }),
}));

vi.mock("@/lib/sounds", () => ({
  playCue: () => {},
  stopAllSoundLoops: () => {},
  whenCueSettled: async () => {},
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

/** Every `setMuted` call the SFU session got, in order. */
const mutedCalls: boolean[] = [];

/** Every `publishVoiceTrack`/`unpublishVoiceTrack` call, in order. */
const voiceTrackCalls: ("publish" | "unpublish")[] = [];
/** Every `publishStageMix`/`unpublishStageMix` call, in order (CONVIDADOS). */
const stageMixCalls: ("publish" | "unpublish")[] = [];
/**
 * One-shot gate: when set, the NEXT `publishVoiceTrack`/`unpublishVoiceTrack`
 * call hangs on it before resolving, so a test can hold one call's SFU round
 * trip open while a later, overlapping call runs to completion — the race
 * `voiceTrackGeneration` exists to resolve.
 */
let voiceTrackGate: Promise<void> | null = null;
async function holdNextVoiceTrackCall(): Promise<void> {
  const gate = voiceTrackGate;
  voiceTrackGate = null;
  if (gate) {
    await gate;
  }
}

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({
    publish: async () => {},
    replaceTrack: async () => {},
    setMuted: async (muted: boolean) => {
      mutedCalls.push(muted);
    },
    publishScreen: async () => {},
    unpublishScreen: async () => {},
    unpublishScreenAudio: async () => {},
    publishMicArchive: async () => {},
    unpublishMicArchive: async () => {},
    publishVoiceTrack: async () => {
      voiceTrackCalls.push("publish");
      await holdNextVoiceTrackCall();
    },
    unpublishVoiceTrack: async () => {
      voiceTrackCalls.push("unpublish");
      await holdNextVoiceTrackCall();
    },
    publishStageMix: async () => {
      stageMixCalls.push("publish");
    },
    unpublishStageMix: async () => {
      stageMixCalls.push("unpublish");
    },
    publishCamera: async () => {},
    unpublishCamera: async () => {},
    setCameraMaxBitrate: async () => {},
    reconcileCameraLadder: async () => {},
    setScreenMaxBitrate: async () => {},
    setScreenQuality: async () => {},
    setScreenHlsPublishHeight: () => {},
    setReceiveQuality: async () => {},
    setHlsSource: async () => {},
    setAudioDelivery: () => {},
    disconnect: async () => {},
    isConnected: () => true,
  })),
}));

/**
 * Whatever `GET /api/live-hls/config` says about `voiceTrack`, for
 * `refreshVoiceTrackAvailable()` — default `true` (a deployment that
 * supports the flag), one test below flips it to prove the fallback.
 */
let voiceTrackServerSupport = true;
vi.mock("@/hooks/use-live-hls-config", () => ({
  loadLiveHlsConfig: async () => ({ voiceTrack: voiceTrackServerSupport }),
}));

const { createVoiceController } = await import("./use-voice");

function fakeTrack(kind: "audio" | "video") {
  return {
    kind,
    id: `${kind}-track`,
    enabled: true,
    contentHint: "",
    onended: null as null | (() => void),
    stop: () => {},
    applyConstraints: async () => {},
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
  g.setInterval = () => 1;
  g.clearInterval = () => {};
  g.window = { addEventListener: () => {}, dispatchEvent: () => true };
  // `stage-mix.ts` wraps a stream's own tracks in `new MediaStream(tracks)`
  // before handing them to `AudioContext.createMediaStreamSource` — needed
  // only once CONVIDADOS is exercised in this file, node has no such global.
  g.MediaStream = class {
    private tracks: ReturnType<typeof fakeTrack>[];
    constructor(tracks: ReturnType<typeof fakeTrack>[] = []) {
      this.tracks = tracks;
    }
    getTracks() {
      return [...this.tracks];
    }
    getAudioTracks() {
      return this.tracks.filter((t) => t.kind === "audio");
    }
    getVideoTracks() {
      return this.tracks.filter((t) => t.kind === "video");
    }
  };
  try {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  } catch {
    // Already absent.
  }
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (constraints: MediaStreamConstraints) =>
        constraints.video ? fakeStream("camera", "video") : fakeStream("mic"),
      getDisplayMedia: async () => fakeStream("screen", "video"),
    },
  });
  // Needed for the mic PIPELINE (gain node on the raw capture), not for
  // `createScreenMix` — that is mocked above, so this file never touches
  // the real audio graph `screen-mix.test.ts` owns.
  g.AudioContext = class {
    createMediaStreamSource() {
      return { connect: () => {}, disconnect: () => {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
    }
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        connect: () => {},
        disconnect: () => {},
      };
    }
    createMediaStreamDestination() {
      return { stream: fakeStream("processed") };
    }
    createDynamicsCompressor() {
      return {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        connect: () => {},
        disconnect: () => {},
      };
    }
    close() {
      return Promise.resolve();
    }
  };
}

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
  } as VoiceSignalingMessage;
}

/** Every `set-voice-track-mode` frame sent, in order. */
const voiceTrackModeFrames: { separated: boolean }[] = [];

function createTransport() {
  const transport: RealtimeTransport = {
    connect: () => {},
    disconnect: () => {},
    sendChat: () => {},
    sendVoice: (message) => {
      if (message.type === "set-voice-track-mode") {
        voiceTrackModeFrames.push({ separated: message.separated });
      }
    },
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
  return { transport };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Joined, in a LiveKit room, mic open. */
async function joinedHost() {
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
  expect(voice.getState().usingSfu).toBe(true);
  return voice;
}

beforeEach(() => {
  installBrowserStubs();
  screenMixInstances.length = 0;
  mutedCalls.length = 0;
  voiceTrackCalls.length = 0;
  stageMixCalls.length = 0;
  voiceTrackModeFrames.length = 0;
  voiceTrackServerSupport = true;
  voiceTrackGate = null;
});

describe("voiceTrackMode defaults", () => {
  it("starts on 'junto' when nothing was ever chosen", async () => {
    const voice = await joinedHost();
    expect(voice.getState().voiceTrackMode).toBe("junto");
  });
});

describe("starting a watch-party share with the mic already on", () => {
  it("'junto' (default): the mix gets the mic, and the ordinary publication mutes", async () => {
    const voice = await joinedHost();
    await voice.startScreenShare(false, { watchParty: true });
    await settle();

    expect(voice.getState().isSharingScreen).toBe(true);
    expect(voice.getState().isSharingMic).toBe(true);
    expect(screenMixInstances).toHaveLength(1);
    // The mix was built WITH a mic stream, not null.
    expect(screenMixInstances[0]!.initialMic).not.toBeNull();
    // The separate publication goes quiet: the mix already carries it, and a
    // second copy would double every seated listener.
    expect(mutedCalls.at(-1)).toBe(true);
  });

  it("'separada': the mix stays mic-free, and the ordinary publication unmutes", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();

    expect(voice.getState().isSharingScreen).toBe(true);
    // Voice still reaches the audience — just not through this bus.
    expect(voice.getState().isSharingMic).toBe(true);
    expect(screenMixInstances).toHaveLength(1);
    expect(screenMixInstances[0]!.initialMic).toBeNull();
    // Nothing else carries the voice in this mode, so the publication has to
    // stay open, never muted for "the mix already has it" reasons.
    expect(mutedCalls.at(-1)).toBe(false);
  });
});

describe("flipping the mode on a running share", () => {
  it("moves the mic out of the mix and unmutes the publication live", async () => {
    const voice = await joinedHost();
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    expect(mutedCalls.at(-1)).toBe(true);

    voice.setVoiceTrackMode("separada");
    await settle();

    expect(voice.getState().voiceTrackMode).toBe("separada");
    // setMic(null) is the live move: the running mix drops the mic branch
    // without a republish or an interruption to the share.
    expect(screenMixInstances[0]!.setMic).toHaveBeenLastCalledWith(null);
    expect(mutedCalls.at(-1)).toBe(false);
  });

  it("moves it back into the mix and re-mutes the publication", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    expect(mutedCalls.at(-1)).toBe(false);

    voice.setVoiceTrackMode("junto");
    await settle();

    expect(screenMixInstances[0]!.setMic).toHaveBeenLastCalledWith(
      expect.anything(),
    );
    expect(screenMixInstances[0]!.setMic.mock.calls.at(-1)![0]).not.toBeNull();
    expect(mutedCalls.at(-1)).toBe(true);
  });

  it("is a no-op when set to the mode already in force", async () => {
    const voice = await joinedHost();
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    const callsBefore = screenMixInstances[0]!.setMic.mock.calls.length;
    const mutedBefore = mutedCalls.length;

    voice.setVoiceTrackMode("junto");
    await settle();

    expect(screenMixInstances[0]!.setMic.mock.calls.length).toBe(callsBefore);
    expect(mutedCalls.length).toBe(mutedBefore);
  });
});

describe("turning 'meu mic vai no stream' on while already 'separada'", () => {
  it("builds the mix — mic-free — only once the switch is actually flipped on", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    voice.setMicInStream(false);
    // The switch is off, so the share starts with no mix at all — same as
    // any "junto" share started muted.
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    expect(screenMixInstances).toHaveLength(0);
    expect(voice.getState().isSharingMic).toBe(false);

    // Flipping it on builds the mix now, and "separada" means mic-free.
    voice.setMicInStream(true);
    await settle();

    expect(voice.getState().isSharingMic).toBe(true);
    expect(screenMixInstances).toHaveLength(1);
    expect(screenMixInstances[0]!.initialMic).toBeNull();
    expect(mutedCalls.at(-1)).toBe(false);
  });
});

describe("'separada' publishes voice-track, and only voice-track — never the ordinary mic clone", () => {
  it("publishes voice-track once the mix is up in separada", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();

    expect(voiceTrackCalls).toContain("publish");
  });

  it("withdraws voice-track when the mode moves back to junto", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    voiceTrackCalls.length = 0;

    voice.setVoiceTrackMode("junto");
    await settle();

    expect(voiceTrackCalls).toContain("unpublish");
  });
});

/**
 * THE PERSISTED PREFERENCE, RE-CHECKED AGAINST THE SERVER THAT IS ACTUALLY
 * ANSWERING. `voiceTrackMode` is a standing, per-browser choice
 * (`localStorage`) that outlives any one server or deployment — a Farol
 * review on the first version of this feature caught what happens without
 * this check: a host who picked "separada" once, then shares again on a
 * deployment where the flag is off, would still have the mic pulled OUT of
 * the film's audio with nothing left to carry it to the audience at all.
 */
describe("a persisted 'separada' preference on a deployment that cannot carry it", () => {
  it("falls back to junto: the mix keeps the mic, the publication stays muted, no voice-track is published", async () => {
    voiceTrackServerSupport = false;
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();

    expect(voice.getState().voiceTrackMode).toBe("separada");
    expect(screenMixInstances).toHaveLength(1);
    // NOT null: the deployment cannot carry the voice any other way, so the
    // film's own audio is what the audience gets it from, same as "junto".
    expect(screenMixInstances[0]!.initialMic).not.toBeNull();
    // Muted, not unmuted: with the mic IN the mix, an unmuted ordinary
    // publication would double it for the room.
    expect(mutedCalls.at(-1)).toBe(true);
    expect(voiceTrackCalls).not.toContain("publish");
  });

  it("stops excluding the mic the moment the deployment starts supporting it", async () => {
    voiceTrackServerSupport = false;
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    expect(screenMixInstances[0]!.initialMic).not.toBeNull();

    voiceTrackServerSupport = true;
    // Any of the re-check points works; a mode toggle is the most direct.
    voice.setVoiceTrackMode("junto");
    await settle();
    voice.setVoiceTrackMode("separada");
    await settle();

    expect(screenMixInstances[0]!.setMic).toHaveBeenLastCalledWith(null);
    expect(mutedCalls.at(-1)).toBe(false);
  });
});

describe("set-voice-track-mode reaches the server alongside the publication", () => {
  it("sends separated: true the moment voice-track is published", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();

    expect(voiceTrackModeFrames.at(-1)).toEqual({ separated: true });
  });

  it("sends separated: false the moment voice-track is withdrawn", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    voiceTrackModeFrames.length = 0;

    voice.setVoiceTrackMode("junto");
    await settle();

    expect(voiceTrackModeFrames.at(-1)).toEqual({ separated: false });
  });
});

/**
 * THE FIRE-AND-FORGET BUG A FAROL REVIEW CAUGHT: two overlapping
 * `syncVoiceTrackPublication` calls — one enabling, one right behind it
 * disabling — could previously interleave their own SFU round trips so the
 * SLOWER (enabling) call resumed and published AFTER the faster (disabling)
 * one had already unpublished, leaving a stale microphone exposed to the
 * HLS audience after the presenter had already turned "separada" back off.
 * `voiceTrackGeneration` plus the serialized `voiceTrackSyncChain` exist to
 * stop exactly that: a superseded call must skip its own turn rather than
 * apply a decision nobody wants any more.
 */
describe("disabling separada while its own publish is still in flight", () => {
  it("a slow publish never tells the server separated:true once a fast disable has superseded it", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");

    let releaseGate: () => void = () => {};
    voiceTrackGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    // The share starts "separada": this call's publishVoiceTrack hangs on
    // the gate, so its own generation check and set-voice-track-mode send
    // have not run yet either.
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    expect(voiceTrackCalls).toEqual(["publish"]);
    expect(voiceTrackModeFrames).toEqual([]);

    // The presenter flips back to "junto" before the stuck publish resumes.
    // SERIALIZED, not concurrent: this call's own unpublishVoiceTrack cannot
    // run yet either — it is queued behind the still-in-flight publish, on
    // the same voiceTrackSyncChain.
    voice.setVoiceTrackMode("junto");
    await settle();
    expect(voiceTrackCalls).toEqual(["publish"]);
    expect(voiceTrackModeFrames).toEqual([]);

    // Now the stuck publish resumes. Without the generation guard it would
    // tell the server separated: true here — a decision "junto" already
    // superseded before this call ever got to announce it. With the guard,
    // it recognises it is stale and says nothing; the queue then moves on
    // to the "junto" call, which unpublishes and announces separated: false.
    releaseGate();
    await settle();
    await settle();

    expect(voiceTrackCalls).toEqual(["publish", "unpublish"]);
    // NEVER separated: true. The server's own `presenterWantsSeparatedVoice`
    // (`hls-egress.ts`) never once agreed with a publication the presenter
    // had already withdrawn their choice on.
    expect(voiceTrackModeFrames).toEqual([{ separated: false }]);
  });
});

describe("'separada' with no microphone to publish at all", () => {
  it("falls back to junto and says why, rather than storing an inert choice", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    voice.setSessionProvider(async () => ({
      backend: "livekit" as const,
      url: "ws://sfu",
      token: "t",
      room: CHANNEL,
      identity: PEER,
    }));
    // The audience seat: no mic pipeline opens at all.
    await voice.join(CHANNEL, { audienceOnly: true });
    voice.handleSignaling(welcome());
    await settle();
    await settle();

    voice.setVoiceTrackMode("separada");
    await settle();

    expect(voice.getState().voiceTrackMode).toBe("junto");
    expect(voice.getState().notice).toBeTruthy();
  });
});

describe("CONVIDADOS: guests publish stage-mix instead of voice-track", () => {
  it("publishes stage-mix, not voice-track, the moment guests turn on while sharing", async () => {
    const voice = await joinedHost();
    await voice.startScreenShare(false, { watchParty: true });
    await settle();

    voice.setWatchPartyGuests("invite", []);
    await settle();

    expect(stageMixCalls).toEqual(["publish"]);
    expect(voiceTrackCalls).toEqual([]);
  });

  it("does not republish stage-mix when a guest joins or leaves air", async () => {
    // §5.2: "the mix persists across calls so a guest joining mid-show is
    // an input added to a bus already running, not a fresh one starting."
    // The SFU publication itself must not churn either.
    const voice = await joinedHost();
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    voice.setWatchPartyGuests("invite", []);
    await settle();
    expect(stageMixCalls).toEqual(["publish"]);

    voice.setWatchPartyGuests("invite", ["guest-1"]);
    await settle();
    voice.setWatchPartyGuests("invite", ["guest-1", "guest-2"]);
    await settle();
    voice.setWatchPartyGuests("invite", []);
    await settle();

    // Still exactly the one publish from turning guests on in the first
    // place — none of the on-air roster changes touched the SFU.
    expect(stageMixCalls).toEqual(["publish"]);
  });

  it("switches back to voice-track when guests turn off, still separated", async () => {
    const voice = await joinedHost();
    await voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    voice.setWatchPartyGuests("request", ["guest-1"]);
    await settle();
    expect(stageMixCalls).toEqual(["publish"]);

    voice.setWatchPartyGuests("off", []);
    await settle();

    expect(stageMixCalls).toEqual(["publish", "unpublish"]);
    // The share started already "separada" (voice-track published first),
    // guests turning on swapped it for stage-mix (unpublish then publish
    // above), and guests turning off again swaps back.
    expect(voiceTrackCalls).toEqual(["publish", "unpublish", "publish"]);
  });

  it("guests forces separada even when the standing preference is junto", async () => {
    const voice = await joinedHost();
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    expect(voice.getState().voiceTrackMode).toBe("junto");

    voice.setWatchPartyGuests("request", []);
    await settle();

    // The film mix stays out of the mic's way — same signal
    // `effectiveVoiceSeparated()` gives the standing preference.
    expect(mutedCalls.at(-1)).toBe(false);
    expect(stageMixCalls).toEqual(["publish"]);
  });
});
