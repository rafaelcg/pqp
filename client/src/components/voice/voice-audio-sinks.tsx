import { useEffect, useRef } from "react";
import { applyAudioOutputDevice } from "@/lib/audio-devices";
import type { RemotePeer } from "@/lib/peer-connection-manager";

interface PeerAudioProps {
  peer: RemotePeer;
  outputDeviceId: string;
  outputVolume: number;
  peerVolume: number;
  isDeafened: boolean;
  /**
   * Play the audio of this peer's screen share instead of their microphone.
   *
   * A second element rather than a merged stream: the two start and stop at
   * different times, and the presentation must keep playing while its presenter
   * is muted. Everything else about it is identical, deliberately: deafen,
   * the output device and this person's volume slider all apply, because a
   * film blasting through a "you are deafened" state would be the same bug as
   * a voice doing it.
   */
  screenAudio?: boolean;
}

function PeerAudio({
  peer,
  outputDeviceId,
  outputVolume,
  peerVolume,
  isDeafened,
  screenAudio = false,
}: PeerAudioProps) {
  const stream = screenAudio ? peer.screenAudioStream : peer.stream;
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.srcObject = stream;
    if (stream) {
      void audio.play().catch(() => {
        // Autoplay can be blocked until the page has been interacted with;
        // joining voice is itself an interaction, so this is rare.
      });
    }
  }, [stream]);

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
  }, [outputDeviceId, stream]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      data-peer-id={peer.peerId}
      data-screen-audio={screenAudio ? "true" : undefined}
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
  /**
   * peerIds whose screen audio we should play. Comes from voice-hook state,
   * not from whether the stage is mounted, so navigating to a text channel
   * does not mute a live share. Unannounced SFU publications stay silent
   * because they never make this list (the roster is the gate).
   */
  audibleScreenPeerIds?: string[];
}

/**
 * The `<audio>` elements that actually play remote voice and remote screen
 * audio. They live at the app root rather than inside the voice panel: the
 * panel unmounts as soon as you navigate to another channel, and audio must
 * not stop when you do.
 */
export function VoiceAudioSinks({
  peers,
  peerVolumes,
  isDeafened,
  outputDeviceId = "",
  outputVolume = 1,
  audibleScreenPeerIds = [],
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
      {/* Screen audio for the shares the hook marked audible. The roster is
          what put them on that list, so an unannounced publication stays
          silent rather than merely unwatchable. */}
      {peers
        .filter(
          (peer) =>
            peer.screenAudioStream &&
            audibleScreenPeerIds.includes(peer.peerId),
        )
        .map((peer) => (
          <PeerAudio
            key={`${peer.peerId}:screen`}
            peer={peer}
            screenAudio
            outputDeviceId={outputDeviceId}
            outputVolume={outputVolume}
            peerVolume={peerVolumes[peer.userId ?? peer.peerId] ?? 1}
            isDeafened={isDeafened}
          />
        ))}
    </>
  );
}
