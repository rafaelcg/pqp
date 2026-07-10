import type { VoiceBackendType } from "@pqp/shared";
import { createPeerConnectionManager } from "./peer-connection-manager";

export interface VoiceSession {
  join(voiceChannelId: string): Promise<void>;
  leave(): void;
  toggleMute(): void;
  dispose(): void;
}

/**
 * Voice backend abstraction. Mesh is the default implementation.
 * Cloudflare Realtime SFU and LiveKit adapters are Phase 5 stubs.
 */
export function createVoiceBackend(
  type: VoiceBackendType,
  localPeerId: string,
  send: Parameters<typeof createPeerConnectionManager>[1],
): VoiceSession & { getManager: () => ReturnType<typeof createPeerConnectionManager> } {
  if (type === "cloudflare-sfu") {
    console.warn(
      "[pqp] Cloudflare Realtime SFU backend not yet implemented — falling back to mesh",
    );
  }

  if (type === "livekit") {
    console.warn(
      "[pqp] LiveKit backend not yet implemented — falling back to mesh",
    );
  }

  const manager = createPeerConnectionManager(localPeerId, send);
  let localStream: MediaStream | null = null;
  let isMuted = false;

  return {
    getManager: () => manager,

    async join(_voiceChannelId: string) {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      manager.setLocalStream(localStream);
    },

    leave() {
      manager.dispose();
      if (localStream) {
        for (const track of localStream.getTracks()) {
          track.stop();
        }
        localStream = null;
      }
      isMuted = false;
    },

    toggleMute() {
      if (!localStream) {
        return;
      }
      isMuted = !isMuted;
      for (const track of localStream.getAudioTracks()) {
        track.enabled = !isMuted;
      }
    },

    dispose() {
      this.leave();
    },
  };
}

export function getVoiceBackendType(): VoiceBackendType {
  const configured = import.meta.env.VITE_VOICE_BACKEND as
    | VoiceBackendType
    | undefined;
  return configured ?? "mesh";
}
