import type { VoiceInputMode, VoiceState } from "@/hooks/use-voice";
import type { VideoQuality } from "@/lib/video-quality";
import { CallStage } from "@/components/voice/call-stage";

/**
 * Server voice channel mount of the shared call stage.
 *
 * Idle join lives in the chat header and the channel list, not here. This
 * renders only while we are joining or connected to *this* channel.
 */
export function VoiceChannelStage({
  channelId,
  channelName,
  currentUser,
  voiceState,
  videoQuality,
  onLeave,
  onToggleMute,
  onToggleCamera,
  onVideoQualityChange,
  onStartScreenShare,
  onShareWithoutSound,
  onStopScreenShare,
  shareSystemAudio = false,
  onShareSystemAudioChange,
  onFocusScreenShare,
  inputMode,
  pushToTalkKeyLabel,
  windowFocused,
  onPushToTalk,
  onSetPeerVolume,
  onSetScreenVolume,
  onRetryPeer,
  compactPeers = false,
}: {
  channelId: string;
  channelName: string;
  currentUser: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  voiceState: VoiceState;
  videoQuality: VideoQuality;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  onStartScreenShare?: () => void;
  onShareWithoutSound?: () => void;
  onStopScreenShare?: () => void;
  shareSystemAudio?: boolean;
  onShareSystemAudioChange?: (next: boolean) => void;
  onFocusScreenShare?: (peerId: string) => void;
  inputMode?: VoiceInputMode;
  pushToTalkKeyLabel?: string | null;
  windowFocused?: boolean;
  onPushToTalk?: (held: boolean) => void;
  onSetPeerVolume?: (peerId: string, volume: number) => void;
  onSetScreenVolume?: (userId: string, volume: number) => void;
  onRetryPeer?: (peerId: string) => void;
  compactPeers?: boolean;
}) {
  const inThisCall =
    voiceState.voiceChannelId === channelId && voiceState.status !== "idle";
  if (!inThisCall) {
    return null;
  }

  return (
    <CallStage
      channelId={channelId}
      title={channelName}
      currentUser={currentUser}
      voiceState={voiceState}
      videoQuality={videoQuality}
      onLeave={onLeave}
      onToggleMute={onToggleMute}
      onToggleCamera={onToggleCamera}
      onVideoQualityChange={onVideoQualityChange}
      onStartScreenShare={onStartScreenShare}
      onShareWithoutSound={onShareWithoutSound}
      onStopScreenShare={onStopScreenShare}
      shareSystemAudio={shareSystemAudio}
      onShareSystemAudioChange={onShareSystemAudioChange}
      onFocusScreenShare={onFocusScreenShare}
      inputMode={inputMode}
      pushToTalkKeyLabel={pushToTalkKeyLabel}
      windowFocused={windowFocused}
      onPushToTalk={onPushToTalk}
      onSetPeerVolume={onSetPeerVolume}
      onSetScreenVolume={onSetScreenVolume}
      onRetryPeer={onRetryPeer}
      compactPeers={compactPeers}
      controlsMayIdle={false}
      ringWhenAlone={false}
    />
  );
}
