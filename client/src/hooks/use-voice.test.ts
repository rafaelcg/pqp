import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";
import type { RemotePeer } from "@/lib/peer-connection-manager";

/**
 * The client obeys the room's transport, or leaves and says so.
 *
 * It used to pick mesh-vs-SFU for itself, once per join, silently, and fall
 * back to mesh whenever the SFU path failed for any reason. In a room where
 * everyone else was on the SFU that produced a participant who could neither
 * hear nor be heard, with no error on any screen and no way to tell them apart
 * from someone sitting there muted. Every assertion about `transportFailure`
 * below is really an assertion that the user finds out.
 */

const managers: ManagerStub[] = [];

interface ManagerStub {
  peerIds: string[];
  removedPeerIds: string[];
  disposed: boolean;
  /** Every capture handed to the mesh, in order. `null` means "stop sharing". */
  screenStreams: (MediaStream | null)[];
  /**
   * Every "peer X is/is not presenting" the roster forwarded to the mesh.
   *
   * The mesh cannot work this out for itself — a share announces no stream id,
   * and the sender's `removeTrack` only mutes the receiver's track — so this
   * wiring is the whole of how a receiver learns a share ended.
   */
  sharingScreen: [string, boolean][];
  emitState: ((peers: RemotePeer[]) => void) | null;
  /** Renames pushed onto live peers, so a profile edit can be observed. */
  identities: [string, { displayName: string; avatarUrl: string | null }][];
}

const playCueMock = vi.hoisted(() => vi.fn());
const whenCueSettledMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/sounds", () => ({
  playCue: (...args: unknown[]) => playCueMock(...args),
  stopAllSoundLoops: () => {},
  whenCueSettled: () => whenCueSettledMock(),
}));

const beaconVoiceLeaveMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/voice-leave-beacon", () => ({
  beaconVoiceLeave: (...args: unknown[]) => beaconVoiceLeaveMock(...args),
}));

vi.mock("@/lib/peer-connection-manager", () => ({
  getDefaultIceServers: () => [],
  createPeerConnectionManager: vi.fn(() => {
    const stub: ManagerStub = {
      peerIds: [],
      removedPeerIds: [],
      disposed: false,
      screenStreams: [],
      sharingScreen: [],
      emitState: null,
      identities: [],
    };
    managers.push(stub);
    return {
      setLocalStream: () => {},
      setLocalScreenStream: async (stream: MediaStream | null) => {
        stub.screenStreams.push(stream);
      },
      setLocalCameraStream: async () => {},
      setCameraMaxBitrate: () => {},
      setScreenQuality: () => {},
      setPeerCameraStreamId: () => {},
      setPeerScreenAudioStreamId: () => {},
      setPeerSharingScreen: (peerId: string, sharing: boolean) => {
        stub.sharingScreen.push([peerId, sharing]);
      },
      onPeerStateChange: (handler: (peers: RemotePeer[]) => void) => {
        stub.emitState = handler;
      },
      connectToPeer: (peerId: string) => {
        if (!stub.peerIds.includes(peerId)) {
          stub.peerIds.push(peerId);
        }
      },
      setPeerIdentity: (
        peerId: string,
        identity: { displayName: string; avatarUrl: string | null },
      ) => stub.identities.push([peerId, identity]),
      removePeer: (peerId: string) => {
        stub.removedPeerIds.push(peerId);
        stub.peerIds = stub.peerIds.filter((id) => id !== peerId);
      },
      handleOffer: async () => {},
      handleAnswer: async () => {},
      handleIceCandidate: async () => {},
      retryPeer: async () => {},
      replaceLocalTrack: async () => {},
      setIceServers: () => {},
      dispose: () => {
        stub.disposed = true;
      },
    };
  }),
}));

/** Screen publications the SFU stub was asked for, in order. */
const sfuScreenPublishes: (MediaStream | null)[] = [];

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({
    publish: async () => {},
    replaceTrack: async () => {},
    setMuted: async () => {},
    publishScreen: async (stream: MediaStream) => {
      sfuScreenPublishes.push(stream);
    },
    unpublishScreen: async () => {
      sfuScreenPublishes.push(null);
    },
    unpublishScreenAudio: async () => {},
    publishCamera: async () => {},
    setCameraMaxBitrate: async () => {},
    setScreenMaxBitrate: async () => {},
    unpublishCamera: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
  })),
}));

const { createVoiceController } = await import("./use-voice");
const { connectLiveKit } = await import("@/lib/livekit-session");

// ------------------------------------------------------------------ browser
// Just enough of the media APIs for the mic pipeline; the speaking loop never
// ticks because rAF is a no-op, which is all this suite needs.

const stoppedTracks: string[] = [];

function fakeTrack(label: string) {
  return {
    enabled: true,
    stop: () => stoppedTracks.push(label),
  };
}

function fakeStream(label: string) {
  const tracks = [fakeTrack(label)];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  };
}

/** A track with the two things the share paths touch: `stop` and `onended`. */
interface FakeCaptureTrack {
  kind: "video" | "audio";
  onended: (() => void) | null;
  stop: () => void;
  /**
   * Only the video track has one, and only when the test cares which surface
   * the picker returned. Absent is a real shape: Safari and Firefox omit
   * `displaySurface`, and older engines have no `getSettings` on a capture
   * track at all.
   */
  getSettings?: () => { displaySurface?: string };
}

interface FakeCapture {
  id: string;
  getTracks: () => FakeCaptureTrack[];
  getVideoTracks: () => FakeCaptureTrack[];
  getAudioTracks: () => FakeCaptureTrack[];
  removeTrack: (track: FakeCaptureTrack) => void;
}

/**
 * A `getDisplayMedia` result, with or without the system-audio track.
 *
 * Without is the case that must keep working untouched: Safari, Firefox, and
 * every macOS screen or window share land here.
 */
function fakeCapture(
  id: string,
  withAudio: boolean,
  displaySurface?: string,
): FakeCapture {
  let tracks: FakeCaptureTrack[] = [
    {
      kind: "video",
      onended: null,
      stop: () => stoppedTracks.push(`${id}:video`),
      ...(displaySurface ? { getSettings: () => ({ displaySurface }) } : {}),
    },
  ];
  if (withAudio) {
    tracks.push({
      kind: "audio",
      onended: null,
      stop: () => stoppedTracks.push(`${id}:audio`),
    });
  }
  return {
    id,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    removeTrack: (track) => {
      tracks = tracks.filter((t) => t !== track);
    },
  };
}

/** Arguments every `getDisplayMedia` of the current test received. */
let displayMediaCalls: unknown[] = [];
/** What the next `getDisplayMedia` does. Replaced per test. */
let displayMedia: () => Promise<unknown> = async () => fakeCapture("screen", false);

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  const pagehideHandlers: Array<() => void> = [];
  g.window = {
    addEventListener: (type: string, handler: () => void) => {
      if (type === "pagehide") {
        pagehideHandlers.push(handler);
      }
    },
    dispatchEvent: (event: { type: string }) => {
      if (event.type === "pagehide") {
        for (const handler of pagehideHandlers) {
          handler();
        }
      }
      return true;
    },
  };
  displayMediaCalls = [];
  displayMedia = async () => fakeCapture("screen", false);
  // Node exposes `navigator` as a getter-only global, so define the one
  // property the mic pipeline reaches for rather than replacing the object.
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => fakeStream("mic"),
      // Chrome desktop 141+ knows `restrictOwnAudio`. Stubbed as the modern
      // shape so the constraint's feature detection is exercised rather than
      // silently skipped by a stub that answers nothing.
      getSupportedConstraints: () => ({ restrictOwnAudio: true }),
      getDisplayMedia: async (options: unknown) => {
        displayMediaCalls.push(options);
        return displayMedia();
      },
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

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000bb";

function welcome(
  transport?: "mesh" | "livekit",
  peers: { peerId: string; sharingScreen?: boolean }[] = [],
  voiceChannelId: string = CHANNEL,
): Extract<VoiceSignalingMessage, { type: "welcome" }> {
  const self = {
    peerId: PEER,
    userId: "00000000-0000-4000-8000-0000000000cc",
    displayName: "Me",
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
  };
  return {
    type: "welcome",
    peerId: PEER,
    voiceChannelId,
    self,
    peers: peers.map((p) => ({ ...self, ...p })),
    ...(transport ? { transport } : {}),
  };
}

/** Let the promise chain inside the welcome handler settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function sfuSession() {
  return {
    backend: "livekit" as const,
    url: "ws://sfu",
    token: "t",
    room: CHANNEL,
    identity: PEER,
  };
}

/**
 * Screen share carries the machine's audio when the browser will give it, and
 * is silent, working and unremarkable when it will not.
 *
 * The silent case is the majority one (Safari, Firefox, every macOS screen or
 * window capture, and anyone who leaves the box unticked), which is why most of
 * what is pinned here is that nothing about it looks like a failure.
 */
describe("screen share audio", () => {
  beforeEach(() => {
    installBrowserStubs();
    managers.length = 0;
    stoppedTracks.length = 0;
    sfuScreenPublishes.length = 0;
    vi.mocked(connectLiveKit).mockClear();
  });

  async function connectedMesh() {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("mesh"));
    await settle();
    return { voice, sent };
  }

  it("does not ask for the machine's audio, and hides our own tab from the picker", async () => {
    // The 23 Aug 2026 echo report, pinned. `systemAudio: "include"` was what
    // captured the call off the machine's own mixer and sent it back to the
    // people who were speaking. Audio is still REQUESTED, because that is what
    // keeps a Chrome tab share carrying that tab's sound, which cannot echo.
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    expect(displayMediaCalls).toHaveLength(1);
    expect(displayMediaCalls[0]).toMatchObject({
      audio: { echoCancellation: false, restrictOwnAudio: true },
      systemAudio: "exclude",
      // The anti-feedback rule: sharing the call's own tab would put the call
      // back into the call.
      selfBrowserSurface: "exclude",
    });
  });

  it("asks for the machine's audio only when the caller opted in", async () => {
    const { voice } = await connectedMesh();
    await voice.startScreenShare(true);

    expect(displayMediaCalls[0]).toMatchObject({
      systemAudio: "include",
      audio: { restrictOwnAudio: true },
    });
  });

  it("flags a whole-screen share that carries sound", async () => {
    // The only surface that can be carrying everybody's voices, and the one
    // the UI says so about while it is live.
    displayMedia = async () => fakeCapture("cap-mon", true, "monitor");
    const { voice } = await connectedMesh();
    await voice.startScreenShare(true);

    expect(voice.getState().isSharingSystemAudio).toBe(true);
  });

  it("does not flag a tab share that carries sound", async () => {
    // The recommended route. A tab capture contains that tab and nothing else.
    displayMedia = async () => fakeCapture("cap-tab", true, "browser");
    const { voice } = await connectedMesh();
    await voice.startScreenShare(true);

    expect(voice.getState().isSharingScreenAudio).toBe(true);
    expect(voice.getState().isSharingSystemAudio).toBe(false);
  });

  it("does not flag a silent whole-screen share", async () => {
    displayMedia = async () => fakeCapture("cap-quiet", false, "monitor");
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    expect(voice.getState().isSharingSystemAudio).toBe(false);
  });

  it("drops the flag when the share stops", async () => {
    displayMedia = async () => fakeCapture("cap-mon2", true, "monitor");
    const { voice } = await connectedMesh();
    await voice.startScreenShare(true);
    await voice.stopScreenShare();

    expect(voice.getState().isSharingSystemAudio).toBe(false);
  });

  it("publishes the capture and announces its audio stream id", async () => {
    displayMedia = async () => fakeCapture("cap-1", true);
    const { voice, sent } = await connectedMesh();
    await voice.startScreenShare();

    expect(managers[0]?.screenStreams).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({
      type: "set-sharing-screen",
      sharing: true,
      audioStreamId: "cap-1",
    });
    expect(voice.getState().isSharingScreenAudio).toBe(true);
  });

  it("shares silently, with no error, when the browser gives no audio track", async () => {
    displayMedia = async () => fakeCapture("cap-2", false);
    const { voice, sent } = await connectedMesh();
    await voice.startScreenShare();

    expect(sent.at(-1)).toMatchObject({
      type: "set-sharing-screen",
      sharing: true,
      // Not the id: there is no audio to file under it, and a receiver acting
      // on a stale one would mute the presenter's voice.
      audioStreamId: null,
    });
    expect(voice.getState().isSharingScreen).toBe(true);
    expect(voice.getState().isSharingScreenAudio).toBe(false);
    expect(voice.getState().error).toBeNull();
  });

  it("falls back to a plain video request when the audio one is refused", async () => {
    let attempt = 0;
    displayMedia = async () => {
      attempt += 1;
      if (attempt === 1) {
        const err = new Error("nope");
        err.name = "NotSupportedError";
        throw err;
      }
      return fakeCapture("cap-3", false);
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    expect(displayMediaCalls).toHaveLength(2);
    expect(displayMediaCalls[1]).toEqual({ video: true });
    expect(voice.getState().isSharingScreen).toBe(true);
  });

  it("does not reopen the picker when the capture itself failed", async () => {
    displayMedia = async () => {
      // Raised after the user has already chosen a surface. Asking again would
      // put a second picker on screen with nothing to explain it.
      const err = new Error("Could not start audio source");
      err.name = "NotReadableError";
      throw err;
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    expect(displayMediaCalls).toHaveLength(1);
    expect(voice.getState().isSharingScreen).toBe(false);
    expect(voice.getState().error).not.toBeNull();
  });

  it("offers a silent retry when sound is what killed the capture", async () => {
    // The 3 Sep 2026 report, in full: "o picker fecha e a stream não começa".
    // Sound is the only part of a capture that can fail on its own and take the
    // picture down with it, and the person has no way to know that: the toggle
    // that did it lives on another bar and was armed minutes earlier. The flag
    // is what puts a one-click way out into the error banner.
    displayMedia = async () => {
      const err = new Error("Could not start audio source");
      err.name = "NotReadableError";
      throw err;
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare(true);

    expect(voice.getState().screenShareAudioFailed).toBe(true);
  });

  it("does not offer a silent retry when the person cancelled the picker", async () => {
    // Backing out is not a failure, and a red banner offering to fix it would
    // be the app arguing with a decision that was made on purpose.
    displayMedia = async () => {
      const err = new Error("Permission denied");
      err.name = "NotAllowedError";
      throw err;
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare(true);

    expect(voice.getState().screenShareAudioFailed).toBe(false);
  });

  it("clears the failed banner once a silent share succeeds", async () => {
    displayMedia = async () => {
      const err = new Error("Could not start audio source");
      err.name = "NotReadableError";
      throw err;
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare(true);
    expect(voice.getState().error).not.toBeNull();

    displayMedia = async () => fakeCapture("screen", false);
    await voice.startScreenShare(false);

    expect(voice.getState().isSharingScreen).toBe(true);
    expect(voice.getState().error).toBeNull();
    expect(voice.getState().screenShareAudioFailed).toBe(false);
  });

  it("explains a failed audio capture instead of quoting the browser", async () => {
    // A real report from the QG, 24 Aug 2026: "Could not start audio source",
    // in English, with no clue attached, and the share dropped even though the
    // video was fine. The person worked out on their own that unticking the
    // audio box fixed it, which is a thing the product should have told them.
    displayMedia = async () => {
      const err = new Error("Could not start audio source");
      err.name = "NotReadableError";
      throw err;
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    const message = voice.getState().error ?? "";
    // The specific failure this regressed into: passing the browser's own
    // string through untranslated.
    expect(message).not.toBe("Could not start audio source");
    expect(message).not.toContain("Could not start");
    // And it has to name the fix, not just the symptom.
    expect(message.toLowerCase()).toMatch(/aba|guia|tab/);
  });

  it("does not reopen the picker when the user dismissed it", async () => {
    displayMedia = async () => {
      const err = new Error("denied");
      err.name = "NotAllowedError";
      throw err;
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    // Asking twice would be arguing with someone who just said no.
    expect(displayMediaCalls).toHaveLength(1);
    expect(voice.getState().isSharingScreen).toBe(false);
    expect(voice.getState().error).not.toBeNull();
  });

  it("stops both tracks and withdraws the announcement", async () => {
    displayMedia = async () => fakeCapture("cap-4", true);
    const { voice, sent } = await connectedMesh();
    await voice.startScreenShare();
    await voice.stopScreenShare();

    expect(stoppedTracks).toContain("cap-4:video");
    expect(stoppedTracks).toContain("cap-4:audio");
    expect(sent.at(-1)).toMatchObject({
      type: "set-sharing-screen",
      sharing: false,
      audioStreamId: null,
    });
    expect(managers[0]?.screenStreams.at(-1)).toBeNull();
    expect(voice.getState().isSharingScreenAudio).toBe(false);
  });

  it("keeps the picture when only the audio track ends", async () => {
    const capture = fakeCapture("cap-5", true);
    displayMedia = async () => capture;
    const { voice, sent } = await connectedMesh();
    await voice.startScreenShare();

    const audio = capture.getAudioTracks()[0]!;
    audio.onended?.();
    await settle();

    expect(voice.getState().isSharingScreen).toBe(true);
    expect(voice.getState().isSharingScreenAudio).toBe(false);
    expect(sent.at(-1)).toMatchObject({
      type: "set-sharing-screen",
      sharing: true,
      audioStreamId: null,
    });
    // Re-published without the audio half rather than torn down.
    expect(managers[0]?.screenStreams.at(-1)).not.toBeNull();
  });

  it("hands the whole capture to the SFU, audio included", async () => {
    displayMedia = async () => fakeCapture("cap-6", true);
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    voice.setSessionProvider(async () => sfuSession());
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("livekit"));
    await settle();

    await voice.startScreenShare();
    expect(sfuScreenPublishes).toHaveLength(1);
    expect(
      (sfuScreenPublishes[0] as unknown as FakeCapture).getAudioTracks(),
    ).toHaveLength(1);

    await voice.stopScreenShare();
    expect(sfuScreenPublishes.at(-1)).toBeNull();
  });
});

describe("concurrent screen shares", () => {
  beforeEach(() => {
    installBrowserStubs();
    managers.length = 0;
    stoppedTracks.length = 0;
    sfuScreenPublishes.length = 0;
    vi.mocked(connectLiveKit).mockClear();
  });

  function participant(peerId: string, sharingScreen: boolean) {
    return {
      peerId,
      userId: "00000000-0000-4000-8000-0000000000dd",
      displayName: peerId,
      avatarUrl: null,
      sharingScreen,
      muted: false,
      deafened: false,
    };
  }

  async function connectedMesh() {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("mesh"));
    await settle();
    return { voice, sent };
  }

  it("tracks every sharer and plays both when there are two", async () => {
    const { voice } = await connectedMesh();
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      transport: "mesh",
      participants: [
        participant(PEER, false),
        participant("aaa", true),
        participant("bbb", true),
      ],
    });
    const state = voice.getState();
    expect(state.screenSharePeerIds).toEqual(["aaa", "bbb"]);
    expect(state.focusedScreenPeerId).toBe("aaa");
    expect(state.audibleScreenPeerIds).toEqual(["aaa", "bbb"]);
  });

  it("tells the mesh when a peer stops presenting", async () => {
    // The half of the re-share fix that lives up here. A share announces no
    // stream id and the sender's `removeTrack` only *mutes* the receiver's
    // track, so if this hand-off is missing the dead capture stays filed as
    // that peer's screen and their next share renders black behind it.
    const { voice } = await connectedMesh();
    const mesh = managers.at(-1)!;
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      transport: "mesh",
      participants: [participant(PEER, false), participant("aaa", true)],
    });
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      transport: "mesh",
      participants: [participant(PEER, false), participant("aaa", false)],
    });

    expect(mesh.sharingScreen).toContainEqual(["aaa", true]);
    expect(mesh.sharingScreen).toContainEqual(["aaa", false]);
    // Never about ourselves: our own preview does not come off the mesh.
    expect(mesh.sharingScreen.map(([peerId]) => peerId)).not.toContain(PEER);
  });

  it("skips the picker when the mesh cap is already full", async () => {
    const { voice } = await connectedMesh();
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      transport: "mesh",
      participants: [
        participant(PEER, false),
        participant("aaa", true),
        participant("bbb", true),
      ],
    });
    await voice.startScreenShare();
    expect(displayMediaCalls).toHaveLength(0);
    expect(voice.getState().error).toMatch(/2/);
    expect(voice.getState().isSharingScreen).toBe(false);
  });

  it("stops the capture when the server denies a share at the cap", async () => {
    const { voice } = await connectedMesh();
    await voice.startScreenShare();
    expect(voice.getState().isSharingScreen).toBe(true);
    voice.handleSignaling({
      type: "screen-share-denied",
      voiceChannelId: CHANNEL,
    });
    await settle();
    expect(voice.getState().isSharingScreen).toBe(false);
    expect(voice.getState().error).toMatch(/2/);
  });

  it("treats a channel switch as a join into live shares, not a newest-diff", async () => {
    const other = "00000000-0000-4000-8000-0000000000ee";
    const { voice } = await connectedMesh();
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      transport: "mesh",
      participants: [
        participant(PEER, false),
        participant("aaa", true),
        participant("bbb", true),
      ],
    });
    expect(voice.getState().focusedScreenPeerId).toBe("aaa");

    await voice.join(other);
    expect(voice.getState().screenSharePeerIds).toEqual([]);

    voice.handleSignaling(
      welcome(
        "mesh",
        [
          { peerId: "ccc", sharingScreen: true },
          { peerId: "ddd", sharingScreen: true },
        ],
        other,
      ),
    );
    await settle();
    expect(voice.getState().screenSharePeerIds).toEqual(["ccc", "ddd"]);
    expect(voice.getState().focusedScreenPeerId).toBe("ccc");
    expect(voice.getState().audibleScreenPeerIds).toEqual(["ccc", "ddd"]);
  });
});

describe("voice transport is the server's decision", () => {
  beforeEach(() => {
    installBrowserStubs();
    managers.length = 0;
    stoppedTracks.length = 0;
    vi.mocked(connectLiveKit).mockClear();
  });

  describe("mesh room", () => {
    it("builds a peer mesh and never asks for an SFU session", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);
      const provider = vi.fn(async () => sfuSession());
      voice.setSessionProvider(provider);

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome("mesh", [{ peerId: "other" }]));
      await settle();

      // Having an SFU available does not entitle a client to use it: the room
      // is mesh, so the room is mesh for everybody.
      expect(provider).not.toHaveBeenCalled();
      expect(managers[0]?.peerIds).toEqual(["other"]);
      expect(voice.getState().status).toBe("connected");
      expect(voice.getState().usingSfu).toBe(false);
      expect(voice.getState().transportFailure).toBeNull();
    });

    it("declares mesh-only capability when it has no SFU provider", async () => {
      const { transport, sent } = createTransport();
      const voice = createVoiceController(transport);

      await voice.join(CHANNEL);

      expect(sent[0]).toEqual({
        type: "join-voice-room",
        voiceChannelId: CHANNEL,
        transports: ["mesh"],
        resume: true,
      });
    });

    it("declares both transports when it can run either", async () => {
      const { transport, sent } = createTransport();
      const voice = createVoiceController(transport);
      voice.setSessionProvider(async () => sfuSession());

      await voice.join(CHANNEL);

      expect(sent[0]).toMatchObject({ transports: ["mesh", "livekit"] });
    });
  });

  describe("SFU room", () => {
    it("connects to the SFU and reports connected only once media is up", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);
      let release: (() => void) | null = null;
      voice.setSessionProvider(
        () =>
          new Promise((resolve) => {
            release = () => resolve(sfuSession());
          }),
      );

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome("livekit"));
      await settle();

      // The old code said "Voice connected" here and stayed there for the 15s
      // LiveKit takes to give up on a black-holed host, with no audio either way.
      expect(voice.getState().status).toBe("joining");

      release!();
      await settle();

      expect(voice.getState().status).toBe("connected");
      expect(voice.getState().usingSfu).toBe(true);
      // No mesh was built alongside it.
      expect(managers).toHaveLength(0);
    });

    it("leaves the call when the SFU cannot be reached, instead of joining the mesh", async () => {
      const { transport, sent } = createTransport();
      const voice = createVoiceController(transport);
      voice.setSessionProvider(async () => {
        throw new Error("503 Voice backend unavailable");
      });

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome("livekit"));
      await settle();

      const state = voice.getState();
      // THE FIX. Previously: a peer mesh, a roster entry, and total silence.
      expect(managers).toHaveLength(0);
      expect(state.status).toBe("idle");
      expect(state.transportFailure).toEqual({
        transport: "livekit",
        reason: "unreachable",
      });
      expect(state.error).toContain("you have not joined");
      // Nobody is left seeing a participant who is not in the call.
      expect(sent.map((m) => m.type)).toContain("leave-voice-room");
      // And the mic is released, so the recording indicator does not linger.
      expect(stoppedTracks).toContain("mic");
    });

    it("refuses up front when this build cannot run an SFU at all", async () => {
      const { transport, sent } = createTransport();
      const voice = createVoiceController(transport);
      // e.g. VITE_VOICE_BACKEND=mesh, against a server that predates the
      // server-side capability check.

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome("livekit"));
      await settle();

      expect(managers).toHaveLength(0);
      expect(voice.getState().transportFailure).toEqual({
        transport: "livekit",
        reason: "unsupported",
      });
      expect(sent.map((m) => m.type)).toContain("leave-voice-room");
    });

    it("surfaces a server-side refusal as its own outcome, not a generic drop", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);

      await voice.join(CHANNEL);
      voice.handleSignaling({
        type: "voice-transport-unsupported",
        voiceChannelId: CHANNEL,
        transport: "livekit",
      });

      const state = voice.getState();
      expect(state.status).toBe("idle");
      expect(state.transportFailure).toEqual({
        transport: "livekit",
        reason: "unsupported",
      });
      expect(state.voiceChannelId).toBeNull();
      expect(managers).toHaveLength(0);
    });

    it("ignores a refusal aimed at a channel it is not joining", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);

      await voice.join(CHANNEL);
      voice.handleSignaling({
        type: "voice-transport-unsupported",
        voiceChannelId: "00000000-0000-4000-8000-0000000000ff",
        transport: "livekit",
      });

      expect(voice.getState().status).toBe("joining");
      expect(voice.getState().transportFailure).toBeNull();
    });
  });

  describe("server too old to state the transport", () => {
    it("uses mesh, which is what a mesh-only deployment has always done", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);
      // Provider registered, backend probe said mesh — the old behaviour.
      voice.setSessionProvider(async () => sfuSession(), "mesh");

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome(undefined, [{ peerId: "other" }]));
      await settle();

      expect(managers).toHaveLength(1);
      expect(voice.getState().status).toBe("connected");
      expect(connectLiveKit).not.toHaveBeenCalled();
    });

    it("uses the SFU when the backend probe said so", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);
      voice.setSessionProvider(async () => sfuSession(), "livekit");

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome());
      await settle();

      expect(managers).toHaveLength(0);
      expect(voice.getState().usingSfu).toBe(true);
    });
  });
});

describe("lobby presence sounds", () => {
  beforeEach(() => {
    installBrowserStubs();
    managers.length = 0;
    playCueMock.mockReset();
    whenCueSettledMock.mockReset();
    whenCueSettledMock.mockImplementation(async () => {});
  });

  it("plays join as soon as you ask, not after welcome", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    const joining = voice.join(CHANNEL);
    expect(playCueMock).toHaveBeenCalledWith("voiceJoin");
    await joining;
    playCueMock.mockClear();
    voice.handleSignaling(welcome("mesh"));
    await settle();
    expect(playCueMock).not.toHaveBeenCalled();
  });

  it("does not open the mic until the join cue has settled", async () => {
    let releaseCue = () => {};
    const cueGate = new Promise<void>((resolve) => {
      releaseCue = resolve;
    });
    whenCueSettledMock.mockImplementation(() => cueGate);

    const getUserMedia = vi.fn(async () => fakeStream("mic"));
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        getDisplayMedia: async () => fakeCapture("screen", false),
      },
    });

    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    const joining = voice.join(CHANNEL);
    expect(playCueMock).toHaveBeenCalledWith("voiceJoin");
    await Promise.resolve();
    expect(getUserMedia).not.toHaveBeenCalled();
    releaseCue();
    await joining;
    expect(getUserMedia).toHaveBeenCalled();
  });

  it("falls back to the default mic when the saved device is gone, and stops asking for it", async () => {
    // The real failure: a saved `inputDeviceId` outlives the device. Unplug a
    // USB headset and the browser rejects `deviceId: { exact }` with
    // NotFoundError. Joining must still work on the default microphone.
    const notFound = Object.assign(new Error("Requested device not found"), {
      name: "NotFoundError",
    });
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const audio = constraints.audio as MediaTrackConstraints;
      if (audio && audio.deviceId) {
        throw notFound;
      }
      return fakeStream("mic");
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        getSupportedConstraints: () => ({ restrictOwnAudio: true }),
        getDisplayMedia: async () => fakeCapture("screen", false),
      },
    });

    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL, { inputDeviceId: "dead-device-id" });

    // Asked for the dead device, then retried on the default and succeeded.
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(
      (getUserMedia.mock.calls[0][0].audio as MediaTrackConstraints).deviceId,
    ).toEqual({ exact: "dead-device-id" });
    expect(
      (getUserMedia.mock.calls[1][0].audio as MediaTrackConstraints).deviceId,
    ).toBeUndefined();
    expect(voice.getState().status).not.toBe("idle");
    expect(voice.getState().error).toBeFalsy();

    // And the dead id is forgotten, so the next capture does not probe it again.
    getUserMedia.mockClear();
    await voice.leave();
    await voice.join(CHANNEL);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(
      (getUserMedia.mock.calls[0][0].audio as MediaTrackConstraints).deviceId,
    ).toBeUndefined();
  });

  it("tries the default when the saved mic will not start, and says which mic it used", async () => {
    // The QG case of 1 Sep 2026: the device is there, permission is granted,
    // and the OS still refuses it (another app holds it). The person fixed it
    // by picking a different microphone; the join should do that itself.
    const unreadable = Object.assign(new Error("Could not start audio source"), {
      name: "NotReadableError",
    });
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const audio = constraints.audio as MediaTrackConstraints;
      if (audio && audio.deviceId) {
        throw unreadable;
      }
      const stream = fakeStream("mic");
      Object.defineProperty(stream.getAudioTracks()[0]!, "label", {
        value: "MacBook Pro Microphone",
      });
      return stream;
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices: async () => [],
        getSupportedConstraints: () => ({ restrictOwnAudio: true }),
        getDisplayMedia: async () => fakeCapture("screen", false),
      },
    });

    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL, { inputDeviceId: "busy-headset" });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(voice.getState().status).not.toBe("idle");
    expect(voice.getState().error).toBeNull();
    expect(voice.getState().notice).toContain("MacBook Pro Microphone");
  });

  it("walks the other microphones when the default will not start either", async () => {
    const unreadable = Object.assign(new Error("Could not start audio source"), {
      name: "NotReadableError",
    });
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const audio = constraints.audio as MediaTrackConstraints;
      const exact = (audio?.deviceId as { exact?: string } | undefined)?.exact;
      if (exact === "usb-interface") {
        return fakeStream("mic");
      }
      throw unreadable;
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "busy-headset", label: "Headset" },
          { kind: "audioinput", deviceId: "usb-interface", label: "USB Audio" },
          { kind: "audiooutput", deviceId: "speakers", label: "Speakers" },
        ],
        getSupportedConstraints: () => ({ restrictOwnAudio: true }),
        getDisplayMedia: async () => fakeCapture("screen", false),
      },
    });

    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL, { inputDeviceId: "busy-headset" });

    // Chosen, default, then the one other input: never the chosen one twice.
    const asked = getUserMedia.mock.calls.map(
      (call) =>
        ((call[0].audio as MediaTrackConstraints).deviceId as
          | { exact: string }
          | undefined)?.exact ?? "default",
    );
    expect(asked).toEqual(["busy-headset", "default", "usb-interface"]);
    expect(voice.getState().status).not.toBe("idle");
    expect(voice.getState().error).toBeNull();
    expect(voice.getState().notice).toBeTruthy();
  });

  it("names the fix when no microphone will start, and marks the error as a mic error", async () => {
    const unreadable = Object.assign(new Error("Could not start audio source"), {
      name: "NotReadableError",
    });
    const getUserMedia = vi.fn(async () => {
      throw unreadable;
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "a", label: "A" },
          { kind: "audioinput", deviceId: "b", label: "B" },
        ],
        getSupportedConstraints: () => ({ restrictOwnAudio: true }),
        getDisplayMedia: async () => fakeCapture("screen", false),
      },
    });

    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);

    expect(voice.getState().status).toBe("idle");
    expect(voice.getState().errorKind).toBe("mic");
    // Not the browser's "Could not start audio source": the fix, in our words.
    expect(voice.getState().error).toMatch(/microphone/i);
    expect(voice.getState().error).not.toMatch(/audio source/);
  });

  it("does not retry after a permission refusal", async () => {
    const refused = Object.assign(new Error("Permission denied"), {
      name: "NotAllowedError",
    });
    const getUserMedia = vi.fn(async () => {
      throw refused;
    });
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "a", label: "A" },
        ],
        getSupportedConstraints: () => ({ restrictOwnAudio: true }),
        getDisplayMedia: async () => fakeCapture("screen", false),
      },
    });

    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL, { inputDeviceId: "a" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(voice.getState().errorKind).toBe("mic");
  });

  it("plays join when someone else enters the lobby, leave when they go", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("mesh"));
    await settle();
    playCueMock.mockClear();

    const other = {
      peerId: "00000000-0000-4000-8000-0000000000dd",
      userId: "00000000-0000-4000-8000-0000000000ee",
      displayName: "Ana",
      avatarUrl: null,
      sharingScreen: false,
      muted: false,
      deafened: false,
    };
    voice.handleSignaling({ type: "peer-joined", peer: other } as never);
    expect(playCueMock).toHaveBeenCalledWith("voiceJoin");
    playCueMock.mockClear();
    voice.handleSignaling({
      type: "peer-left",
      peerId: other.peerId,
    } as never);
    expect(playCueMock).toHaveBeenCalledWith("voiceLeave");
  });

  it("renames a peer in place, with no join cue and no new connection", async () => {
    // The bug this pins: a nickname or a profile rename reached every surface
    // except the call, because the label is copied onto the peer at join.
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    // The mesh only exists once the room has welcomed us, and the mesh is
    // what holds a tile's label.
    voice.handleSignaling(welcome("mesh"));
    await settle();
    const other = {
      peerId: "peer-2",
      userId: "22222222-2222-4222-8222-222222222222",
      displayName: "Rafael Cammarano",
      avatarUrl: null,
      sharingScreen: false,
      muted: false,
      deafened: false,
    };
    voice.handleSignaling({ type: "peer-joined", peer: other } as never);
    playCueMock.mockClear();

    voice.handleSignaling({
      type: "peer-updated",
      peer: { ...other, displayName: "Qriox", avatarUrl: "https://x.test/a.png" },
    } as never);

    // The mesh holds the label for the tile, so that is where the rename
    // has to land (`remotePeers` itself is the manager's own state, stubbed
    // out here).
    const manager = managers.at(-1)!;
    expect(manager.identities).toContainEqual([
      "peer-2",
      expect.objectContaining({
        displayName: "Qriox",
        avatarUrl: "https://x.test/a.png",
      }),
    ]);
    // Nobody walked in, so nobody hears anybody walk in.
    expect(playCueMock).not.toHaveBeenCalledWith("voiceJoin");
  });

  it("plays leave when you hang up", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("mesh"));
    await settle();
    playCueMock.mockClear();
    voice.leave();
    expect(playCueMock).toHaveBeenCalledWith("voiceLeave");
  });

  it("plays leave then join immediately when you switch rooms", async () => {
    const other = "00000000-0000-4000-8000-0000000000ee";
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("mesh"));
    await settle();
    playCueMock.mockClear();
    const switching = voice.join(other);
    expect(playCueMock.mock.calls.map((call) => call[0])).toEqual([
      "voiceLeave",
      "voiceJoin",
    ]);
    await switching;
  });
});

describe("voice session resume", () => {
  beforeEach(() => {
    installBrowserStubs();
    managers.length = 0;
    stoppedTracks.length = 0;
    playCueMock.mockReset();
    beaconVoiceLeaveMock.mockReset();
  });

  const OTHER = "00000000-0000-4000-8000-0000000000dd";
  const TOKEN = "resume-token-1";

  function resumedWelcome(
    extra?: Partial<{ transport: "mesh" | "livekit"; peerId: string }>,
  ): Extract<VoiceSignalingMessage, { type: "welcome" }> {
    const peerId = extra?.peerId ?? PEER;
    return {
      ...welcome(extra?.transport ?? "mesh"),
      peerId,
      self: {
        peerId,
        userId: "00000000-0000-4000-8000-0000000000cc",
        displayName: "Me",
        avatarUrl: null,
        sharingScreen: false,
        muted: false,
        deafened: false,
      },
      resumed: true,
      resumeToken: TOKEN,
    };
  }

  async function connected(): Promise<{
    voice: ReturnType<typeof createVoiceController>;
    sent: { type: string; [key: string]: unknown }[];
    transport: ReturnType<typeof createTransport>["transport"];
  }> {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling({
      ...welcome("mesh", [{ peerId: OTHER }]),
      resumeToken: TOKEN,
    });
    await settle();
    return { voice, sent, transport };
  }

  it("holds the mesh across a disconnect and accepts a resumed welcome while connected", async () => {
    const { voice, sent } = await connected();
    expect(managers).toHaveLength(1);
    expect(managers[0]?.disposed).toBe(false);

    sent.length = 0;
    voice.notifyDisconnected();
    expect(voice.getState().status).toBe("connected");
    expect(managers[0]?.disposed).toBe(false);

    voice.handleSignaling(resumedWelcome());
    await settle();

    expect(sent.map((m) => m.type)).not.toContain("leave-voice-room");
    expect(managers).toHaveLength(1);
    expect(managers[0]?.disposed).toBe(false);
    expect(voice.getState().status).toBe("connected");
    expect(voice.getState().peerId).toBe(PEER);
  });

  it("sends resumePeerId on reconnect before any other voice frame", async () => {
    const { voice, sent } = await connected();
    voice.notifyDisconnected();
    sent.length = 0;
    await voice.notifyReconnected();

    expect(sent[0]).toMatchObject({
      type: "join-voice-room",
      voiceChannelId: CHANNEL,
      resume: true,
      resumePeerId: PEER,
      resumeToken: TOKEN,
    });
  });

  it("does not wipe known peers when a roster arrives while holding", async () => {
    const { voice } = await connected();
    playCueMock.mockClear();
    voice.notifyDisconnected();
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      participants: [],
    });
    voice.handleSignaling({
      type: "peer-joined",
      peer: {
        peerId: OTHER,
        userId: "00000000-0000-4000-8000-0000000000ee",
        displayName: "Other",
        avatarUrl: null,
        sharingScreen: false,
        muted: false,
        deafened: false,
      },
    });
    expect(playCueMock).not.toHaveBeenCalled();
    expect(managers[0]?.peerIds).toEqual([OTHER]);
  });

  it("does not play join twice for a duplicate peer-joined", async () => {
    const { voice } = await connected();
    playCueMock.mockClear();
    voice.handleSignaling({
      type: "peer-joined",
      peer: {
        peerId: OTHER,
        userId: "00000000-0000-4000-8000-0000000000ee",
        displayName: "Other",
        avatarUrl: null,
        sharingScreen: false,
        muted: false,
        deafened: false,
      },
    });
    expect(playCueMock).not.toHaveBeenCalled();
    expect(managers[0]?.peerIds).toEqual([OTHER]);
  });

  it("rebuilds when welcome assigns a new peer id", async () => {
    const { voice } = await connected();
    const first = managers[0]!;
    voice.notifyDisconnected();
    const newId = "00000000-0000-4000-8000-0000000000ff";
    voice.handleSignaling({
      ...welcome("mesh"),
      peerId: newId,
      self: {
        peerId: newId,
        userId: "00000000-0000-4000-8000-0000000000cc",
        displayName: "Me",
        avatarUrl: null,
        sharingScreen: false,
        muted: false,
        deafened: false,
      },
    });
    await settle();
    expect(first.disposed).toBe(true);
    expect(managers).toHaveLength(2);
    expect(voice.getState().peerId).toBe(newId);
  });

  it("rebuilds when the resumed welcome names a different transport", async () => {
    const { voice } = await connected();
    const first = managers[0]!;
    voice.setSessionProvider(async () => sfuSession());
    voice.notifyDisconnected();
    voice.handleSignaling(resumedWelcome({ transport: "livekit" }));
    await settle();
    expect(first.disposed).toBe(true);
    expect(voice.getState().usingSfu).toBe(true);
  });

  it("drops a failed ghost PC after resume when the roster no longer lists them", async () => {
    const { voice } = await connected();
    const mesh = managers[0]!;
    expect(mesh.peerIds).toEqual([OTHER]);

    voice.notifyDisconnected();
    voice.handleSignaling(resumedWelcome());
    await settle();
    expect(mesh.disposed).toBe(false);
    expect(mesh.peerIds).toEqual([OTHER]);

    mesh.emitState?.([
      {
        peerId: OTHER,
        connectionState: "failed",
        stream: null,
        screenStream: null,
        cameraStream: null,
        screenAudioStream: null,
      },
    ]);
    // Still in the allowlist until an authoritative roster arrives: they may
    // be reconstructing inside the orphan window.
    expect(mesh.removedPeerIds).toEqual([]);

    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      participants: [],
    });
    expect(mesh.removedPeerIds).toEqual([OTHER]);
    expect(mesh.peerIds).toEqual([]);
  });

  it("hangs up held media when auth is gone for good", async () => {
    const { voice } = await connected();
    voice.notifyDisconnected();
    expect(managers[0]?.disposed).toBe(false);
    voice.notifyAuthLost();
    expect(voice.getState().status).toBe("idle");
    expect(managers[0]?.disposed).toBe(true);
  });

  it("sends leave-voice-room on pagehide so a closed tab is not an orphan", async () => {
    const { sent } = await connected();
    sent.length = 0;
    beaconVoiceLeaveMock.mockClear();
    (globalThis as unknown as { window: { dispatchEvent: (e: { type: string }) => void } }).window.dispatchEvent(
      { type: "pagehide" },
    );
    expect(sent).toContainEqual({
      type: "leave-voice-room",
      resumePeerId: PEER,
      resumeToken: TOKEN,
    });
    expect(beaconVoiceLeaveMock).toHaveBeenCalledWith({
      resumePeerId: PEER,
      resumeToken: TOKEN,
    });
  });

  it("connects mesh peers that arrived during the outage", async () => {
    const arrived = "00000000-0000-4000-8000-0000000000ee";
    const { voice } = await connected();
    expect(managers[0]?.peerIds).toEqual([OTHER]);

    voice.notifyDisconnected();
    voice.handleSignaling({
      ...resumedWelcome(),
      peers: [
        {
          peerId: OTHER,
          userId: "00000000-0000-4000-8000-0000000000dd",
          displayName: "Other",
          avatarUrl: null,
          sharingScreen: false,
          muted: false,
          deafened: false,
        },
        {
          peerId: arrived,
          userId: "00000000-0000-4000-8000-0000000000ee",
          displayName: "Arrived",
          avatarUrl: null,
          sharingScreen: false,
          muted: false,
          deafened: false,
        },
      ],
    });
    await settle();

    expect(managers).toHaveLength(1);
    expect(managers[0]?.disposed).toBe(false);
    expect(managers[0]?.peerIds).toEqual([OTHER, arrived]);
  });

  it("tears down held media when the room is full", async () => {
    const { voice, sent } = await connected();
    voice.notifyDisconnected();
    sent.length = 0;
    voice.handleSignaling({
      type: "voice-room-full",
      voiceChannelId: CHANNEL,
      limit: 8,
    });
    expect(managers[0]?.disposed).toBe(true);
    expect(voice.getState().status).toBe("idle");
    expect(sent[0]).toMatchObject({
      type: "leave-voice-room",
      resumePeerId: PEER,
      resumeToken: TOKEN,
    });
  });

  it("cold-rejoins after the grace window instead of hanging up", async () => {
    const { voice, sent, transport } = await connected();
    transport.isConnected = () => false;
    vi.useFakeTimers();
    try {
      voice.notifyDisconnected();
      expect(voice.getState().status).toBe("connected");
      await vi.advanceTimersByTimeAsync(90_000);
      expect(voice.getState().status).toBe("joining");
      expect(voice.getState().voiceChannelId).toBe(CHANNEL);
      expect(managers[0]?.disposed).toBe(true);
      sent.length = 0;
      await voice.notifyReconnected();
      expect(sent[0]).toMatchObject({
        type: "join-voice-room",
        voiceChannelId: CHANNEL,
        resume: true,
      });
      expect(sent[0]).not.toHaveProperty("resumePeerId");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cold-joins when the grace window ends on a live socket", async () => {
    const { voice, sent } = await connected();
    vi.useFakeTimers();
    try {
      voice.notifyDisconnected();
      sent.length = 0;
      await voice.notifyReconnected();
      expect(sent[0]).toMatchObject({
        type: "join-voice-room",
        resumePeerId: PEER,
        resumeToken: TOKEN,
      });
      sent.length = 0;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(voice.getState().status).toBe("joining");
      expect(managers[0]?.disposed).toBe(true);
      expect(sent[0]).toMatchObject({
        type: "join-voice-room",
        voiceChannelId: CHANNEL,
        resume: true,
      });
      expect(sent[0]).not.toHaveProperty("resumePeerId");
    } finally {
      vi.useRealTimers();
    }
  });

  it("beacons leave when hanging up while the socket is down", async () => {
    const { voice, transport } = await connected();
    transport.isConnected = () => false;
    beaconVoiceLeaveMock.mockClear();
    voice.leave();
    expect(beaconVoiceLeaveMock).toHaveBeenCalledWith({
      resumePeerId: PEER,
      resumeToken: TOKEN,
    });
  });

  it("does not beacon leave when the socket can carry leave-voice-room", async () => {
    const { voice } = await connected();
    beaconVoiceLeaveMock.mockClear();
    voice.leave();
    expect(beaconVoiceLeaveMock).not.toHaveBeenCalled();
  });

  it("hangs up on voice-join-refused", async () => {
    const { voice } = await connected();
    voice.handleSignaling({
      type: "voice-join-refused",
      voiceChannelId: CHANNEL,
    });
    expect(voice.getState().status).toBe("idle");
    expect(managers[0]?.disposed).toBe(true);
  });
});
