import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { STAFF_ROLE_COLORS } from "@pqp/shared";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { isCargosHintSeen, rememberCargosHint } from "@/lib/cargos-hint";
import { isAutomatedBrowser } from "@/lib/hints";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const PREVIEW = [
  { key: "admin", label: "roles.system.admin", checked: false },
  { key: "manager", label: "roles.system.manager", checked: true },
  { key: "moderator", label: "roles.system.moderator", checked: false },
  { key: "vip", label: "roles.system.vip", checked: false },
] as const;

/**
 * One corner card: cargos moved onto the profile.
 *
 * The picture is the real ticks, not a screenshot. A PNG of the profile
 * would be unreadable at this width, need two locales, and go stale the
 * next time the card is restyled. The Android prompt had a phone because
 * the news *was* the phone.
 */
export function CargosHint({
  enabled,
  onOpenRoles,
}: {
  enabled: boolean;
  onOpenRoles: () => void;
}) {
  const { t } = useTranslation();
  const [eligible] = useState(() => !isAutomatedBrowser() && !isCargosHintSeen());
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (eligible && enabled) {
      rememberCargosHint();
    }
  }, [eligible, enabled]);

  const show = eligible && enabled && open;

  return (
    <CornerCard
      open={show}
      onClose={() => setOpen(false)}
      label={t("cargosHint.title")}
      dismissLabel={t("cargosHint.dismiss")}
      dataAttribute="cargos"
      title={t("cargosHint.title")}
      body={t("cargosHint.body")}
      footer={
        <Button
          size="sm"
          className="cta-lift rounded-full px-4"
          onClick={() => {
            setOpen(false);
            onOpenRoles();
          }}
        >
          {t("cargosHint.cta")}
        </Button>
      }
    >
      <div
        aria-hidden
        className="pointer-events-none mt-3 overflow-hidden rounded-xl bg-ink-3/60"
      >
        {PREVIEW.map((row) => (
          <div
            key={row.key}
            className="flex items-center justify-between gap-4 px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: STAFF_ROLE_COLORS[row.key] }}
              />
              <span className="truncate text-sm text-paper">
                {t(row.label)}
              </span>
            </span>
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px]",
                row.checked
                  ? "bg-signal"
                  : "bg-ink-3 ring-1 ring-inset ring-ink-4",
              )}
            >
              {row.checked ? (
                <Check className="h-3 w-3 text-ink" strokeWidth={3} />
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </CornerCard>
  );
}
