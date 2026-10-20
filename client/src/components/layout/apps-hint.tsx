import { LayoutGrid } from "lucide-react";
import { useEffect, useState } from "react";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { isAutomatedBrowser } from "@/lib/hints";
import { isAppsHintSeen, rememberAppsHint } from "@/lib/apps/apps-hint";
import { useTranslation } from "@/lib/i18n";

/**
 * One corner card: apps live in the composer now. Shown once, only where the
 * `apps` flag is on for the open server (the queue in `App` decides that and
 * passes `enabled`; a card that is not enabled records nothing).
 *
 * The picture is the real button, drawn small, so the person knows what to
 * look for next to the + without a screenshot that goes stale.
 */
export function AppsHint({
  enabled,
  onDismiss,
}: {
  enabled: boolean;
  /** Hands the corner on (see `CargosHint.onDismiss`). */
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const [eligible] = useState(() => !isAutomatedBrowser() && !isAppsHintSeen());
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    onDismiss?.();
  };

  useEffect(() => {
    if (eligible && enabled) {
      rememberAppsHint();
    }
  }, [eligible, enabled]);

  return (
    <CornerCard
      open={eligible && enabled && open}
      onClose={close}
      label={t("appsHint.title")}
      dismissLabel={t("appsHint.dismiss")}
      dataAttribute="apps"
      title={t("appsHint.title")}
      body={t("appsHint.body")}
      footer={
        <Button size="sm" className="cta-lift rounded-full px-4" onClick={close}>
          {t("appsHint.cta")}
        </Button>
      }
    >
      <div
        aria-hidden
        className="pointer-events-none mt-3 flex items-center gap-2 rounded-xl bg-ink-3/60 px-3 py-2 text-sm text-paper-muted"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-surface-3 text-text">
          <LayoutGrid className="h-4 w-4" />
        </span>
        <span>{t("apps.name")}</span>
      </div>
    </CornerCard>
  );
}
