import { useEffect, useRef } from "react";
import { applyAudioOutputDevice } from "@/lib/audio-devices";
import type { RemotePeer } from "@/lib/peer-connection-manager";

interface PeerAudioProps {
  peer: RemotePeer;
  outputDeviceId: string;
  outputVolume: number;
  peerVolume: number;
  isDeafened: boolean;
}

function PeerAudio({
  peer,
  outputDeviceId,
  outputVolume,
  peerVolume,
  isDeafened,
}: PeerAudioProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.srcObject = peer.stream;
    if (peer.stream) {
      void audio.play().catch(() => {
        // Autoplay can be blocked until the page has been interacted with;
        // joining voice is itself an interaction, so this is rare.
      });
    }
  }, [peer.stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.volume = Math.min(1, Math.max(0, outputVolume * peerVolume));
    audio.muted = isDeafened;
  }, [outputVolume, peerVolume, isDeafened]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    void applyAudioOutputDevice(audio, outputDeviceId);
  }, [outputDeviceId, peer.stream]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      data-peer-id={peer.peerId}
      className="sr-only"
    />
  );
}

interface VoiceAudioSinksProps {
  peers: RemotePeer[];
  /** Keyed by user id so a level survives that person reconnecting. */
  peerVolumes: Record<string, number>;
  isDeafened: boolean;
  outputDeviceId?: string;
  outputVolume?: number;
}

/**
 * The `<audio>` elements that actually play remote voice. They live at the app
 * root rather than inside the voice panel: the panel unmounts as soon as you
 * navigate to another channel, and audio must not stop when you do.
 */
export function VoiceAudioSinks({
  peers,
  peerVolumes,
  isDeafened,
  outputDeviceId = "",
  outputVolume = 1,
}: VoiceAudioSinksProps) {
  return (
    <>
      {peers.map((peer) => (
        <PeerAudio
          key={peer.peerId}
          peer={peer}
          outputDeviceId={outputDeviceId}
          outputVolume={outputVolume}
          peerVolume={peerVolumes[peer.userId ?? peer.peerId] ?? 1}
          isDeafened={isDeafened}
        />
      ))}
    </>
  );
}
