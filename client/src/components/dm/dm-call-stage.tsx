import { Phone } from "lucide-react";
import type { DmSummary } from "@pqp/shared";
import type { VoiceState } from "@/hooks/use-voice";
import type { VideoQuality } from "@/lib/video-quality";
import { useTranslation } from "@/lib/i18n";
import { conversationTitle } from "@/lib/conversations";
import {
  CallStage,
  OccupantFaces,
} from "@/components/voice/call-stage";

/**
 * The call surface of a conversation — a stage on top of a thread you are
 * already reading.
 *
 * Renders nothing while there is no call. Somebody else in a call here is a
 * slim "N in call · Join" banner. Once we are in it, the shared `CallStage`
 * owns the picture: a slim bar for voice-only, the full stage when a camera
 * or a screen is on.
 */
export function DmCallStage({
  conversation,
  currentUser,
  voiceState,
  videoQuality,
  onJoinCall,
  onLeave,
  onToggleMute,
  onToggleCamera,
  onVideoQualityChange,
  onStartScreenShare,
  onStopScreenShare,
  shareSystemAudio = false,
  onShareSystemAudioChange,
  onFocusScreenShare,
  compactPeers = false,
}: {
  conversation: DmSummary;
  currentUser: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  voiceState: VoiceState;
  videoQuality: VideoQuality;
  onJoinCall: () => void;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  onStartScreenShare?: () => void;
  shareSystemAudio?: boolean;
  onShareSystemAudioChange?: (next: boolean) => void;
  onStopScreenShare?: () => void;
  onFocusScreenShare?: (peerId: string) => void;
  compactPeers?: boolean;
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
        <OccupantFaces
          faces={occupants.map((person) => ({
            key: person.peerId,
            displayName: person.displayName,
            avatarUrl: person.avatarUrl,
          }))}
        />
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

  const declinedNames = voiceState.callDeclinedUserIds
    .map(
      (userId) =>
        conversation.participants.find((person) => person.id === userId)
          ?.displayName ?? null,
    )
    .filter((name): name is string => name !== null);

  return (
    <CallStage
      channelId={channelId}
      title={conversationTitle(conversation.participants)}
      currentUser={currentUser}
      voiceState={voiceState}
      videoQuality={videoQuality}
      ringFaces={conversation.participants.map((person) => ({
        id: person.id,
        displayName: person.displayName,
        avatarUrl: person.avatarUrl,
      }))}
      declinedNames={declinedNames}
      playOutgoingRingtone
      onLeave={onLeave}
      onToggleMute={onToggleMute}
      onToggleCamera={onToggleCamera}
      onVideoQualityChange={onVideoQualityChange}
      onStartScreenShare={onStartScreenShare}
      onStopScreenShare={onStopScreenShare}
      shareSystemAudio={shareSystemAudio}
      onShareSystemAudioChange={onShareSystemAudioChange}
      onFocusScreenShare={onFocusScreenShare}
      compactPeers={compactPeers}
    />
  );
}
