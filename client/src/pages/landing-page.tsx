import {
  ArrowRight,
  AtSign,
  Check,
  Code2,
  DoorOpen,
  Import,
  KeyRound,
  LayoutGrid,
  MonitorSmartphone,
  MonitorUp,
  Palette,
  type LucideIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HeroDownload } from "@/components/marketing/hero-download";
import { MarketingAuthCtas } from "@/components/marketing/marketing-auth-ctas";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import {
  ChatFrame,
  HeroFrame,
  RolesFrame,
  ScreenFrame,
  VoiceFrame,
} from "@/components/marketing/product-frames";
import { Seo } from "@/components/marketing/seo";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

/**
 * Five facts, each of them checkable. The watch party is the one dated claim
 * on the page and it is real (5 Sep 2026, see docs/HANDOVER-2026-09-07.md);
 * if the number ever needs softening, delete the row rather than rounding it.
 */
const PROOF: { key: MessageKey; href?: string; external?: boolean }[] = [
  { key: "landing.proof.openSource", href: SOURCE_REPO_URL, external: true },
  { key: "landing.proof.watchParty", href: "/#voice" },
  { key: "landing.proof.region", href: "/#faq" },
  { key: "landing.proof.platforms", href: "/download" },
  { key: "landing.proof.languages" },
];

/**
 * The three reasons a group leaves Discord for this, in the order visitors
 * arrive with them. The screen-share card carries the only claim about another
 * company's product, and it carries the date so it stays true after the fact
 * changes. See docs/SEO.md for the fact sheet these are checked against.
 */
const DISCORD_CARDS: {
  icon: LucideIcon;
  title: MessageKey;
  body: MessageKey;
  hint?: MessageKey;
  link?: { key: MessageKey; to: string; external?: boolean };
}[] = [
  {
    icon: MonitorUp,
    title: "landing.discord.screen.title",
    body: "landing.discord.screen.body",
    link: { key: "landing.discord.screen.link", to: "/vs-discord" },
  },
  {
    icon: Import,
    title: "landing.discord.import.title",
    body: "landing.discord.import.body",
    hint: "landing.discord.import.hint",
  },
  {
    icon: Code2,
    title: "landing.discord.own.title",
    body: "landing.discord.own.body",
    link: { key: "landing.discord.own.link", to: SOURCE_REPO_URL, external: true },
  },
];

/**
 * The four pillars, each with a drawn frame of the feature. Only things that
 * ship today and are on at pqp.gg; the comment on `product-frames.tsx` says
 * what happens when one stops being true.
 */
const PILLARS: {
  id: string;
  title: MessageKey;
  body: MessageKey;
  points: MessageKey[];
  frame: ReactNode;
}[] = [
  {
    id: "voice",
    title: "landing.voice.title",
    body: "landing.voice.body",
    points: ["landing.voice.point1", "landing.voice.point2", "landing.voice.point3"],
    frame: <VoiceFrame />,
  },
  {
    id: "screen",
    title: "landing.screen.title",
    body: "landing.screen.body",
    points: ["landing.screen.point1", "landing.screen.point2", "landing.screen.point3"],
    frame: <ScreenFrame />,
  },
  {
    id: "chat",
    title: "landing.chat.title",
    body: "landing.chat.body",
    points: ["landing.chat.point1", "landing.chat.point2", "landing.chat.point3"],
    frame: <ChatFrame />,
  },
  {
    id: "roles",
    title: "landing.roles.title",
    body: "landing.roles.body",
    points: ["landing.roles.point1", "landing.roles.point2", "landing.roles.point3"],
    frame: <RolesFrame />,
  },
];

const MORE: { icon: LucideIcon; title: MessageKey; body: MessageKey; to?: string }[] = [
  {
    icon: AtSign,
    title: "landing.more.handle.title",
    body: "landing.more.handle.body",
    to: "/garanta",
  },
  {
    icon: MonitorSmartphone,
    title: "landing.more.everywhere.title",
    body: "landing.more.everywhere.body",
    to: "/download",
  },
  {
    icon: Palette,
    title: "landing.more.appearance.title",
    body: "landing.more.appearance.body",
  },
];

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

/**
 * The homepage FAQ. The edge middleware serves the same pairs as FAQPage
 * JSON-LD (`src/lib/marketing-meta.ts`), and `marketing-meta.test.ts` pins the
 * two copies together in this order, so a question added here without its
 * edge twin fails the suite rather than silently drifting.
 */
export const LANDING_FAQ_IDS = ["free", "install", "capacity", "import", "data"] as const;

const SECTION = "scroll-mt-20 px-5 py-20 sm:px-8 sm:py-28";
const H2 = "font-display text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl";
const EYEBROW = "font-display text-xs font-bold uppercase tracking-[0.22em] text-signal";

export function LandingPage() {
  const { t, locale } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const [heroPlaying, setHeroPlaying] = useState(false);
  const [overHero, setOverHero] = useState(true);
  const heroRef = useRef<HTMLElement>(null);
  const heroVideo = useRef<HTMLVideoElement>(null);

  // `autoplay` alone is not enough: a tab that mounts in the background leaves
  // the element idle and Chrome does not revisit that on its own. Ask directly,
  // and ask again whenever the tab comes forward.
  useEffect(() => {
    const el = heroVideo.current;
    if (!el) return;
    const start = () => {
      if (el.readyState === 0) el.load();
      void el.play().catch(() => {
        // Autoplay refused (Low Power Mode, strict settings): the still stands in.
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

      {/* Hero. The painting stays as the backdrop, but the product now sits in
          front of it: a visitor should know what the app looks like before
          they read a word. The scrim is heavier than before for the same
          reason, so the frame reads as the subject and the painting as mood. */}
      <section ref={heroRef} className="relative -mt-16 overflow-hidden">
        <div className="hero-parallax pointer-events-none absolute inset-0" aria-hidden>
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
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-black/45 to-ink"
          aria-hidden
        />
        <div className="hero-grain pointer-events-none absolute inset-0" aria-hidden />

        <div className="relative z-10 mx-auto flex max-w-6xl flex-col items-center px-5 pb-10 pt-28 text-center sm:px-8 sm:pt-36">
          <p
            className={cn("animate-rise", EYEBROW, "text-white/80")}
            style={stagger(0)}
          >
            {t("landing.hero.eyebrow")}
          </p>
          <h1
            className="animate-rise mt-5 max-w-4xl font-display text-4xl font-bold leading-[1.02] tracking-tight text-white sm:text-6xl md:text-7xl"
            style={stagger(1)}
          >
            {t("landing.hero.title")}
          </h1>
          <p
            className="animate-rise mt-6 max-w-2xl text-lg text-white/85 sm:text-xl"
            style={stagger(2)}
          >
            {t("landing.hero.body")}
          </p>

          <div className="animate-rise mt-9" style={stagger(3)}>
            <MarketingAuthCtas appearance="hero" primaryKey="landing.hero.action" />
          </div>

          <p className="animate-rise mt-4 max-w-md text-sm text-white/65" style={stagger(4)}>
            {t("landing.hero.hint")}
          </p>
          <HeroDownload className="animate-rise mt-4" style={stagger(5)} />

          <div className="animate-rise mt-14 w-full" style={stagger(6)}>
            <HeroFrame />
          </div>
        </div>

        <ul className="relative z-10 mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-8 gap-y-2 px-5 pb-10 sm:px-8">
          {PROOF.map((item, i) => {
            const cls =
              "text-[11px] font-medium uppercase tracking-[0.22em] text-white/70 underline decoration-transparent underline-offset-4 transition-colors duration-150 hover:text-white hover:decoration-white/70";
            return (
              <li key={item.key} className="animate-rise" style={stagger(7 + i)}>
                {item.href ? (
                  <a
                    href={item.href}
                    {...(item.external ? { target: "_blank", rel: "noopener" } : {})}
                    className={cls}
                  >
                    {t(item.key)}
                  </a>
                ) : (
                  <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-white/70">
                    {t(item.key)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Why people leave Discord. First after the hero, because that is who
          the page mostly gets, and the honest opener ("Discord is good") is
          what makes the three cards believable. */}
      <section id="discord" className={cn(SECTION, "border-b border-ink-4/40")}>
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-2xl text-center">
            <p className={EYEBROW}>{t("landing.discord.eyebrow")}</p>
            <h2 className={cn(H2, "mt-3")}>{t("landing.discord.title")}</h2>
            <p className="mt-4 text-lg text-paper-muted">{t("landing.discord.body")}</p>
          </div>
          <ul className="mt-14 grid gap-5 md:grid-cols-3">
            {DISCORD_CARDS.map((card) => (
              <li
                key={card.title}
                className="flex flex-col rounded-2xl border border-ink-4/60 bg-ink-2/60 p-6 transition-colors duration-200 hover:border-signal/40"
              >
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-signal/15 text-signal">
                  <card.icon aria-hidden className="h-5 w-5" />
                </span>
                <h3 className="mt-5 font-display text-xl font-bold">{t(card.title)}</h3>
                <p className="mt-2 text-paper-muted">{t(card.body)}</p>
                {card.hint && (
                  <p className="mt-2 text-sm text-paper-muted/70">{t(card.hint)}</p>
                )}
                {card.link && (
                  <p className="mt-auto pt-5">
                    {card.link.external ? (
                      <a
                        href={card.link.to}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-signal hover:underline"
                      >
                        {t(card.link.key)} <ArrowRight className="h-4 w-4" aria-hidden />
                      </a>
                    ) : (
                      <Link
                        to={card.link.to}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-signal hover:underline"
                      >
                        {t(card.link.key)} <ArrowRight className="h-4 w-4" aria-hidden />
                      </Link>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* The four pillars, alternating text and frame. */}
      <section id="features" className={cn(SECTION, "border-b border-ink-4/40")}>
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-2xl text-center">
            <p className={EYEBROW}>{t("landing.pillars.eyebrow")}</p>
            <h2 className={cn(H2, "mt-3")}>{t("landing.pillars.title")}</h2>
            <p className="mt-4 text-lg text-paper-muted">{t("landing.pillars.body")}</p>
          </div>

          <div className="mt-20 space-y-24 sm:space-y-32">
            {PILLARS.map((pillar, i) => (
              <article
                key={pillar.id}
                id={pillar.id}
                className={cn(
                  "scroll-mt-24 grid items-center gap-10 lg:grid-cols-12 lg:gap-14",
                )}
              >
                <div
                  className={cn(
                    "lg:col-span-5",
                    i % 2 === 1 && "lg:order-2",
                  )}
                >
                  <h3 className="font-display text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">
                    {t(pillar.title)}
                  </h3>
                  <p className="mt-4 text-lg text-paper-muted">{t(pillar.body)}</p>
                  <ul className="mt-6 space-y-2.5">
                    {pillar.points.map((p) => (
                      <li key={p} className="flex items-start gap-3 text-paper">
                        <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-signal/15 text-signal">
                          <Check aria-hidden className="h-3 w-3" />
                        </span>
                        {t(p)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={cn("lg:col-span-7", i % 2 === 1 && "lg:order-1")}>
                  {pillar.frame}
                </div>
              </article>
            ))}
          </div>

          <div className="mt-24 sm:mt-32">
            <h3 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("landing.more.title")}
            </h3>
            <ul className="mt-10 grid gap-5 md:grid-cols-3">
              {MORE.map((item) => {
                const inner = (
                  <>
                    <item.icon aria-hidden className="h-5 w-5 text-signal" />
                    <h4 className="mt-3 font-display text-lg font-bold">{t(item.title)}</h4>
                    <p className="mt-2 text-sm text-paper-muted">{t(item.body)}</p>
                  </>
                );
                return (
                  <li key={item.title}>
                    {item.to ? (
                      <Link
                        to={item.to}
                        className="block h-full rounded-2xl border border-ink-4/60 p-6 transition-colors duration-200 hover:border-signal/40"
                      >
                        {inner}
                      </Link>
                    ) : (
                      <div className="h-full rounded-2xl border border-ink-4/60 p-6">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      {/* Communities. The directory itself sits behind sign-in and hides rooms
          the viewer is banned from, so this band is the only public statement
          that it exists. */}
      <section
        id="communities"
        className={cn(SECTION, "border-b border-ink-4/40 bg-signal/[0.04]")}
      >
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-xl text-center">
            <p className={EYEBROW}>{t("landing.communities.eyebrow")}</p>
            <h2 className={cn(H2, "mt-3")}>{t("landing.communities.title")}</h2>
            <p className="mt-4 text-lg text-paper-muted">{t("landing.communities.body")}</p>
          </div>
          <ul className="mt-14 grid gap-10 sm:grid-cols-3 sm:gap-8">
            {COMMUNITY_POINTS.map((item) => (
              <li key={item.title} className="text-left sm:text-center">
                <item.icon aria-hidden className="h-6 w-6 text-signal sm:mx-auto" />
                <h3 className="mt-2 font-display text-lg font-bold">{t(item.title)}</h3>
                <p className="mt-2 text-sm text-paper-muted">{t(item.body)}</p>
              </li>
            ))}
          </ul>
          <div className="mt-12 flex justify-center">
            <MarketingAuthCtas primaryKey="landing.communities.action" showSignIn={false} />
          </div>
        </div>
      </section>

      <section id="hosting" className={cn(SECTION, "border-b border-ink-4/40")}>
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-xl text-center">
            <h2 className={H2}>{t("landing.hosting.title")}</h2>
            <p className="mt-3 text-lg text-paper-muted">{t("landing.hosting.body")}</p>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2">
            <div className="rounded-2xl border border-ink-4/60 p-6 transition-colors duration-200 hover:border-signal/40">
              <h3
                className="font-display text-xl font-bold"
                lang={locale === "en" ? undefined : "en"}
              >
                {t("landing.hosting.selfHost.title")}
              </h3>
              <p className="mt-3 text-paper-muted">{t("landing.hosting.selfHost.body")}</p>
              <a
                href={SOURCE_REPO_URL}
                target="_blank"
                rel="noopener"
                className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-signal transition-colors duration-150 hover:underline"
              >
                {t("landing.hosting.selfHost.action")} <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            </div>
            <div className="rounded-2xl border border-signal/30 bg-signal/[0.05] p-6">
              <h3 className="font-display text-xl font-bold">{t("landing.hosting.hosted.title")}</h3>
              <p className="mt-3 text-paper-muted">{t("landing.hosting.hosted.body")}</p>
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

      {/* FAQ. Real questions with real answers, rendered as copy, which is
          what lets the edge serve them as FAQPage schema without lying. */}
      <section id="faq" className={cn(SECTION, "border-b border-ink-4/40")}>
        <div className="mx-auto max-w-3xl">
          <h2 className={cn(H2, "text-center")}>{t("landing.faq.title")}</h2>
          <dl className="mt-12 divide-y divide-ink-4/40">
            {LANDING_FAQ_IDS.map((id) => (
              <div key={id} className="py-6">
                <dt className="font-display text-lg font-bold">
                  {t(`landing.faq.${id}.q` as MessageKey)}
                </dt>
                <dd className="mt-2 text-paper-muted">
                  {t(`landing.faq.${id}.a` as MessageKey)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="relative overflow-hidden px-5 py-24 text-center sm:px-8 sm:py-32">
        <img
          src="/images/hero-background.jpg"
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center opacity-40"
        />
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-ink via-ink/70 to-ink"
          aria-hidden
        />
        <div className="relative">
          <h2 className={H2}>{t("landing.cta.title")}</h2>
          <p className="mx-auto mt-3 max-w-md text-lg text-paper-muted">{t("landing.cta.body")}</p>
          <MarketingAuthCtas primaryKey="landing.cta.action" decoratePrimary className="mt-8" />
          <p className="mt-6 text-sm text-paper-muted">
            <Link
              to="/beta"
              className="underline decoration-paper-muted/40 underline-offset-4 transition-colors duration-150 hover:text-paper hover:decoration-paper/60"
            >
              {t("landing.cta.beta")}
            </Link>
            <span aria-hidden className="mx-2 text-paper-muted/40">
              ·
            </span>
            <Link
              to="/android"
              className="underline decoration-paper-muted/40 underline-offset-4 transition-colors duration-150 hover:text-paper hover:decoration-paper/60"
            >
              {t("landing.cta.android")}
            </Link>
          </p>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
