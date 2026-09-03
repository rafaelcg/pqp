import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { isAutomatedBrowser } from "@/lib/hints";
import { useTranslation } from "@/lib/i18n";
import {
  WHATS_NEW_PACK_ID,
  isWhatsNewSeen,
  rememberWhatsNew,
} from "@/lib/whats-new";

/**
 * One corner card: Novidades now lives on the rail.
 *
 * Same shape as cargos and the QG invite. No backdrop, no focus trap,
 * Escape or the X closes it. The CTA opens the feed so nobody has to hunt
 * for the sparkle. Dice and polls used to live here; they are in the notes.
 */
export function WhatsNewPrompt({
  enabled = true,
  onOpen,
}: {
  enabled?: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [state] = useState(() =>
    isWhatsNewSeen() ? null : { pack: WHATS_NEW_PACK_ID },
  );
  const [open, setOpen] = useState(true);
  const automated = isAutomatedBrowser();

  useEffect(() => {
    if (automated || !state || !enabled) {
      return;
    }
    rememberWhatsNew(state.pack);
  }, [automated, state, enabled]);

  const show = !automated && Boolean(state) && enabled && open;

  return (
    <CornerCard
      open={show}
      onClose={() => setOpen(false)}
      label={t("whatsNew.label")}
      dismissLabel={t("whatsNew.dismiss")}
      dataAttribute="whats-new"
      hero={
        <div className="flex h-28 items-center justify-center bg-ink-1">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-signal text-ink">
            <Sparkles className="h-5 w-5" aria-hidden />
          </span>
        </div>
      }
      title={t("whatsNew.prompt.title")}
      body={t("whatsNew.prompt.body")}
      footer={
        <Button
          size="sm"
          className="cta-lift rounded-full px-4"
          onClick={() => {
            setOpen(false);
            onOpen();
          }}
        >
          {t("whatsNew.prompt.cta")}
        </Button>
      }
    />
  );
}
