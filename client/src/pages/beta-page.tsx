import { Gift, MonitorUp, Smartphone, Sparkles } from "lucide-react";
import { type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { testflightUrl } from "@/lib/testflight";

/**
 * `/beta` — the iOS TestFlight landing. Its job is one conversion: tapping into
 * the beta. The framing is early access rather than "an app you can download",
 * because that is the honest truth (no public App Store listing yet) and it is
 * also the more enticing one. The TestFlight link comes from `testflight.ts`,
 * so this page has a real button whether or not a build secret is set.
 */

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

interface Perk {
  id: string;
  icon: typeof MonitorUp;
  title: MessageKey;
  body: MessageKey;
}

const PERKS: Perk[] = [
  {
    id: "share",
    icon: MonitorUp,
    title: "betaPage.perk.share.title",
    body: "betaPage.perk.share.body",
  },
  {
    id: "early",
    icon: Sparkles,
    title: "betaPage.perk.early.title",
    body: "betaPage.perk.early.body",
  },
  {
    id: "free",
    icon: Gift,
    title: "betaPage.perk.free.title",
    body: "betaPage.perk.free.body",
  },
];

const STEPS: MessageKey[] = [
  "betaPage.how.1",
  "betaPage.how.2",
  "betaPage.how.3",
];

export function BetaPage() {
  const { t } = useTranslation();
  const betaUrl = testflightUrl();

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("betaPage.seo.title")}
        description={t("betaPage.seo.description")}
        path="/beta"
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />

        <div className="relative mx-auto max-w-3xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          {/* Hero: the badge sells scarcity, the headline sells the privilege. */}
          <div
            className="animate-rise flex justify-center"
            style={stagger(0)}
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-signal/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-signal">
              <Smartphone aria-hidden className="h-3.5 w-3.5" />
              {t("betaPage.badge")}
            </span>
          </div>

          <h1
            className="animate-rise mt-6 text-balance text-center font-brand text-4xl leading-[1.05] tracking-tight sm:text-5xl"
            style={stagger(1)}
          >
            {t("betaPage.title")}
          </h1>

          <p
            className="animate-rise mx-auto mt-6 max-w-xl text-pretty text-center text-base leading-relaxed text-paper-muted sm:text-lg"
            style={stagger(2)}
          >
            {t("betaPage.body")}
          </p>

          <div
            className="animate-rise mt-9 flex flex-col items-center gap-3"
            style={stagger(3)}
          >
            {betaUrl && (
              <Button asChild className="cta-lift h-12 px-8 text-base">
                <a href={betaUrl} target="_blank" rel="noopener noreferrer">
                  {t("betaPage.cta")}
                </a>
              </Button>
            )}
            <p className="text-sm text-paper-muted">{t("betaPage.cta.sub")}</p>
            <Link
              to="/app"
              className="text-sm text-paper-muted underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
            >
              {t("betaPage.web")}
            </Link>
          </div>

          {/* What you get. */}
          <section className="animate-rise mt-20" style={stagger(4)}>
            <h2 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("betaPage.perks.title")}
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              {PERKS.map((perk) => {
                const Icon = perk.icon;
                return (
                  <div
                    key={perk.id}
                    className="rounded-2xl border border-ink-4 bg-ink-2/60 p-6"
                  >
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-signal/12 text-signal">
                      <Icon aria-hidden className="h-5 w-5" />
                    </span>
                    <h3 className="mt-4 font-display text-base font-bold tracking-tight text-paper">
                      {t(perk.title)}
                    </h3>
                    <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                      {t(perk.body)}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* How to join — a real 3-step sequence, so numbered markers earn it. */}
          <section className="animate-rise mt-16" style={stagger(5)}>
            <h2 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("betaPage.how.title")}
            </h2>
            <ol className="mx-auto mt-8 flex max-w-xl flex-col gap-4">
              {STEPS.map((step, index) => (
                <li key={step} className="flex items-start gap-4">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-signal font-display text-sm font-bold text-ink">
                    {index + 1}
                  </span>
                  <span className="pt-1 text-pretty text-base leading-relaxed text-paper">
                    {t(step)}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {/* The honest note, on purpose, at the point of decision. */}
          <Aside>{t("betaPage.honest")}</Aside>

          {betaUrl && (
            <div className="mt-10 flex justify-center">
              <Button asChild className="cta-lift h-12 px-8 text-base">
                <a href={betaUrl} target="_blank" rel="noopener noreferrer">
                  {t("betaPage.cta")}
                </a>
              </Button>
            </div>
          )}
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

function Aside({ children }: { children: ReactNode }) {
  return (
    <p className="mx-auto mt-14 max-w-xl text-pretty text-center text-sm leading-relaxed text-paper-muted">
      {children}
    </p>
  );
}
