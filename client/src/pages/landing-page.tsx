import {
  SignInButton,
  SignUpButton,
  SignedIn,
  SignedOut,
} from "@clerk/clerk-react";
import { ArrowUpRight } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

const TRUST_ITEMS: MessageKey[] = [
  "landing.trust.openSource",
  "landing.trust.selfHostable",
  "landing.trust.meshVoice",
  "landing.trust.inviteCodes",
  "landing.trust.yourKeys",
];

const HOW_STEPS = [
  {
    step: "01",
    title: "landing.how.step1.title",
    body: "landing.how.step1.body",
  },
  {
    step: "02",
    title: "landing.how.step2.title",
    body: "landing.how.step2.body",
  },
  {
    step: "03",
    title: "landing.how.step3.title",
    body: "landing.how.step3.body",
  },
] satisfies { step: string; title: MessageKey; body: MessageKey }[];

export function LandingPage() {
  const { t, locale } = useTranslation();
  const bypass = isDevAuthBypassEnabled();
  const reducedMotion = usePrefersReducedMotion();
  // The still is what paints first and what stays put if the clip never runs —
  // a blocked autoplay (iOS Low Power Mode) simply leaves this false.
  const [heroPlaying, setHeroPlaying] = useState(false);
  const heroVideo = useRef<HTMLVideoElement>(null);

  // `autoplay` alone is not enough: a tab that mounts in the background leaves
  // the element idle (networkState IDLE, nothing fetched) and Chrome does not
  // revisit that on its own, so the loop would never start. Ask directly, and
  // ask again whenever the tab comes forward.
  useEffect(() => {
    const el = heroVideo.current;
    if (!el) return;
    const start = () => {
      if (el.readyState === 0) el.load();
      void el.play().catch(() => {
        // Autoplay refused (Low Power Mode, strict settings) — the still stands in.
      });
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => document.removeEventListener("visibilitychange", start);
  }, [reducedMotion]);

  return (
    <div className="min-h-full bg-ink text-paper">
      <Seo
        title={t("landing.seo.title")}
        description={t("landing.seo.description")}
        path="/"
      />

      <section className="relative flex min-h-[100svh] flex-col overflow-hidden">
        <div className="hero-parallax absolute inset-0" aria-hidden>
          <img
            src="/images/hero-background.jpg"
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-center"
            fetchPriority="high"
            decoding="async"
          />
          {!reducedMotion && (
            <video
              ref={heroVideo}
              src="/images/hero-background.mp4"
              className={cn(
                "absolute inset-0 h-full w-full object-cover object-center transition-opacity duration-[1200ms] ease-out",
                heroPlaying ? "opacity-100" : "opacity-0",
              )}
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              onPlaying={() => setHeroPlaying(true)}
            />
          )}
        </div>
        <div
          className="absolute inset-0 bg-gradient-to-b from-black/50 via-black/28 to-black/75"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,var(--scrim-media)_100%)]"
          aria-hidden
        />
        <div className="hero-grain pointer-events-none absolute inset-0" aria-hidden />

        <MarketingNav variant="hero" />

        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-5 pb-28 pt-8 text-center sm:px-8">
          <p
            className="animate-rise font-brand text-6xl font-normal tracking-tight text-white drop-shadow-sm sm:text-7xl md:text-8xl"
            style={stagger(0)}
          >
            pqp
          </p>
          <h1
            className="animate-rise mt-6 max-w-2xl font-display text-3xl font-bold leading-[1.05] tracking-tight text-white sm:text-4xl md:text-5xl"
            style={stagger(1)}
          >
            {t("landing.hero.title")}
          </h1>
          <p
            className="animate-rise mt-4 max-w-lg text-base text-white/85 sm:text-lg"
            style={stagger(2)}
          >
            {t("landing.hero.body")}
          </p>

          <div
            className="animate-rise mt-8 flex items-center gap-3"
            style={stagger(3)}
          >
            {bypass ? (
              <>
                <Button
                  asChild
                  className="cta-lift h-11 rounded-full bg-white px-6 text-base font-semibold text-ink shadow-lg shadow-black/25 hover:bg-white/90"
                >
                  <Link to="/app">{t("nav.openApp")}</Link>
                </Button>
                <Link
                  to="/app"
                  className="cta-lift flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/40 backdrop-blur-sm hover:bg-white/25"
                  aria-label={t("nav.openApp")}
                >
                  <ArrowUpRight className="h-5 w-5" />
                </Link>
              </>
            ) : (
              <>
                <SignedOut>
                  <SignUpButton mode="modal" forceRedirectUrl="/app">
                    <Button className="cta-lift h-11 rounded-full bg-white px-6 text-base font-semibold text-ink shadow-lg shadow-black/25 hover:bg-white/90">
                      {t("nav.signUp")}
                    </Button>
                  </SignUpButton>
                  <SignInButton mode="modal" forceRedirectUrl="/app">
                    <button
                      type="button"
                      className="cta-lift flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/40 backdrop-blur-sm hover:bg-white/25"
                      aria-label={t("nav.signIn")}
                    >
                      <ArrowUpRight className="h-5 w-5" />
                    </button>
                  </SignInButton>
                </SignedOut>
                <SignedIn>
                  <Button
                    asChild
                    className="cta-lift h-11 rounded-full bg-white px-6 text-base font-semibold text-ink shadow-lg shadow-black/25 hover:bg-white/90"
                  >
                    <Link to="/app">{t("nav.openApp")}</Link>
                  </Button>
                  <Link
                    to="/app"
                    className="cta-lift flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/40 backdrop-blur-sm hover:bg-white/25"
                    aria-label={t("nav.openApp")}
                  >
                    <ArrowUpRight className="h-5 w-5" />
                  </Link>
                </SignedIn>
              </>
            )}
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-white/10 bg-black/25 px-5 py-4 backdrop-blur-sm sm:px-8">
          <ul className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-x-8 gap-y-2">
            {TRUST_ITEMS.map((key, i) => (
              <li
                key={key}
                className="animate-rise text-[11px] font-medium uppercase tracking-[0.22em] text-white/70"
                style={stagger(4 + i)}
                // "Self-host" is left in English in Portuguese because that is
                // the word the audience uses. Saying so in the markup keeps a
                // screen reader from pronouncing it with Portuguese phonetics.
                lang={
                  key === "landing.trust.selfHostable" && locale !== "en"
                    ? "en"
                    : undefined
                }
              >
                {t(key)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-b border-ink-4/40 px-5 py-20 sm:px-8 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {t("landing.pitch.title")}
          </h2>
          <p className="mt-4 text-lg text-paper-muted">
            {t("landing.pitch.body")}
          </p>
        </div>
      </section>

      <section
        id="how"
        className="scroll-mt-8 border-b border-ink-4/40 px-5 py-20 sm:px-8 sm:py-24"
      >
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              {t("landing.how.title")}
            </h2>
            <p className="mt-3 text-paper-muted">{t("landing.how.body")}</p>
          </div>
          <ol className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-8">
            {HOW_STEPS.map((item) => (
              <li key={item.step} className="text-left sm:text-center">
                <p className="font-display text-sm font-bold text-signal">
                  {item.step}
                </p>
                <h3 className="mt-2 font-display text-xl font-bold">
                  {t(item.title)}
                </h3>
                <p className="mt-2 text-sm text-paper-muted">{t(item.body)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        id="hosting"
        className="scroll-mt-8 border-b border-ink-4/40 px-5 py-20 sm:px-8 sm:py-24"
      >
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              {t("landing.hosting.title")}
            </h2>
            <p className="mt-3 text-paper-muted">{t("landing.hosting.body")}</p>
          </div>
          <div className="mt-14 grid gap-8 sm:grid-cols-2">
            <div>
              <h3
                className="font-display text-xl font-bold"
                lang={locale === "en" ? undefined : "en"}
              >
                {t("landing.hosting.selfHost.title")}
              </h3>
              <p className="mt-3 text-paper-muted">
                {t("landing.hosting.selfHost.body")}
              </p>
            </div>
            <div>
              <h3 className="font-display text-xl font-bold">
                {t("landing.hosting.hosted.title")}
              </h3>
              <p className="mt-3 text-paper-muted">
                {t("landing.hosting.hosted.body")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-5 py-20 text-center sm:px-8 sm:py-24">
        <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          {t("landing.cta.title")}
        </h2>
        <p className="mx-auto mt-3 max-w-md text-paper-muted">
          {t("landing.cta.body")}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {bypass ? (
            <Button asChild className="cta-lift h-11 px-6 text-base">
              <Link to="/app">{t("nav.openApp")}</Link>
            </Button>
          ) : (
            <>
              <SignedOut>
                <SignUpButton mode="modal" forceRedirectUrl="/app">
                  <Button className="cta-lift h-11 px-6 text-base">
                    {t("nav.signUp")}
                  </Button>
                </SignUpButton>
                <SignInButton mode="modal" forceRedirectUrl="/app">
                  <Button variant="secondary" className="cta-lift h-11 px-6 text-base">
                    {t("nav.signIn")}
                  </Button>
                </SignInButton>
              </SignedOut>
              <SignedIn>
                <Button asChild className="cta-lift h-11 px-6 text-base">
                  <Link to="/app">{t("nav.openApp")}</Link>
                </Button>
              </SignedIn>
            </>
          )}
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
