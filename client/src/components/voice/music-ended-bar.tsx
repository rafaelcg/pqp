import { Play, RotateCcw, X } from "lucide-react";
import type { MusicTrack } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * THE END OF A QUEUE, PARKED.
 *
 * The bar used to key on `current`, and `musicAdvance` leaves that null
 * when the last track finishes, so the player disappeared out from under
 * the hand that skipped it: the control gone mid-gesture, and the song you
 * had just heard gone with it. Every player people already know (Spotify,
 * YouTube Music) holds the last track and offers it back, and that is what
 * this is: the finished track, dimmed, one button to play it again, and the
 * field above still open for whatever comes next.
 *
 * It is not a state of the ROOM. `lib/music-store.ts` holds it per machine,
 * set on the transition, so nobody who joins later is shown a stranger's
 * last song.
 */
export function MusicEndedBar({
  track,
  canAdd,
  onPlayAgain,
  onDismiss,
  tone = "composer",
}: {
  track: MusicTrack;
  /** Without SPEAK there is nothing this person may put back on. */
  canAdd: boolean;
  onPlayAgain: () => void;
  onDismiss: () => void;
  tone?: "composer" | "rail";
}) {
  const { t } = useTranslation();
  const composer = tone === "composer";
  const muted = composer ? "text-text-secondary" : "text-paper-muted";
  const title = composer ? "text-text" : "text-paper";
  const thumb = composer ? "bg-surface-3" : "bg-ink-3";
  const icon = composer
    ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-3 hover:text-text"
    : "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-paper-muted hover:bg-ink-3 hover:text-paper";

  return (
    <div
      data-music-ended=""
      className="flex min-w-0 items-center gap-3 px-3 py-2"
    >
      <span
        className={cn(
          "relative h-10 w-10 shrink-0 overflow-hidden rounded-md opacity-60",
          thumb,
        )}
      >
        {track.thumbnailUrl ? (
          <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Play className={cn("m-auto h-4 w-4", muted)} aria-hidden="true" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm font-medium", title)}>
          {t("music.ended.title")}
        </span>
        <span className={cn("truncate text-xs", muted)}>{track.title}</span>
      </span>
      {canAdd ? (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0 rounded-full px-3"
          onClick={onPlayAgain}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("music.playAgain")}
        </Button>
      ) : null}
      <Tooltip label={t("music.ended.dismiss")} side="top">
        <button
          type="button"
          data-music-ended-dismiss=""
          className={icon}
          aria-label={t("music.ended.dismiss")}
          onClick={onDismiss}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}
