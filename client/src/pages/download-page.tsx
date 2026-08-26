import { Download } from "lucide-react";
import { type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { DownloadCatalog } from "@/components/downloads/download-catalog";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

/**
 * `/download` — the URL you send when someone asks "tem app ou só site?".
 *
 * The landing hides the desktop offer under the real CTA so it does not split
 * the click. This page is the other half: every platform, named, with the
 * honest caveats (unsigned Windows/Linux, iOS is TestFlight, Android is the
 * browser). Filenames on GitHub carry the version, so this path is the one
 * that cannot 404 on the next tag.
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

        <div className="relative mx-auto max-w-2xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          <div className="animate-rise flex justify-center" style={stagger(0)}>
            <span className="inline-flex items-center gap-2 rounded-full border border-signal/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-signal">
              <Download aria-hidden className="h-3.5 w-3.5" />
              {t("downloadPage.badge")}
            </span>
          </div>

          <h1
            className="animate-rise mt-6 text-balance text-center font-brand text-4xl leading-[1.05] tracking-tight sm:text-5xl"
            style={stagger(1)}
          >
            {t("downloadPage.title")}
          </h1>

          <p
            className="animate-rise mx-auto mt-6 max-w-xl text-pretty text-center text-base leading-relaxed text-paper-muted sm:text-lg"
            style={stagger(2)}
          >
            {t("downloadPage.body")}
          </p>

          <div className="animate-rise mt-12" style={stagger(3)}>
            <DownloadCatalog />
          </div>

          <p className="mx-auto mt-14 max-w-xl text-pretty text-center text-sm leading-relaxed text-paper-muted">
            {t("downloadPage.honest")}
          </p>

          <div className="mt-8 flex justify-center">
            <Button asChild variant="secondary">
              <Link to="/app">{t("downloadPage.web.cta")}</Link>
            </Button>
          </div>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
