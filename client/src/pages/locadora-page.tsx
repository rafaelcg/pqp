import { ArrowLeft, ArrowRight, Check, ChevronDown, Clock, Play } from "lucide-react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { AppsCta } from "@/components/apps-landing/apps-cta";
import { AppsLandingGate } from "@/components/apps-landing/apps-landing-gate";
import { AppsShell } from "@/components/apps-landing/apps-shell";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { usePublicAppsConfig } from "@/hooks/use-apps-landing";
import { appsDocsUrl, LOCADORA_LANDING_REF } from "@/lib/apps-landing";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { ACCOUNT_CLAIMS, claimView } from "@/lib/locadora-claims";
import { LOCADORA_GUEST_PATH } from "@/lib/locadora-guest";
import { cn } from "@/lib/utils";

/**
 * `/apps/locadora` (and the short link `/locadora`, canonicalised to it the way
 * `/claim` is to `/garanta`): what Locadora is, for somebody who has never
 * opened it. The approved launch copy (2026-10-21), in pt-BR, en and es.
 *
 * NOTHING HERE CLAIMS MORE THAN THE CODE DOES. The hero's "sem cadastro pra
 * começar" and "Jogar agora" exist only while guest play is offered (the
 * public config's `guest`); without it the page says "dentro do pqp" and its
 * button opens pqp, as before. The account section is data
 * (`lib/locadora-claims.ts`): Saves na conta is "em breve" until
 * `locadora_saves_announced`, watching a friend play is not drawn at all until
 * the share is allowed, and the FAQ answers were checked against the code
 * (turbo is 1x to 10x, `turbo.ts`; four slots plus the autosave, `saves.ts`;
 * fullscreen on a double click, `hud.ts`; the sign-in line is the home page's
 * own). The legal line is under the buttons and again at the end.
 *
 * ART. Pixel art generated with Google Gemini (Nano Banana 2.1) from our own
 * prompts, credited in the footer: the neon sign, the CRT, the console and the
 * cartridge in the hero, the controllers and the rack below. No game's picture
 * anywhere: the TV shows our own colour bars, drawn in CSS. The first view is
 * the four hero sprites (about 100 KB together), everything below is lazy and
 * every image carries its size, so nothing shifts as it arrives.
 */

const H2 =
  "text-balance font-display text-3xl font-bold leading-[1.1] tracking-tight text-text sm:text-4xl";

function at(ms: number): CSSProperties {
  return { "--d": ms } as CSSProperties;
}

const IMG = "/images/apps/";

/** One card per console. Game Boy and Game Boy Color share the controller, the Color one tinted. */
const CONSOLES = [
  { id: "nes", label: "NES", art: "pad-nes.webp", width: 480, height: 358, tint: false },
  { id: "snes", label: "SNES", art: "pad-snes.webp", width: 480, height: 321, tint: false },
  { id: "gb", label: "Game Boy", art: "pad-gb.webp", width: 334, height: 480, tint: false },
  { id: "gbc", label: "Game Boy Color", art: "pad-gb.webp", width: 334, height: 480, tint: true },
  { id: "gba", label: "Game Boy Advance", art: "pad-gba.webp", width: 480, height: 339, tint: false },
] as const;

const STEPS: { id: string; art: string; width: number; height: number; title: MessageKey; body: MessageKey }[] = [
  { id: "1", art: "cart.webp", width: 240, height: 218, title: "locadoraPage.how.1.title", body: "locadoraPage.how.1.body" },
  { id: "2", art: "pad-snes.webp", width: 480, height: 321, title: "locadoraPage.how.2.title", body: "locadoraPage.how.2.body" },
  { id: "3", art: "rack.webp", width: 320, height: 320, title: "locadoraPage.how.3.title", body: "locadoraPage.how.3.body" },
];

export function LocadoraPage() {
  return (
    <AppsLandingGate>
      <LocadoraPageBody />
    </AppsLandingGate>
  );
}

export function LocadoraPageBody() {
  const { t } = useTranslation();
  const { config } = usePublicAppsConfig();
  const guest = config?.guest === true;
  const gates = { cloudSaves: config?.cloudSaves === true };
  const docsUrl = appsDocsUrl();

  const faq: { id: string; q: MessageKey; a: MessageKey; link?: string }[] = [
    { id: "games", q: "locadoraPage.faq.games.q", a: "locadoraPage.faq.games.a" },
    { id: "file", q: "locadoraPage.faq.file.q", a: "locadoraPage.faq.file.a" },
    // "Não pra jogar" is only true while guest play is offered
    ...(guest
      ? [
          {
            id: "account",
            q: "locadoraPage.faq.account.q" as MessageKey,
            a: (gates.cloudSaves ? "locadoraPage.faq.account.aSaves" : "locadoraPage.faq.account.a") as MessageKey,
          },
        ]
      : []),
    { id: "free", q: "locadoraPage.faq.free.q", a: "locadoraPage.faq.free.a" },
    { id: "consoles", q: "locadoraPage.faq.consoles.q", a: "locadoraPage.faq.consoles.a" },
    { id: "phone", q: "locadoraPage.faq.phone.q", a: "locadoraPage.faq.phone.a" },
    { id: "who", q: "locadoraPage.faq.who.q", a: "locadoraPage.faq.who.a" },
    // only once the builders' docs are live (a hosted-only link, like the hub's)
    ...(docsUrl ? [{ id: "build", q: "locadoraPage.faq.build.q" as MessageKey, a: "locadoraPage.faq.build.a" as MessageKey, link: docsUrl }] : []),
  ];

  const claims = ACCOUNT_CLAIMS.map((claim) => ({ claim, view: claimView(claim, gates) })).filter(
    ({ view }) => view !== "hidden",
  );

  const playButton = (className?: string) =>
    guest ? (
      <Button asChild className={cn("cta-lift h-12 px-7 text-base", className)}>
        <Link to={LOCADORA_GUEST_PATH} data-locadora-play="">
          <Play className="h-4 w-4" aria-hidden />
          {t("locadoraPage.hero.play")}
        </Link>
      </Button>
    ) : (
      <AppsCta
        tag={LOCADORA_LANDING_REF}
        path="/apps/locadora"
        label={t("locadoraPage.hero.cta")}
        className={className}
      />
    );

  return (
    <AppsShell creditKey="locadoraPage.credit">
      <Seo
        title={t("locadoraPage.seo.title")}
        description={t("locadoraPage.seo.description")}
        path="/apps/locadora"
        image="/images/og-locadora-chegou.jpg"
      />

      {/* Hero: a night scene in every theme (art direction, `.loc-night` in
          index.css), the words on the left and the stage on the right. */}
      <section
        className="relative mx-auto max-w-6xl px-0 pt-0 sm:px-8 sm:pt-8"
        aria-labelledby="locadora-title"
      >
        <div
          className="loc-night relative isolate overflow-hidden sm:rounded-[var(--radius-panel)] sm:shadow-[var(--shadow-2)]"
          data-locadora-hero=""
        >
          <div
            className="loc-floor pointer-events-none absolute inset-x-[-20%] bottom-0 -z-10 h-40 sm:h-56"
            aria-hidden
          />
          <div className="grid items-center gap-6 px-4 pb-10 pt-5 sm:px-10 sm:pb-14 sm:pt-8 md:grid-cols-[1.05fr_1fr] md:gap-10 lg:px-14 lg:py-16">
            <div className="flex flex-col">
              <Link
                to="/apps"
                className="mb-6 inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-medium text-white/75 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                data-apps-crumb=""
              >
                <ArrowLeft className="h-4 w-4" aria-hidden />
                {t("locadoraPage.crumb")}
              </Link>
              <p
                className="loc-eyebrow vem-rise inline-flex self-start rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-[0.2em]"
                style={at(0)}
              >
                {t("locadoraPage.hero.eyebrow")}
              </p>
              <h1
                id="locadora-title"
                className="vem-rise mt-4 text-balance font-display text-[2.6rem] font-extrabold leading-[1.02] tracking-tight text-white sm:text-6xl lg:text-7xl"
                style={at(60)}
              >
                {t("locadoraPage.hero.title")}
              </h1>
              <p
                className="vem-rise mt-5 max-w-xl text-pretty text-lg leading-relaxed text-white/85 sm:text-xl"
                style={at(120)}
              >
                {guest ? t("locadoraPage.hero.sub") : t("locadoraPage.hero.subMember")}
              </p>
              <div className="vem-rise mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap" style={at(180)}>
                {playButton("w-full sm:w-auto")}
                {guest && (
                  <AppsCta
                    tag={LOCADORA_LANDING_REF}
                    path="/apps/locadora"
                    label={t("locadoraPage.hero.signup")}
                    variant="secondary"
                    className="w-full border-white/30 bg-white/10 text-white hover:bg-white/20 sm:w-auto"
                  />
                )}
              </div>
              <p className="vem-rise mt-5 max-w-md text-balance text-sm leading-relaxed text-white/70" style={at(220)} data-apps-legal="">
                {t("locadoraPage.legal")}
              </p>
            </div>
            <HeroStage label={t("locadoraPage.hero.imageAlt")} sign={t("locadoraPage.hero.sign")} />
          </div>
        </div>
      </section>

      {/* Como funciona: three steps, each with its sprite. */}
      <section
        className="relative mx-auto max-w-6xl px-4 py-16 sm:px-8 sm:py-24"
        aria-labelledby="locadora-how-title"
      >
        <div data-reveal>
          <h2 id="locadora-how-title" className={cn(H2, "vem-rise")} style={at(0)}>
            {t("locadoraPage.how.title")}
          </h2>
          <ol className="mt-10 grid gap-4 sm:gap-6 md:grid-cols-3" data-locadora-steps="">
            {STEPS.map((step, index) => (
              <li
                key={step.id}
                className="vem-rise relative flex flex-col rounded-[var(--radius-panel)] border border-border bg-surface-card p-6 sm:p-7"
                style={at(80 + index * 80)}
                data-locadora-step={step.id}
              >
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft font-display text-base font-bold text-on-accent-soft"
                  aria-hidden
                >
                  {step.id}
                </span>
                <span className="mt-4 flex h-32 items-center justify-center" aria-hidden>
                  <img
                    src={`${IMG}${step.art}`}
                    width={step.width}
                    height={step.height}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="max-h-full w-auto max-w-[70%] object-contain"
                  />
                </span>
                <h3 className="mt-5 font-display text-xl font-bold text-text">{t(step.title)}</h3>
                <p className="mt-2 text-pretty leading-relaxed text-text-secondary">{t(step.body)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Cinco consoles, uma prateleira. */}
      <section className="relative border-y border-border bg-surface-1" aria-labelledby="locadora-consoles-title">
        <div data-reveal className="mx-auto max-w-6xl px-4 py-16 sm:px-8 sm:py-20">
          <h2 id="locadora-consoles-title" className={cn(H2, "vem-rise")} style={at(0)}>
            {t("locadoraPage.consoles.title")}
          </h2>
          <p className="vem-rise mt-4 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary" style={at(60)}>
            {t("locadoraPage.consoles.body")}
          </p>
          <ul className="mt-10 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-5" data-locadora-consoles="">
            {CONSOLES.map((console_, index) => (
              <li
                key={console_.id}
                className={cn(
                  "vem-rise flex flex-col items-center gap-4 rounded-[var(--radius-card)] border border-border bg-surface-card px-3 pb-5 pt-6",
                  index === CONSOLES.length - 1 && "col-span-2 md:col-span-1",
                )}
                style={at(120 + index * 60)}
                data-locadora-console={console_.id}
              >
                <span className="flex h-24 items-center justify-center sm:h-28" aria-hidden>
                  <img
                    src={`${IMG}${console_.art}`}
                    width={console_.width}
                    height={console_.height}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className={cn(
                      "max-h-full w-auto max-w-full object-contain",
                      console_.tint && "hue-rotate-[150deg] saturate-150",
                    )}
                  />
                </span>
                <span className="text-center text-sm font-semibold leading-snug text-text">{console_.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* O que tu ganha com uma conta: only claims whose gate is open, Saves
          na conta muted as "em breve" while it is not announced. */}
      <section className="relative mx-auto max-w-6xl px-4 py-16 sm:px-8 sm:py-24" aria-labelledby="locadora-account-title">
        <div data-reveal className="grid gap-10 md:grid-cols-[1fr_1.3fr] md:gap-14">
          <div>
            <h2 id="locadora-account-title" className={cn(H2, "vem-rise")} style={at(0)}>
              {t("locadoraPage.account.title")}
            </h2>
            <p className="vem-rise mt-4 max-w-md text-pretty text-lg leading-relaxed text-text-secondary" style={at(60)}>
              {guest ? t("locadoraPage.account.lead") : t("locadoraPage.account.leadMember")}
            </p>
            <div className="vem-rise mt-8 flex flex-col items-start gap-3" style={at(120)}>
              <AppsCta tag={LOCADORA_LANDING_REF} path="/apps/locadora" label={t("locadoraPage.account.cta")} />
              <p className="text-sm text-text-tertiary">{t("locadoraPage.account.note")}</p>
            </div>
          </div>
          <ul className="grid gap-3" data-locadora-claims="">
            {claims.map(({ claim, view }, index) => (
              <li
                key={claim.id}
                className={cn(
                  "vem-rise rounded-[var(--radius-card)] border border-border p-5",
                  view === "soon" ? "bg-surface-1" : "bg-surface-card",
                )}
                style={at(80 + index * 60)}
                data-locadora-claim={claim.id}
                data-claim-view={view}
              >
                <div className="flex items-center gap-2">
                  {view === "soon" ? (
                    <Clock className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
                  ) : (
                    <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                  )}
                  <h3 className={cn("font-semibold", view === "soon" ? "text-text-secondary" : "text-text")}>
                    {t(claim.titleKey)}
                  </h3>
                  {view === "soon" && (
                    <span className="ml-auto shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-xs font-medium text-text-secondary">
                      {t("locadoraPage.account.soon")}
                    </span>
                  )}
                </div>
                <p className={cn("mt-2 text-pretty text-sm leading-relaxed", view === "soon" ? "text-text-tertiary" : "text-text-secondary")}>
                  {t(claim.bodyKey)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Perguntas: native disclosures, so the keyboard and a screen reader
          get them for free. */}
      <section className="relative border-y border-border bg-surface-1" aria-labelledby="locadora-faq-title">
        <div data-reveal className="mx-auto max-w-3xl px-4 py-16 sm:px-8 sm:py-20">
          <h2 id="locadora-faq-title" className={cn(H2, "vem-rise")} style={at(0)}>
            {t("locadoraPage.faq.title")}
          </h2>
          <div className="mt-8 divide-y divide-border border-y border-border" data-locadora-faq="">
            {faq.map((item) => (
              <details key={item.id} className="group" data-locadora-faq-item={item.id}>
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-4 text-left font-semibold text-text marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [&::-webkit-details-marker]:hidden">
                  {t(item.q)}
                  <ChevronDown
                    className="h-5 w-5 shrink-0 text-text-tertiary transition-transform duration-[var(--duration-fast)] group-open:rotate-180 motion-reduce:transition-none"
                    aria-hidden
                  />
                </summary>
                <p className="pb-5 pr-9 text-pretty leading-relaxed text-text-secondary">
                  {t(item.a)}
                  {item.link && (
                    <>
                      {" "}
                      <a href={item.link} className="font-medium text-accent underline-offset-4 hover:underline">
                        {t("locadoraPage.faq.build.link")}
                      </a>
                    </>
                  )}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Close. */}
      <section className="relative mx-auto max-w-3xl px-4 py-16 text-center sm:px-8 sm:py-24" aria-labelledby="locadora-final-title">
        <h2 id="locadora-final-title" className={H2}>
          {t("locadoraPage.final.title")}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary">
          {guest ? t("locadoraPage.final.body") : t("locadoraPage.final.bodyMember")}
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {playButton()}
          {guest && (
            <Link
              to="#locadora-account-title"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById("locadora-account-title")?.scrollIntoView({ block: "start" });
              }}
              className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent underline-offset-4 hover:underline"
            >
              {t("locadoraPage.account.title")}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          )}
        </div>
        <p className="mx-auto mt-8 max-w-md text-sm text-text-tertiary" data-apps-legal="">
          {t("locadoraPage.legal")}
        </p>
      </section>
    </AppsShell>
  );
}

/**
 * The hero's stage: the neon sign with the shop's name, the CRT showing our
 * colour bars, and the console with the cartridge sliding in (`.loc-*` in
 * index.css). One picture to a screen reader, with the description as its
 * name; the parts are decoration.
 */
function HeroStage({ label, sign }: { label: string; sign: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="loc-stage relative mx-auto aspect-[5/4] w-full max-w-[34rem]"
      data-locadora-stage=""
    >
      {/* the sign, with the name lit on its dark panel */}
      <div className="absolute left-[4%] top-0 w-[64%]" aria-hidden>
        <img
          src={`${IMG}neon-sign.webp`}
          width={480}
          height={335}
          alt=""
          fetchPriority="high"
          decoding="async"
          className="block h-auto w-full"
        />
        <span className="loc-sign-text absolute left-[34%] top-[27%] flex h-[37%] w-[54%] items-center justify-center font-display font-black leading-none">
          {sign}
        </span>
      </div>
      {/* the TV, switching on to the bars */}
      <div className="absolute bottom-0 left-0 w-[38%]" aria-hidden>
        <img src={`${IMG}tv-crt.webp`} width={344} height={480} alt="" decoding="async" className="block h-auto w-full" />
        <span className="loc-screen absolute left-[13.4%] top-[26.6%] h-[34%] w-[45.4%] overflow-hidden rounded-[16%]" />
      </div>
      {/* the console, and the cartridge going into its slot behind its front */}
      <div className="absolute bottom-[3%] right-0 w-[56%]" aria-hidden>
        <img
          src={`${IMG}cart.webp`}
          width={240}
          height={218}
          alt=""
          decoding="async"
          className="loc-cart absolute left-[29.5%] top-[-12%] z-10 w-[40%]"
        />
        <img src={`${IMG}console.webp`} width={480} height={416} alt="" decoding="async" className="relative block h-auto w-full" />
        <span className="loc-led absolute left-[52%] top-[63%] h-[2.2%] w-[2.2%] rounded-full" />
      </div>
    </div>
  );
}
