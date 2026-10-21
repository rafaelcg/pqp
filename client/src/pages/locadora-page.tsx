import {
  ArrowLeft,
  Gamepad2,
  Keyboard,
  Lock,
  Maximize,
  Save,
  Zap,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { AppsCta } from "@/components/apps-landing/apps-cta";
import { AppsLandingGate } from "@/components/apps-landing/apps-landing-gate";
import { AppsShell } from "@/components/apps-landing/apps-shell";
import { Seo } from "@/components/marketing/seo";
import { LOCADORA_LANDING_REF } from "@/lib/apps-landing";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `/apps/locadora` (and the short link `/locadora`, canonicalised to it the way
 * `/claim` is to `/garanta`): what Locadora is, for somebody who has never
 * opened it.
 *
 * EVERY CLAIM ON THIS PAGE IS SOMETHING THE APP DOES TODAY: a shelf of the
 * person's own games (NES, SNES, Game Boy, Game Boy Color, Game Boy Advance),
 * playing in a voice channel with the call able to watch, four save slots,
 * turbo, fullscreen, keyboard or gamepad, and the file never leaving the
 * device. Saves tied to an account, playing without an account and any free
 * game are NOT live, and are not sold: the only mention is one muted "later"
 * line. Co-op input is not promised either; each person plays their own game.
 * The legal line (we do not rent or provide any game) and the rights line are
 * on the page on purpose.
 *
 * ART. Pixel art generated with Google Gemini (Nano Banana 2.1) from our own
 * prompts, credited in the footer. Scenes are shown at or below their native
 * width, so the browser always scales them down; the sprites carry their own
 * transparency. First view is the hero scene (about 120 KB at 1376 px, 52 KB
 * at 800), everything below it is lazy.
 */

const EYEBROW = "text-xs font-semibold uppercase tracking-[0.18em] text-accent";
const H2 =
  "text-balance font-display text-3xl font-bold leading-[1.1] tracking-tight text-text sm:text-4xl";

function at(ms: number): CSSProperties {
  return { "--d": ms } as CSSProperties;
}

const IMG = "/images/apps/";

/** One console card: the controller, and what it is called. Game Boy and Game Boy Color share a card. */
const CONSOLES = [
  { id: "nes", label: "NES", art: "pad-nes.webp", width: 480, height: 358 },
  { id: "snes", label: "SNES", art: "pad-snes.webp", width: 480, height: 321 },
  { id: "gb", label: "Game Boy / Game Boy Color", art: "pad-gb.webp", width: 334, height: 480 },
  { id: "gba", label: "Game Boy Advance", art: "pad-gba.webp", width: 480, height: 339 },
] as const;

export function LocadoraPage() {
  return (
    <AppsLandingGate>
      <LocadoraPageBody />
    </AppsLandingGate>
  );
}

export function LocadoraPageBody() {
  const { t } = useTranslation();

  const tools: { id: string; icon: ReactNode; key: MessageKey }[] = [
    { id: "saves", icon: <Save className="h-5 w-5" aria-hidden />, key: "locadoraPage.tools.saves" },
    { id: "turbo", icon: <Zap className="h-5 w-5" aria-hidden />, key: "locadoraPage.tools.turbo" },
    { id: "full", icon: <Maximize className="h-5 w-5" aria-hidden />, key: "locadoraPage.tools.full" },
    { id: "pad", icon: <Keyboard className="h-5 w-5" aria-hidden />, key: "locadoraPage.tools.pad" },
  ];

  return (
    <AppsShell creditKey="locadoraPage.credit">
      <Seo
        title={t("locadoraPage.seo.title")}
        description={t("locadoraPage.seo.description")}
        path="/apps/locadora"
        image="/images/og-locadora.jpg"
      />

      {/* Hero: the street at dusk, with the words on a scrim. The text is
          white in every theme because it sits on the picture, not on the page. */}
      <section
        className="relative mx-auto max-w-6xl px-0 pt-0 sm:px-8 sm:pt-8"
        aria-labelledby="locadora-title"
      >
        <div
          className="relative isolate overflow-hidden bg-black sm:rounded-[var(--radius-panel)] sm:shadow-[var(--shadow-2)]"
          data-locadora-hero=""
        >
          <img
            src={`${IMG}street-dusk-800.webp`}
            srcSet={`${IMG}street-dusk-800.webp 800w, ${IMG}street-dusk.webp 1376w`}
            sizes="(min-width: 1152px) 1152px, 100vw"
            width={1376}
            height={768}
            alt={t("locadoraPage.hero.imageAlt")}
            fetchPriority="high"
            decoding="async"
            className="block aspect-[16/9] w-full object-cover md:absolute md:inset-0 md:-z-10 md:aspect-auto md:h-full md:object-[70%_50%]"
          />
          {/* Below md the picture is a banner of its own and the words sit
              under it on the page's dark; from md up they sit on the scene. */}
          <div
            className="absolute inset-0 -z-10 hidden bg-gradient-to-r from-black/85 via-black/50 to-transparent md:block"
            aria-hidden
          />
          <div className="flex flex-col justify-end px-4 pb-8 pt-5 sm:px-10 sm:pb-12 md:min-h-[34rem] md:max-w-md md:pt-40 lg:max-w-lg">
            <Link
              to="/apps"
              className="mb-5 inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-medium text-white/80 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              data-apps-crumb=""
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {t("locadoraPage.crumb")}
            </Link>
            <h1
              id="locadora-title"
              className="text-balance font-display text-5xl font-extrabold leading-[1.02] tracking-tight text-white sm:text-7xl"
            >
              {t("locadoraPage.hero.title")}
            </h1>
            <p className="mt-3 text-xl font-semibold leading-snug text-white sm:text-2xl">
              {t("locadoraPage.hero.tagline")}
            </p>
            <p className="mt-4 max-w-lg text-pretty text-base leading-relaxed text-white/85 sm:text-lg">
              {t("locadoraPage.hero.body")}
            </p>
            <div className="mt-7">
              <AppsCta
                tag={LOCADORA_LANDING_REF}
                path="/apps/locadora"
                label={t("locadoraPage.hero.cta")}
                className="w-full sm:w-auto"
              />
            </div>
          </div>
        </div>
      </section>

      {/* The shelf. */}
      <section
        className="relative mx-auto grid max-w-6xl items-center gap-8 px-4 py-16 sm:px-8 sm:py-24 md:grid-cols-2 md:gap-14"
        aria-labelledby="locadora-shelf-title"
      >
        <div data-reveal>
          <h2 id="locadora-shelf-title" className={cn(H2, "vem-rise")} style={at(0)}>
            {t("locadoraPage.shelf.title")}
          </h2>
          <p
            className="vem-rise mt-4 max-w-md text-pretty text-lg leading-relaxed text-text-secondary"
            style={at(80)}
          >
            {t("locadoraPage.shelf.body")}
          </p>
        </div>
        <figure
          data-reveal
          className="overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 shadow-[var(--shadow-2)]"
        >
          <img
            src={`${IMG}shop-interior-800.webp`}
            srcSet={`${IMG}shop-interior-800.webp 800w, ${IMG}shop-interior.webp 1376w`}
            sizes="(min-width: 768px) 560px, calc(100vw - 32px)"
            width={800}
            height={447}
            alt={t("locadoraPage.shelf.imageAlt")}
            loading="lazy"
            decoding="async"
            className="vem-rise block h-auto w-full"
            style={at(80)}
          />
        </figure>
      </section>

      {/* What it runs. */}
      <section
        className="relative border-y border-border bg-surface-1"
        aria-labelledby="locadora-systems-title"
      >
        <div data-reveal className="mx-auto max-w-6xl px-4 py-14 sm:px-8 sm:py-20">
          <h2 id="locadora-systems-title" className={cn(EYEBROW, "vem-rise")} style={at(0)}>
            {t("locadoraPage.systems.title")}
          </h2>
          <p
            className="vem-rise mt-3 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary"
            style={at(60)}
          >
            {t("locadoraPage.systems.body")}
          </p>
          <ul className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4" data-locadora-consoles="">
            {CONSOLES.map((console_, index) => (
              <li
                key={console_.id}
                className="vem-rise flex flex-col items-center gap-4 rounded-[var(--radius-card)] border border-border bg-surface-card px-3 pb-5 pt-6"
                style={at(120 + index * 60)}
                data-locadora-console={console_.id}
              >
                <span className="flex h-28 items-center justify-center sm:h-32">
                  <img
                    src={`${IMG}${console_.art}`}
                    width={console_.width}
                    height={console_.height}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="max-h-full w-auto max-w-full object-contain"
                  />
                </span>
                <span className="text-center text-sm font-semibold leading-snug text-text">
                  {console_.label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Playing on the call. */}
      <section
        className="relative mx-auto grid max-w-6xl items-center gap-8 px-4 py-16 sm:px-8 sm:py-24 md:grid-cols-[1fr_auto] md:gap-14"
        aria-labelledby="locadora-call-title"
      >
        <div data-reveal>
          <h2 id="locadora-call-title" className={cn(H2, "vem-rise")} style={at(0)}>
            {t("locadoraPage.call.title")}
          </h2>
          <p
            className="vem-rise mt-4 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary"
            style={at(80)}
          >
            {t("locadoraPage.call.body")}
          </p>
          <h3
            className={cn(EYEBROW, "vem-rise mt-10")}
            style={at(140)}
          >
            {t("locadoraPage.tools.title")}
          </h3>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2" data-locadora-tools="">
            {tools.map((tool, index) => (
              <li
                key={tool.id}
                className="vem-rise flex min-h-11 items-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface-card px-4 py-3 text-sm font-medium text-text"
                style={at(180 + index * 50)}
                data-locadora-tool={tool.id}
              >
                <span className="text-accent">{tool.icon}</span>
                {t(tool.key)}
              </li>
            ))}
          </ul>
        </div>
        <img
          src={`${IMG}tv-crt.webp`}
          width={344}
          height={480}
          alt=""
          loading="lazy"
          decoding="async"
          className="mx-auto hidden h-auto w-56 md:block lg:w-64"
        />
      </section>

      {/* The privacy truth, kept exactly, and the lines that have to be said. */}
      <section
        className="relative border-y border-border bg-surface-1"
        aria-labelledby="locadora-privacy-title"
      >
        <div
          data-reveal
          className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-14 sm:px-8 sm:py-20 md:flex-row md:items-start md:gap-8"
          data-locadora-privacy=""
        >
          <span
            className="vem-rise flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-on-accent-soft"
            style={at(0)}
            aria-hidden
          >
            <Lock className="h-6 w-6" />
          </span>
          <div>
            <h2 id="locadora-privacy-title" className={cn(H2, "vem-rise")} style={at(40)}>
              {t("locadoraPage.privacy.title")}
            </h2>
            <p
              className="vem-rise mt-4 text-pretty text-lg leading-relaxed text-text"
              style={at(100)}
            >
              {t("locadoraPage.privacy.body")}
            </p>
            <p
              className="vem-rise mt-3 text-pretty leading-relaxed text-text-secondary"
              style={at(150)}
            >
              {t("locadoraPage.privacy.rights")}
            </p>
            <p
              className="vem-rise mt-3 text-sm font-medium text-text-secondary"
              style={at(200)}
              data-apps-legal=""
            >
              {t("locadoraPage.legal")}
            </p>
          </div>
        </div>
      </section>

      {/* Close. */}
      <section
        className="relative mx-auto max-w-3xl px-4 py-16 text-center sm:px-8 sm:py-24"
        aria-labelledby="locadora-final-title"
      >
        <h2 id="locadora-final-title" className={H2}>
          {t("locadoraPage.final.title")}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary">
          {t("locadoraPage.final.body")}
        </p>
        <div className="mt-8 flex justify-center">
          <AppsCta
            tag={LOCADORA_LANDING_REF}
            path="/apps/locadora"
            label={t("locadoraPage.hero.cta")}
          />
        </div>
        {/* Not live, and not sold: one muted line, no more. */}
        <p
          className="mx-auto mt-10 flex max-w-xl items-center justify-center gap-2 text-sm text-text-tertiary"
          data-locadora-soon=""
        >
          <Gamepad2 className="h-4 w-4 shrink-0" aria-hidden />
          {t("locadoraPage.soon")}
        </p>
      </section>
    </AppsShell>
  );
}
