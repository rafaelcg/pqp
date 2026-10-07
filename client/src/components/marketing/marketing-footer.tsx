import { Link } from "react-router-dom";
import { LanguagePicker } from "@/components/marketing/language-picker";
import { BetaTag } from "@/components/ui/beta-tag";
import { useCommunitiesEnabled } from "@/hooks/use-communities-enabled";
import {
  CODE_SIGNING_PATH,
  DOWNLOAD_PAGE_PATH,
  SOURCE_REPO_URL,
} from "@/lib/downloads";
import { CONTACT_EMAIL } from "@/lib/help-contact";
import { useTranslation } from "@/lib/i18n";
import { playStoreUrl } from "@/lib/play-store";
import { isSupportPageEnabled, supportPagePath } from "@/lib/support-links";

const FOOTER_LINK =
  "text-paper transition-colors duration-150 hover:text-signal";

export function MarketingFooter() {
  const { t, locale } = useTranslation();
  const communitiesEnabled = useCommunitiesEnabled();
  // Hosted-only: a self-hosted build has no donation links and gets no link
  // to a page that would only redirect home. See `lib/support-links.ts`.
  const supportEnabled = isSupportPageEnabled();
  // The link always goes to /android; only the label changes, so a self-host
  // that hides the Play badge with a single space never claims a listing it
  // does not have.
  const hasPlay = Boolean(playStoreUrl());

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
          {/* The header's picker sits in a cramped mobile bar next to the
              nav's beta tag and Join button; the footer gives a mobile
              visitor a second, roomier place to find it. Hidden from `sm`
              up, where the header copy is already there. */}
          <div className="mt-4 sm:hidden">
            <LanguagePicker />
          </div>
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
            <a href="/#features" className={FOOTER_LINK}>
              {t("nav.features")}
            </a>
            {communitiesEnabled && (
              <a href="/#communities" className={FOOTER_LINK}>
                {t("nav.communities")}
              </a>
            )}
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
            <Link to="/vem" className={FOOTER_LINK}>
              {t("footer.vem")}
            </Link>
            <Link to="/tela" className={FOOTER_LINK}>
              {t("footer.tela")}
            </Link>
            <Link to="/streamers" className={FOOTER_LINK}>
              {t("footer.streamers")}
            </Link>
            {/* The footer drives to the /beta landing, not straight to
                TestFlight: the page sells the beta and carries the honest
                framing before the external hop. */}
            <Link to="/beta" className={FOOTER_LINK}>
              {t("footer.iosBeta")}
            </Link>
            <Link to="/android" className={FOOTER_LINK}>
              {t(hasPlay ? "footer.androidBeta.play" : "footer.androidBeta")}
            </Link>
            <Link to="/blog" className={FOOTER_LINK}>
              {t("nav.blog")}
            </Link>
            <Link to="/status" className={FOOTER_LINK}>
              {t("footer.status")}
            </Link>
            {supportEnabled && (
              <Link to={supportPagePath(locale)} className={FOOTER_LINK}>
                {t("footer.support")}
              </Link>
            )}
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
            {/* A condition of the SignPath Foundation's free signing program:
                the policy must be reachable from the site. It lives on the
                download page, where the installers are. */}
            <Link to={CODE_SIGNING_PATH} className={FOOTER_LINK}>
              {t("footer.codeSigning")}
            </Link>
            {/* The page that says who makes pqp, gives the one address every
                legal page and security.txt already give, and says pqp is
                independent. A question about the service should not need the
                terms opened first. */}
            <Link to="/contact" className={FOOTER_LINK}>
              {t("footer.contact")}
            </Link>
          </div>
        </div>
      </div>
      <div className="mx-auto mt-10 max-w-5xl space-y-2 text-xs text-paper-muted">
        <p>
          {t("footer.copyright", { year: new Date().getFullYear() })}
          {" · "}
          {t("footer.madeBy")}
          {" · "}
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="transition-colors duration-150 hover:text-signal"
          >
            {CONTACT_EMAIL}
          </a>
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
        {/* One sentence, on every marketing page, in the reader's language. Not
            a banner: it answers "whose is this?" for anyone who looks. */}
        <p>{t("footer.independent")}</p>
      </div>
    </footer>
  );
}
