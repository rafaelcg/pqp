import { MessagesSquare } from "lucide-react";
import { useEffect, useRef, type FocusEvent } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

/**
 * "O fórum abriu": the one corner card that tells a server's members its
 * forum is live (`lib/forum-announcement.ts` has who, when and the store).
 * The queue in `App` decides and passes `enabled`; this only draws.
 *
 * Painting records nothing. Both buttons, the X and Escape go through the
 * caller, which stamps the server; "Abrir o fórum" also opens the channel.
 * Not a live region: it is unsolicited, so it is a labelled landmark a
 * screen reader finds without being interrupted by it, and it never takes
 * focus. Somebody who tabbed into it gets focus back where they came from
 * when it closes, instead of on the page body.
 */
export function ForumAnnouncementHint({
  enabled,
  onShowingChange,
  onOpen,
  onDismiss,
}: {
  enabled: boolean;
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

  const rememberWhereFrom = (event: FocusEvent<HTMLDivElement>) => {
    const from = event.relatedTarget;
    if (from instanceof HTMLElement && !holder.current?.contains(from)) {
      cameFrom.current = from;
    }
  };

  // Opening the forum moves the page, so focus is left to the forum pane;
  // only a dismissal hands it back.
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

  return (
    <div ref={holder} onFocus={rememberWhereFrom}>
      <CornerCard
        open={enabled}
        onClose={() => close(onDismiss)}
        label={t("forumAnnouncement.title")}
        dismissLabel={t("forumAnnouncement.dismiss")}
        dataAttribute="forum-announcement"
        title={
          <span className="flex items-center gap-2">
            <MessagesSquare aria-hidden className="h-4 w-4 shrink-0 text-signal" />
            {t("forumAnnouncement.title")}
          </span>
        }
        body={t("forumAnnouncement.body")}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="cta-lift rounded-full px-4"
              onClick={() => close(onOpen, false)}
            >
              {t("forumAnnouncement.cta")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              onClick={() => close(onDismiss)}
            >
              {t("forumAnnouncement.later")}
            </Button>
          </div>
        }
      />
    </div>
  );
}
