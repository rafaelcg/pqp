import { Eye, ScreenShare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * "You are still sharing", for a person who hid their own preview.
 *
 * The preview used to stay in the grid as a placeholder tile, which cost a
 * whole slot under a friend's screen. Without a tile the share would be
 * invisible to the one person who needs to know it is running, so this row
 * says it, and carries the way back. A row in the stage's own flow, never a
 * layer over a picture, and drawn for as long as the preview is hidden and
 * the share is up: it does not fade with the idle controls, because a status
 * that vanishes after three seconds is not honest about something that is
 * still going out.
 */
export function OwnShareStrip({
  onShowPreview,
  className,
}: {
  onShowPreview: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="own-share-strip"
      role="group"
      aria-label={t("voice.share.ownHiddenStrip")}
      className={cn(
        "on-media-scope flex shrink-0 items-center justify-center gap-2 px-3 py-1",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-on-media">
        <ScreenShare
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-signal"
        />
        <span className="truncate">{t("voice.share.ownHiddenStrip")}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="own-share-strip-show"
        className="shrink-0 rounded-full bg-black/70 px-2.5 text-on-media hover:bg-black/80 hover:text-on-media"
        onClick={onShowPreview}
      >
        <Eye aria-hidden="true" className="h-3.5 w-3.5" />
        {t("voice.share.showPreview")}
      </Button>
    </div>
  );
}
