import {
  MESH_VOICE_WARNING,
  type ClientRelayMessage,
  type VoiceSignalingMessage,
} from "@pqp/shared";
import { buildAudioConstraints } from "@/lib/audio-devices";
import {
  createPeerConnectionManager,
  type PeerConnectionState,
  type RemotePeer,
} from "@/lib/peer-connection-manager";
import type { RealtimeTransport } from "@/lib/realtime";

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
}

interface MicPipeline {
  rawStream: MediaStream;
  processedStream: MediaStream;
  audioContext: AudioContext;
  gainNode: GainNode;
  analyser: AnalyserNode;
}

function clampVolume(value: number): number {
  if (Number.isNaN(value)) {
    return 1;
  }
  return Math.min(2, Math.max(0, value));
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
  };
  let listener: ((state: VoiceState) => void) | null = null;

  function clearJoinTimeout() {
    if (joinTimeoutId) {
      clearTimeout(joinTimeoutId);
      joinTimeoutId = null;
    }
  }

  function emit() {
    listener?.({ ...state });
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

  function handleSignaling(message: VoiceSignalingMessage) {
    switch (message.type) {
      case "welcome":
        clearJoinTimeout();
        state.peerId = message.peerId;
        state.status = "connected";
        state.voiceChannelId = message.voiceChannelId;
        manager = createPeerConnectionManager(message.peerId, sendRelay);
        if (pipeline) {
          manager.setLocalStream(pipeline.processedStream);
        }
        manager.onPeerStateChange((peers) => {
          state.remotePeers = peers;
          emit();
        });
        for (const peerId of message.peers) {
          manager.connectToPeer(peerId);
        }
        emit();
        break;
      case "peer-joined":
        manager?.connectToPeer(message.peerId);
        break;
      case "peer-left":
        manager?.removePeer(message.peerId);
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
      return { ...state };
    },

    getAnalyser() {
      return pipeline?.analyser ?? null;
    },

    handleSignaling,

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
          err instanceof Error
            ? err.message
            : "Failed to switch microphone";
        emit();
      }
    },

    hasMeshWarning() {
      return state.remotePeers.length >= MESH_VOICE_WARNING;
    },
  };
}

export type { PeerConnectionState, RemotePeer };
