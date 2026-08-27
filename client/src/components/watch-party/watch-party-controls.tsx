import { Pause, Play, RotateCcw, RotateCw, X, Youtube } from "lucide-react";
import type { WatchPartyState } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import {
  SKIP_MS,
  statusKey,
  type TransportAvailability,
} from "@/components/watch-party/watch-party-view";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The transport bar, and what the channel is currently doing.
 *
 * IT SITS BELOW THE PLAYER AND NEVER OVER IT. The IFrame API's terms forbid
 * modifying, hiding or overlaying the player's own chrome, which rules out the
 * tidy-looking design where our controls fade in across the bottom of the
 * video. That constraint costs less than it sounds: YouTube's chrome already
 * has a scrubber, a volume control and a fullscreen button that all work, so
 * the only things worth adding are the ones that mean something to a *group*:
 * play and pause, which everybody feels, and a ten second jump back for when
 * somebody talked over a line.
 *
 * There is no scrubber of our own for the same reason. Dragging YouTube's own
 * one is observed by `lib/watch-party/player.ts` and becomes a seek for the
 * whole channel, so a second scrubber would be a second way to do a thing that
 * already works, drawn where we are not allowed to draw it.
 *
 * NOTHING HERE DECIDES ANYTHING. Every button is an intent. What a skip does
 * to the shared clock, whose write wins, and whether the room needs correcting
 * afterwards all belong to `lib/watch-party/state.ts`.
 *
 * THERE IS NO "SENDING" STATE, AND THAT IS A DECISION. A local action is
 * applied optimistically and only acknowledged when the server echoes it back,
 * so there is a real window in which this bar is showing something unconfirmed.
 * It is not shown. The window is one round trip on a socket that is already
 * carrying the call's own signalling, the resend machinery in `state` recovers
 * the case where the echo never lands, and a pause button that flickered
 * through a pending look every time somebody pressed it would make a working
 * feature feel unreliable. The failure this would guard against is a stuck
 * button; the cost is paid on every press that works.
 */
export interface WatchPartyControlsProps {
  status: WatchPartyState["status"];
  /** Display name of the last writer, when we can resolve one. */
  actorName?: string | null;
  actorIsSelf?: boolean;
  /**
   * `on` dispatches. `unavailable` renders the same three controls dimmed and
   * says why, for a participant whose own player has failed and who must never
   * write. `off` renders none of them.
   */
  transport: TransportAvailability;
  onPlay: () => void;
  onPause: () => void;
  onSkip: (deltaMs: number) => void;
  onChangeVideo?: () => void;
  onEndParty?: () => void;
}

export function WatchPartyControls({
  status,
  actorName,
  actorIsSelf = false,
  transport,
  onPlay,
  onPause,
  onSkip,
  onChangeVideo,
  onEndParty,
}: WatchPartyControlsProps) {
  const { t } = useTranslation();
  const playing = status === "playing";
  const driving = transport === "on";

  return (
    <div className="shrink-0 border-t border-panel-hover bg-ink px-3 py-2">
      <div className="flex items-center gap-2">
        {transport !== "off" && (
          <>
            <Button
              variant="secondary"
              size="icon"
              className={cn("h-8 w-8", !driving && "opacity-40")}
              aria-label={
                playing
                  ? t("watchParty.control.pause")
                  : t("watchParty.control.play")
              }
              aria-pressed={playing}
              // `aria-disabled` rather than `disabled`, the same choice the
              // voice panel makes for a control the platform will not honour:
              // a disabled button is invisible to a screen reader's tab order
              // and unreachable on a phone, and the whole point of showing it
              // is that the person can see the rule exists.
              aria-disabled={!driving || undefined}
              onClick={driving ? () => (playing ? onPause() : onPlay()) : undefined}
            >
              {playing ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", !driving && "opacity-40")}
              aria-label={t("watchParty.control.back")}
              aria-disabled={!driving || undefined}
              onClick={driving ? () => onSkip(-SKIP_MS) : undefined}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", !driving && "opacity-40")}
              aria-label={t("watchParty.control.forward")}
              aria-disabled={!driving || undefined}
              onClick={driving ? () => onSkip(SKIP_MS) : undefined}
            >
              <RotateCw className="h-4 w-4" />
            </Button>
          </>
        )}

        {/* `aria-live` because this line is how a screen reader learns that
            somebody else paused the video, which is otherwise a silent event
            happening inside a cross-origin iframe. */}
        <p
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-xs text-paper-muted"
        >
          {t(statusKey(status, actorName, actorIsSelf), {
            name: actorName ?? "",
          })}
        </p>

        {onChangeVideo && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={onChangeVideo}
          >
            <Youtube className="h-3.5 w-3.5" aria-hidden="true" />
            {t("watchParty.control.change")}
          </Button>
        )}
        {onEndParty && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={t("watchParty.control.end")}
            onClick={onEndParty}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {transport === "unavailable" && (
        <p className="mt-1 text-[11px] text-paper-muted/80">
          {t("watchParty.control.unavailable")}
        </p>
      )}
    </div>
  );
}
