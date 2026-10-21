import { useEffect, useRef, type ReactNode } from "react";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { useScrollReveal } from "@/hooks/use-scroll-reveal";
import { trackAppsDoorView } from "@/lib/apps-landing";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * What `/apps` and `/apps/locadora` share: the skip link, the nav, the
 * landmarks, the scroll reveals, the artwork credit and the footer.
 *
 * The page view event is sent from here, once per mount, and only because this
 * shell is rendered inside the flag's gate: a page that redirects home never
 * counts. It is the one measurement these pages make (`lib/apps-landing.ts`).
 */
export function AppsShell({
  children,
  creditKey,
}: {
  children: ReactNode;
  creditKey: MessageKey;
}) {
  const { t } = useTranslation();
  const mainRef = useRef<HTMLElement>(null);
  useScrollReveal(mainRef);
  useEffect(() => {
    trackAppsDoorView();
  }, []);

  return (
    <div className="flex min-h-full flex-col bg-surface-0 text-text">
      {/* First Tab stop, as on the landing: jumps over the header. Moves focus
          itself rather than leaning on the hash, which the router owns. */}
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main");
          main?.focus({ preventScroll: true });
          main?.scrollIntoView({ block: "start" });
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-surface-2 focus:px-5 focus:py-3 focus:text-sm focus:font-semibold focus:text-text focus:shadow-[var(--shadow-2)] focus:outline-none focus:ring-2 focus:ring-focus-ring"
      >
        {t("nav.skipToContent")}
      </a>
      <MarketingNav />
      <main
        ref={mainRef}
        id="main"
        tabIndex={-1}
        className="relative flex-1 overflow-hidden outline-none"
      >
        {children}
      </main>
      {/* The artwork is generated, and says so, on the page that shows it. */}
      <p
        className="border-t border-border bg-surface-1 px-4 py-4 text-center text-xs text-text-tertiary sm:px-8"
        data-apps-credit=""
      >
        {t(creditKey)}
      </p>
      <MarketingFooter />
    </div>
  );
}
