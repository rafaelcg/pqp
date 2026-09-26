import { useAuth, useClerk } from "@clerk/clerk-react";
import { ArrowRight, Clapperboard } from "lucide-react";
import { type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { WatchPartyFeatureList } from "@/components/watch-party/waitlist/watch-party-features";
import { WatchPartyStageArt } from "@/components/watch-party/waitlist/watch-party-stage-art";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import {
  intentStorage,
  stashWaitlistIntent,
  WATCH_PARTY_WAITLIST_HREF,
} from "@/lib/handle-intent";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `/watch-party` (and `/watchparty`): the shareable page for the waitlist
 * campaign. One job, the same as `/beta`: get somebody onto the list. Its
 * button carries `?intent=watch-party-waitlist` through sign-up
 * (`lib/handle-intent.ts`), so a visitor who makes an account here lands in
 * the app with the waitlist dialog already open instead of on an empty hub.
 *
 * The picture is the same `WatchPartyStageArt` the in-app dialog shows, so the
 * page and the product cannot drift into two ideas of what a party looks like.
 * Open Graph tags come from the Pages middleware (`marketing-meta.ts`),
 * because an unfurler never runs this component.
 */

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

const STEPS: { title: MessageKey; body: MessageKey }[] = [
  { title: "watchPartyPage.steps.join.title", body: "watchPartyPage.steps.join.body" },
  { title: "watchPartyPage.steps.review.title", body: "watchPartyPage.steps.review.body" },
  { title: "watchPartyPage.steps.start.title", body: "watchPartyPage.steps.start.body" },
];

const CTA_CLASS = "cta-lift h-12 px-8 text-base";

function WaitlistCta({ className }: { className?: string }) {
  return isDevAuthBypassEnabled() ? (
    <BypassWaitlistCta className={className} />
  ) : (
    <ClerkWaitlistCta className={className} />
  );
}

/** Dev bypass has no ClerkProvider: the account already exists, go straight in. */
function BypassWaitlistCta({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Button asChild className={cn(CTA_CLASS, className)}>
      <Link
        to={WATCH_PARTY_WAITLIST_HREF}
        data-umami-event="watch-party-waitlist-cta"
      >
        {t("watchPartyPage.hero.cta")}
        <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
      </Link>
    </Button>
  );
}

function ClerkWaitlistCta({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const navigate = useNavigate();
  const go = () => void navigate(WATCH_PARTY_WAITLIST_HREF);
  return (
    <Button
      type="button"
      className={cn(CTA_CLASS, className)}
      data-umami-event="watch-party-waitlist-cta"
      onClick={() => {
        // Stashed BEFORE Clerk takes over, same as /vem: the modal can end in
        // a navigation this page does not survive. The URL is the belt.
        stashWaitlistIntent(intentStorage());
        if (isSignedIn || !isLoaded) {
          go();
          return;
        }
        try {
          void Promise.resolve(
            clerk.openSignUp({ forceRedirectUrl: WATCH_PARTY_WAITLIST_HREF }),
          ).catch(go);
        } catch {
          go();
        }
      }}
    >
      {t("watchPartyPage.hero.cta")}
      <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
    </Button>
  );
}

export function WatchPartyPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full flex-col bg-surface-0 text-text">
      <Seo
        title={t("watchPartyPage.seo.title")}
        description={t("watchPartyPage.seo.description")}
        path="/watch-party"
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />

        <div className="relative mx-auto max-w-5xl px-4 pb-24 pt-12 sm:px-8 sm:pt-20">
          <div className="animate-rise flex justify-center" style={stagger(0)}>
            <span className="inline-flex items-center gap-2 rounded-full border border-accent/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-accent">
              <Clapperboard aria-hidden className="h-3.5 w-3.5" />
              {t("watchPartyPage.hero.eyebrow")}
            </span>
          </div>

          <h1
            className="animate-rise mx-auto mt-6 max-w-3xl text-balance text-center font-brand text-4xl leading-[1.05] tracking-tight sm:text-6xl"
            style={stagger(1)}
          >
            {t("watchPartyPage.hero.title")}
          </h1>

          <p
            className="animate-rise mx-auto mt-6 max-w-2xl text-pretty text-center text-base leading-relaxed text-text-secondary sm:text-lg"
            style={stagger(2)}
          >
            {t("watchPartyPage.hero.body")}
          </p>

          <div
            className="animate-rise mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
            style={stagger(3)}
          >
            <WaitlistCta />
            <a
              href="#como-funciona"
              className="text-sm text-text-secondary underline decoration-text-tertiary/50 underline-offset-4 hover:text-text"
            >
              {t("watchPartyPage.hero.secondary")}
            </a>
          </div>

          <div className="animate-rise mt-12 sm:mt-16" style={stagger(4)}>
            <WatchPartyStageArt className="mx-auto max-w-4xl" />
          </div>

          <section className="animate-rise mt-20" style={stagger(5)}>
            <h2 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("watchPartyPage.features.title")}
            </h2>
            <WatchPartyFeatureList
              columns={3}
              className="mx-auto mt-8 max-w-4xl gap-y-6"
            />
            <p className="mx-auto mt-8 max-w-xl text-pretty text-center text-sm leading-relaxed text-text-tertiary">
              {t("watchParty.waitlist.why")}
            </p>
          </section>

          <section
            id="como-funciona"
            className="animate-rise mt-20 scroll-mt-24"
            style={stagger(6)}
          >
            <h2 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("watchPartyPage.steps.title")}
            </h2>
            <ol className="mx-auto mt-8 grid max-w-4xl gap-4 sm:grid-cols-3">
              {STEPS.map((step, index) => (
                <li
                  key={step.title}
                  className="rounded-2xl border border-border bg-surface-1 p-5"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent font-display text-sm font-bold text-on-accent">
                    {index + 1}
                  </span>
                  <h3 className="mt-4 font-display text-base font-bold tracking-tight">
                    {t(step.title)}
                  </h3>
                  <p className="mt-1.5 text-pretty text-sm leading-relaxed text-text-secondary">
                    {t(step.body)}
                  </p>
                </li>
              ))}
            </ol>
          </section>

          <section
            className="animate-rise mx-auto mt-20 max-w-2xl rounded-3xl border border-border bg-surface-1 px-6 py-10 text-center"
            style={stagger(7)}
          >
            <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("watchPartyPage.cta.title")}
            </h2>
            <p className="mt-2 text-sm text-text-secondary">
              {t("watchPartyPage.cta.body")}
            </p>
            <div className="mt-6 flex justify-center">
              <WaitlistCta />
            </div>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
