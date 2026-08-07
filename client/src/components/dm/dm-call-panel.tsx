import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from "lucide-react";
import { useEffect, useRef } from "react";
import type { DmSummary, VoiceParticipant } from "@pqp/shared";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import { conversationTitle } from "@/lib/conversations";
import { cn } from "@/lib/utils";

/**
 * The call surface of a conversation, drawn above its messages.
 *
 * Deliberately NOT the channel `VoicePanel`: that component is a room you
 * navigate into, this is a call that happens on top of a conversation you are
 * already reading. It renders nothing at all while there is no call — the
 * conversation stays a text thread — and grows through three states:
 *
 * - somebody else is in a call here → a slim "N in call · Join" banner
 * - we are joining/ringing → the tiles with a status line
 * - live call → tiles (camera video when a participant sends it, avatar
 *   otherwise), mute / camera / hang-up controls
 *
 * Camera is off by default and only ever turned on by its own toggle here.
 */
export function DmCallPanel({
  conversation,
  currentUser,
  voiceState,
  onJoinCall,
  onLeave,
  onToggleMute,
  onToggleCamera,
}: {
  conversation: DmSummary;
  currentUser: { id: string; displayName: string; avatarUrl: string | null } | null;
  voiceState: VoiceState;
  onJoinCall: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
}) {
  const { t } = useTranslation();
  const channelId = conversation.channelId;
  const occupants = voiceState.occupancy[channelId] ?? [];
  const inThisCall =
    voiceState.voiceChannelId === channelId && voiceState.status !== "idle";

  if (!inThisCall && occupants.length === 0) {
    return null;
  }

  if (!inThisCall) {
    return (
      <div className="flex items-center gap-3 border-b border-ink-4/60 bg-ink-2/70 px-4 py-2">
        <OccupantFaces occupants={occupants} />
        <p className="min-w-0 flex-1 truncate text-sm text-paper-muted">
          {t("call.panel.inCall", { count: occupants.length })}
        </p>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md bg-success/90 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-success"
          onClick={onJoinCall}
        >
          <Phone className="h-3.5 w-3.5" />
          {t("call.panel.join")}
        </button>
      </div>
    );
  }

  const joining = voiceState.status === "joining";
  // "Calling…" is a 1:1/group call that we started and nobody has picked up:
  // connected, but alone in the room.
  const callingOut =
    voiceState.status === "connected" && voiceState.remotePeers.length === 0;
  const declinedNames = voiceState.callDeclinedUserIds
    .map(
      (userId) =>
        conversation.participants.find((p) => p.id === userId)?.displayName ??
        null,
    )
    .filter((name): name is string => name !== null);

  return (
    <div className="border-b border-ink-4/60 bg-ink-2/70 px-4 py-3">
      <div className="flex flex-wrap items-start gap-2">
        {currentUser && (
          <CallTile
            name={currentUser.displayName}
            avatarUrl={currentUser.avatarUrl}
            stream={voiceState.localCameraStream}
            mirrored
            speaking={
              voiceState.peerId !== null &&
              voiceState.speakingPeerIds.includes(voiceState.peerId)
            }
            muted={voiceState.isMuted}
          />
        )}
        {voiceState.remotePeers.map((peer) => (
          <CallTile
            key={peer.peerId}
            name={peer.displayName ?? t("voice.share.someone")}
            avatarUrl={peer.avatarUrl ?? null}
            stream={peer.cameraStream}
            speaking={voiceState.speakingPeerIds.includes(peer.peerId)}
            connecting={peer.connectionState !== "connected"}
          />
        ))}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate text-xs text-paper-muted"
          role="status"
        >
          {joining
            ? t("call.panel.connecting")
            : callingOut
              ? t("call.panel.calling")
              : conversationTitle(conversation.participants)}
          {declinedNames.map((name) => (
            <span key={name} className="ml-2 text-warning">
              {t("call.panel.declined", { name })}
            </span>
          ))}
        </p>
        <button
          type="button"
          title={
            voiceState.isMuted ? t("call.panel.unmute") : t("call.panel.mute")
          }
          aria-label={
            voiceState.isMuted ? t("call.panel.unmute") : t("call.panel.mute")
          }
          aria-pressed={voiceState.isMuted}
          className={cn(
            "rounded-full p-2",
            voiceState.isMuted
              ? "bg-danger/20 text-danger"
              : "bg-ink-3 text-paper hover:bg-ink-4",
          )}
          onClick={onToggleMute}
        >
          {voiceState.isMuted ? (
            <MicOff className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          title={
            voiceState.isCameraOn
              ? t("call.panel.cameraOn")
              : t("call.panel.cameraOff")
          }
          aria-label={
            voiceState.isCameraOn
              ? t("call.panel.cameraOn")
              : t("call.panel.cameraOff")
          }
          aria-pressed={voiceState.isCameraOn}
          className={cn(
            "rounded-full p-2",
            voiceState.isCameraOn
              ? "bg-signal/20 text-signal"
              : "bg-ink-3 text-paper hover:bg-ink-4",
          )}
          onClick={onToggleCamera}
        >
          {voiceState.isCameraOn ? (
            <Video className="h-4 w-4" />
          ) : (
            <VideoOff className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          title={t("call.panel.leave")}
          aria-label={t("call.panel.leave")}
          className="rounded-full bg-danger/90 p-2 text-paper hover:bg-danger"
          onClick={onLeave}
        >
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>

      {voiceState.error && (
        <p className="mt-1.5 text-xs text-danger">{voiceState.error}</p>
      )}
    </div>
  );
}

/** Small overlapped avatar row for the not-yet-joined banner. */
function OccupantFaces({ occupants }: { occupants: VoiceParticipant[] }) {
  return (
    <span className="flex shrink-0 -space-x-2" aria-hidden="true">
      {occupants.slice(0, 3).map((person) =>
        person.avatarUrl ? (
          <img
            key={person.peerId}
            src={person.avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-6 w-6 rounded-full object-cover ring-2 ring-ink-2"
          />
        ) : (
          <span
            key={person.peerId}
            className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-4 text-[10px] font-semibold text-paper ring-2 ring-ink-2"
          >
            {person.displayName.slice(0, 1).toUpperCase()}
          </span>
        ),
      )}
    </span>
  );
}

/** One participant: camera video when they send it, their face otherwise. */
function CallTile({
  name,
  avatarUrl,
  stream,
  mirrored = false,
  speaking = false,
  connecting = false,
  muted = false,
}: {
  name: string;
  avatarUrl: string | null;
  stream: MediaStream | null;
  mirrored?: boolean;
  speaking?: boolean;
  connecting?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      data-call-tile={name}
      className={cn(
        "relative h-24 w-32 overflow-hidden rounded-lg bg-ink-3 sm:h-28 sm:w-40",
        speaking && "ring-2 ring-success",
        connecting && "opacity-60",
      )}
    >
      {stream ? (
        <VideoSink stream={stream} mirrored={mirrored} />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="h-12 w-12 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-4 text-lg font-semibold text-paper">
              {name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
      )}
      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 truncate bg-ink/70 px-1.5 py-0.5 text-[10px] text-paper">
        {muted && <MicOff className="h-3 w-3 shrink-0 text-danger" />}
        <span className="truncate">{name}</span>
      </span>
    </div>
  );
}

/**
 * A `<video>` bound to a MediaStream. Always muted: call audio already plays
 * through `VoiceAudioSinks` at the app root, and playing it here too would
 * double every voice.
 */
function VideoSink({
  stream,
  mirrored,
}: {
  stream: MediaStream;
  mirrored: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) {
      return;
    }
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={cn(
        "h-full w-full object-cover",
        mirrored && "-scale-x-100",
      )}
    />
  );
}
