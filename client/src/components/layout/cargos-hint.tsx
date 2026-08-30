import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { STAFF_ROLE_COLORS } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { isAutomatedBrowser, isCargosHintSeen, rememberCargosHint } from "@/lib/cargos-hint";
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

  useEffect(() => {
    if (!eligible || !enabled || !open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [eligible, enabled, open]);

  if (!eligible || !enabled || !open) {
    return null;
  }

  return (
    <aside
      aria-label={t("cargosHint.title")}
      className="animate-fade-in safe-pb fixed inset-x-3 bottom-3 z-30 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[22rem]"
    >
      <div className="rounded-2xl border border-ink-4 bg-ink-2 p-4 shadow-[var(--shadow-popover)]">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 font-display text-sm font-bold tracking-tight text-paper">
            {t("cargosHint.title")}
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("cargosHint.dismiss")}
            className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-paper-muted outline-none hover:bg-ink-3 hover:text-paper focus-visible:ring-2 focus-visible:ring-signal/60"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <p className="mt-1.5 text-pretty text-sm leading-relaxed text-paper-muted">
          {t("cargosHint.body")}
        </p>
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
        <Button
          size="sm"
          className="cta-lift mt-3 rounded-full px-4"
          onClick={() => {
            setOpen(false);
            onOpenRoles();
          }}
        >
          {t("cargosHint.cta")}
        </Button>
      </div>
    </aside>
  );
}
