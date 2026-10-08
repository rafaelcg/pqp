import { useAuth, useClerk } from "@clerk/clerk-react";
import { ArrowDown, ArrowRight, Clock } from "lucide-react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { useScrollReveal } from "@/hooks/use-scroll-reveal";
import { useScrollToHash } from "@/hooks/use-scroll-to-hash";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import {
  intentStorage,
  stashWaitlistIntent,
  STREAMERS_WAITLIST_HREF,
} from "@/lib/handle-intent";
import { CONTACT_EMAIL } from "@/lib/help-contact";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { Locale } from "@/lib/locale";
import { noteSignupCta } from "@/lib/signup-assist";
import { cn } from "@/lib/utils";

/**
 * `/streamers` (and `/criadores`): the page outreach sends a streamer to.
 *
 * ONE JOB, THE SAME AS `/watch-party`: get somebody onto the watch party
 * waitlist. Its button is `STREAMERS_WAITLIST_HREF`, the waitlist intent with
 * `from=streamers` on it (`lib/handle-intent.ts`), so a visitor who makes an
 * account here lands in the app with the waitlist dialog open, and the row it
 * writes carries `source: "streamers"` for the operator's dashboard. No new
 * list, no new form.
 *
 * TRACKING A LINK PER STREAMER needs nothing here: `pqp.gg/streamers?ref=<who>`
 * is the existing acquisition parameter (`lib/acquisition.ts`), stashed at
 * boot and written onto the account the first time it signs in.
 *
 * WHAT IT SAYS AND DOES NOT. Every claim is something the product does today;
 * low latency is marked as rolling out because it is switched on server by
 * server. The page never names what people watch: what is shown is the
 * presenter's, and the FAQ says exactly that and points at the terms.
 *
 * Open Graph, the canonical and the FAQ's JSON-LD come from the Pages
 * middleware (`marketing-meta.ts`), and a reader with no JavaScript gets the
 * hero, the steps and the FAQ as plain HTML from the same place
 * (`marketing-prerender.ts`), because neither of those runs this component.
 */

/** In the page's order, which is also the FAQPage JSON-LD's (`STREAMERS_FAQ`). */
export const STREAMERS_FAQ_IDS = [
  "share",
  "bring",
  "obs",
  "size",
  "cost",
  "need",
  "help",
] as const;

const STEP_IDS = ["setup", "live", "watch"] as const;

const FEATURE_IDS = [
  "cap",
  "browser",
  "chat",
  "camera",
  "twitch",
  "replay",
  "latency",
] as const;

/** Real, and switched on server by server: said so on the card. */
const ROLLING_OUT: ReadonlySet<(typeof FEATURE_IDS)[number]> = new Set([
  "latency",
]);

const PROOF_IDS = ["duration", "chat", "joined"] as const;

/**
 * TODO(Rafael): the proof block is anonymous on purpose. Its numbers are one
 * community's session, and nobody has asked the channel's owner yet whether
 * they want to be named. Once they say yes, put the name exactly as they write
 * it here and the lead line switches to `streamersPage.proof.leadNamed`. The
 * numbers themselves stay as they are (aggregates only, no other name).
 */
export const PROOF_NAMED_CHANNEL: string | null = null;

/**
 * Product screenshots, one set per language, captured from the dev app by
 * `client/e2e/streamers-shots.spec.ts` (a recorder, skipped in the suite).
 * Two widths each; the 1440 file is the original.
 */
const SHOTS: Record<(typeof STEP_IDS)[number], { width: number; height: number }> = {
  setup: { width: 1440, height: 900 },
  // Cut above the presenter's control row; the recorder says why.
  live: { width: 1440, height: 850 },
  watch: { width: 1440, height: 900 },
};

function shotSrc(step: (typeof STEP_IDS)[number], locale: Locale, width?: number) {
  return `/images/streamers/${step}-${locale}${width ? `-${width}` : ""}.webp`;
}

const EYEBROW = "text-xs font-semibold uppercase tracking-[0.18em] text-accent";
const H2 =
  "text-balance font-display text-3xl font-bold leading-[1.1] tracking-tight text-text sm:text-4xl";
const CTA_CLASS = "cta-lift h-12 px-7 text-base";
const INLINE_LINK =
  "font-medium text-text underline decoration-text-tertiary/50 underline-offset-4 transition-colors duration-[var(--duration-fast)] hover:decoration-text";

function at(ms: number): CSSProperties {
  return { "--d": ms } as CSSProperties;
}

function StreamerCta({ className }: { className?: string }) {
  return isDevAuthBypassEnabled() ? (
    <BypassStreamerCta className={className} />
  ) : (
    <ClerkStreamerCta className={className} />
  );
}

/** Dev bypass has no ClerkProvider: the account already exists, go straight in. */
function BypassStreamerCta({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Button asChild className={cn(CTA_CLASS, className)}>
      <Link
        to={STREAMERS_WAITLIST_HREF}
        data-umami-event="streamers-waitlist-cta"
        data-streamers-cta=""
      >
        {t("streamersPage.hero.cta")}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </Button>
  );
}

function ClerkStreamerCta({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const navigate = useNavigate();
  const go = () => void navigate(STREAMERS_WAITLIST_HREF);
  return (
    <Button
      type="button"
      className={cn(CTA_CLASS, className)}
      data-umami-event="streamers-waitlist-cta"
      data-streamers-cta=""
      onClick={() => {
        // Stashed BEFORE Clerk takes over, as on /watch-party: the modal can
        // end in a navigation this page does not survive. The URL is the belt.
        stashWaitlistIntent(intentStorage(), Date.now(), "streamers");
        if (isSignedIn || !isLoaded) {
          go();
          return;
        }
        try {
          noteSignupCta("streamers", "");
          void Promise.resolve(
            clerk.openSignUp({ forceRedirectUrl: STREAMERS_WAITLIST_HREF }),
          ).catch(go);
        } catch {
          go();
        }
      }}
    >
      {t("streamersPage.hero.cta")}
      <ArrowRight className="h-4 w-4" aria-hidden />
    </Button>
  );
}

/** The contact address inside an answer, as a link. Plain text everywhere else. */
function withContactLink(text: string): ReactNode {
  const index = text.indexOf(CONTACT_EMAIL);
  if (index === -1) {
    return text;
  }
  return (
    <>
      {text.slice(0, index)}
      <a href={`mailto:${CONTACT_EMAIL}`} className={INLINE_LINK}>
        {CONTACT_EMAIL}
      </a>
      {text.slice(index + CONTACT_EMAIL.length)}
    </>
  );
}

function Shot({
  step,
  alt,
  locale,
}: {
  step: (typeof STEP_IDS)[number];
  alt: string;
  locale: Locale;
}) {
  return (
    <figure className="overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 shadow-[var(--shadow-2)]">
      <img
        src={shotSrc(step, locale)}
        srcSet={`${shotSrc(step, locale, 720)} 720w, ${shotSrc(step, locale)} 1440w`}
        sizes="(min-width: 1024px) 640px, calc(100vw - 32px)"
        alt={alt}
        width={SHOTS[step].width}
        height={SHOTS[step].height}
        loading="lazy"
        decoding="async"
        className="block h-auto w-full"
        data-streamers-shot={step}
      />
    </figure>
  );
}

export function StreamersPage() {
  const { t, locale } = useTranslation();
  const mainRef = useRef<HTMLElement>(null);
  useScrollToHash();
  useScrollReveal(mainRef);

  const proofLead = PROOF_NAMED_CHANNEL
    ? t("streamersPage.proof.leadNamed", { name: PROOF_NAMED_CHANNEL })
    : t("streamersPage.proof.lead");

  return (
    <div className="flex min-h-full flex-col bg-surface-0 text-text">
      <Seo
        title={t("streamersPage.seo.title")}
        description={t("streamersPage.seo.description")}
        path="/streamers"
        image={
          locale === "en"
            ? "/images/og-streamers-en.jpg"
            : locale === "es"
              ? "/images/og-streamers-es.jpg"
              : "/images/og-streamers.jpg"
        }
      />
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
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[40rem] bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_60%)]"
          aria-hidden
        />

        {/* Hero. Static on purpose: the headline is the largest paint on a
            phone, and nothing here waits for an animation to show it. */}
        <section
          className="relative mx-auto max-w-4xl px-4 pb-16 pt-12 text-center sm:px-8 sm:pb-20 sm:pt-20"
          aria-labelledby="streamers-title"
        >
          <p className={EYEBROW}>{t("streamersPage.hero.eyebrow")}</p>
          <h1
            id="streamers-title"
            className="mx-auto mt-5 max-w-3xl text-balance font-display text-4xl font-extrabold leading-[1.04] tracking-tight text-text sm:text-6xl"
          >
            {t("streamersPage.hero.title")}
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary sm:text-xl">
            {t("streamersPage.hero.body")}
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <StreamerCta className="w-full sm:w-auto" />
            <Button
              asChild
              variant="secondary"
              className={cn(CTA_CLASS, "w-full sm:w-auto")}
            >
              <a href="#como-funciona" data-umami-event="streamers-how">
                {t("streamersPage.hero.secondary")}
                <ArrowDown className="h-4 w-4" aria-hidden />
              </a>
            </Button>
          </div>
          <p className="mx-auto mt-5 max-w-xl text-pretty text-sm text-text-tertiary">
            {t("streamersPage.hero.beta")} {t("streamersPage.hero.signup")}
          </p>
        </section>

        {/* Proof: one real session, as aggregates. */}
        <section
          className="relative border-y border-border bg-surface-1"
          aria-labelledby="streamers-proof-title"
        >
          <div
            data-reveal
            className="mx-auto max-w-5xl px-4 py-12 sm:px-8 sm:py-16"
          >
            <h2
              id="streamers-proof-title"
              className={cn(EYEBROW, "vem-rise")}
              style={at(0)}
            >
              {t("streamersPage.proof.eyebrow")}
            </h2>
            <p
              className="vem-rise mt-3 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary"
              style={at(80)}
              data-streamers-proof-lead=""
            >
              {proofLead}
            </p>
            <dl className="mt-8 grid gap-6 sm:grid-cols-3">
              {PROOF_IDS.map((id, index) => (
                <div
                  key={id}
                  className="vem-rise flex flex-col-reverse gap-1 border-l-2 border-accent pl-4"
                  style={at(160 + index * 90)}
                >
                  <dt className="text-pretty text-sm leading-relaxed text-text-secondary">
                    {t(`streamersPage.proof.${id}.label` as MessageKey)}
                  </dt>
                  <dd className="font-display text-4xl font-extrabold tracking-tight text-text tabular-nums">
                    {t(`streamersPage.proof.${id}.value` as MessageKey)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-6 text-xs text-text-tertiary">
              {t("streamersPage.proof.source")}
            </p>
          </div>
        </section>

        {/* How it works, with the product itself. */}
        <section
          id="como-funciona"
          className="relative mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-8 sm:py-28"
          aria-labelledby="streamers-steps-title"
        >
          {/* English readers guess this one. */}
          <span id="how-it-works" className="absolute -top-20" aria-hidden />
          <div data-reveal className="max-w-3xl">
            <p className={cn(EYEBROW, "vem-rise")} style={at(0)}>
              {t("streamersPage.steps.eyebrow")}
            </p>
            <h2
              id="streamers-steps-title"
              className={cn(H2, "vem-rise mt-4")}
              style={at(80)}
            >
              {t("streamersPage.steps.title")}
            </h2>
          </div>
          <ol className="mt-12 flex flex-col gap-16 sm:gap-20">
            {STEP_IDS.map((id, index) => (
              <li
                key={id}
                data-reveal
                className="grid items-center gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-12"
              >
                <div
                  className={cn("vem-rise", index % 2 === 1 && "lg:order-2")}
                  style={at(0)}
                >
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-accent font-display text-sm font-bold text-on-accent"
                    aria-hidden
                  >
                    {index + 1}
                  </span>
                  <h3 className="mt-4 font-display text-2xl font-bold tracking-tight text-text">
                    {t(`streamersPage.steps.${id}.title` as MessageKey)}
                  </h3>
                  <p className="mt-3 max-w-md text-pretty leading-relaxed text-text-secondary">
                    {t(`streamersPage.steps.${id}.body` as MessageKey)}
                  </p>
                </div>
                <div className="vem-rise" style={at(120)}>
                  <Shot
                    step={id}
                    locale={locale}
                    alt={t(`streamersPage.steps.${id}.alt` as MessageKey)}
                  />
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* What comes with it. */}
        <section
          className="border-t border-border bg-surface-1"
          aria-labelledby="streamers-features-title"
        >
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-8 sm:py-28">
            <div data-reveal className="max-w-3xl">
              <p className={cn(EYEBROW, "vem-rise")} style={at(0)}>
                {t("streamersPage.features.eyebrow")}
              </p>
              <h2
                id="streamers-features-title"
                className={cn(H2, "vem-rise mt-4")}
                style={at(80)}
              >
                {t("streamersPage.features.title")}
              </h2>
            </div>
            <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURE_IDS.map((id, index) => (
                <li
                  key={id}
                  data-reveal
                  className="vem-rise rounded-[var(--radius-panel)] border border-border bg-surface-0 p-6"
                  style={at((index % 3) * 90)}
                >
                  <h3 className="flex flex-wrap items-center gap-2 text-balance font-display text-lg font-bold leading-snug tracking-tight text-text">
                    {t(`streamersPage.features.${id}.title` as MessageKey)}{" "}
                    {ROLLING_OUT.has(id) && (
                      <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-on-warning-soft">
                        {t("streamersPage.features.rolling")}
                      </span>
                    )}
                  </h3>
                  <p className="mt-3 text-pretty text-sm leading-relaxed text-text-secondary">
                    {t(`streamersPage.features.${id}.body` as MessageKey)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Beta, said plainly. */}
        <section
          className="mx-auto max-w-4xl px-4 pt-20 sm:px-8 sm:pt-28"
          aria-labelledby="streamers-beta-title"
        >
          <div
            data-reveal
            className="vem-rise flex flex-col gap-4 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-6 sm:flex-row sm:items-start sm:p-8"
            style={at(0)}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-on-accent-soft">
              <Clock className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2
                id="streamers-beta-title"
                className="font-display text-xl font-bold tracking-tight text-text"
              >
                {t("streamersPage.beta.title")}
              </h2>
              <p className="mt-2 text-pretty leading-relaxed text-text-secondary">
                {t("streamersPage.beta.body")}
              </p>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section
          className="mx-auto max-w-3xl px-4 py-20 sm:px-8 sm:py-28"
          aria-labelledby="streamers-faq-title"
        >
          <h2
            id="streamers-faq-title"
            data-reveal
            className={cn(H2, "vem-rise")}
            style={at(0)}
          >
            {t("streamersPage.faq.title")}
          </h2>
          <dl className="mt-10 divide-y divide-border border-y border-border">
            {STREAMERS_FAQ_IDS.map((id) => (
              <div key={id} data-reveal className="vem-rise py-6" style={at(0)}>
                <dt className="font-display text-lg font-bold tracking-tight text-text">
                  {t(`streamersPage.faq.${id}.q` as MessageKey)}
                </dt>
                <dd className="mt-2 text-pretty leading-relaxed text-text-secondary">
                  {withContactLink(t(`streamersPage.faq.${id}.a` as MessageKey))}
                  {id === "share" && (
                    <>
                      {" "}
                      <Link to="/terms#voice" className={INLINE_LINK}>
                        {t("streamersPage.faq.share.link")}
                      </Link>
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Final CTA */}
        <section
          className="border-t border-border bg-surface-1"
          aria-labelledby="streamers-final-title"
        >
          <div
            data-reveal
            className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-8 sm:py-24"
          >
            <h2
              id="streamers-final-title"
              className={cn(H2, "vem-rise")}
              style={at(0)}
            >
              {t("streamersPage.final.title")}
            </h2>
            <p
              className="vem-rise mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary"
              style={at(90)}
            >
              {t("streamersPage.final.body")}
            </p>
            <div className="vem-rise mt-9 flex justify-center" style={at(180)}>
              <StreamerCta />
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
