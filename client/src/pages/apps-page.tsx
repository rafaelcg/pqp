import { ArrowRight, BookOpen, Code2, Package, Play, Plus } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { AppsCta } from "@/components/apps-landing/apps-cta";
import { AppsLandingGate } from "@/components/apps-landing/apps-landing-gate";
import { AppsShell } from "@/components/apps-landing/apps-shell";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { usePublicAppsConfig } from "@/hooks/use-apps-landing";
import { APPS_LANDING_REF, appsDocsUrl } from "@/lib/apps-landing";
import { LOCADORA_GUEST_PATH } from "@/lib/locadora-guest";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `/apps`: the front door of pqp Apps, which is a handful of small apps that
 * open inside a voice channel. Today that is one, Locadora, so the page says
 * what exists and does not invent a catalogue: the "more coming" row is a
 * single honest card, not a grid of apps nobody has built.
 *
 * It exists only while the runtime flag `apps_landing` is on
 * (`AppsLandingGate`); with it off the route is a redirect to `/`, exactly like
 * the donation page on a build with no links. Nothing links here yet: it is a
 * page to send people to.
 *
 * "Build yours" points at the SDK and the example in the repository (open
 * source, nothing hosted-only) and at the docs only while `VITE_APPS_DOCS_URL`
 * is set, hidden when empty like the donation links. The legal line is on the
 * page on purpose: pqp does not rent or provide a game, a person brings theirs.
 *
 * Head, canonical and the share card come from the Pages middleware
 * (`lib/apps-meta.ts`); `Seo` mirrors them in the browser.
 */

const EYEBROW = "text-xs font-semibold uppercase tracking-[0.18em] text-accent";
const H2 =
  "text-balance font-display text-3xl font-bold leading-[1.1] tracking-tight text-text sm:text-4xl";
const INLINE_LINK =
  "font-medium text-text underline decoration-text-tertiary/50 underline-offset-4 transition-colors duration-[var(--duration-fast)] hover:decoration-text";

function at(ms: number): CSSProperties {
  return { "--d": ms } as CSSProperties;
}

export function AppsPage() {
  return (
    <AppsLandingGate>
      <AppsPageBody />
    </AppsLandingGate>
  );
}

export function AppsPageBody() {
  const { t } = useTranslation();
  const docsUrl = appsDocsUrl();
  const guest = usePublicAppsConfig().config?.guest === true;

  return (
    <AppsShell creditKey="appsLanding.credit">
      <Seo
        title={t("appsLanding.seo.title")}
        description={t("appsLanding.seo.description")}
        path="/apps"
        image="/images/og-apps.jpg"
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[40rem] bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_60%)]"
        aria-hidden
      />

      {/* Hero. Static on purpose: the headline is the largest paint on a
          phone, and nothing here waits for an animation to show it. */}
      <section
        className="relative mx-auto max-w-4xl px-4 pb-14 pt-12 text-center sm:px-8 sm:pb-16 sm:pt-20"
        aria-labelledby="apps-title"
      >
        <p className={EYEBROW}>{t("appsLanding.hero.eyebrow")}</p>
        <h1
          id="apps-title"
          className="mx-auto mt-5 max-w-3xl text-balance font-display text-4xl font-extrabold leading-[1.04] tracking-tight text-text sm:text-6xl"
        >
          {t("appsLanding.hero.title")}
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary sm:text-xl">
          {t("appsLanding.hero.body")}
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <AppsCta
            tag={APPS_LANDING_REF}
            path="/apps"
            label={t("appsLanding.hero.cta")}
            className="w-full sm:w-auto"
          />
          <Button
            asChild
            variant="secondary"
            className="cta-lift h-12 w-full px-7 text-base sm:w-auto"
          >
            <Link to="/apps/locadora" data-apps-locadora-link="hero">
              {t("appsLanding.hero.secondary")}
            </Link>
          </Button>
        </div>
      </section>

      {/* The one app there is. */}
      <section
        className="relative mx-auto max-w-6xl px-4 pb-16 sm:px-8 sm:pb-20"
        aria-labelledby="apps-featured-title"
      >
        <h2 id="apps-featured-title" className={cn(EYEBROW, "mb-4")}>
          {t("appsLanding.featured.eyebrow")}
        </h2>
        <article
          data-reveal
          className="vem-rise grid overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 shadow-[var(--shadow-2)] md:grid-cols-[1.25fr_1fr]"
          style={at(0)}
          data-apps-featured="locadora"
        >
          <img
            src="/images/apps/street-dusk-800.webp"
            srcSet="/images/apps/street-dusk-800.webp 800w, /images/apps/street-dusk.webp 1376w"
            sizes="(min-width: 768px) 640px, calc(100vw - 32px)"
            width={800}
            height={447}
            alt={t("appsLanding.locadora.imageAlt")}
            decoding="async"
            className="block h-full min-h-[14rem] w-full object-cover"
          />
          <div className="flex flex-col justify-center gap-4 p-6 sm:p-9">
            <h3 className="font-display text-3xl font-extrabold tracking-tight text-text">
              {t("appsLanding.locadora.name")}
            </h3>
            <p className="text-lg font-semibold leading-snug text-text">
              {t("appsLanding.locadora.tagline")}
            </p>
            <p className="text-pretty leading-relaxed text-text-secondary">
              {t("appsLanding.locadora.body")}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              {/* Only while guest play is offered (the public config's `guest`). */}
              {guest && (
                <Button asChild className="cta-lift h-12 px-6 text-base">
                  <Link to={LOCADORA_GUEST_PATH} data-apps-locadora-link="play">
                    <Play className="h-4 w-4" aria-hidden />
                    {t("locadoraPage.hero.play")}
                  </Link>
                </Button>
              )}
              <Button
                asChild
                variant="secondary"
                className="cta-lift h-12 px-6 text-base"
              >
                <Link to="/apps/locadora" data-apps-locadora-link="card">
                  {t("appsLanding.locadora.cta")}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </Button>
            </div>
          </div>
        </article>

        {/* More are coming. One card, no names: nothing here is promised. */}
        <div
          data-reveal
          className="vem-rise mt-5 flex items-center gap-4 rounded-[var(--radius-panel)] border border-dashed border-border-strong px-5 py-5 sm:px-7"
          style={at(80)}
          data-apps-more=""
        >
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-secondary"
            aria-hidden
          >
            <Plus className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-display text-lg font-bold text-text">
              {t("appsLanding.more.title")}
            </h3>
            <p className="text-sm leading-relaxed text-text-secondary">
              {t("appsLanding.more.body")}
            </p>
          </div>
        </div>
      </section>

      {/* For people who build. */}
      <section
        className="relative border-y border-border bg-surface-1"
        aria-labelledby="apps-build-title"
      >
        <div data-reveal className="mx-auto max-w-6xl px-4 py-14 sm:px-8 sm:py-20">
          <p className={cn(EYEBROW, "vem-rise")} style={at(0)}>
            {t("appsLanding.build.eyebrow")}
          </p>
          <h2 id="apps-build-title" className={cn(H2, "vem-rise mt-3")} style={at(60)}>
            {t("appsLanding.build.title")}
          </h2>
          <p
            className="vem-rise mt-4 max-w-2xl text-pretty text-lg leading-relaxed text-text-secondary"
            style={at(120)}
          >
            {t("appsLanding.build.body")}
          </p>
          <ul
            className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-apps-build=""
          >
            <BuildCard
              icon={<Package className="h-5 w-5" aria-hidden />}
              title={t("appsLanding.build.sdk.title")}
              body={t("appsLanding.build.sdk.body")}
              link={t("appsLanding.build.sdk.link")}
              href={`${SOURCE_REPO_URL}/tree/main/packages/app-sdk`}
              id="sdk"
              delay={180}
            />
            <BuildCard
              icon={<Code2 className="h-5 w-5" aria-hidden />}
              title={t("appsLanding.build.example.title")}
              body={t("appsLanding.build.example.body")}
              link={t("appsLanding.build.example.link")}
              href={`${SOURCE_REPO_URL}/tree/main/apps/eco`}
              id="example"
              delay={240}
            />
            {docsUrl && (
              <BuildCard
                icon={<BookOpen className="h-5 w-5" aria-hidden />}
                title={t("appsLanding.build.docs.title")}
                body={t("appsLanding.build.docs.body")}
                link={t("appsLanding.build.docs.link")}
                href={docsUrl}
                id="docs"
                delay={300}
              />
            )}
          </ul>
        </div>
      </section>

      {/* Close: the cta again, and the line that has to be on the page. */}
      <section
        className="relative mx-auto max-w-3xl px-4 py-16 text-center sm:px-8 sm:py-24"
        aria-labelledby="apps-final-title"
      >
        <h2 id="apps-final-title" className={H2}>
          {t("appsLanding.final.title")}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-pretty text-lg leading-relaxed text-text-secondary">
          {t("appsLanding.final.body")}
        </p>
        <div className="mt-8 flex justify-center">
          <AppsCta
            tag={APPS_LANDING_REF}
            path="/apps"
            label={t("appsLanding.hero.cta")}
          />
        </div>
        <p className="mx-auto mt-10 max-w-xl text-sm text-text-tertiary" data-apps-legal="">
          {t("appsLanding.legal")}
        </p>
      </section>
    </AppsShell>
  );
}

function BuildCard({
  icon,
  title,
  body,
  link,
  href,
  id,
  delay,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  link: string;
  href: string;
  id: string;
  delay: number;
}) {
  return (
    <li
      className="vem-rise flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-surface-card p-5"
      style={at(delay)}
      data-apps-build-card={id}
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-text-secondary">
        {icon}
      </span>
      <h3 className="font-display text-lg font-bold text-text">{title}</h3>
      <p className="flex-1 text-sm leading-relaxed text-text-secondary">{body}</p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(INLINE_LINK, "inline-flex min-h-11 items-center gap-1.5 self-start")}
      >
        {link}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </a>
    </li>
  );
}
