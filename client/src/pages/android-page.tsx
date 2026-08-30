import { type CSSProperties } from "react";
import { Gift, MonitorUp, Smartphone, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { androidApkUrl } from "@/lib/android-apk";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { testflightUrl } from "@/lib/testflight";

/**
 * `/android` — the APK landing. Same job as `/beta` for iOS: one conversion,
 * honest about what it is (a sideloaded APK, not Play Store). The download
 * URL comes from `android-apk.ts`, so the button is real whether or not a
 * build-time override is set.
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
    title: "androidPage.perk.share.title",
    body: "androidPage.perk.share.body",
  },
  {
    id: "early",
    icon: Sparkles,
    title: "androidPage.perk.early.title",
    body: "androidPage.perk.early.body",
  },
  {
    id: "free",
    icon: Gift,
    title: "androidPage.perk.free.title",
    body: "androidPage.perk.free.body",
  },
];

const STEPS: MessageKey[] = [
  "androidPage.how.1",
  "androidPage.how.2",
  "androidPage.how.3",
];

export function AndroidPage() {
  const { t } = useTranslation();
  const apkUrl = androidApkUrl();
  const iosUrl = testflightUrl();

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("androidPage.seo.title")}
        description={t("androidPage.seo.description")}
        path="/android"
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />

        <div className="relative mx-auto max-w-3xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          <div
            className="animate-rise flex justify-center"
            style={stagger(0)}
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-signal/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-signal">
              <Smartphone aria-hidden className="h-3.5 w-3.5" />
              {t("androidPage.badge")}
            </span>
          </div>

          <h1
            className="animate-rise mt-6 text-balance text-center font-brand text-4xl leading-[1.05] tracking-tight sm:text-5xl"
            style={stagger(1)}
          >
            {t("androidPage.title")}
          </h1>

          <p
            className="animate-rise mx-auto mt-6 max-w-xl text-pretty text-center text-base leading-relaxed text-paper-muted sm:text-lg"
            style={stagger(2)}
          >
            {t("androidPage.body")}
          </p>

          <div
            className="animate-rise mt-9 flex flex-col items-center gap-3"
            style={stagger(3)}
          >
            {apkUrl ? (
              <>
                <Button asChild className="cta-lift h-12 px-8 text-base">
                  <a href={apkUrl} rel="noopener">
                    {t("androidPage.cta")}
                  </a>
                </Button>
                <p className="text-sm text-paper-muted">
                  {t("androidPage.cta.sub")}
                </p>
              </>
            ) : (
              <p className="text-sm text-paper-muted">
                {t("androidPage.cta.soon")}
              </p>
            )}
            <Link
              to="/app"
              className="text-sm text-paper-muted underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
            >
              {t("androidPage.web")}
            </Link>
          </div>

          <div
            className="animate-rise mt-14 flex justify-center"
            style={stagger(4)}
          >
            <PhoneFrame />
          </div>

          <section className="animate-rise mt-20" style={stagger(5)}>
            <h2 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("androidPage.perks.title")}
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

          <section className="animate-rise mt-16" style={stagger(6)}>
            <h2 className="text-center font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {t("androidPage.how.title")}
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

          <p className="mx-auto mt-14 max-w-xl text-pretty text-center text-sm leading-relaxed text-paper-muted">
            {t("androidPage.honest")}
          </p>

          {iosUrl && (
            <p className="mx-auto mt-4 max-w-xl text-pretty text-center text-sm leading-relaxed text-paper-muted">
              <Link
                to="/beta"
                className="underline decoration-paper-muted/40 underline-offset-4 hover:text-paper hover:decoration-paper/60"
              >
                {t("androidPage.ios")}
              </Link>
            </p>
          )}

          {apkUrl && (
            <div className="mt-10 flex justify-center">
              <Button asChild className="cta-lift h-12 px-8 text-base">
                <a href={apkUrl} rel="noopener">
                  {t("androidPage.cta")}
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

/**
 * A phone frame drawn in CSS — same idea as `/download`'s window. There is
 * no Android screenshot in the repo, and a mocked-up fake one would be a lie.
 * The wordmark inside a squircle says "it is an app on a phone".
 */
function PhoneFrame() {
  return (
    <div aria-hidden className="relative">
      <div className="absolute -inset-10 rounded-full bg-signal/5 blur-3xl" />
      <div className="relative w-[236px] overflow-hidden rounded-[2.25rem] border border-ink-4 bg-ink-2/90 shadow-2xl shadow-black/50 sm:w-[272px]">
        <div className="mx-auto mt-3 h-5 w-24 rounded-full bg-ink-4/80" />
        <div className="flex min-h-[28rem] flex-col items-center justify-center gap-6 px-8 py-16">
          <span className="font-brand text-6xl tracking-tight text-paper">
            pqp
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-signal" />
            <span className="h-2 w-16 rounded-full bg-ink-4" />
          </span>
        </div>
        <div className="mx-auto mb-4 h-1.5 w-28 rounded-full bg-ink-4" />
      </div>
    </div>
  );
}
