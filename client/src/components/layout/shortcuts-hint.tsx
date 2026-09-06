import { useEffect, useState } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { isFeatureHintSeen, rememberFeatureHint } from "@/lib/feature-hints";
import { isAutomatedBrowser } from "@/lib/hints";
import { useTranslation } from "@/lib/i18n";

/**
 * Quiet corner card: Cmd+/ (or Ctrl+/) opens the shortcut map.
 *
 * Last in `CORNER_HINT_ORDER` so campaigns keep the corner. Yields while an
 * attached feature hint is up, so this is not a second step in a tour.
 */
export function ShortcutsHint({
  enabled,
  shortcutLabel,
}: {
  enabled: boolean;
  shortcutLabel: string;
}) {
  const { t } = useTranslation();
  const [eligible] = useState(
    () => !isAutomatedBrowser() && !isFeatureHintSeen("shortcuts"),
  );
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (eligible && enabled) {
      rememberFeatureHint("shortcuts");
    }
  }, [eligible, enabled]);

  const show = eligible && enabled && open;

  return (
    <CornerCard
      open={show}
      onClose={() => setOpen(false)}
      label={t("featureHint.shortcuts.title")}
      dismissLabel={t("featureHint.dismiss")}
      dataAttribute="shortcuts"
      title={t("featureHint.shortcuts.title")}
      body={t("featureHint.shortcuts.body", { key: shortcutLabel })}
      footer={
        <Button
          size="sm"
          className="cta-lift rounded-full px-4"
          onClick={() => setOpen(false)}
        >
          {t("featureHint.gotIt")}
        </Button>
      }
    />
  );
}
