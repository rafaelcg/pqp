import { Mail } from "lucide-react";
import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { CONTACT_EMAIL } from "@/lib/help-contact";
import { useTranslation } from "@/lib/i18n";

/**
 * `/contact` (and `/contato`): who is behind pqp, how to reach them, and that
 * pqp answers to nobody else.
 *
 * WHY IT EXISTS. An ad platform asked, in as many words, that the site make
 * clear who stands behind the product and that it is independent of the
 * services it gets compared to. A footer line is not an answer to that; a page
 * a person can land on and read in ten seconds is.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. No names, no country, no address. The
 * page says what pqp is, that two brothers make it, one email address, and
 * that it is not affiliated with Discord or any other company. That is the
 * whole disclosure, chosen as the smallest one that answers the question.
 * The legal pages (`/privacy`, `/terms`) say more, and they are linked from
 * here, but they are written by a different hand and this page must not
 * contradict them: when they change, read this one.
 *
 * Two spellings, one page, canonical `/contact` (`marketing-meta.ts`), the
 * `/watch-party` arrangement. Both words are in RESERVED_HANDLES. The words
 * are also in `marketing-prerender.ts`, so a reader without JavaScript gets
 * them. Role tokens only, like every page under `DarkRoutes`.
 */

const LINK_CLASS =
  "text-paper underline decoration-paper-muted/40 underline-offset-4 transition-colors duration-150 hover:decoration-paper/60";

export function ContactPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("contactPage.seo.title")}
        description={t("contactPage.seo.description")}
        path="/contact"
      />
      <MarketingNav variant="solid" />

      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8 sm:py-16">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-signal">
          {t("contactPage.eyebrow")}
        </p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
          {t("contactPage.title")}
        </h1>
        <p className="mt-5 text-pretty text-lg leading-relaxed text-paper-muted">
          {t("contactPage.lead")}
        </p>

        <section className="mt-12" aria-labelledby="contact-who">
          <h2
            id="contact-who"
            className="font-display text-xl font-bold tracking-tight sm:text-2xl"
          >
            {t("contactPage.who.title")}
          </h2>
          <p className="mt-2 text-pretty leading-relaxed text-paper-muted">
            {t("contactPage.who.body")}
          </p>
        </section>

        <section className="mt-10" aria-labelledby="contact-mail">
          <h2
            id="contact-mail"
            className="font-display text-xl font-bold tracking-tight sm:text-2xl"
          >
            {t("contactPage.contact.title")}
          </h2>
          <p className="mt-2 text-pretty leading-relaxed text-paper-muted">
            {t("contactPage.contact.body")}
          </p>
          <Button asChild className="cta-lift mt-5 h-11 px-6 text-base">
            <a href={`mailto:${CONTACT_EMAIL}`}>
              <Mail aria-hidden className="h-4 w-4" />
              {CONTACT_EMAIL}
            </a>
          </Button>
        </section>

        <section className="mt-10" aria-labelledby="contact-independent">
          <h2
            id="contact-independent"
            className="font-display text-xl font-bold tracking-tight sm:text-2xl"
          >
            {t("contactPage.independent.title")}
          </h2>
          <p className="mt-2 text-pretty leading-relaxed text-paper-muted">
            {t("contactPage.independent.body")}
          </p>
        </section>

        <section className="mt-10" aria-labelledby="contact-links">
          <h2
            id="contact-links"
            className="font-display text-xl font-bold tracking-tight sm:text-2xl"
          >
            {t("contactPage.links.title")}
          </h2>
          <ul className="mt-3 space-y-2 leading-relaxed">
            <li>
              <Link to="/privacy" className={LINK_CLASS}>
                {t("footer.privacy")}
              </Link>
            </li>
            <li>
              <Link to="/terms" className={LINK_CLASS}>
                {t("footer.terms")}
              </Link>
            </li>
            <li>
              <a
                href={SOURCE_REPO_URL}
                target="_blank"
                rel="noopener"
                className={LINK_CLASS}
              >
                {t("footer.source")}
              </a>
            </li>
          </ul>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
