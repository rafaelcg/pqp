import { useEffect, useState } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { useNotificationSettings } from "@/hooks/use-notifications";
import { isAutomatedBrowser } from "@/lib/hints";
import { useTranslation } from "@/lib/i18n";
import { dismissNotifyOffer } from "@/lib/notifications";
import { isNotifyOfferSeen, rememberNotifyOffer } from "@/lib/notify-offer-hint";

/**
 * One corner card, once: "Quer ser avisado quando te chamarem?".
 *
 * It exists because OS banners are opt-in behind a switch in Settings that
 * nearly nobody opens, and a browser may only ask for the permission from a
 * click. `notifyChannelActivity` records the moment worth asking about (a DM or
 * a mention reached a hidden tab, `shouldQueueNotifyOffer`); this draws the
 * card when the person is back, and the button is the gesture the prompt needs.
 *
 * `enabled` is the queue's verdict (`lib/corner-hints.ts`): it also carries the
 * flag, the pending moment and the permission still being undecided, so this
 * never paints on a tab where the button could not work. The impression is
 * recorded only while it is on screen.
 */
export function NotifyOfferHint({
  enabled,
  onDismiss,
}: {
  enabled: boolean;
  /** Frees the corner for the queue; see `CargosHint` for why it matters. */
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const { enable } = useNotificationSettings();
  const [eligible] = useState(() => !isAutomatedBrowser() && !isNotifyOfferSeen());
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setOpen(false);
    dismissNotifyOffer();
    onDismiss?.();
  };

  useEffect(() => {
    if (eligible && enabled) {
      rememberNotifyOffer();
    }
  }, [eligible, enabled]);

  const turnOn = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      // The click is the gesture: this is where the browser's prompt opens.
      await enable();
    } finally {
      setBusy(false);
      close();
    }
  };

  return (
    <CornerCard
      open={eligible && enabled && open}
      onClose={close}
      label={t("notifyOfferHint.title")}
      dismissLabel={t("notifyOfferHint.dismiss")}
      dataAttribute="notify-offer"
      title={t("notifyOfferHint.title")}
      body={t("notifyOfferHint.body")}
      footer={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="cta-lift rounded-full px-4"
            disabled={busy}
            onClick={() => void turnOn()}
          >
            {t("notifyOfferHint.cta")}
          </Button>
          <Button size="sm" variant="ghost" className="rounded-full px-3" onClick={close}>
            {t("notifyOfferHint.later")}
          </Button>
        </div>
      }
    />
  );
}
