import { Check, Clock } from "lucide-react";
import { useEffect, useRef } from "react";
import { AppsCta } from "@/components/apps-landing/apps-cta";
import { Button } from "@/components/ui/button";
import { LOCADORA_GUEST_REF } from "@/lib/apps-landing";
import { useTranslation } from "@/lib/i18n";
import { claimView, UPSELL_CLAIMS } from "@/lib/locadora-claims";
import { LOCADORA_GUEST_EVENTS, trackLocadoraGuest } from "@/lib/locadora-guest";
import { cn } from "@/lib/utils";

/**
 * "Gostou da Locadora?": the guest player's one sign-up card (COPY.md section
 * 4). Drawn by the PAGE, over the corner of the player and never inside the
 * game's picture, and only when `UpsellMoments` and `upsellAllowed` say so
 * (a pause, an eject or an idle frame, once a day per device). One clear
 * button, carrying `?ref=locadora-guest` through sign-up; a quiet "Agora não"
 * remembered on the device. The lines are `UPSELL_CLAIMS` through `claimView`,
 * so cloud saves read "em breve" until they are announced, and the last line
 * says plainly where a guest's cartridges are.
 *
 * Not modal and it takes no focus: the person may simply carry on. It is a
 * labelled region announced politely; Escape inside it is "Agora não".
 */
export function LocadoraGuestUpsell({
  cloudSaves,
  onDismiss,
}: {
  cloudSaves: boolean;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const lines = UPSELL_CLAIMS.map((claim) => ({ claim, view: claimView(claim, { cloudSaves }) })).filter(
    ({ view }) => view !== "hidden",
  );
  const ref = useRef<HTMLElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        dismiss.current();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      ref={ref}
      aria-labelledby="locadora-upsell-title"
      aria-live="polite"
      className="loc-upsell-in absolute bottom-4 right-4 z-10 w-[min(22rem,calc(100%-2rem))] rounded-[var(--radius-panel)] border border-border bg-surface-card p-5 shadow-[var(--shadow-2)]"
      data-locadora-upsell=""
    >
      <h2 id="locadora-upsell-title" className="font-display text-xl font-bold text-text">
        {t("locadoraGuest.upsell.title")}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{t("locadoraGuest.upsell.lead")}</p>
      <ul className="mt-3 space-y-2" data-locadora-upsell-lines="">
        {lines.map(({ claim, view }) => (
          <li
            key={claim.id}
            className={cn("flex items-start gap-2 text-sm", view === "soon" ? "text-text-tertiary" : "text-text")}
            data-claim-view={view}
          >
            {view === "soon" ? (
              <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
            )}
            <span>
              {t(claim.titleKey)}
              {view === "soon" && <span className="ml-1.5 text-xs">({t("locadoraGuest.upsell.soon")})</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-text-tertiary">{t("locadoraGuest.upsell.device")}</p>
      <div className="mt-4 flex flex-col gap-2">
        <AppsCta
          tag={LOCADORA_GUEST_REF}
          path="/locadora/jogar"
          label={t("locadoraGuest.upsell.cta")}
          className="h-11 w-full text-sm"
          onActivate={() => trackLocadoraGuest(LOCADORA_GUEST_EVENTS.signupClick)}
        />
        <Button type="button" variant="ghost" className="h-10 w-full text-sm" onClick={onDismiss}>
          {t("locadoraGuest.upsell.later")}
        </Button>
      </div>
    </aside>
  );
}
