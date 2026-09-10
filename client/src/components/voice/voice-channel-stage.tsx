import type { VoiceInputMode, VoiceState } from "@/hooks/use-voice";
import type { CallStageShape } from "@/lib/call-split";
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
  serverName = null,
  serverIconUrl = null,
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
  onFocusScreenShare,
  inputMode,
  pushToTalkKeyLabel,
  windowFocused,
  onPushToTalk,
  onSetPeerVolume,
  onSetScreenVolume,
  onDismissShare,
  onWatchShare,
  onRetryPeer,
  onToggleRaisedHand,
  canLowerHands = false,
  onLowerHand,
  compactPeers = false,
  fill = false,
  onShapeChange,
  watchPartyChrome,
}: {
  channelId: string;
  channelName: string;
  serverName?: string | null;
  serverIconUrl?: string | null;
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
  onStartScreenShare?: (
    intent?: { preferBrowserTab?: boolean },
  ) => void | Promise<void>;
  onShareWithoutSound?: () => void;
  onStopScreenShare?: () => void;
  onFocusScreenShare?: (peerId: string) => void;
  inputMode?: VoiceInputMode;
  pushToTalkKeyLabel?: string | null;
  windowFocused?: boolean;
  onPushToTalk?: (held: boolean) => void;
  onSetPeerVolume?: (peerId: string, volume: number) => void;
  onSetScreenVolume?: (userId: string, volume: number) => void;
  onDismissShare?: (peerId: string) => void;
  onWatchShare?: (peerId: string) => void;
  onRetryPeer?: (peerId: string) => void;
  /** Our own hand in this room's queue. */
  onToggleRaisedHand?: () => void;
  /** `Permission.MUTE_MEMBERS` here: may lower somebody else's hand. */
  canLowerHands?: boolean;
  onLowerHand?: (userId: string) => void;
  compactPeers?: boolean;
  /** See `CallStage.watchPartyChrome`. */
  watchPartyChrome?: boolean;
  /** The pane's divider owns the stage's height. See `CallSplit`. */
  fill?: boolean;
  onShapeChange?: (shape: CallStageShape) => void;
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
      serverName={serverName}
      serverIconUrl={serverIconUrl}
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
      onFocusScreenShare={onFocusScreenShare}
      inputMode={inputMode}
      pushToTalkKeyLabel={pushToTalkKeyLabel}
      windowFocused={windowFocused}
      onPushToTalk={onPushToTalk}
      onSetPeerVolume={onSetPeerVolume}
      onSetScreenVolume={onSetScreenVolume}
      onDismissShare={onDismissShare}
      onWatchShare={onWatchShare}
      onRetryPeer={onRetryPeer}
      onToggleRaisedHand={onToggleRaisedHand}
      canLowerHands={canLowerHands}
      onLowerHand={onLowerHand}
      compactPeers={compactPeers}
      watchPartyChrome={watchPartyChrome}
      ringWhenAlone={false}
      fill={fill}
      onShapeChange={onShapeChange}
    />
  );
}
