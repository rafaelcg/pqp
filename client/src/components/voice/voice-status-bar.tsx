import { useMemo, type ReactNode } from "react";
import {
  Loader2,
  MicOff,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
} from "lucide-react";
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
  peerCount: number;
  isMuted: boolean;
  usingSfu: boolean;
  /**
   * Somebody in the call is sharing a screen — anybody, including you.
   *
   * This strip sits above the user panel for the whole call, the Discord
   * corner, so hangup stays in the same place whether you are in the channel
   * or have walked away. It is also the only place a live share is visible
   * from the rest of the app.
   */
  isPresenting?: boolean;
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
}

const ACTION = "h-10 w-full shrink-0";

/**
 * Discord's Voice Connected corner: status, the channel, camera, share, hangup.
 *
 * Mute and deafen live on the user panel under this strip, not here.
 */
export function VoiceStatusBar({
  channelName,
  status,
  peerCount,
  isMuted,
  usingSfu,
  isPresenting = false,
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
}: VoiceStatusBarProps) {
  const { t } = useTranslation();
  const connected = status === "connected";
  const total = peerCount + 1;
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
  const cameraLabel = isCameraOn
    ? t("voice.bar.cameraOff")
    : t("voice.bar.cameraOn");
  const shareLabel = isSharingScreen
    ? t("voice.bar.stopShare")
    : t("voice.bar.share");

  return (
    <div className="border-t border-ink-4/60 bg-ink px-2 py-2">
      <div className="flex items-center gap-1.5">
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
          {connected && (
            <span className="ml-1 min-w-0 truncate font-normal text-paper-muted">
              · {t("voice.bar.people", { count: total })}
            </span>
          )}
        </p>
        {connected && (
          <VoiceQualityMeter quality={quality} compact className="shrink-0" />
        )}
        {isPresenting && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-signal/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal">
            <ScreenShare className="h-3 w-3" aria-hidden="true" />
            {t("voice.tile.presenting")}
          </span>
        )}
        {listenOnly && (
          <span
            data-listen-only
            className="flex shrink-0 items-center gap-1 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning"
          >
            <MicOff className="h-3 w-3" aria-hidden="true" />
            {t("voice.bar.listenOnly")}
          </span>
        )}
        {usingSfu && (
          <span className="shrink-0 rounded bg-ink-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-paper-muted">
            SFU
          </span>
        )}
        {connected && !isMuted && !listenOnly && (
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
              isTransmitting
                ? "bg-accent/20 text-accent"
                : "bg-ink-3 text-paper-muted",
            )}
          >
            {inputMode === "push-to-talk"
              ? isTransmitting
                ? t("voice.bar.pttLive")
                : t("voice.bar.pttIdle")
              : isTransmitting
                ? t("voice.bar.vadLive")
                : t("voice.bar.vadIdle")}
          </span>
        )}
      </div>

      <div className="mt-1 grid grid-cols-3 gap-1">
        {showCamera ? (
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
        ) : (
          <span />
        )}
        {showShare ? (
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
        ) : (
          <span />
        )}
        {/* This widget is pinned to the bottom-left corner, so every bubble in
            it points up and away from the window edge rather than off it. */}
        <Tooltip label={t("voice.bar.leave")}>
          <Button
            variant="ghost"
            size="icon"
            className={ACTION}
            aria-label={t("voice.bar.leave")}
            onClick={onLeave}
          >
            <PhoneOff className="h-4 w-4 text-danger" />
          </Button>
        </Tooltip>
      </div>

      <button
        type="button"
        onClick={onOpen}
        aria-label={t("voice.bar.open", { name: channelName })}
        className="mt-1 w-full truncate rounded-md px-1.5 py-1 text-left text-sm text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
      >
        {channelName}
      </button>
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
      <span className="inline-flex w-full">
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
