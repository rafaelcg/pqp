import { useEffect, useRef } from "react";
import { MESH_VOICE_WARNING, type VoiceParticipant } from "@pqp/shared";
import type { RemotePeer } from "@/lib/peer-connection-manager";
import { applyAudioOutputDevice } from "@/lib/audio-devices";
import { Button } from "@/components/ui/button";
import { VoiceAvatar } from "@/components/voice/voice-avatar";

interface PeerAudioProps {
  peerId: string;
  stream: MediaStream | null;
  outputDeviceId: string;
  outputVolume: number;
}

function PeerAudio({
  peerId,
  stream,
  outputDeviceId,
  outputVolume,
}: PeerAudioProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.srcObject = stream;
    if (stream) {
      void audio.play().catch(() => {});
    }
  }, [stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.volume = Math.min(1, Math.max(0, outputVolume));
  }, [outputVolume]);

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
      data-peer-id={peerId}
      className="sr-only"
    />
  );
}

interface VoicePanelProps {
  channelName: string;
  status: "idle" | "joining" | "connected";
  remotePeers: RemotePeer[];
  self: VoiceParticipant | null;
  localPeerId: string | null;
  speakingPeerIds: string[];
  isMuted: boolean;
  error: string | null;
  compactPeers?: boolean;
  outputDeviceId?: string;
  outputVolume?: number;
  onJoin: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
}

export function VoicePanel({
  channelName,
  status,
  remotePeers,
  self,
  localPeerId,
  speakingPeerIds,
  isMuted,
  error,
  compactPeers = false,
  outputDeviceId = "",
  outputVolume = 1,
  onJoin,
  onLeave,
  onToggleMute,
}: VoicePanelProps) {
  const showWarning = remotePeers.length >= MESH_VOICE_WARNING;
  const speaking = new Set(speakingPeerIds);
  const connectedCount =
    (status === "connected" && self ? 1 : 0) + remotePeers.length;

  return (
    <div className="flex h-full min-h-0 flex-col border-b border-panel-hover lg:border-b-0 lg:border-r">
      <header className="flex h-12 shrink-0 items-center border-b border-panel-hover px-4 shadow-sm">
        <MicIcon />
        <span className="ml-2 font-semibold">{channelName}</span>
        {status === "connected" && (
          <span className="ml-2 text-xs text-success">Live</span>
        )}
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-4">
        {error && (
          <p className="rounded bg-danger/20 px-4 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        {status === "idle" && (
          <>
            <p className="text-center text-sm text-muted">
              Join voice to talk. Chat stays available below / beside.
            </p>
            <Button onClick={onJoin}>Join Voice</Button>
          </>
        )}

        {status === "joining" && (
          <p className="text-muted">Connecting to voice…</p>
        )}

        {status === "connected" && (
          <div className="w-full max-w-sm space-y-3">
            {showWarning && (
              <p className="rounded bg-warning/20 px-3 py-2 text-center text-xs text-warning">
                Mesh limit approaching — SFU coming later.
              </p>
            )}

            <div className="flex justify-center gap-2">
              <Button variant="secondary" size="sm" onClick={onToggleMute}>
                {isMuted ? "Unmute" : "Mute"}
              </Button>
              <Button variant="danger" size="sm" onClick={onLeave}>
                Leave
              </Button>
            </div>

            <div className="rounded-lg border border-ink-4 bg-ink p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-paper-muted">
                Connected ({connectedCount})
              </h3>
              <ul className={compactPeers ? "space-y-1" : "space-y-2"}>
                {self && (
                  <li className="flex items-center gap-2 text-sm">
                    <VoiceAvatar
                      name={self.displayName}
                      avatarUrl={self.avatarUrl}
                      isSpeaking={
                        !!localPeerId && speaking.has(localPeerId) && !isMuted
                      }
                      muted={isMuted}
                      size={compactPeers ? "sm" : "md"}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {self.displayName}
                      <span className="ml-1 text-xs text-paper-muted">
                        (you)
                      </span>
                    </span>
                    {isMuted && (
                      <span className="rounded bg-danger/20 px-2 py-0.5 text-[10px] uppercase text-danger">
                        Muted
                      </span>
                    )}
                  </li>
                )}
                {remotePeers.map((peer) => (
                  <li
                    key={peer.peerId}
                    className="flex items-center gap-2 text-sm"
                  >
                    <VoiceAvatar
                      name={peer.displayName ?? "Peer"}
                      avatarUrl={peer.avatarUrl}
                      isSpeaking={speaking.has(peer.peerId)}
                      size={compactPeers ? "sm" : "md"}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {peer.displayName ??
                        `${peer.peerId.slice(0, compactPeers ? 6 : 8)}…`}
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] uppercase ${
                        peer.connectionState === "connected"
                          ? "bg-success/20 text-success"
                          : peer.connectionState === "failed"
                            ? "bg-danger/20 text-danger"
                            : "bg-warning/20 text-warning"
                      }`}
                    >
                      {peer.connectionState}
                    </span>
                    <PeerAudio
                      peerId={peer.peerId}
                      stream={peer.stream}
                      outputDeviceId={outputDeviceId}
                      outputVolume={outputVolume}
                    />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}
