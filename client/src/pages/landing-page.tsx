import {
  DoorOpen,
  KeyRound,
  LayoutGrid,
  Link2,
  MessageSquare,
  MessagesSquare,
  Mic,
  MonitorUp,
  Search,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HeroDownload } from "@/components/marketing/hero-download";
import { MarketingAuthCtas } from "@/components/marketing/marketing-auth-ctas";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

const TRUST_ITEMS = [
  {
    key: "landing.trust.openSource",
    href: SOURCE_REPO_URL,
    external: true,
  },
  { key: "landing.trust.selfHostable", href: "/#hosting" },
  { key: "landing.trust.meshVoice", href: "/#features" },
  { key: "landing.trust.inviteCodes", href: "/#features" },
  { key: "landing.trust.yourKeys", href: "/#hosting" },
] satisfies {
  key: MessageKey;
  href: string;
  external?: boolean;
}[];

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

/**
 * Only things that ship today and are on by default. Attachments are absent on
 * purpose — they stay dark unless `S3_*` is configured, so advertising them
 * would be a claim the hosted site cannot honour. Nothing here is aspirational;
 * if a row stops being true, delete the row rather than softening the wording.
 */
const FEATURES = [
  {
    icon: Mic,
    title: "landing.features.voice.title",
    body: "landing.features.voice.body",
  },
  {
    icon: MonitorUp,
    title: "landing.features.screen.title",
    body: "landing.features.screen.body",
  },
  {
    icon: MessageSquare,
    title: "landing.features.chat.title",
    body: "landing.features.chat.body",
  },
  {
    icon: Search,
    title: "landing.features.search.title",
    body: "landing.features.search.body",
  },
  {
    icon: MessagesSquare,
    title: "landing.features.dms.title",
    body: "landing.features.dms.body",
  },
  {
    icon: LayoutGrid,
    title: "landing.features.structure.title",
    body: "landing.features.structure.body",
  },
  {
    icon: Link2,
    title: "landing.features.invites.title",
    body: "landing.features.invites.body",
  },
  {
    icon: ShieldCheck,
    title: "landing.features.moderation.title",
    body: "landing.features.moderation.body",
  },
] satisfies { icon: LucideIcon; title: MessageKey; body: MessageKey }[];

/**
 * The three things a community is, sold on the open web.
 *
 * The directory itself is behind sign-in — it reads auth on every route and
 * hides rooms the viewer is banned from, so it is not and will not be an SEO
 * surface. This section is therefore the only public statement that the
 * feature exists, which is why it says what walking into one is like rather
 * than listing what one contains.
 */
const COMMUNITY_POINTS = [
  {
    icon: DoorOpen,
    title: "landing.communities.point1.title",
    body: "landing.communities.point1.body",
  },
  {
    icon: LayoutGrid,
    title: "landing.communities.point2.title",
    body: "landing.communities.point2.body",
  },
  {
    icon: KeyRound,
    title: "landing.communities.point3.title",
    body: "landing.communities.point3.body",
  },
] satisfies { icon: LucideIcon; title: MessageKey; body: MessageKey }[];

export function LandingPage() {
  const { t, locale } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  // The still is what paints first and what stays put if the clip never runs —
  // a blocked autoplay (iOS Low Power Mode) simply leaves this false.
  const [heroPlaying, setHeroPlaying] = useState(false);
  const [overHero, setOverHero] = useState(true);
  const heroRef = useRef<HTMLElement>(null);
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

  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setOverHero(entry.isIntersecting),
      { rootMargin: "-64px 0px 0px 0px", threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div className="min-h-full bg-ink text-paper">
      <Seo
        title={t("landing.seo.title")}
        description={t("landing.seo.description")}
        path="/"
      />

      <div className="sticky top-0 z-30">
        <MarketingNav variant={overHero ? "hero" : "solid"} />
      </div>

      <section
        ref={heroRef}
        className="relative -mt-16 flex min-h-[100svh] flex-col overflow-hidden"
      >
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

        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-5 pb-28 pt-24 text-center sm:px-8">
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

          <div className="animate-rise mt-8" style={stagger(3)}>
            <MarketingAuthCtas appearance="hero" />
          </div>

          <p
            className="animate-rise mt-4 max-w-md text-sm text-white/65"
            style={stagger(4)}
          >
            {t("landing.hero.hint")}
          </p>

          {/* Under the buttons, not beside them. See `HeroDownload` for why
              this is a link rather than a second pill. */}
          <HeroDownload className="animate-rise mt-5" style={stagger(5)} />
        </div>

        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-white/10 bg-black/25 px-5 py-4 backdrop-blur-sm sm:px-8">
          <ul className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-x-8 gap-y-2">
            {TRUST_ITEMS.map((item, i) => (
              <li key={item.key} className="animate-rise" style={stagger(5 + i)}>
                <a
                  href={item.href}
                  {...(item.external
                    ? { target: "_blank", rel: "noopener" }
                    : {})}
                  className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/70 underline-offset-4 hover:text-white hover:underline"
                  // "Self-host" is left in English in Portuguese because that is
                  // the word the audience uses. Saying so in the markup keeps a
                  // screen reader from pronouncing it with Portuguese phonetics.
                  lang={
                    item.key === "landing.trust.selfHostable" && locale !== "en"
                      ? "en"
                      : undefined
                  }
                >
                  {t(item.key)}
                </a>
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
        className="scroll-mt-20 border-b border-ink-4/40 px-5 py-20 sm:px-8 sm:py-24"
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

      {/* Communities. Placed straight after "three moves", because the three
          moves assume you have people to invite and this is the answer for
          everybody who does not. The band is tinted rather than plain so it
          reads as the one different thing on a page of equal sections. */}
      <section
        id="communities"
        className="scroll-mt-20 border-b border-ink-4/40 bg-signal/[0.04] px-5 py-20 sm:px-8 sm:py-24"
      >
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-xl text-center">
            <p className="font-display text-xs font-bold uppercase tracking-[0.22em] text-signal">
              {t("landing.communities.eyebrow")}
            </p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
              {t("landing.communities.title")}
            </h2>
            <p className="mt-4 text-lg text-paper-muted">
              {t("landing.communities.body")}
            </p>
          </div>
          <ul className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-8">
            {COMMUNITY_POINTS.map((item) => (
              <li key={item.title} className="text-left sm:text-center">
                <item.icon
                  aria-hidden
                  className="h-6 w-6 text-signal sm:mx-auto"
                />
                <h3 className="mt-2 font-display text-lg font-bold">
                  {t(item.title)}
                </h3>
                <p className="mt-2 text-sm text-paper-muted">{t(item.body)}</p>
              </li>
            ))}
          </ul>
          <div className="mt-12 flex justify-center">
            <MarketingAuthCtas
              primaryKey="landing.communities.action"
              showSignIn={false}
            />
          </div>
        </div>
      </section>

      <section
        id="features"
        className="scroll-mt-20 border-b border-ink-4/40 px-5 py-20 sm:px-8 sm:py-24"
      >
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              {t("landing.features.title")}
            </h2>
            <p className="mt-3 text-paper-muted">{t("landing.features.body")}</p>
          </div>
          {/* One column on a phone, so each item is a heading and a single
              line rather than a card to swipe past. */}
          <ul className="mt-14 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((item) => (
              <li key={item.title}>
                <item.icon aria-hidden className="h-5 w-5 text-signal" />
                <h3 className="mt-2 font-display text-lg font-bold">
                  {t(item.title)}
                </h3>
                <p className="mt-2 text-sm text-paper-muted">{t(item.body)}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section
        id="hosting"
        className="scroll-mt-20 border-b border-ink-4/40 px-5 py-20 sm:px-8 sm:py-24"
      >
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-xl text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              {t("landing.hosting.title")}
            </h2>
            <p className="mt-3 text-paper-muted">{t("landing.hosting.body")}</p>
          </div>
          <div className="mt-14 grid gap-8 sm:grid-cols-2">
            <div className="rounded-xl border border-ink-4/60 p-6">
              <h3
                className="font-display text-xl font-bold"
                lang={locale === "en" ? undefined : "en"}
              >
                {t("landing.hosting.selfHost.title")}
              </h3>
              <p className="mt-3 text-paper-muted">
                {t("landing.hosting.selfHost.body")}
              </p>
              <a
                href={SOURCE_REPO_URL}
                target="_blank"
                rel="noopener"
                className="mt-5 inline-flex text-sm font-medium text-signal hover:underline"
              >
                {t("landing.hosting.selfHost.action")}
              </a>
            </div>
            <div className="rounded-xl border border-ink-4/60 p-6">
              <h3 className="font-display text-xl font-bold">
                {t("landing.hosting.hosted.title")}
              </h3>
              <p className="mt-3 text-paper-muted">
                {t("landing.hosting.hosted.body")}
              </p>
              <div className="mt-5">
                <MarketingAuthCtas
                  primaryKey="landing.hosting.hosted.action"
                  showSignIn={false}
                  className="justify-start"
                />
              </div>
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
        <MarketingAuthCtas
          primaryKey="landing.cta.action"
          decoratePrimary
          className="mt-8"
        />
        {/* iOS beta is not just a mobile-visitor affordance (HeroDownload
            handles that); it gets a standing mention here so a desktop visitor
            can send the /beta link to a friend on iPhone. */}
        <p className="mt-6 text-sm text-paper-muted">
          <Link
            to="/beta"
            className="underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
          >
            {t("landing.cta.beta")}
          </Link>
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}
