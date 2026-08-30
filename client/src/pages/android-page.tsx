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
 *
 * The hero is a two-column split (copy left, a real screenshot right) on
 * the same grid `/download` uses. The photo is a capture of the running app,
 * not a CSS phone, because we now have one.
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

        <div className="relative mx-auto w-full max-w-6xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:gap-20">
            <div className="max-w-xl">
              <div className="animate-rise" style={stagger(0)}>
                <span className="inline-flex items-center gap-2 rounded-full border border-signal/50 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-signal">
                  <Smartphone aria-hidden className="h-3.5 w-3.5" />
                  {t("androidPage.badge")}
                </span>
              </div>

              <h1
                className="animate-rise mt-6 text-balance font-brand text-4xl leading-[1.05] tracking-tight sm:text-5xl"
                style={stagger(1)}
              >
                {t("androidPage.title")}
              </h1>

              <p
                className="animate-rise mt-6 max-w-md text-pretty text-base leading-relaxed text-paper-muted sm:text-lg"
                style={stagger(2)}
              >
                {t("androidPage.body")}
              </p>

              <div
                className="animate-rise mt-9 flex flex-col items-start gap-3"
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
            </div>

            <div
              className="animate-rise flex justify-center lg:justify-end"
              style={stagger(4)}
            >
              <PhoneShot alt={t("androidPage.shot.alt")} />
            </div>
          </div>

          <section
            className="animate-rise mx-auto mt-20 max-w-3xl"
            style={stagger(5)}
          >
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

          <section
            className="animate-rise mx-auto mt-16 max-w-3xl"
            style={stagger(6)}
          >
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

/** A real capture of the running Android app, not a drawn frame. */
function PhoneShot({ alt }: { alt: string }) {
  return (
    <div className="relative">
      <div
        className="absolute -inset-10 rounded-full bg-signal/5 blur-3xl"
        aria-hidden
      />
      <img
        src="/images/beta-android.webp"
        alt={alt}
        width={720}
        height={1607}
        fetchPriority="high"
        className="relative w-[236px] rounded-[2rem] shadow-2xl shadow-black/50 sm:w-[272px] lg:w-full"
      />
    </div>
  );
}
