import { type CSSProperties } from "react";
import { DownloadCatalog } from "@/components/downloads/download-catalog";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { useTranslation } from "@/lib/i18n";

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

/**
 * `/download` — the URL you send when someone asks "tem app ou só site?".
 *
 * ONE ACTION, NOT FIVE CARDS. The catalog detects the platform and offers one
 * big button; every other platform stays on the page as a quiet row, because
 * this link gets forwarded and the friend's machine is not the sender's. The
 * headline stays product-level for the same reason — only the button names an
 * OS.
 *
 * THE WINDOW ON THE RIGHT IS CSS. There is no desktop screenshot in the repo,
 * and a mocked-up fake one would be a lie. A drawn window frame with the
 * wordmark says "it is an app in a window", which is exactly the claim.
 */
export function DownloadPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("downloadPage.seo.title")}
        description={t("downloadPage.seo.description")}
        path="/download"
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />

        <div className="relative mx-auto w-full max-w-6xl px-5 pb-28 pt-16 sm:px-8 sm:pt-24">
          <div className="grid items-center gap-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-24">
            <div className="max-w-xl">
              <p
                className="animate-rise font-brand text-lg tracking-tight text-signal"
                style={stagger(0)}
              >
                pqp
              </p>

              <h1
                className="animate-rise mt-5 text-balance font-display text-5xl font-extrabold leading-[1.03] tracking-tight sm:text-6xl"
                style={stagger(1)}
              >
                {t("downloadPage.title")}
              </h1>

              <p
                className="animate-rise mt-6 max-w-md text-pretty text-lg leading-relaxed text-paper-muted"
                style={stagger(2)}
              >
                {t("downloadPage.body")}
              </p>

              <div className="animate-rise mt-10" style={stagger(3)}>
                <DownloadCatalog />
              </div>
            </div>

            <div className="animate-rise hidden lg:block" style={stagger(4)}>
              <AppWindow />
            </div>
          </div>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

/** A window frame drawn in CSS — the product presence, without a fake screenshot. */
function AppWindow() {
  return (
    <div aria-hidden className="relative">
      <div className="absolute -inset-10 rounded-full bg-signal/5 blur-3xl" />
      <div className="relative overflow-hidden rounded-2xl border border-ink-4 bg-ink-2/80 shadow-2xl shadow-black/50">
        <div className="flex items-center gap-1.5 border-b border-ink-4/70 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-ink-4" />
          <span className="h-2.5 w-2.5 rounded-full bg-ink-4" />
          <span className="h-2.5 w-2.5 rounded-full bg-ink-4" />
        </div>
        <div className="flex">
          <div className="hidden w-36 shrink-0 space-y-3 border-r border-ink-4/70 p-4 xl:block">
            <div className="h-2 w-16 rounded-full bg-ink-4" />
            <div className="h-2 w-24 rounded-full bg-ink-4/70" />
            <div className="h-2 w-20 rounded-full bg-signal/50" />
            <div className="h-2 w-24 rounded-full bg-ink-4/70" />
            <div className="h-2 w-14 rounded-full bg-ink-4/70" />
          </div>
          <div className="flex min-h-[24rem] flex-1 flex-col items-center justify-center gap-6 p-10">
            <span className="font-brand text-6xl tracking-tight text-paper">
              pqp
            </span>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-signal" />
              <span className="h-2 w-16 rounded-full bg-ink-4" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
