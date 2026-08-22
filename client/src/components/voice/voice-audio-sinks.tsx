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
   * Whoever the server says holds the presenter slot, or null.
   *
   * Screen audio is played only for them. On the mesh that is nearly implied
   * already, because the roster is what classifies the track in the first
   * place; on the SFU it is the only check there is, since a publication
   * labelled `ScreenShareAudio` is whatever the publishing client chose to
   * call it. Without this, a client that never won the slot would be heard by
   * the whole room while its picture was correctly refused a place on stage.
   */
  screenSharePeerId?: string | null;
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
  screenSharePeerId = null,
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
      {/* The presenter's system audio, when their capture carried any. Mounted
          only for the peer the roster names as the presenter, so the usual call
          has exactly the elements it has always had and an unannounced
          publication is inaudible rather than merely unwatchable. */}
      {peers
        .filter(
          (peer) => peer.screenAudioStream && peer.peerId === screenSharePeerId,
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
