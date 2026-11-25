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
 * `hasSong` is whether the top-song lookup found a public song. With one the
 * primary button is "Ouvir uma jam"; with none it is "Começar uma jam", which
 * is the honest offer on an empty catalogue. The caller does what each means.
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
  onShowingChange,
  onOpen,
  onDismiss,
}: {
  enabled: boolean;
  hasSong: boolean;
  /** Told whether the card is up, so typing only holds its entrance. */
  onShowingChange?: (showing: boolean) => void;
  onOpen: () => void;
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
        hero={<JamHowToHero className="h-28" />}
        title={t("jamAnnouncement.title")}
        body={t("jamAnnouncement.body")}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="cta-lift rounded-full px-4"
              data-jam-announcement-action=""
              onClick={() => {
                track("jam_news_click", { hasSong });
                close(onOpen, false);
              }}
            >
              {hasSong ? t("jamAnnouncement.cta") : t("jamAnnouncement.ctaStart")}
            </Button>
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
