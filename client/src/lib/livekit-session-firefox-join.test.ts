import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";

/**
 * Firefox regression: `ParticipantConnected` fired synchronously.
 *
 * QA on main hit `ReferenceError: can't access lexical declaration
 * 'reconciling' before initialization` joining a LiveKit room in Firefox,
 * only in Firefox. `connectLiveKit` registers `room.on(RoomEvent
 * .ParticipantConnected, ...)` and then `await room.connect(...)`; the
 * handler calls `reconcileScreenPlan`, which closes over `let reconciling`
 * declared much later in the same function body. Chromium's LiveKit
 * transport never emits `ParticipantConnected` before `connect()`'s promise
 * settles, so the declaration always runs first there; Firefox's does, which
 * put the read inside `reconciling`'s temporal dead zone.
 *
 * This fake `Room.connect` reproduces exactly that ordering: it fires
 * `ParticipantConnected` synchronously, before its own promise resolves.
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

class FakeFirefoxRoom {
  remoteParticipants = new Map<string, { identity: string }>();
  handlers = new Map<string, (...args: unknown[]) => void>();
  localParticipant = {
    publishTrack: async () => {},
    unpublishTrack: async () => {},
    getTrackPublication: () => undefined,
  };
  constructor(public options: Record<string, unknown>) {}
  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }
  /**
   * Firefox-shaped: a peer already in the room is announced synchronously,
   * inside `connect()`, before the connect promise resolves. This is the
   * exact ordering that put `reconciling` in its TDZ on the old code.
   */
  async connect() {
    const participant = { identity: "already-here" };
    this.remoteParticipants.set(participant.identity, participant);
    this.handlers.get(RoomEvent.ParticipantConnected)?.(participant);
  }
  async disconnect() {}
}

vi.mock("livekit-client", () => {
  class LocalAudioTrack {
    constructor(public track: unknown) {}
    async mute() {}
    async unmute() {}
  }
  return {
    Room: FakeFirefoxRoom,
    RoomEvent,
    ConnectionQuality: {
      Excellent: "excellent",
      Good: "good",
      Poor: "poor",
      Lost: "lost",
      Unknown: "unknown",
    },
    Track,
    LocalAudioTrack,
    ConnectionState: { Disconnected: "disconnected" },
    VideoPreset: class {
      constructor(
        public width: number,
        public height: number,
        public maxBitrate: number,
        public maxFramerate?: number,
      ) {}
    },
    VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
  };
});

const { connectLiveKit } = await import("./livekit-session");

const SESSION: VoiceSessionInfo = {
  backend: "livekit",
  url: "ws://sfu",
  token: "t",
  room: "room",
  identity: "peer",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("joining in Firefox, where the SFU announces existing peers mid-connect", () => {
  it("does not throw on a ParticipantConnected fired before connect() resolves", async () => {
    await expect(
      connectLiveKit({
        session: SESSION,
        lookupIdentity: () => undefined,
        onPeersChanged: () => {},
        onError: () => {},
      }),
    ).resolves.toBeDefined();
  });
});
