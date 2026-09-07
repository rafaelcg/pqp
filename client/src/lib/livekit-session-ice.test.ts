import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceSessionInfo } from "@pqp/shared";

/**
 * Which ICE servers the SFU connection is given.
 *
 * WHY THIS FILE EXISTS. Until 8 Sep 2026 the web client connected to LiveKit
 * with no `rtcConfig` at all, so both of its peer connections took the relay
 * list from the LiveKit server's join response: the media box's own
 * `turn:216.238.114.79:3478` and a `turns:turn.pqp.gg:443` that Caddy answers
 * instead of the relay. The list the app fetched from `/api/ice-servers`
 * (Cloudflare TURN, 24 h credentials) only ever reached the mesh path. Users on
 * UDP-blocked networks could not join a large room, and relayed viewers cost the
 * media box a second packet pass, all while everything looked configured.
 *
 * The doubles capture the arguments of `Room.connect`, because in livekit-client
 * 2.21.0 that is where `rtcConfig` is honoured (`RoomConnectOptions`, copied
 * onto the engine in `Room.connect`); a Room-constructor option would be
 * ignored silently, which is the failure shape this repository keeps meeting.
 */

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

const Track = {
  Kind: { Video: "video", Audio: "audio" },
  Source: {
    Camera: "camera",
    ScreenShare: "screen_share",
    ScreenShareAudio: "screen_share_audio",
    Microphone: "microphone",
  },
};

/** Every `Room.connect(url, token, options)` call, in order. */
const connects: unknown[][] = [];

class FakeRoom {
  state = "connected";
  remoteParticipants = new Map<string, unknown>();
  localParticipant = {
    publishTrack: async () => {},
    unpublishTrack: async () => {},
    getTrackPublication: () => undefined,
  };
  on() {
    return this;
  }
  async connect(...args: unknown[]) {
    connects.push(args);
  }
  async disconnect() {}
}

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent,
  Track,
  LocalAudioTrack: class {},
  ConnectionState: { Disconnected: "disconnected", Connected: "connected" },
  VideoPreset: class {},
  VideoQuality: { LOW: 0, MEDIUM: 1, HIGH: 2 },
}));

const { connectLiveKit } = await import("./livekit-session");

const session: VoiceSessionInfo = {
  backend: "livekit",
  url: "wss://sfu.example",
  token: "jwt",
  room: "room-1",
  identity: "peer-self",
} as VoiceSessionInfo;

const STUN = { urls: "stun:stun.l.google.com:19302" };
const CLOUDFLARE = {
  urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349"],
  username: "cf-user",
  credential: "cf-pass",
};

async function connectWith(iceServers?: RTCIceServer[]) {
  await connectLiveKit({
    session,
    iceServers,
    lookupIdentity: () => undefined,
    onPeersChanged: () => {},
    onError: () => {},
  });
  return connects.at(-1) as [string, string, { rtcConfig?: RTCConfiguration } | undefined];
}

describe("connectLiveKit ICE servers", () => {
  beforeEach(() => {
    connects.length = 0;
  });

  it("hands the stored list to Room.connect when it carries a relay", async () => {
    const [url, token, options] = await connectWith([STUN, CLOUDFLARE]);
    expect(url).toBe(session.url);
    expect(token).toBe(session.token);
    expect(options?.rtcConfig?.iceServers).toEqual([STUN, CLOUDFLARE]);
  });

  it("leaves iceTransportPolicy alone", async () => {
    const [, , options] = await connectWith([CLOUDFLARE]);
    expect(options?.rtcConfig?.iceServers).toEqual([CLOUDFLARE]);
    expect(options?.rtcConfig?.iceTransportPolicy).toBeUndefined();
  });

  it("passes no iceServers key for a STUN-only list, so the SDK keeps the server's relays", async () => {
    const [, , options] = await connectWith([STUN]);
    expect(options?.rtcConfig?.iceServers).toBeUndefined();
  });

  it("passes no iceServers key for an empty or absent list", async () => {
    let [, , options] = await connectWith([]);
    expect(options?.rtcConfig?.iceServers).toBeUndefined();
    [, , options] = await connectWith(undefined);
    expect(options?.rtcConfig?.iceServers).toBeUndefined();
  });
});
