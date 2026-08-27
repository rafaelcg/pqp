import { Link } from "react-router-dom";
import { BetaTag } from "@/components/ui/beta-tag";
import { DOWNLOAD_PAGE_PATH, SOURCE_REPO_URL } from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";

const FOOTER_LINK =
  "text-paper transition-colors duration-150 hover:text-signal";

export function MarketingFooter() {
  const { t, locale } = useTranslation();

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
            <Link to="/app" className={FOOTER_LINK}>
              {t("nav.openApp")}
            </Link>
            {/* Filenames on GitHub carry the version, so this page is the
                URL that cannot 404 on the next tag. */}
            <Link to={DOWNLOAD_PAGE_PATH} className={FOOTER_LINK}>
              {t("footer.desktop")}
            </Link>
            <a href="/#how" className={FOOTER_LINK}>
              {t("nav.howItWorks")}
            </a>
            <a href="/#communities" className={FOOTER_LINK}>
              {t("nav.communities")}
            </a>
            <a
              href="/#hosting"
              className={FOOTER_LINK}
              lang={locale === "en" ? undefined : "en"}
            >
              {t("nav.selfHost")}
            </a>
            <Link to="/vs-discord" className={FOOTER_LINK}>
              {t("footer.vsDiscord")}
            </Link>
            <Link to="/tela" className={FOOTER_LINK}>
              {t("footer.tela")}
            </Link>
            {/* The footer drives to the /beta landing, not straight to
                TestFlight: the page sells the beta and carries the honest
                framing before the external hop. */}
            <Link to="/beta" className={FOOTER_LINK}>
              {t("footer.iosBeta")}
            </Link>
            {/* Unconditional, unlike the CTAs on `/android` itself. A footer is
                a site map, and the page is worth reading even in the window
                where the tester group has no link yet: it is where somebody
                finds out an Android app exists at all. */}
            <Link to="/android" className={FOOTER_LINK}>
              {t("footer.androidBeta")}
            </Link>
            <Link to="/blog" className={FOOTER_LINK}>
              {t("nav.blog")}
            </Link>
            <Link to="/status" className={FOOTER_LINK}>
              {t("footer.status")}
            </Link>
            {/* Sits with self-host rather than in its own column: the person
                who wants the code is usually the person who just read that
                they can run their own copy. */}
            <a
              href={SOURCE_REPO_URL}
              target="_blank"
              rel="noopener"
              className={FOOTER_LINK}
            >
              {t("footer.source")}
            </a>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-paper-muted">
              {t("footer.legal")}
            </p>
            <Link to="/privacy" className={FOOTER_LINK}>
              {t("footer.privacy")}
            </Link>
            <Link to="/terms" className={FOOTER_LINK}>
              {t("footer.terms")}
            </Link>
            <Link to="/cookies" className={FOOTER_LINK}>
              {t("footer.cookies")}
            </Link>
          </div>
        </div>
      </div>
      <p className="mx-auto mt-10 max-w-5xl text-xs text-paper-muted">
        {t("footer.copyright", { year: new Date().getFullYear() })}
        {" · "}
        <a
          href="https://rafael.ltd"
          target="_blank"
          rel="noopener"
          className="transition-colors duration-150 hover:text-signal"
        >
          rafael.ltd
        </a>
      </p>
    </footer>
  );
}
