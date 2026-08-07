import {
  MESH_VOICE_WARNING,
  type ClientRelayMessage,
  type VoiceParticipant,
  type VoiceRoomTransport,
  type VoiceSessionInfo,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import {
  screenShareUnavailableMessage,
  supportsScreenShare,
} from "@/components/voice/capabilities";
import { buildAudioConstraints } from "@/lib/audio-devices";
import {
  connectLiveKit,
  type LiveKitIdentity,
  type LiveKitSession,
} from "@/lib/livekit-session";
import {
  createPeerConnectionManager,
  getDefaultIceServers,
  type PeerConnectionState,
  type RemotePeer,
} from "@/lib/peer-connection-manager";
import type { RealtimeTransport } from "@/lib/realtime";
import {
  createSpeakingTracker,
  createStreamAnalyser,
  readAnalyserLevel,
} from "@/lib/voice-audio";

export type VoiceStatus = "idle" | "joining" | "connected";

/** One wording for "this browser cannot capture a screen", shared with the UI. */
const SCREEN_SHARE_UNSUPPORTED_MESSAGE =
  screenShareUnavailableMessage("no-api");

/**
 * Why a join was refused because of the room's transport.
 *
 * - `unsupported` — this build cannot run the transport at all (mesh-forced
 *   build, or no way to obtain an SFU session). The server refused the join
 *   before creating a peer, so nobody saw us arrive.
 * - `unreachable` — we can run it in principle but could not establish it:
 *   token request failed, or the SFU is not reachable from this network.
 *
 * Either way the user is **not** in the call and is told so. There is
 * deliberately no third option where we join on the other transport instead;
 * that is the partition this type exists to prevent.
 */
export interface VoiceTransportFailure {
  transport: VoiceRoomTransport;
  reason: "unsupported" | "unreachable";
}

const TRANSPORT_FAILURE_MESSAGE: Record<
  VoiceTransportFailure["reason"],
  string
> = {
  unsupported:
    "This call runs on a voice server this app build cannot use, so you have not joined it. Nobody in the call can hear you.",
  unreachable:
    "Could not reach the voice server, so you have not joined this call. Check your network and try again.",
};

export interface VoiceAudioOptions {
  inputDeviceId?: string;
  inputVolume?: number;
  /**
   * Join with the microphone already off. Applied before the track is published
   * so "mute on join" is muted from the very first sample.
   */
  startMuted?: boolean;
}

export interface VoiceState {
  status: VoiceStatus;
  peerId: string | null;
  remotePeers: RemotePeer[];
  isMuted: boolean;
  /** Deafened silences everyone else and forces your own mic off, as in Discord. */
  isDeafened: boolean;
  error: string | null;
  voiceChannelId: string | null;
  self: VoiceParticipant | null;
  speakingPeerIds: string[];
  /** channelId → participants currently in that voice channel */
  occupancy: Record<string, VoiceParticipant[]>;
  /** userId → 0..1 playback multiplier, persisted for the session. */
  peerVolumes: Record<string, number>;
  /** True when media is flowing through an SFU rather than a peer mesh. */
  usingSfu: boolean;
  /**
   * Set when the last join was refused because this client could not use the
   * room's transport. Distinct from `error` so the UI (and tests) can tell this
   * apart from a mic failure or a dropped socket.
   */
  transportFailure: VoiceTransportFailure | null;
  /** True when this client is the one presenting. */
  isSharingScreen: boolean;
  /** peerId of whoever is presenting (self or remote), or null if nobody is. */
  screenSharePeerId: string | null;
  /** Our own outgoing capture, for a local preview of what's being shared. */
  localScreenStream: MediaStream | null;
}

interface MicPipeline {
  rawStream: MediaStream;
  processedStream: MediaStream;
  audioContext: AudioContext;
  gainNode: GainNode;
  analyser: AnalyserNode;
}

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function clampVolume(value: number): number {
  if (Number.isNaN(value)) {
    return 1;
  }
  return Math.min(2, Math.max(0, value));
}

function sameSpeaking(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

async function createMicPipeline(
  deviceId: string | undefined,
  inputVolume: number,
): Promise<MicPipeline> {
  const rawStream = await navigator.mediaDevices.getUserMedia({
    audio: buildAudioConstraints(deviceId),
    video: false,
  });

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(rawStream);
  const gainNode = audioContext.createGain();
  gainNode.gain.value = clampVolume(inputVolume);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  const destination = audioContext.createMediaStreamDestination();

  source.connect(gainNode);
  gainNode.connect(analyser);
  gainNode.connect(destination);

  return {
    rawStream,
    processedStream: destination.stream,
    audioContext,
    gainNode,
    analyser,
  };
}

function stopMicPipeline(pipeline: MicPipeline | null) {
  if (!pipeline) {
    return;
  }
  for (const track of pipeline.rawStream.getTracks()) {
    track.stop();
  }
  void pipeline.audioContext.close();
}

function micErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return "Failed to access microphone";
  }
  if (err.name === "NotAllowedError") {
    return "Microphone access was blocked. Allow it in your browser settings, then rejoin.";
  }
  return err.message;
}

function screenShareErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return "Failed to start screen share";
  }
  if (err.name === "NotSupportedError" || err instanceof TypeError) {
    // A browser without getDisplayMedia throws a TypeError from the call
    // itself. That is a platform limit, not a fault: say it plainly rather
    // than surfacing "…is not a function" as an alarm.
    return SCREEN_SHARE_UNSUPPORTED_MESSAGE;
  }
  if (err.name === "NotAllowedError") {
    // Also covers the user dismissing the OS/browser picker without choosing
    // a source — that rejects with the same error name, so this isn't really
    // a permissions problem in the usual sense, but the copy still fits.
    return "Screen share was blocked or cancelled.";
  }
  return err.message;
}

/**
 * Supplies an SFU session for a voice channel.
 *
 * Registering one is a statement of **capability**, not a choice of transport:
 * whether media actually goes through the SFU is decided per room by the server
 * and delivered in `welcome.transport`. With a provider registered this client
 * can run either transport; without one it can only run mesh, and the server
 * will refuse to admit it to an SFU room rather than let it sit there inaudible.
 */
export type VoiceSessionProvider = (
  voiceChannelId: string,
  peerId: string,
) => Promise<VoiceSessionInfo | null>;

export function createVoiceController(transport: RealtimeTransport) {
  let manager: ReturnType<typeof createPeerConnectionManager> | null = null;
  let sfu: LiveKitSession | null = null;
  let sessionProvider: VoiceSessionProvider | null = null;
  /**
   * What to assume when `welcome` carries no `transport` — i.e. the server
   * predates the field. Set from `GET /api/voice/backend` at bootstrap, which
   * is the only thing an older server can tell us. Never used when the server
   * states the room's transport, which it always does from this version on.
   */
  let legacyRoomTransport: VoiceRoomTransport = "mesh";
  /** peerId → roster identity, used to label SFU participants. */
  const identities = new Map<string, LiveKitIdentity>();
  let pipeline: MicPipeline | null = null;
  /** Owns the getDisplayMedia() capture; mirrored into state.localScreenStream. */
  let screenCaptureStream: MediaStream | null = null;
  let joinTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let speakingRaf = 0;
  let iceServers: RTCIceServer[] = getDefaultIceServers();
  const remoteAnalysers = new Map<
    string,
    { analyser: AnalyserNode; dispose: () => void }
  >();
  const speakingTracker = createSpeakingTracker();
  // Peers the server has told us are in *our* room. Signaling from anyone else
  // is dropped so a stray/cross-room offer can never open a mic connection.
  const knownPeerIds = new Set<string>();
  let joinGeneration = 0;
  // The room the user means to be in. Kept across a WS drop so we can auto-
  // rejoin on reconnect instead of ejecting them from the call.
  let intendedChannelId: string | null = null;
  let audioOptions: VoiceAudioOptions = {
    inputDeviceId: "",
    inputVolume: 1,
  };
  let state: VoiceState = {
    status: "idle",
    peerId: null,
    remotePeers: [],
    isMuted: false,
    isDeafened: false,
    error: null,
    voiceChannelId: null,
    self: null,
    speakingPeerIds: [],
    occupancy: {},
    peerVolumes: {},
    usingSfu: false,
    transportFailure: null,
    isSharingScreen: false,
    screenSharePeerId: null,
    localScreenStream: null,
  };
  let listener: ((state: VoiceState) => void) | null = null;

  function clearJoinTimeout() {
    if (joinTimeoutId) {
      clearTimeout(joinTimeoutId);
      joinTimeoutId = null;
    }
  }

  /** Which transports this client can actually run — sent with every join. */
  function transportCapabilities(): [
    VoiceRoomTransport,
    ...VoiceRoomTransport[],
  ] {
    return sessionProvider ? ["mesh", "livekit"] : ["mesh"];
  }

  function sendJoin(voiceChannelId: string) {
    transport.sendVoice({
      type: "join-voice-room",
      voiceChannelId,
      transports: transportCapabilities(),
    });
  }

  /**
   * Returns the generation this attempt owns; older attempts are abandoned.
   *
   * The same timer covers the WebSocket handshake *and*, on an SFU room, the
   * media connection: `welcome` does not mean the call is up, and a black-holed
   * SFU host used to take LiveKit's own 15s to give up while the UI said "Voice
   * connected". Nothing here reports a live call until media is actually running.
   */
  function armJoinTimeout(failure?: VoiceTransportFailure): number {
    clearJoinTimeout();
    const generation = ++joinGeneration;
    joinTimeoutId = setTimeout(() => {
      if (state.status === "joining" && generation === joinGeneration) {
        // A media transport that never came up is a transport failure, and has
        // to look like one: a black-holed SFU host hangs rather than refusing,
        // and that is the *likely* cloud failure, not the exotic one.
        if (failure) {
          refuseTransport(failure);
          return;
        }
        joinGeneration++;
        // Release the mic so the browser recording indicator clears, and tell
        // the server to drop us if the room ever registered the join.
        stopMicPipeline(pipeline);
        pipeline = null;
        intendedChannelId = null;
        void teardownSfu();
        manager?.dispose();
        manager = null;
        transport.sendVoice({ type: "leave-voice-room" });
        state.error =
          "Voice connection timed out. Is the server running and WebSocket connected?";
        state.status = "idle";
        state.peerId = null;
        state.self = null;
        state.remotePeers = [];
        state.voiceChannelId = null;
        emit();
      }
    }, 12_000);
    return generation;
  }

  /**
   * The room runs a transport we cannot run. Leave — do not build the other one.
   *
   * Falling back to mesh here is what used to make two people sit in a call
   * unable to hear each other with no error anywhere. The user is told, and the
   * `leave-voice-room` keeps them out of everyone else's roster so nobody is
   * left talking to a participant who was never there.
   */
  function refuseTransport(failure: VoiceTransportFailure) {
    clearJoinTimeout();
    joinGeneration++;
    intendedChannelId = null;
    knownPeerIds.clear();
    stopSpeakingLoop();
    disposeRemoteAnalysers();
    transport.sendVoice({ type: "leave-voice-room" });
    manager?.dispose();
    manager = null;
    void teardownSfu();
    stopMicPipeline(pipeline);
    pipeline = null;
    releaseScreenCapture();
    state.status = "idle";
    state.peerId = null;
    state.self = null;
    state.remotePeers = [];
    state.voiceChannelId = null;
    state.speakingPeerIds = [];
    state.transportFailure = failure;
    state.error = TRANSPORT_FAILURE_MESSAGE[failure.reason];
    emit();
  }

  // WS dropped mid-call: the media session is dead. Tear it down but keep the
  // mic pipeline and intendedChannelId so we can rejoin on reconnect.
  function teardownMeshForReconnect() {
    knownPeerIds.clear();
    stopSpeakingLoop();
    disposeRemoteAnalysers();
    manager?.dispose();
    manager = null;
    void teardownSfu();
    state.peerId = null;
    state.remotePeers = [];
    state.self = null;
    state.speakingPeerIds = [];
  }

  function snapshot(): VoiceState {
    return {
      ...state,
      remotePeers: [...state.remotePeers],
      speakingPeerIds: [...state.speakingPeerIds],
      occupancy: { ...state.occupancy },
      peerVolumes: { ...state.peerVolumes },
      self: state.self ? { ...state.self } : null,
    };
  }

  function emit() {
    listener?.(snapshot());
  }

  function sendRelay(message: ClientRelayMessage) {
    if (!state.peerId) {
      return;
    }
    transport.sendVoice({ ...message, from: state.peerId });
  }

  function applyMuteToPipeline() {
    if (!pipeline) {
      return;
    }
    for (const track of pipeline.processedStream.getAudioTracks()) {
      track.enabled = !state.isMuted;
    }
    for (const track of pipeline.rawStream.getAudioTracks()) {
      track.enabled = !state.isMuted;
    }
  }

  function applyMute() {
    applyMuteToPipeline();
    void sfu?.setMuted(state.isMuted);
  }

  function disposeRemoteAnalysers() {
    for (const entry of remoteAnalysers.values()) {
      entry.dispose();
    }
    remoteAnalysers.clear();
  }

  function syncRemoteAnalysers(peers: RemotePeer[]) {
    const live = new Set(peers.map((p) => p.peerId));
    for (const [peerId, entry] of remoteAnalysers) {
      if (!live.has(peerId)) {
        entry.dispose();
        remoteAnalysers.delete(peerId);
      }
    }
    for (const peer of peers) {
      if (!peer.stream || remoteAnalysers.has(peer.peerId)) {
        continue;
      }
      const created = createStreamAnalyser(peer.stream);
      if (created) {
        remoteAnalysers.set(peer.peerId, {
          analyser: created.analyser,
          dispose: created.dispose,
        });
      }
    }
  }

  function stopSpeakingLoop() {
    if (speakingRaf) {
      cancelAnimationFrame(speakingRaf);
      speakingRaf = 0;
    }
    speakingTracker.clear();
    if (state.speakingPeerIds.length > 0) {
      state.speakingPeerIds = [];
      emit();
    }
  }

  function startSpeakingLoop() {
    stopSpeakingLoop();
    const tick = () => {
      const next: string[] = [];
      if (pipeline && state.peerId && !state.isMuted) {
        const level = readAnalyserLevel(pipeline.analyser);
        if (speakingTracker.update(state.peerId, level, true)) {
          next.push(state.peerId);
        }
      } else if (state.peerId) {
        speakingTracker.update(state.peerId, 0, false);
      }

      for (const [peerId, entry] of remoteAnalysers) {
        const level = readAnalyserLevel(entry.analyser);
        if (speakingTracker.update(peerId, level, true)) {
          next.push(peerId);
        }
      }

      next.sort();
      if (!sameSpeaking(state.speakingPeerIds, next)) {
        state.speakingPeerIds = next;
        emit();
      }
      speakingRaf = requestAnimationFrame(tick);
    };
    speakingRaf = requestAnimationFrame(tick);
  }

  function toIdentity(participant: VoiceParticipant) {
    return {
      userId: participant.userId,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl,
    };
  }

  async function teardownSfu() {
    const session = sfu;
    sfu = null;
    state.usingSfu = false;
    identities.clear();
    if (session) {
      try {
        await session.disconnect();
      } catch {
        // already gone
      }
    }
  }

  /** Stops the capture tracks only — no network call, no peer teardown. */
  function releaseScreenCapture() {
    if (!screenCaptureStream) {
      return;
    }
    for (const track of screenCaptureStream.getTracks()) {
      track.stop();
    }
    screenCaptureStream = null;
    state.isSharingScreen = false;
    state.localScreenStream = null;
  }

  /** Full stop while still in-call: releases the capture and tells everyone. */
  async function stopScreenShareInternal() {
    if (!screenCaptureStream) {
      return;
    }
    releaseScreenCapture();
    transport.sendVoice({ type: "set-sharing-screen", sharing: false });
    await manager?.setLocalScreenStream(null);
    if (sfu) {
      await sfu.unpublishScreen();
    }
  }

  /**
   * SFU media path. Returns false if the session could not be established —
   * the caller then *leaves the call and says so*. It must never build a mesh
   * instead: the rest of the room is on the SFU and would neither hear this
   * client nor see it drop out.
   */
  async function startSfuSession(
    voiceChannelId: string,
    peerId: string,
    peers: VoiceParticipant[],
  ): Promise<boolean> {
    if (!sessionProvider) {
      return false;
    }
    try {
      const session = await sessionProvider(voiceChannelId, peerId);
      if (!session) {
        return false;
      }
      // A leave() may have landed while the token request was in flight.
      if (state.peerId !== peerId) {
        return true;
      }

      for (const peer of peers) {
        identities.set(peer.peerId, toIdentity(peer));
      }

      sfu = await connectLiveKit({
        session,
        lookupIdentity: (id) => identities.get(id),
        onPeersChanged: (remote) => {
          state.remotePeers = remote;
          syncRemoteAnalysers(remote);
          emit();
        },
        onError: (msg) => {
          state.error = msg;
          emit();
        },
      });

      if (state.peerId !== peerId) {
        await teardownSfu();
        return true;
      }
      if (pipeline) {
        await sfu.publish(pipeline.processedStream);
        await sfu.setMuted(state.isMuted);
      }
      // A screen share started before a reconnect rebuilds the session — the
      // capture itself survives the WS drop (it's a browser-level grant, not
      // tied to the connection), only the publish needs redoing.
      if (screenCaptureStream) {
        await sfu.publishScreen(screenCaptureStream);
        transport.sendVoice({ type: "set-sharing-screen", sharing: true });
      }
      state.usingSfu = true;
      emit();
      return true;
    } catch (err) {
      console.warn("[pqp] SFU session failed — leaving the call", err);
      await teardownSfu();
      return false;
    }
  }

  function startMeshSession(peerId: string, peers: VoiceParticipant[]) {
    manager = createPeerConnectionManager(peerId, sendRelay, iceServers);
    if (pipeline) {
      manager.setLocalStream(pipeline.processedStream);
    }
    // See the matching comment in startSfuSession: carry an in-progress share
    // forward across a rebuilt mesh (e.g. after a WS reconnect).
    if (screenCaptureStream) {
      void manager.setLocalScreenStream(screenCaptureStream);
      transport.sendVoice({ type: "set-sharing-screen", sharing: true });
    }
    manager.onPeerStateChange((remote) => {
      state.remotePeers = remote;
      syncRemoteAnalysers(remote);
      emit();
    });
    for (const peer of peers) {
      manager.connectToPeer(peer.peerId, toIdentity(peer));
    }
  }

  function handleSignaling(message: VoiceSignalingMessage) {
    switch (message.type) {
      case "voice-roster":
        state.occupancy = {
          ...state.occupancy,
          [message.voiceChannelId]: message.participants,
        };
        if (message.participants.length === 0) {
          const next = { ...state.occupancy };
          delete next[message.voiceChannelId];
          state.occupancy = next;
        }
        // Rebuild the signaling allowlist from the room's authoritative roster
        // snapshot (not just append), so a stale id from a missed/out-of-order
        // peer-left can't linger as a trusted signaling source. Safe against
        // dropping a valid peer: the server sends peer-joined before the roster
        // on the same ordered socket, and only our own room's roster resets it.
        if (message.voiceChannelId === state.voiceChannelId) {
          knownPeerIds.clear();
          for (const participant of message.participants) {
            if (participant.peerId !== state.peerId) {
              knownPeerIds.add(participant.peerId);
            }
          }
          state.screenSharePeerId =
            message.participants.find((p) => p.sharingScreen)?.peerId ?? null;
        }
        emit();
        break;
      case "screen-share-denied":
        if (message.voiceChannelId !== state.voiceChannelId) {
          return;
        }
        void stopScreenShareInternal();
        state.error = "Someone else is already sharing their screen.";
        emit();
        break;
      case "voice-room-full":
        clearJoinTimeout();
        stopMicPipeline(pipeline);
        pipeline = null;
        intendedChannelId = null;
        state.error = `This voice channel is full (max ${message.limit}).`;
        state.status = "idle";
        state.voiceChannelId = null;
        emit();
        break;
      case "welcome": {
        // Drop a welcome that arrives after we already gave up (join timeout)
        // or left — otherwise it would flip us back to "connected" with no mic.
        if (state.status !== "joining") {
          transport.sendVoice({ type: "leave-voice-room" });
          return;
        }
        knownPeerIds.clear();
        state.peerId = message.peerId;
        state.voiceChannelId = message.voiceChannelId;
        state.self = message.self;
        state.transportFailure = null;

        const welcomePeers = message.peers;
        for (const peer of welcomePeers) {
          knownPeerIds.add(peer.peerId);
        }
        const channelId = message.voiceChannelId;
        const peerId = message.peerId;
        // The server owns this. We never re-derive it, and we never substitute
        // the other transport when ours fails.
        const roomTransport = message.transport ?? legacyRoomTransport;

        // Rejoin/channel-switch: tear the previous session down before building
        // a new one, or its connections and ICE-restart timers leak.
        manager?.dispose();
        manager = null;
        void teardownSfu();

        if (roomTransport === "livekit") {
          if (!sessionProvider) {
            // Only reachable against a server old enough to omit `transport`;
            // a current one refuses this join before minting a peer.
            refuseTransport({
              transport: roomTransport,
              reason: "unsupported",
            });
            break;
          }
          // Still "joining": on the SFU path the call is not up until media is,
          // and the timer bounds how long that can be claimed. A black-holed
          // LiveKit host takes ~15s to reject on its own, which used to be 15s
          // of "Voice connected" with no audio in either direction.
          const generation = armJoinTimeout({
            transport: roomTransport,
            reason: "unreachable",
          });
          void startSfuSession(channelId, peerId, welcomePeers).then((ok) => {
            if (generation !== joinGeneration || state.peerId !== peerId) {
              return;
            }
            clearJoinTimeout();
            if (!ok) {
              refuseTransport({
                transport: roomTransport,
                reason: "unreachable",
              });
              return;
            }
            state.status = "connected";
            startSpeakingLoop();
            emit();
          });
          emit();
          break;
        }

        clearJoinTimeout();
        state.status = "connected";
        startMeshSession(peerId, welcomePeers);
        startSpeakingLoop();
        emit();
        break;
      }
      case "voice-transport-unsupported":
        // The server refused before creating a peer: no roster entry of ours
        // ever existed, so there is nothing for anyone else to clean up.
        if (
          state.status === "idle" ||
          message.voiceChannelId !== state.voiceChannelId
        ) {
          return;
        }
        refuseTransport({
          transport: message.transport,
          reason: "unsupported",
        });
        break;
      case "peer-joined":
        knownPeerIds.add(message.peer.peerId);
        identities.set(message.peer.peerId, toIdentity(message.peer));
        manager?.connectToPeer(message.peer.peerId, toIdentity(message.peer));
        break;
      case "peer-left":
        knownPeerIds.delete(message.peerId);
        identities.delete(message.peerId);
        manager?.removePeer(message.peerId);
        {
          const entry = remoteAnalysers.get(message.peerId);
          if (entry) {
            entry.dispose();
            remoteAnalysers.delete(message.peerId);
          }
        }
        break;
      case "offer":
        if (!knownPeerIds.has(message.from)) {
          return;
        }
        void manager?.handleOffer(message.from, message.sdp);
        break;
      case "answer":
        if (!knownPeerIds.has(message.from)) {
          return;
        }
        void manager?.handleAnswer(message.from, message.sdp);
        break;
      case "ice-candidate":
        if (!knownPeerIds.has(message.from)) {
          return;
        }
        void manager?.handleIceCandidate(message.from, message.candidate);
        break;
    }
  }

  return {
    onStateChange(cb: (next: VoiceState) => void) {
      listener = cb;
    },

    getState() {
      return snapshot();
    },

    getAnalyser() {
      return pipeline?.analyser ?? null;
    },

    handleSignaling,

    /**
     * Declare that this client can obtain SFU sessions. Pass `null` for a build
     * that cannot (mesh-forced), which the server is then told about on join.
     *
     * `legacyTransport` is only consulted when the server's `welcome` carries no
     * `transport` field — i.e. a server older than this protocol, where
     * `GET /api/voice/backend` is the best information available.
     */
    setSessionProvider(
      provider: VoiceSessionProvider | null,
      legacyTransport: VoiceRoomTransport = "mesh",
    ) {
      sessionProvider = provider;
      legacyRoomTransport = provider ? legacyTransport : "mesh";
    },

    setIceServers(servers: IceServerConfig[]) {
      if (servers.length === 0) {
        return;
      }
      iceServers = servers as RTCIceServer[];
      manager?.setIceServers(iceServers);
    },

    async retryPeer(peerId: string) {
      await manager?.retryPeer(peerId);
    },

    async join(voiceChannelId: string, options?: VoiceAudioOptions) {
      state.error = null;
      state.transportFailure = null;
      state.status = "joining";
      // Known from the moment we start, not only once the server says welcome —
      // otherwise the UI cannot tell which channel is connecting.
      state.voiceChannelId = voiceChannelId;
      intendedChannelId = voiceChannelId;
      // Applied before the track exists, so "mute on join" is genuinely muted
      // from the first sample rather than a moment later.
      state.isMuted = options?.startMuted ?? state.isMuted;
      emit();

      if (options) {
        audioOptions = {
          inputDeviceId: options.inputDeviceId ?? audioOptions.inputDeviceId,
          inputVolume: options.inputVolume ?? audioOptions.inputVolume,
        };
      }

      const generation = armJoinTimeout();

      try {
        stopMicPipeline(pipeline);
        let next: MicPipeline;
        try {
          next = await createMicPipeline(
            audioOptions.inputDeviceId || undefined,
            audioOptions.inputVolume ?? 1,
          );
        } catch (deviceError) {
          if (!audioOptions.inputDeviceId) {
            throw deviceError;
          }
          next = await createMicPipeline(
            undefined,
            audioOptions.inputVolume ?? 1,
          );
        }

        // Abandoned (left, timed out, or superseded) while the permission
        // prompt was open: never open a mic for a join nobody is waiting on.
        if (generation !== joinGeneration) {
          stopMicPipeline(next);
          return;
        }

        pipeline = next;
        applyMuteToPipeline();
        sendJoin(voiceChannelId);
      } catch (err) {
        if (generation !== joinGeneration) {
          return;
        }
        clearJoinTimeout();
        stopMicPipeline(pipeline);
        pipeline = null;
        intendedChannelId = null;
        state.error = micErrorMessage(err);
        state.status = "idle";
        state.voiceChannelId = null;
        emit();
      }
    },

    leave() {
      clearJoinTimeout();
      joinGeneration++;
      intendedChannelId = null;
      knownPeerIds.clear();
      stopSpeakingLoop();
      disposeRemoteAnalysers();
      transport.sendVoice({ type: "leave-voice-room" });
      manager?.dispose();
      manager = null;
      void teardownSfu();
      stopMicPipeline(pipeline);
      pipeline = null;
      releaseScreenCapture();
      state = {
        status: "idle",
        peerId: null,
        remotePeers: [],
        isMuted: false,
        isDeafened: false,
        error: null,
        voiceChannelId: null,
        self: null,
        speakingPeerIds: [],
        occupancy: state.occupancy,
        peerVolumes: state.peerVolumes,
        usingSfu: false,
        transportFailure: null,
        isSharingScreen: false,
        screenSharePeerId: null,
        localScreenStream: null,
      };
      emit();
    },

    /** WS connection lost mid-call: keep the mic + intent, drop the dead mesh. */
    notifyDisconnected() {
      if (state.status === "idle" || !intendedChannelId) {
        return;
      }
      clearJoinTimeout();
      teardownMeshForReconnect();
      // Show "joining" (reconnecting) rather than kicking the user to idle.
      state.status = "joining";
      emit();
    },

    /** WS reconnected: auto-rejoin the room so the call resumes seamlessly. */
    async notifyReconnected() {
      if (!intendedChannelId || state.status === "idle") {
        return;
      }
      if (!pipeline) {
        // Mic was released (e.g. a long outage) — re-acquire via a full join.
        await this.join(intendedChannelId);
        return;
      }
      // Mic still live: re-enter the room; welcome rebuilds the mesh with a
      // fresh peer id and other participants reconnect to us.
      state.status = "joining";
      emit();
      armJoinTimeout();
      sendJoin(intendedChannelId);
    },

    setMuted(muted: boolean) {
      if (!pipeline) {
        return;
      }
      // Undeafening is the only way back to an unmuted mic while deafened.
      state.isMuted = state.isDeafened ? true : muted;
      applyMute();
      emit();
    },

    toggleMute() {
      if (!pipeline) {
        return;
      }
      if (state.isDeafened) {
        state.isDeafened = false;
        state.isMuted = false;
      } else {
        state.isMuted = !state.isMuted;
      }
      applyMute();
      emit();
    },

    toggleDeafen() {
      if (!pipeline) {
        return;
      }
      state.isDeafened = !state.isDeafened;
      // Deafening also mutes; undeafening restores an open mic.
      state.isMuted = state.isDeafened;
      applyMute();
      emit();
    },

    async startScreenShare() {
      if (state.status !== "connected") {
        return;
      }
      // Only one presenter per room (mesh and SFU alike — see the server-side
      // comment in voice.ts). Checking the roster here skips the OS picker
      // when we already know it'll be refused; the server call below is still
      // the authoritative check for the rare simultaneous-click race.
      if (state.screenSharePeerId && state.screenSharePeerId !== state.peerId) {
        state.error = "Someone else is already sharing their screen.";
        emit();
        return;
      }

      // Defensive: the UI already hides the affordance where this is missing
      // (see components/voice/capabilities.ts), so reaching here means a
      // programmatic call, not a user tapping a button we should not have shown.
      if (!supportsScreenShare()) {
        state.error = SCREEN_SHARE_UNSUPPORTED_MESSAGE;
        emit();
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      } catch (err) {
        state.error = screenShareErrorMessage(err);
        emit();
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        for (const t of stream.getTracks()) t.stop();
        state.error = "No video track from screen capture";
        emit();
        return;
      }
      // Fires on the browser's native "Stop sharing" control, not just our
      // own button.
      track.onended = () => {
        void stopScreenShareInternal();
        emit();
      };
      screenCaptureStream = stream;
      state.isSharingScreen = true;
      state.localScreenStream = stream;
      emit();
      transport.sendVoice({ type: "set-sharing-screen", sharing: true });

      try {
        await manager?.setLocalScreenStream(stream);
        if (sfu) {
          await sfu.publishScreen(stream);
        }
      } catch (err) {
        state.error = screenShareErrorMessage(err);
        await stopScreenShareInternal();
        emit();
      }
    },

    async stopScreenShare() {
      await stopScreenShareInternal();
      emit();
    },

    /**
     * Per-peer playback level. Keyed by user id, not peer id: the server mints a
     * fresh peer id on every join, so a peer-keyed setting would reset whenever
     * that person reconnected.
     */
    setPeerVolume(userId: string, volume: number) {
      state.peerVolumes = {
        ...state.peerVolumes,
        [userId]: Math.min(1, Math.max(0, volume)),
      };
      emit();
    },

    setInputVolume(volume: number) {
      audioOptions.inputVolume = clampVolume(volume);
      if (pipeline) {
        pipeline.gainNode.gain.value = audioOptions.inputVolume;
      }
    },

    async setInputDevice(deviceId: string) {
      const previousDeviceId = audioOptions.inputDeviceId ?? "";
      audioOptions.inputDeviceId = deviceId;
      if (!pipeline || state.status === "idle") {
        return;
      }
      if (previousDeviceId === deviceId) {
        return;
      }

      const wasMuted = state.isMuted;
      try {
        const next = await createMicPipeline(
          deviceId || undefined,
          audioOptions.inputVolume ?? 1,
        );
        stopMicPipeline(pipeline);
        pipeline = next;
        state.isMuted = wasMuted;
        applyMuteToPipeline();

        if (manager) {
          await manager.replaceLocalTrack(pipeline.processedStream);
        }
        if (sfu) {
          await sfu.replaceTrack(pipeline.processedStream);
          await sfu.setMuted(state.isMuted);
        }
        emit();
      } catch (err) {
        state.error =
          err instanceof Error ? err.message : "Failed to switch microphone";
        emit();
      }
    },

    hasMeshWarning() {
      return state.remotePeers.length >= MESH_VOICE_WARNING;
    },
  };
}

export type { PeerConnectionState, RemotePeer };
