import { useEffect, useRef, type FocusEvent } from "react";
import { JamHowToHero } from "@/components/jam/jam-howto";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { track } from "@/lib/track";

/**
 * "A Jam abriu": the one corner card that tells people already on pqp that
 * public jams exist (`lib/jam-announcement.ts` has who, when and the store).
 * The queue in `App` decides and passes `enabled`; this only draws.
 *
 * `hasSong` is whether the featured-song lookup found a public song (the site
 * hero's rule, `lib/jam-featured.ts`). With one the primary button is "Ouvir
 * uma jam" and the song waits for a tap on play; `canRecord` (the song takes a
 * part and this account may record) adds "Gravar minha parte"; and "Começar a
 * minha" is always there, because a card that says "grava a tua parte" must
 * never leave somebody with only a song to hear. With no song the primary is
 * "Começar uma jam", the honest offer on an empty catalogue. The caller does
 * what each means.
 *
 * Painting records nothing in the store; it does count one `jam_news_view`
 * per page load. Both buttons, the X and Escape go through the caller, which
 * stamps the browser. Not a live region: it is unsolicited, so it is a
 * labelled landmark a screen reader finds without being interrupted by it, and
 * it never takes focus. Somebody who tabbed into it gets focus back where they
 * came from when it is dismissed; acting on it moves the page, so focus is
 * left to the view that opens.
 */

let viewedThisLoad = false;

export function JamAnnouncementHint({
  enabled,
  hasSong,
  canRecord = false,
  onShowingChange,
  onListen,
  onRecord,
  onStart,
  onDismiss,
}: {
  enabled: boolean;
  hasSong: boolean;
  /** The featured song takes a part and this account may record one. */
  canRecord?: boolean;
  /** Told whether the card is up, so typing only holds its entrance. */
  onShowingChange?: (showing: boolean) => void;
  /** "Ouvir uma jam": the song, waiting for play. */
  onListen: () => void;
  /** "Gravar minha parte": the song, with the studio opening. */
  onRecord: () => void;
  /** "Começar a minha" (and the primary when there is no song). */
  onStart: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const cameFrom = useRef<HTMLElement | null>(null);
  const holder = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onShowingChange?.(enabled);
  }, [enabled, onShowingChange]);

  useEffect(() => {
    if (enabled && !viewedThisLoad) {
      viewedThisLoad = true;
      track("jam_news_view", { hasSong });
    }
  }, [enabled, hasSong]);

  const rememberWhereFrom = (event: FocusEvent<HTMLDivElement>) => {
    const from = event.relatedTarget;
    if (from instanceof HTMLElement && !holder.current?.contains(from)) {
      cameFrom.current = from;
    }
  };

  const close = (action: () => void, restore = true) => {
    const focusInside =
      typeof document !== "undefined" &&
      holder.current?.contains(document.activeElement) === true;
    action();
    const back = cameFrom.current;
    cameFrom.current = null;
    if (restore && focusInside && back?.isConnected) {
      back.focus();
    }
  };

  const dismiss = () => {
    track("jam_news_dismiss", { hasSong });
    close(onDismiss);
  };

  return (
    <div ref={holder} onFocus={rememberWhereFrom}>
      <CornerCard
        open={enabled}
        onClose={dismiss}
        label={t("jamAnnouncement.title")}
        dismissLabel={t("jamAnnouncement.dismiss")}
        dataAttribute="jam-announcement"
        hero={<JamHowToHero />}
        phoneHero={false}
        title={t("jamAnnouncement.title")}
        body={t("jamAnnouncement.body")}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="cta-lift rounded-full px-4"
              data-jam-announcement-action="listen"
              onClick={() => {
                track("jam_news_click", { hasSong, action: hasSong ? "listen" : "start" });
                close(hasSong ? onListen : onStart, false);
              }}
            >
              {hasSong ? t("jamAnnouncement.cta") : t("jamAnnouncement.ctaStart")}
            </Button>
            {hasSong && canRecord && (
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full px-4"
                data-jam-announcement-action="record"
                onClick={() => {
                  track("jam_news_click", { hasSong, action: "record" });
                  close(onRecord, false);
                }}
              >
                {t("jamAnnouncement.record")}
              </Button>
            )}
            {hasSong && (
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full px-4"
                data-jam-announcement-action="start"
                onClick={() => {
                  track("jam_news_click", { hasSong, action: "start" });
                  close(onStart, false);
                }}
              >
                {t("jamAnnouncement.start")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              onClick={dismiss}
            >
              {t("jamAnnouncement.later")}
            </Button>
          </div>
        }
      />
    </div>
  );
}

/** Test seam. */
export function resetJamAnnouncementViewForTests(): void {
  viewedThisLoad = false;
}
