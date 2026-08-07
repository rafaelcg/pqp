import {
  HeadphoneOff,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  ScreenShare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface VoiceStatusBarProps {
  channelName: string;
  status: "idle" | "joining" | "connected";
  peerCount: number;
  isMuted: boolean;
  isDeafened: boolean;
  usingSfu: boolean;
  /**
   * Somebody in the call is sharing a screen — anybody, including you.
   *
   * This widget is what you see *after* navigating out of the voice channel, so
   * it is the only place a live share is visible from the rest of the app.
   * Without it, walking away from the channel makes a running presentation
   * indistinguishable from no presentation.
   */
  isPresenting?: boolean;
  onOpen: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onLeave: () => void;
}

export function VoiceStatusBar({
  channelName,
  status,
  peerCount,
  isMuted,
  isDeafened,
  usingSfu,
  isPresenting = false,
  onOpen,
  onToggleMute,
  onToggleDeafen,
  onLeave,
}: VoiceStatusBarProps) {
  const { t } = useTranslation();
  const connected = status === "connected";
  const total = peerCount + 1;

  return (
    <div className="border-t border-ink-4/60 bg-ink px-2 py-2">
      <div className="flex items-center gap-2">
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
            "min-w-0 flex-1 truncate text-xs font-semibold",
            connected ? "text-success" : "text-warning",
          )}
        >
          {connected ? t("voice.bar.connected") : t("voice.bar.connecting")}
          {connected && (
            <span className="ml-1 font-normal text-paper-muted">
              ·{" "}
              {total === 1
                ? t("voice.bar.person", { count: total })
                : t("voice.bar.people", { count: total })}
            </span>
          )}
        </p>
        {isPresenting && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-signal/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal">
            <ScreenShare className="h-3 w-3" aria-hidden="true" />
            {t("voice.tile.presenting")}
          </span>
        )}
        {usingSfu && (
          <span className="shrink-0 rounded bg-ink-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-paper-muted">
            SFU
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={t("voice.bar.leave")}
          onClick={onLeave}
        >
          <PhoneOff className="h-4 w-4 text-danger" />
        </Button>
      </div>

      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          onClick={onOpen}
          aria-label={t("voice.bar.open", { name: channelName })}
          className="min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left text-sm text-paper-muted transition-colors hover:bg-ink-3 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
        >
          <Mic className="mr-1 inline-block h-3 w-3 align-[-1px] text-paper-muted" />
          {channelName}
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={
            isMuted ? t("voice.control.unmute") : t("voice.control.mute")
          }
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
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={
            isDeafened
              ? t("voice.control.undeafen")
              : t("voice.control.deafen")
          }
          aria-pressed={isDeafened}
          onClick={onToggleDeafen}
        >
          {isDeafened ? (
            <HeadphoneOff className="h-4 w-4 text-danger" />
          ) : (
            <Headphones className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
