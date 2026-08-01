import {
  MESH_VOICE_WARNING,
  type ClientRelayMessage,
  type VoiceParticipant,
  type VoiceSessionInfo,
  type VoiceSignalingMessage,
} from "@pqp/shared";
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

/**
 * Supplies an SFU session for a voice channel. When set, the controller routes
 * media through the SFU instead of building a mesh. Presence/roster still come
 * over the app WebSocket either way.
 */
export type VoiceSessionProvider = (
  voiceChannelId: string,
  peerId: string,
) => Promise<VoiceSessionInfo | null>;

export function createVoiceController(transport: RealtimeTransport) {
  let manager: ReturnType<typeof createPeerConnectionManager> | null = null;
  let sfu: LiveKitSession | null = null;
  let sessionProvider: VoiceSessionProvider | null = null;
  /** peerId → roster identity, used to label SFU participants. */
  const identities = new Map<string, LiveKitIdentity>();
  let pipeline: MicPipeline | null = null;
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
  };
  let listener: ((state: VoiceState) => void) | null = null;

  function clearJoinTimeout() {
    if (joinTimeoutId) {
      clearTimeout(joinTimeoutId);
      joinTimeoutId = null;
    }
  }

  /** Returns the generation this attempt owns; older attempts are abandoned. */
  function armJoinTimeout(): number {
    clearJoinTimeout();
    const generation = ++joinGeneration;
    joinTimeoutId = setTimeout(() => {
      if (state.status === "joining" && generation === joinGeneration) {
        joinGeneration++;
        // Release the mic so the browser recording indicator clears, and tell
        // the server to drop us if the room ever registered the join.
        stopMicPipeline(pipeline);
        pipeline = null;
        intendedChannelId = null;
        transport.sendVoice({ type: "leave-voice-room" });
        state.error =
          "Voice connection timed out. Is the server running and WebSocket connected?";
        state.status = "idle";
        state.voiceChannelId = null;
        emit();
      }
    }, 12_000);
    return generation;
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

  /**
   * SFU media path. Falls back to mesh if the session cannot be established,
   * so a misconfigured SFU degrades instead of leaving the user with no audio.
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
      state.usingSfu = true;
      emit();
      return true;
    } catch (err) {
      console.warn("[pqp] SFU session failed — falling back to mesh", err);
      await teardownSfu();
      return false;
    }
  }

  function startMeshSession(peerId: string, peers: VoiceParticipant[]) {
    manager = createPeerConnectionManager(peerId, sendRelay, iceServers);
    if (pipeline) {
      manager.setLocalStream(pipeline.processedStream);
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
        }
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
        clearJoinTimeout();
        knownPeerIds.clear();
        state.peerId = message.peerId;
        state.status = "connected";
        state.voiceChannelId = message.voiceChannelId;
        state.self = message.self;

        const welcomePeers = message.peers;
        for (const peer of welcomePeers) {
          knownPeerIds.add(peer.peerId);
        }
        const channelId = message.voiceChannelId;
        const peerId = message.peerId;

        // Rejoin/channel-switch: tear the previous session down before building
        // a new one, or its connections and ICE-restart timers leak.
        manager?.dispose();
        manager = null;
        void teardownSfu();

        if (sessionProvider) {
          void startSfuSession(channelId, peerId, welcomePeers).then((ok) => {
            // Only build a mesh if the SFU path declined or failed, and the
            // user is still in the same voice session.
            if (!ok && state.peerId === peerId && !manager) {
              startMeshSession(peerId, welcomePeers);
              emit();
            }
          });
        } else {
          startMeshSession(peerId, welcomePeers);
        }

        startSpeakingLoop();
        emit();
        break;
      }
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
     * Enable the SFU media path. Pass `null` to stay on mesh. Takes effect on
     * the next voice join.
     */
    setSessionProvider(provider: VoiceSessionProvider | null) {
      sessionProvider = provider;
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
        transport.sendVoice({ type: "join-voice-room", voiceChannelId });
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
      transport.sendVoice({
        type: "join-voice-room",
        voiceChannelId: intendedChannelId,
      });
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
