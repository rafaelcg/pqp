import { useMemo, type ReactNode } from "react";
import {
  Loader2,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
} from "lucide-react";
import { FeatureHint } from "@/components/layout/feature-hint";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { supportsScreenShare } from "@/components/voice/capabilities";
import { VoiceQualityMeter } from "@/components/voice/voice-quality-meter";
import { useVoiceLinkQuality } from "@/hooks/use-voice-link-quality";
import { useTranslation } from "@/lib/i18n";
import {
  aggregateQuality,
  type VoiceLinkQuality,
} from "@/lib/voice-link-quality";
import { cn } from "@/lib/utils";

interface VoiceStatusBarProps {
  channelName: string;
  status: "idle" | "joining" | "connected";
  isMuted: boolean;
  /**
   * Push-to-talk state: without it a closed push-to-talk mic looks identical
   * to an open one once you have left the channel.
   */
  inputMode?: "voice-activity" | "push-to-talk";
  isTransmitting?: boolean;
  /**
   * The channel does not let this person speak (`Permission.SPEAK` denied).
   * Shown here because this strip is the one place the call is visible from
   * the rest of the app, and a locked mic with no label reads as broken.
   */
  listenOnly?: boolean;
  /**
   * SFU readings already attached to remote peers. The mesh half is sampled
   * here; this list is how LiveKit's Excellent / Good / Poor reach the strip.
   */
  peerQualities?: VoiceLinkQuality[];
  /**
   * `Permission.STREAM`. False hides camera and share, same as the stage and
   * channel settings. Mute and deafen stay on the user panel under this strip.
   */
  canStream?: boolean;
  isCameraOn?: boolean;
  isSharingScreen?: boolean;
  cameraCappedOut?: boolean;
  shareCappedOut?: boolean;
  cameraLimit?: number;
  shareLimit?: number;
  /**
   * Override for tests. Default is the same `getDisplayMedia` probe the stage
   * uses, so Electron still shows share when that action works there.
   */
  canShareScreen?: boolean;
  onToggleCamera?: () => void;
  onToggleScreenShare?: () => void;
  onOpen: () => void;
  onLeave: () => void;
  /** One-shot share / Watch party coachmark when the stage is not on screen. */
  shareHintEnabled?: boolean;
}

const ACTION = "h-8 w-full shrink-0";

/**
 * Discord's Voice Connected corner: status + hang-up, the channel, camera, share.
 *
 * Mute and deafen live on the user panel under this strip, not here.
 */
export function VoiceStatusBar({
  channelName,
  status,
  isMuted,
  inputMode = "voice-activity",
  isTransmitting = true,
  listenOnly = false,
  peerQualities = [],
  canStream = true,
  isCameraOn = false,
  isSharingScreen = false,
  cameraCappedOut = false,
  shareCappedOut = false,
  cameraLimit = 0,
  shareLimit = 0,
  canShareScreen,
  onToggleCamera,
  onToggleScreenShare,
  onOpen,
  onLeave,
  shareHintEnabled = false,
}: VoiceStatusBarProps) {
  const { t } = useTranslation();
  const connected = status === "connected";
  const meshQuality = useVoiceLinkQuality(connected);
  const quality = aggregateQuality([
    ...Object.values(meshQuality),
    ...peerQualities,
  ]);
  const platformCanShare = useMemo(
    () => canShareScreen ?? supportsScreenShare(),
    [canShareScreen],
  );
  const showVideoActions = connected && canStream;
  const showCamera = showVideoActions && onToggleCamera != null;
  const showShare =
    showVideoActions && onToggleScreenShare != null && platformCanShare;
  const showActionRow = showCamera || showShare;
  const cameraLabel = isCameraOn
    ? t("voice.bar.cameraOff")
    : t("voice.bar.cameraOn");
  const shareLabel = isSharingScreen
    ? t("voice.bar.stopShare")
    : t("voice.bar.share");
  const showPttIdle =
    connected &&
    !isMuted &&
    !listenOnly &&
    inputMode === "push-to-talk" &&
    !isTransmitting;

  return (
    <div className="border-t border-ink-4/60 bg-ink px-2 py-2">
      {shareHintEnabled && (
        <div className="mb-2">
          <FeatureHint
            id="watchParty"
            enabled
            body={t("featureHint.watchParty.strip")}
          />
        </div>
      )}
      <div className="flex items-center gap-1">
        {connected ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-success shadow-[0_0_8px_var(--glow-success)]"
            aria-hidden="true"
          />
        ) : (
          <Loader2
            className="h-3 w-3 shrink-0 animate-spin text-warning"
            aria-hidden="true"
          />
        )}
        <p
          aria-live="polite"
          className={cn(
            "flex min-w-0 flex-1 items-baseline text-xs font-semibold",
            connected ? "text-success" : "text-warning",
          )}
        >
          <span className="shrink-0 whitespace-nowrap">
            {connected ? t("voice.bar.connected") : t("voice.bar.connecting")}
          </span>
          {connected && listenOnly && (
            <span
              data-listen-only
              className="ml-1.5 min-w-0 truncate text-[10px] font-normal normal-case tracking-normal text-warning"
            >
              {t("voice.bar.listenOnly")}
            </span>
          )}
          {showPttIdle && (
            <span className="ml-1 shrink-0 text-[9px] font-medium uppercase tracking-wide text-paper-muted">
              {t("voice.bar.pttIdle")}
            </span>
          )}
        </p>
        {connected && (
          <VoiceQualityMeter quality={quality} compact className="shrink-0" />
        )}
        {/* This widget is pinned to the bottom-left corner, so every bubble in
            it points up and away from the window edge rather than off it. */}
        <Tooltip label={t("voice.bar.leave")}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            aria-label={t("voice.bar.leave")}
            onClick={onLeave}
          >
            <PhoneOff className="h-4 w-4 text-danger" />
          </Button>
        </Tooltip>
      </div>

      {connected && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("voice.bar.open", { name: channelName })}
          className="mt-0.5 w-full truncate rounded-md px-0.5 py-0.5 text-left text-xs text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
        >
          {channelName}
        </button>
      )}

      {showActionRow && (
        <div
          className={cn(
            "mt-1 grid gap-1",
            showCamera && showShare ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          {showCamera && (
            <VoiceBarAction
              label={cameraLabel}
              detail={
                cameraCappedOut
                  ? t("voice.control.cameraLimit", { limit: cameraLimit })
                  : undefined
              }
              pressed={isCameraOn}
              disabled={cameraCappedOut}
              onClick={() => onToggleCamera?.()}
            >
              {isCameraOn ? (
                <Video className="h-4 w-4" aria-hidden="true" />
              ) : (
                <VideoOff className="h-4 w-4" aria-hidden="true" />
              )}
            </VoiceBarAction>
          )}
          {showShare && (
            <VoiceBarAction
              label={shareLabel}
              detail={
                shareCappedOut
                  ? t("voice.control.shareLimit", { limit: shareLimit })
                  : undefined
              }
              pressed={isSharingScreen}
              disabled={shareCappedOut}
              onClick={() => onToggleScreenShare?.()}
            >
              {isSharingScreen ? (
                <ScreenShareOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ScreenShare className="h-4 w-4" aria-hidden="true" />
              )}
            </VoiceBarAction>
          )}
        </div>
      )}
    </div>
  );
}

function VoiceBarAction({
  label,
  detail,
  pressed = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  detail?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} detail={detail}>
      <span className="inline-flex min-w-0 w-full">
        <button
          type="button"
          aria-pressed={pressed}
          aria-disabled={disabled || undefined}
          aria-label={label}
          className={cn(
            "flex items-center justify-center rounded-md text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
            ACTION,
            pressed &&
              "bg-signal/20 text-signal hover:bg-signal/25 hover:text-signal",
            disabled &&
              "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-paper-muted",
          )}
          onClick={() => {
            if (disabled) {
              return;
            }
            onClick();
          }}
        >
          {children}
        </button>
      </span>
    </Tooltip>
  );
}
