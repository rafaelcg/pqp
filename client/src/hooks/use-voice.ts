import {
  MESH_VOICE_WARNING,
  type ClientRelayMessage,
  type VoiceParticipant,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import { buildAudioConstraints } from "@/lib/audio-devices";
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
}

export interface VoiceState {
  status: VoiceStatus;
  peerId: string | null;
  remotePeers: RemotePeer[];
  isMuted: boolean;
  error: string | null;
  voiceChannelId: string | null;
  self: VoiceParticipant | null;
  speakingPeerIds: string[];
  /** channelId → participants currently in that voice channel */
  occupancy: Record<string, VoiceParticipant[]>;
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

export function createVoiceController(transport: RealtimeTransport) {
  let manager: ReturnType<typeof createPeerConnectionManager> | null = null;
  let pipeline: MicPipeline | null = null;
  let joinTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let speakingRaf = 0;
  let iceServers: RTCIceServer[] = getDefaultIceServers();
  const remoteAnalysers = new Map<
    string,
    { analyser: AnalyserNode; dispose: () => void }
  >();
  const speakingTracker = createSpeakingTracker();
  let audioOptions: VoiceAudioOptions = {
    inputDeviceId: "",
    inputVolume: 1,
  };
  let state: VoiceState = {
    status: "idle",
    peerId: null,
    remotePeers: [],
    isMuted: false,
    error: null,
    voiceChannelId: null,
    self: null,
    speakingPeerIds: [],
    occupancy: {},
  };
  let listener: ((state: VoiceState) => void) | null = null;

  function clearJoinTimeout() {
    if (joinTimeoutId) {
      clearTimeout(joinTimeoutId);
      joinTimeoutId = null;
    }
  }

  function emit() {
    listener?.({
      ...state,
      remotePeers: [...state.remotePeers],
      speakingPeerIds: [...state.speakingPeerIds],
      occupancy: { ...state.occupancy },
      self: state.self ? { ...state.self } : null,
    });
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
        emit();
        break;
      case "welcome":
        clearJoinTimeout();
        state.peerId = message.peerId;
        state.status = "connected";
        state.voiceChannelId = message.voiceChannelId;
        state.self = message.self;
        manager = createPeerConnectionManager(
          message.peerId,
          sendRelay,
          iceServers,
        );
        if (pipeline) {
          manager.setLocalStream(pipeline.processedStream);
        }
        manager.onPeerStateChange((peers) => {
          state.remotePeers = peers;
          syncRemoteAnalysers(peers);
          emit();
        });
        for (const peer of message.peers) {
          manager.connectToPeer(peer.peerId, toIdentity(peer));
        }
        startSpeakingLoop();
        emit();
        break;
      case "peer-joined":
        manager?.connectToPeer(message.peer.peerId, toIdentity(message.peer));
        break;
      case "peer-left":
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
        void manager?.handleOffer(message.from, message.sdp);
        break;
      case "answer":
        void manager?.handleAnswer(message.from, message.sdp);
        break;
      case "ice-candidate":
        void manager?.handleIceCandidate(message.from, message.candidate);
        break;
    }
  }

  return {
    onStateChange(cb: (next: VoiceState) => void) {
      listener = cb;
    },

    getState() {
      return {
        ...state,
        remotePeers: [...state.remotePeers],
        speakingPeerIds: [...state.speakingPeerIds],
        occupancy: { ...state.occupancy },
        self: state.self ? { ...state.self } : null,
      };
    },

    getAnalyser() {
      return pipeline?.analyser ?? null;
    },

    handleSignaling,

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
      emit();

      if (options) {
        audioOptions = {
          inputDeviceId: options.inputDeviceId ?? audioOptions.inputDeviceId,
          inputVolume: options.inputVolume ?? audioOptions.inputVolume,
        };
      }

      clearJoinTimeout();
      joinTimeoutId = setTimeout(() => {
        if (state.status === "joining") {
          state.error =
            "Voice connection timed out. Is the server running and WebSocket connected?";
          state.status = "idle";
          emit();
        }
      }, 12_000);

      try {
        stopMicPipeline(pipeline);
        try {
          pipeline = await createMicPipeline(
            audioOptions.inputDeviceId || undefined,
            audioOptions.inputVolume ?? 1,
          );
        } catch (deviceError) {
          if (!audioOptions.inputDeviceId) {
            throw deviceError;
          }
          pipeline = await createMicPipeline(
            undefined,
            audioOptions.inputVolume ?? 1,
          );
        }
        applyMuteToPipeline();
        transport.sendVoice({ type: "join-voice-room", voiceChannelId });
      } catch (err) {
        clearJoinTimeout();
        stopMicPipeline(pipeline);
        pipeline = null;
        state.error =
          err instanceof Error ? err.message : "Failed to access microphone";
        state.status = "idle";
        emit();
      }
    },

    leave() {
      clearJoinTimeout();
      stopSpeakingLoop();
      disposeRemoteAnalysers();
      transport.sendVoice({ type: "leave-voice-room" });
      manager?.dispose();
      manager = null;
      stopMicPipeline(pipeline);
      pipeline = null;
      state = {
        status: "idle",
        peerId: null,
        remotePeers: [],
        isMuted: false,
        error: null,
        voiceChannelId: null,
        self: null,
        speakingPeerIds: [],
        occupancy: state.occupancy,
      };
      emit();
    },

    setMuted(muted: boolean) {
      if (!pipeline) {
        return;
      }
      state.isMuted = muted;
      applyMuteToPipeline();
      emit();
    },

    toggleMute() {
      if (!pipeline) {
        return;
      }
      state.isMuted = !state.isMuted;
      applyMuteToPipeline();
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
