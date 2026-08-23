import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * Push-to-talk, at the level where it can actually be wrong.
 *
 * Three properties are being defended here, in descending order of how badly
 * they hurt when they break:
 *
 * 1. **The mic cannot be left open.** Every path back out of a press —
 *    releasing, changing mode, muting, deafening, leaving — closes it, on both
 *    transports. A hot mic is the failure people cannot recover from because
 *    they do not know it is happening.
 * 2. **Switching mode mid-call does not disturb the call.** No new
 *    `getUserMedia`, no `replaceTrack`, no peer teardown — otherwise a setting
 *    people are told to try becomes a setting that drops them from the room.
 * 3. **Mesh and LiveKit mute the same way.** The mesh gate is `track.enabled`;
 *    LiveKit needs `setMuted` on top, and forgetting the second one is silent
 *    from the sender's side.
 */

interface ManagerStub {
  disposed: boolean;
  replacedTracks: number;
}

const managers: ManagerStub[] = [];

vi.mock("@/lib/peer-connection-manager", () => ({
  getDefaultIceServers: () => [],
  createPeerConnectionManager: vi.fn(() => {
    const stub: ManagerStub = { disposed: false, replacedTracks: 0 };
    managers.push(stub);
    return {
      setLocalStream: () => {},
      setLocalScreenStream: async () => {},
      setLocalCameraStream: async () => {},
      setCameraMaxBitrate: () => {},
      setPeerCameraStreamId: () => {},
      onPeerStateChange: () => {},
      connectToPeer: () => {},
      removePeer: () => {},
      handleOffer: async () => {},
      handleAnswer: async () => {},
      handleIceCandidate: async () => {},
      retryPeer: async () => {},
      replaceLocalTrack: async () => {
        stub.replacedTracks++;
      },
      setIceServers: () => {},
      dispose: () => {
        stub.disposed = true;
      },
    };
  }),
}));

/** Every `setMuted` LiveKit was told, in order. */
const sfuMuteLog: boolean[] = [];
let sfuReplacedTracks = 0;

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({
    publish: async () => {},
    replaceTrack: async () => {
      sfuReplacedTracks++;
    },
    setMuted: async (muted: boolean) => {
      sfuMuteLog.push(muted);
    },
    publishScreen: async () => {},
    unpublishScreen: async () => {},
    publishCamera: async () => {},
    setCameraMaxBitrate: async () => {},
    unpublishCamera: async () => {},
    disconnect: async () => {},
  })),
}));

const { createVoiceController } = await import("./use-voice");

// ------------------------------------------------------------------ browser

/** Every audio track handed out, so "is the mic open" is directly observable. */
const tracks: { enabled: boolean; stopped: boolean }[] = [];
/** Constraints of every `getUserMedia` call, newest last. */
const captureRequests: MediaTrackConstraints[] = [];

function fakeTrack() {
  // `stop()` does not clear `enabled` on a real MediaStreamTrack — it ends the
  // track, which is a stronger guarantee. Modelling both means "is anything
  // still being transmitted" is one question rather than two.
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      track.stopped = true;
    },
  };
  tracks.push(track);
  return track;
}

function fakeStream() {
  const list = [fakeTrack()];
  return { getTracks: () => list, getAudioTracks: () => list };
}

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        captureRequests.push(constraints.audio as MediaTrackConstraints);
        return fakeStream();
      },
    },
  });
  g.AudioContext = class {
    // Closing a real AudioContext ends the tracks its destination node was
    // feeding. Modelled, because otherwise the processed track this suite
    // watches would look live forever after `leave()` tore the pipeline down.
    private destinations: { getTracks: () => { stop: () => void }[] }[] = [];
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
      const stream = fakeStream();
      this.destinations.push(stream);
      return { stream };
    }
    close() {
      for (const stream of this.destinations) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
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
    onStatusChange: () => {},
    getStatus: () => "online",
    isConnected: () => true,
  };
  return { transport, sent };
}

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000bb";

function welcome(roomTransport: "mesh" | "livekit"): VoiceSignalingMessage {
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
    voiceChannelId: CHANNEL,
    self,
    peers: [],
    transport: roomTransport,
  };
}

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

/** A connected call on the requested transport. */
async function connected(roomTransport: "mesh" | "livekit") {
  const { transport, sent } = createTransport();
  const voice = createVoiceController(transport);
  if (roomTransport === "livekit") {
    voice.setSessionProvider(async () => sfuSession());
  }
  await voice.join(CHANNEL, { inputMode: "push-to-talk" });
  voice.handleSignaling(welcome(roomTransport));
  await settle();
  expect(voice.getState().status).toBe("connected");
  return { voice, sent };
}

/** Is any audio actually able to leave this machine? */
const anyTrackOpen = () =>
  tracks.some((track) => track.enabled && !track.stopped);

beforeEach(() => {
  installBrowserStubs();
  managers.length = 0;
  tracks.length = 0;
  captureRequests.length = 0;
  sfuMuteLog.length = 0;
  sfuReplacedTracks = 0;
});

describe("push-to-talk on the mesh", () => {
  it("joins with the mic closed and opens it only while held", async () => {
    const { voice } = await connected("mesh");

    // Joining in push-to-talk is joining silent. Nobody has pressed anything.
    expect(voice.getState().isTransmitting).toBe(false);
    expect(anyTrackOpen()).toBe(false);
    // And not by way of the mute button — mute is still the user's own switch.
    expect(voice.getState().isMuted).toBe(false);

    voice.setPushToTalkActive(true);
    expect(voice.getState().isTransmitting).toBe(true);
    expect(anyTrackOpen()).toBe(true);

    voice.setPushToTalkActive(false);
    expect(voice.getState().isTransmitting).toBe(false);
    expect(anyTrackOpen()).toBe(false);
  });

  it("releasing always returns to closed, however many times it is called", async () => {
    const { voice } = await connected("mesh");
    voice.setPushToTalkActive(true);

    voice.setPushToTalkActive(false);
    voice.setPushToTalkActive(false);
    voice.setPushToTalkActive(false);

    expect(voice.getState().isTransmitting).toBe(false);
    expect(anyTrackOpen()).toBe(false);
  });

  it("closes the mic when the mode changes with the key still down", async () => {
    const { voice } = await connected("mesh");
    voice.setPushToTalkActive(true);
    expect(anyTrackOpen()).toBe(true);

    // Alt-tab away, change the setting, come back: the keyup for that press is
    // owed to a listener that no longer exists. It must not be waited for.
    voice.setInputMode("voice-activity");
    voice.setInputMode("push-to-talk");

    expect(voice.getState().isTransmitting).toBe(false);
    expect(anyTrackOpen()).toBe(false);
  });

  it("refuses to open the mic while muted or deafened", async () => {
    const { voice } = await connected("mesh");

    voice.toggleMute();
    voice.setPushToTalkActive(true);
    expect(voice.getState().isTransmitting).toBe(false);
    expect(anyTrackOpen()).toBe(false);

    // Unmuting mid-press does hand the key back its authority — which is right:
    // the key is still down, and that is what the user is asking for.
    voice.toggleMute();
    expect(voice.getState().isTransmitting).toBe(true);

    // Deafen outranks it the same way, and un-deafening does not resurrect a
    // press, because deafen clears the hold along with everything else.
    voice.toggleDeafen();
    expect(voice.getState().isTransmitting).toBe(false);
    expect(anyTrackOpen()).toBe(false);
  });

  it("cannot be opened by a stray press in voice-activity mode", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("mesh"));
    await settle();

    // A listener that has not been torn down yet must not be able to *close* a
    // voice-activity mic either.
    voice.setPushToTalkActive(false);
    expect(voice.getState().isTransmitting).toBe(true);
    voice.setPushToTalkActive(true);
    expect(voice.getState().isTransmitting).toBe(true);
  });

  it("leaves with the mic closed even if the key was down", async () => {
    const { voice } = await connected("mesh");
    voice.setPushToTalkActive(true);

    voice.leave();

    expect(voice.getState().isTransmitting).toBe(false);
    expect(anyTrackOpen()).toBe(false);
    // The mode is a preference and survives; the press does not.
    expect(voice.getState().inputMode).toBe("push-to-talk");
  });
});

describe("push-to-talk on LiveKit", () => {
  it("publishes muted and toggles the publication with the key", async () => {
    const { voice } = await connected("livekit");

    // `track.enabled` alone would leave LiveKit's own publication unmuted, so
    // the SFU would keep relaying (silent) audio and light this participant's
    // speaking indicator for the whole room.
    expect(sfuMuteLog.at(-1)).toBe(true);
    expect(anyTrackOpen()).toBe(false);

    voice.setPushToTalkActive(true);
    expect(sfuMuteLog.at(-1)).toBe(false);
    expect(anyTrackOpen()).toBe(true);

    voice.setPushToTalkActive(false);
    expect(sfuMuteLog.at(-1)).toBe(true);
    expect(anyTrackOpen()).toBe(false);
  });

  it("mutes the publication when the mode changes mid-press", async () => {
    const { voice } = await connected("livekit");
    voice.setPushToTalkActive(true);
    expect(sfuMuteLog.at(-1)).toBe(false);

    voice.setInputMode("voice-activity");

    // Voice activity with nothing muted: the mic is open again, deliberately.
    expect(sfuMuteLog.at(-1)).toBe(false);
    expect(voice.getState().isTransmitting).toBe(true);

    voice.setInputMode("push-to-talk");
    expect(sfuMuteLog.at(-1)).toBe(true);
    expect(voice.getState().isTransmitting).toBe(false);
  });
});

describe("switching input mode mid-call", () => {
  it("does not drop the mesh, re-open the mic, or renegotiate", async () => {
    const { voice, sent } = await connected("mesh");
    const capturesBefore = captureRequests.length;

    voice.setInputMode("voice-activity");
    voice.setInputMode("push-to-talk");
    await settle();

    expect(managers).toHaveLength(1);
    expect(managers[0]?.disposed).toBe(false);
    // The whole design: the gate is `track.enabled`, so no new capture and no
    // `replaceTrack` — nothing that would make a peer see us leave.
    expect(captureRequests).toHaveLength(capturesBefore);
    expect(managers[0]?.replacedTracks).toBe(0);
    expect(sent.map((m) => m.type)).not.toContain("leave-voice-room");
    expect(voice.getState().status).toBe("connected");
  });

  it("does not drop the SFU session either", async () => {
    const { voice, sent } = await connected("livekit");
    const capturesBefore = captureRequests.length;

    voice.setInputMode("voice-activity");
    voice.setInputMode("push-to-talk");
    await settle();

    expect(captureRequests).toHaveLength(capturesBefore);
    expect(sfuReplacedTracks).toBe(0);
    expect(sent.map((m) => m.type)).not.toContain("leave-voice-room");
    expect(voice.getState().status).toBe("connected");
    expect(voice.getState().usingSfu).toBe(true);
  });
});

describe("microphone processing", () => {
  it("asks for the flags explicitly even on the default device", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL, {
      processing: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });

    // `audio: true` would have silently restored the browser's defaults, which
    // is what used to happen to anyone on the system default device.
    expect(captureRequests.at(-1)).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    });
  });

  it("swaps the track into the live call rather than rejoining", async () => {
    const { voice, sent } = await connected("mesh");
    const capturesBefore = captureRequests.length;

    await voice.setMicProcessing({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });

    // One new capture (the constraints genuinely changed), swapped into the
    // existing sender — no teardown, no renegotiation, nobody dropped.
    expect(captureRequests).toHaveLength(capturesBefore + 1);
    expect(captureRequests.at(-1)).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(managers[0]?.replacedTracks).toBe(1);
    expect(managers[0]?.disposed).toBe(false);
    expect(sent.map((m) => m.type)).not.toContain("leave-voice-room");
    expect(voice.getState().status).toBe("connected");
  });

  it("does nothing at all when the flags have not changed", async () => {
    const { voice } = await connected("mesh");
    const capturesBefore = captureRequests.length;

    await voice.setMicProcessing({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });

    expect(captureRequests).toHaveLength(capturesBefore);
    expect(managers[0]?.replacedTracks).toBe(0);
  });

  it("keeps the mic closed across the swap when push-to-talk is idle", async () => {
    const { voice } = await connected("mesh");
    expect(voice.getState().isTransmitting).toBe(false);

    await voice.setMicProcessing({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    });

    // A freshly captured track arrives `enabled: true`. Re-applying the gate is
    // what stops a settings change from being a way to start transmitting.
    expect(voice.getState().isTransmitting).toBe(false);
    expect(anyTrackOpen()).toBe(false);
  });
});
