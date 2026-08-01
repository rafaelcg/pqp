import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  HeadphoneOff,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { MESH_VOICE_WARNING, type VoiceParticipant } from "@pqp/shared";
import type { RemotePeer } from "@/lib/peer-connection-manager";
import { Button } from "@/components/ui/button";
import { VoiceAvatar } from "@/components/voice/voice-avatar";
import { cn } from "@/lib/utils";

interface PeerRowProps {
  peer: RemotePeer;
  compact: boolean;
  isSpeaking: boolean;
  volume: number;
  onSetVolume: (volume: number) => void;
  onRetry?: () => void;
}

function PeerRow({
  peer,
  compact,
  isSpeaking,
  volume,
  onSetVolume,
  onRetry,
}: PeerRowProps) {
  const name = peer.displayName ?? `${peer.peerId.slice(0, compact ? 6 : 8)}…`;
  const silenced = volume === 0;
  // Remembers where the slider was so unmuting restores that level, not 100%.
  const restoreRef = useRef(1);

  useEffect(() => {
    if (volume > 0) {
      restoreRef.current = volume;
    }
  }, [volume]);

  return (
    <li className="group rounded-md px-1 py-0.5 transition-colors hover:bg-ink-2">
      <div className="flex items-center gap-2 text-sm">
        <VoiceAvatar
          name={peer.displayName ?? "Peer"}
          avatarUrl={peer.avatarUrl}
          isSpeaking={isSpeaking && !silenced}
          muted={silenced}
          size={compact ? "sm" : "md"}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {silenced && (
          <span className="flex shrink-0 items-center text-paper-muted">
            <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">Silenced</span>
          </span>
        )}
        <span
          className={cn(
            "rounded px-2 py-0.5 text-[10px] uppercase",
            peer.connectionState === "connected"
              ? "bg-success/20 text-success"
              : peer.connectionState === "failed"
                ? "bg-danger/20 text-danger"
                : "bg-warning/20 text-warning",
          )}
        >
          {peer.connectionState}
        </span>
        {peer.connectionState === "failed" && onRetry && (
          <Button
            variant="secondary"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
      </div>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-150",
          volume === 1
            ? "grid-rows-[0fr] group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr]"
            : "grid-rows-[1fr]",
        )}
      >
        <div className="overflow-hidden">
          <div
            className={cn(
              "flex items-center gap-2 pb-1 pr-1",
              compact ? "pl-8" : "pl-11",
            )}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              aria-label={silenced ? `Unmute ${name}` : `Mute ${name}`}
              aria-pressed={silenced}
              onClick={() => onSetVolume(silenced ? restoreRef.current : 0)}
            >
              {silenced ? (
                <VolumeX className="h-3.5 w-3.5 text-danger" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              aria-label={`Volume for ${name}`}
              aria-valuetext={`${Math.round(volume * 100)} percent`}
              onChange={(event) => onSetVolume(Number(event.target.value))}
              className="h-1 min-w-0 flex-1 cursor-pointer accent-signal"
            />
            <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-paper-muted">
              {Math.round(volume * 100)}%
            </span>
          </div>
        </div>
      </div>

    </li>
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
  isDeafened: boolean;
  /** peerId → 0..2 playback multiplier. Missing entries play at 1. */
  peerVolumes: Record<string, number>;
  error: string | null;
  compactPeers?: boolean;
  /** Media is going through an SFU — the mesh peer ceiling does not apply. */
  usingSfu?: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onSetPeerVolume: (peerId: string, volume: number) => void;
  onRetryPeer?: (peerId: string) => void;
}

export function VoicePanel({
  channelName,
  status,
  remotePeers,
  self,
  localPeerId,
  speakingPeerIds,
  isMuted,
  isDeafened,
  peerVolumes,
  error,
  compactPeers = false,
  usingSfu = false,
  onJoin,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onSetPeerVolume,
  onRetryPeer,
}: VoicePanelProps) {
  const showWarning = !usingSfu && remotePeers.length >= MESH_VOICE_WARNING;
  const speaking = new Set(speakingPeerIds);
  const connectedCount =
    (status === "connected" && self ? 1 : 0) + remotePeers.length;

  return (
    <div className="flex h-full min-h-0 flex-col border-b border-panel-hover lg:border-b-0 lg:border-r">
      <header className="flex h-12 shrink-0 items-center border-b border-panel-hover px-4 shadow-sm">
        <Mic className="h-5 w-5 text-muted" aria-hidden="true" />
        <span className="ml-2 font-semibold">{channelName}</span>
        {status === "connected" && (
          <span className="ml-2 flex items-center gap-1 text-xs text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            Live
          </span>
        )}
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-4">
        {error && (
          <div
            role="alert"
            className="flex w-full max-w-sm items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 break-words">{error}</p>
          </div>
        )}

        {status === "idle" && (
          <>
            <p className="max-w-xs text-center text-sm text-muted">
              Join voice to talk. Chat stays available below / beside.
            </p>
            <Button onClick={onJoin}>Join Voice</Button>
          </>
        )}

        {status === "joining" && (
          <>
            <p
              aria-live="polite"
              className="flex items-center gap-2 text-sm text-muted"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Connecting to {channelName}…
            </p>
            <Button variant="ghost" size="sm" onClick={onLeave}>
              Cancel
            </Button>
          </>
        )}

        {status === "connected" && (
          <div className="w-full max-w-sm space-y-3">
            {showWarning && (
              <p className="rounded bg-warning/20 px-3 py-2 text-center text-xs text-warning">
                Mesh limit approaching — configure an SFU for larger calls.
              </p>
            )}

            <div className="flex justify-center gap-2">
              <Button
                variant="secondary"
                size="icon"
                aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
                aria-pressed={isMuted}
                onClick={onToggleMute}
              >
                {isMuted ? (
                  <MicOff className="h-4 w-4 text-danger" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label={isDeafened ? "Undeafen" : "Deafen"}
                aria-pressed={isDeafened}
                onClick={onToggleDeafen}
              >
                {isDeafened ? (
                  <HeadphoneOff className="h-4 w-4 text-danger" />
                ) : (
                  <Headphones className="h-4 w-4" />
                )}
              </Button>
              <Button variant="danger" size="sm" onClick={onLeave}>
                <PhoneOff className="h-4 w-4" aria-hidden="true" />
                Leave
              </Button>
            </div>

            <div className="rounded-lg border border-ink-4 bg-ink p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-paper-muted">
                Connected ({connectedCount})
              </h3>
              <ul className={compactPeers ? "space-y-1" : "space-y-2"}>
                {self && (
                  <li className="flex items-center gap-2 px-1 py-0.5 text-sm">
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
                    {isDeafened ? (
                      <span className="flex items-center gap-1 rounded bg-danger/20 px-2 py-0.5 text-[10px] uppercase text-danger">
                        <HeadphoneOff className="h-3 w-3" aria-hidden="true" />
                        Deafened
                      </span>
                    ) : (
                      isMuted && (
                        <span className="flex items-center gap-1 rounded bg-danger/20 px-2 py-0.5 text-[10px] uppercase text-danger">
                          <MicOff className="h-3 w-3" aria-hidden="true" />
                          Muted
                        </span>
                      )
                    )}
                  </li>
                )}
                {remotePeers.map((peer) => (
                  <PeerRow
                    key={peer.peerId}
                    peer={peer}
                    compact={compactPeers}
                    isSpeaking={speaking.has(peer.peerId) && !isDeafened}
                    volume={peerVolumes[peer.userId ?? peer.peerId] ?? 1}
                    onSetVolume={(volume) =>
                      onSetPeerVolume(peer.userId ?? peer.peerId, volume)
                    }
                    onRetry={
                      onRetryPeer ? () => onRetryPeer(peer.peerId) : undefined
                    }
                  />
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
