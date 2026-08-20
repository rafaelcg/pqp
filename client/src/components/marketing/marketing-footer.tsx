import { Link } from "react-router-dom";
import { BetaTag } from "@/components/ui/beta-tag";
import { RELEASES_PAGE_URL } from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";
import { testflightUrl } from "@/lib/testflight";

export function MarketingFooter() {
  const { t, locale } = useTranslation();
  const betaUrl = testflightUrl();

  return (
    <footer className="border-t border-ink-4/40 bg-ink px-5 py-10 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="flex items-center gap-2 font-brand text-2xl tracking-tight">
            pqp
            <BetaTag />
          </p>
          <p className="mt-2 max-w-xs text-sm text-paper-muted">
            {t("footer.tagline")}
          </p>
        </div>

        <div className="flex flex-wrap gap-x-10 gap-y-6 text-sm">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-paper-muted">
              {t("footer.product")}
            </p>
            <Link to="/app" className="text-paper hover:text-signal">
              {t("nav.openApp")}
            </Link>
            <a href="/#how" className="text-paper hover:text-signal">
              {t("nav.howItWorks")}
            </a>
            <a
              href="/#hosting"
              className="text-paper hover:text-signal"
              lang={locale === "en" ? undefined : "en"}
            >
              {t("nav.selfHost")}
            </a>
            <Link to="/vs-discord" className="text-paper hover:text-signal">
              {t("footer.vsDiscord")}
            </Link>
            {/* The releases page, not a direct asset: the filenames carry the
                version, so only GitHub can say what the newest one is called.
                See `lib/downloads.ts`. */}
            <a
              href={RELEASES_PAGE_URL}
              target="_blank"
              rel="noopener"
              className="text-paper hover:text-signal"
            >
              {t("footer.desktop")}
            </a>
            {betaUrl ? (
              <a
                href={betaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-paper hover:text-signal"
              >
                {t("footer.iosBeta")}
              </a>
            ) : (
              <Link
                to="/vs-discord#ios-beta"
                className="text-paper hover:text-signal"
              >
                {t("footer.iosBeta")}
              </Link>
            )}
            <Link to="/status" className="text-paper hover:text-signal">
              {t("footer.status")}
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-paper-muted">
              {t("footer.legal")}
            </p>
            <Link to="/privacy" className="text-paper hover:text-signal">
              {t("footer.privacy")}
            </Link>
            <Link to="/terms" className="text-paper hover:text-signal">
              {t("footer.terms")}
            </Link>
            <Link to="/cookies" className="text-paper hover:text-signal">
              {t("footer.cookies")}
            </Link>
          </div>
        </div>
      </div>
      <p className="mx-auto mt-10 max-w-5xl text-xs text-paper-muted">
        {t("footer.copyright", { year: new Date().getFullYear() })}
      </p>
    </footer>
  );
}
