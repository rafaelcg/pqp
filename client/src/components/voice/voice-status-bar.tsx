import { useMemo, type ReactNode } from "react";
import {
  Hash,
  Loader2,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import {
  Hash as HashBold,
  PhoneDisconnect,
  CircleNotch,
  MonitorArrowUp,
  Screencast,
  VideoCamera,
  VideoCameraSlash,
  Microphone,
} from "@phosphor-icons/react";
import { BringFriendsHint } from "@/components/layout/bring-friends-hint";
import { FeatureHint } from "@/components/layout/feature-hint";
import { Button } from "@/components/ui/button";
import { Icon, IconSwap } from "@/components/ui/icon";
import {
  SIDEBAR_FOOTER_CARD_COMPACT_REDESIGN as VOICE_STRIP_CARD_COMPACT_REDESIGN,
  SIDEBAR_FOOTER_CARD_REDESIGN as VOICE_STRIP_CARD_REDESIGN,
} from "@/components/ui/sidebar-block";
import { Tooltip } from "@/components/ui/tooltip";
import {
  canShareScreenAudio,
  supportsScreenShare,
} from "@/components/voice/capabilities";
import { desktopContext } from "@/lib/desktop";
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
  /**
   * Speaker for a voice room, hash when this call is a server text channel
   * (the linked chat). DMs and groups stay on the speaker: this strip is a
   * call, not a channel list.
   */
  channelType?: "voice" | "text";
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
   * Locked by audience mode rather than by the channel: the strip says
   * "Modo plateia" instead of "Só ouvindo" (`docs/plans/AUDIENCE_MODE.md`).
   */
  audienceLocked?: boolean;
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
  /**
   * `null` on the voice server for both: there is no count to name there, and
   * on mesh the number is derived from the room's measured link rather than
   * from a constant. See `meshVideoLimit`.
   */
  cameraLimit?: number | null;
  shareLimit?: number | null;
  /**
   * Override for tests. Default is the same `getDisplayMedia` probe the stage
   * uses, so Electron still shows share when that action works there.
   */
  canShareScreen?: boolean;
  onToggleCamera?: () => void;
  onToggleScreenShare?: () => void;
  onOpen: () => void;
  onLeave: () => void;
  /**
   * Drop the hang-up button. The 72px rail uses it when the composer dock is
   * on screen and already carries Leave; the full sidebar card always keeps it.
   */
  hideLeave?: boolean;
  /** One-shot share / Watch party coachmark when the stage is not on screen. */
  shareHintEnabled?: boolean;
  /** One-shot bring-friends coachmark when the stage is not on screen. */
  bringFriendsHintEnabled?: boolean;
  /**
   * The sidebar is 72px of icons. Only the two things that cannot wait survive
   * the squeeze: the call you are in, and the way out of it. Camera and share
   * are on the stage, which is what the collapsed sidebar made room for.
   */
  compact?: boolean;
  /** Drop the camera and share row. Nothing in the app sets this today. */
  hideActions?: boolean;
}

const ACTION = "h-9 w-full shrink-0 rounded-lg";

/** A round icon button in the strip. */
const STRIP_ICON_REDESIGN =
  "redesign:rounded-full redesign:focus-visible:ring-accent";
/** Hang up: the danger tone, its soft fill on hover. */
const LEAVE_REDESIGN =
  "redesign:text-danger redesign:hover:bg-danger-soft redesign:hover:text-on-danger-soft";

/**
 * Discord's Voice Connected corner: status + hang-up, the channel, camera, share.
 *
 * Mute and deafen live on the user panel under this strip, not here.
 */
export function VoiceStatusBar({
  channelName,
  channelType = "voice",
  status,
  isMuted,
  inputMode = "voice-activity",
  isTransmitting = true,
  listenOnly = false,
  audienceLocked = false,
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
  hideLeave = false,
  shareHintEnabled = false,
  bringFriendsHintEnabled = false,
  compact = false,
  hideActions = false,
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
  const showActionRow = (showCamera || showShare) && !hideActions;
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

  if (compact) {
    return (
      <div
        data-voice-bar-compact=""
        className={cn("flex flex-col items-center gap-1 border-t border-ink-4/60 bg-ink px-2 py-2", VOICE_STRIP_CARD_COMPACT_REDESIGN)}
      >
        {/* The sentence survives the squeeze even though the room for it does
            not. A 72px column cannot print "Voice connected", but a screen
            reader must still hear the same words the wide bar gives it: the
            state of your microphone is not a thing to say in colour alone.
            `aria-live` for the same reason the wide bar has it — connecting
            turning into connected is news. */}
        <p aria-live="polite" className="sr-only">
          {connected ? t("voice.bar.connected") : t("voice.bar.connecting")}
        </p>
        {connected ? (
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center justify-center redesign:h-3.5 redesign:w-3.5"
          >
            <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_8px_var(--glow-success)]" />
          </span>
        ) : (
          <IconSwap
            off={Loader2}
            on={CircleNotch}
            kind="symbol"
            offClassName="h-3 w-3 shrink-0 animate-spin text-warning"
            className="h-3.5 w-3.5 shrink-0 animate-spin text-warning"
          />
        )}
        {connected && (
          <Tooltip
            label={
              channelType === "text"
                ? t("voice.bar.openText", { name: channelName })
                : t("voice.bar.open", { name: channelName })
            }
            side="right"
          >
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8 shrink-0", STRIP_ICON_REDESIGN, "redesign:w-10 redesign:rounded-[var(--radius-row)] redesign:bg-[color:var(--card-row-hover)]")}
              data-voice-bar-channel={channelType}
              onClick={onOpen}
            >
              {channelType === "text" ? (
                <>
                  <Hash className="h-4 w-4 redesign:hidden" />
                  <Icon icon={HashBold} kind="symbol" size="sm" className="hidden redesign:block" />
                </>
              ) : (
                <>
                  <Volume2 className="h-4 w-4 redesign:hidden" />
                  <Icon icon={Microphone} size="sm" className="hidden redesign:block" />
                </>
              )}
            </Button>
          </Tooltip>
        )}
        {!hideLeave && (
        <Tooltip label={t("voice.bar.leave")} side="right">
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8 shrink-0", STRIP_ICON_REDESIGN, LEAVE_REDESIGN)}
            onClick={onLeave}
          >
            <PhoneOff className="h-4 w-4 text-danger redesign:hidden" />
            <Icon icon={PhoneDisconnect} size="md" className="hidden redesign:block" />
          </Button>
        </Tooltip>
        )}
      </div>
    );
  }

  return (
    <div
      data-voice-status-bar=""
      className={cn("border-t border-ink-4/60 bg-ink px-2 py-2", VOICE_STRIP_CARD_REDESIGN, "redesign:px-2.5 redesign:pt-2 redesign:pb-2.5")}
    >
      {/* Above the strip, out of the flow: in it the card lifted the whole
          bar (and the user row under it) by its own height. */}
      {(shareHintEnabled || bringFriendsHintEnabled) && (
        <div className="pointer-events-none relative z-30 h-0 [&>*]:pointer-events-auto">
          <div className="absolute inset-x-0 bottom-2">
            {shareHintEnabled && (
              <FeatureHint
                id="watchParty"
                enabled
                body={t("featureHint.watchParty.strip")}
              />
            )}
            {bringFriendsHintEnabled && <BringFriendsHint enabled />}
          </div>
        </div>
      )}
      <div className="flex items-center gap-1 redesign:gap-1.5 redesign:pl-0.5">
        {connected ? (
          <span
            className="flex shrink-0 items-center justify-center redesign:h-3.5 redesign:w-3.5"
            aria-hidden="true"
          >
            <span className="h-2 w-2 rounded-full bg-success shadow-[0_0_8px_var(--glow-success)]" />
          </span>
        ) : (
          <IconSwap
            off={Loader2}
            on={CircleNotch}
            kind="symbol"
            offClassName="h-3 w-3 shrink-0 animate-spin text-warning"
            className="h-3.5 w-3.5 shrink-0 animate-spin text-warning"
          />
        )}
        <p
          aria-live="polite"
          className={cn(
            "flex min-w-0 flex-1 items-baseline text-xs font-semibold redesign:text-[13px]",
            connected ? "text-success" : "text-warning",
          )}
        >
          <span className="shrink-0 whitespace-nowrap">
            {connected ? t("voice.bar.connected") : t("voice.bar.connecting")}
          </span>
          {connected && listenOnly && (
            <span
              data-listen-only
              className="ml-1.5 min-w-0 truncate text-[10px] font-normal normal-case tracking-normal text-warning redesign:text-[11px] redesign:font-medium"
            >
              {audienceLocked ? t("voice.audience.badge") : t("voice.bar.listenOnly")}
            </span>
          )}
          {showPttIdle && (
            <span className="ml-1 shrink-0 text-[9px] font-medium uppercase tracking-wide text-paper-muted redesign:ml-1.5 redesign:text-[11px] redesign:normal-case redesign:tracking-normal redesign:text-text-secondary">
              {t("voice.bar.pttIdle")}
            </span>
          )}
        </p>
        {connected && (
          <VoiceQualityMeter quality={quality} compact className="shrink-0" />
        )}
        {!hideLeave && (
        <Tooltip label={t("voice.bar.leave")}>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7 shrink-0 text-paper-muted hover:text-danger", STRIP_ICON_REDESIGN, "redesign:-my-1 redesign:h-8 redesign:w-8", LEAVE_REDESIGN)}
            aria-label={t("voice.bar.leave")}
            onClick={onLeave}
          >
            <PhoneOff className="h-4 w-4 redesign:hidden" />
            <Icon icon={PhoneDisconnect} size="md" className="hidden redesign:block" />
          </Button>
        </Tooltip>
        )}
      </div>

      {connected && (
        <Tooltip
          label={
            channelType === "text"
              ? t("channelMeta.kind.text")
              : t("channelMeta.kind.voice")
          }
          name={
            channelType === "text"
              ? t("voice.bar.openText", { name: channelName })
              : t("voice.bar.open", { name: channelName })
          }
        >
          <button
            type="button"
            onClick={onOpen}
            data-voice-bar-channel={channelType}
            className={cn(
              "mt-0.5 flex w-full min-w-0 items-center gap-1 rounded-md px-0.5 py-0.5 text-left text-xs text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
              // The room you are in, as a pill you can open.
              "redesign:-mx-1 redesign:w-[calc(100%+0.5rem)] redesign:gap-1.5 redesign:rounded-full redesign:px-1.5 redesign:py-1 redesign:text-[13px] redesign:text-text-secondary redesign:hover:bg-[color:var(--card-row-hover)] redesign:hover:text-text redesign:focus-visible:ring-accent",
            )}
          >
            {channelType === "text" ? (
              <>
                <Hash className="h-3 w-3 shrink-0 redesign:hidden" aria-hidden="true" />
                <Icon icon={HashBold} kind="symbol" size="sm" className="hidden h-3.5 w-3.5 shrink-0 redesign:block" />
              </>
            ) : (
              <>
                <Volume2 className="h-3 w-3 shrink-0 redesign:hidden" aria-hidden="true" />
                <Icon icon={Microphone} size="sm" className="hidden h-3.5 w-3.5 shrink-0 redesign:block" />
              </>
            )}
            <span className="min-w-0 truncate">
              {t("voice.bar.inChannel", { name: channelName })}
            </span>
          </button>
        </Tooltip>
      )}

      {showActionRow && (
        <div
          className={cn(
            "mt-1.5 grid gap-1.5 redesign:mt-2",
            showCamera && showShare ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          {showCamera && (
            <VoiceBarAction
              label={cameraLabel}
              detail={
                cameraCappedOut
                  ? t("voice.control.cameraLimit", { limit: cameraLimit ?? 0 })
                  : undefined
              }
              pressed={isCameraOn}
              disabled={cameraCappedOut}
              onClick={() => onToggleCamera?.()}
            >
              {isCameraOn ? (
                <>
                  <Video className="h-4 w-4 redesign:hidden" aria-hidden="true" />
                  <Icon icon={VideoCamera} size="sm" className="hidden redesign:block" />
                </>
              ) : (
                <>
                  <VideoOff className="h-4 w-4 redesign:hidden" aria-hidden="true" />
                  <Icon icon={VideoCameraSlash} size="sm" className="hidden redesign:block" />
                </>
              )}
            </VoiceBarAction>
          )}
          {showShare && (
            <VoiceBarAction
              label={shareLabel}
              detail={
                shareCappedOut
                  ? t("voice.control.shareLimit", { limit: shareLimit ?? 0 })
                  : !isSharingScreen && canShareScreenAudio()
                    ? t("voice.control.shareDetail", desktopContext())
                    : undefined
              }
              pressed={isSharingScreen}
              disabled={shareCappedOut}
              onClick={() => onToggleScreenShare?.()}
            >
              {isSharingScreen ? (
                <ScreenShareOff className="h-4 w-4 redesign:hidden" aria-hidden="true" />
              ) : (
                <ScreenShare className="h-4 w-4 redesign:hidden" aria-hidden="true" />
              )}
              {/* A glyph per state, as the camera has: sending up, then on air. */}
              <Icon icon={isSharingScreen ? Screencast : MonitorArrowUp} size="sm" className="hidden redesign:block" />
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
            "flex items-center justify-center bg-ink-4 text-paper transition-colors hover:bg-border-strong hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
            ACTION,
            pressed &&
              "bg-signal/30 text-signal hover:bg-signal/40 hover:text-signal",
            disabled &&
              "cursor-not-allowed opacity-40 hover:bg-ink-4 hover:text-paper",
            // A pill on the secondary button's fill; on, the accent's soft pair.
            "redesign:h-8 redesign:rounded-full redesign:bg-[color:var(--button-secondary-bg)] redesign:text-text redesign:hover:bg-[color:var(--button-secondary-hover)] redesign:hover:text-text redesign:focus-visible:ring-accent",
            pressed &&
              "redesign:bg-accent-soft redesign:text-on-accent-soft redesign:hover:bg-[color:color-mix(in_oklab,var(--color-accent-soft),var(--color-on-accent-soft)_10%)] redesign:hover:text-on-accent-soft",
            // At its limit the pill keeps its fill and only the glyph fades,
            // so it still reads as a button on a light pane.
            disabled &&
              "redesign:opacity-100 redesign:[&>svg]:opacity-40 redesign:hover:bg-[color:var(--button-secondary-bg)] redesign:hover:text-text",
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
