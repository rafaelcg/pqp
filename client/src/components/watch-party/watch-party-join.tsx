import { Play } from "lucide-react";
import type { WatchPartyState } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

/**
 * The join gesture.
 *
 * THIS IS THE FEATURE, NOT AN OBSTACLE IN FRONT OF IT. Every browser refuses
 * to start a video that no human asked for, per person, per document. There is
 * no way around that and we are not looking for one: an autoplay workaround is
 * a bug that a browser update fixes for us later, at the worst possible
 * moment.
 *
 * So the click is spent on something instead of being spent apologising. What
 * this card says is where the channel is right now and that clicking puts you
 * there with them, which is the actual proposition of a watch party and the
 * one sentence that makes somebody want to press the button. The browser's
 * requirement is a small line underneath, phrased as a fact about how videos
 * work rather than as a warning about something having gone wrong. Nobody has
 * ever felt invited by "playback was blocked".
 *
 * NOTHING IS LOADED UNTIL THE CLICK. Not the iframe, not the thumbnail from
 * i.ytimg.com. A gate that has already told Google who is behind it is not a
 * gate, and the card is designed to work without a picture for exactly that
 * reason.
 */
export interface WatchPartyJoinProps {
  status: WatchPartyState["status"];
  /**
   * Called synchronously inside the click handler.
   *
   * Order matters and is the whole reason this is a prop rather than something
   * the panel does on its own: the handler runs during the user activation,
   * and the player mounts on the commit right after it. Anything the container
   * has to do while the activation is fresh has to happen in here.
   */
  onJoin: () => void;
}

export function WatchPartyJoin({ status, onJoin }: WatchPartyJoinProps) {
  const { t } = useTranslation();
  const headline =
    status === "playing"
      ? t("watchParty.join.playing")
      : status === "ended"
        ? t("watchParty.join.ended")
        : t("watchParty.join.paused");

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-paper">{headline}</p>
        <p className="text-xs text-paper-muted">{t("watchParty.join.body")}</p>
      </div>
      <Button className="px-6" onClick={onJoin}>
        <Play className="h-4 w-4" aria-hidden="true" />
        {t("watchParty.join.cta")}
      </Button>
      <p className="max-w-xs text-[11px] text-paper-muted/80">
        {t("watchParty.join.note")}
      </p>
    </div>
  );
}
