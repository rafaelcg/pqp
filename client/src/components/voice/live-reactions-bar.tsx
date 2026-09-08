import { LIVE_REACTION_EMOJIS, type LiveReactionEmoji } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { echoLocalLiveReaction } from "@/lib/live-reactions";
import { cn } from "@/lib/utils";

/**
 * The row of taps, docked at the bottom edge of a video stage.
 *
 * Deliberately not a picker and deliberately not a text field: the set is the
 * six in `LIVE_REACTION_EMOJIS`, closed on the server as well as here, so
 * nothing a viewer composes reaches another viewer's screen through this path.
 *
 * Every tap echoes locally before the frame leaves (`echoLocalLiveReaction`).
 * That is the difference between a button that feels instant and one that
 * feels broken during the 250ms the server spends coalescing.
 */

export interface LiveReactionsBarProps {
  channelId: string;
  /** Sends the frame. The bar never touches the transport itself. */
  onReact: (emoji: LiveReactionEmoji) => void;
  className?: string;
}

export function LiveReactionsBar({
  channelId,
  onReact,
  className,
}: LiveReactionsBarProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "absolute bottom-2 right-2 z-30 flex items-center gap-0.5 rounded-full bg-ink/70 px-1 py-0.5 backdrop-blur",
        className,
      )}
      data-testid="live-reactions-bar"
      role="group"
      aria-label={t("voice.liveReactions.barLabel")}
    >
      {LIVE_REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="rounded-full px-1.5 py-1 text-base leading-none transition hover:scale-125 hover:bg-paper/10 active:scale-95"
          title={t("voice.liveReactions.send", { emoji })}
          aria-label={t("voice.liveReactions.send", { emoji })}
          onClick={() => {
            echoLocalLiveReaction(channelId, emoji);
            onReact(emoji);
          }}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
