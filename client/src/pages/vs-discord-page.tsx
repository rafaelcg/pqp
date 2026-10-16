import { SignUpButton, SignedIn, SignedOut } from "@clerk/clerk-react";
import { noteSignupCta } from "@/lib/signup-assist";
import { Import, MonitorUp, Tv, type LucideIcon } from "lucide-react";
import { type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { VerdictCell } from "@/components/marketing/compare-cells";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import {
  FACTS_CHECKED,
  factFor,
  formatCheckedDate,
  VS_DISCORD_FEATURES,
  type CompareFeature,
} from "@/content/compare-facts";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { testflightUrl } from "@/lib/testflight";
import { cn } from "@/lib/utils";

/**
 * In page order. The edge middleware serves the same pairs as FAQPage JSON-LD
 * (`src/lib/marketing-meta.ts`), and the suite pins the two copies together,
 * so a question added here without its edge twin fails the tests, not
 * silently drifts.
 */
const FAQ_ITEMS: { id: string; question: MessageKey; answer: MessageKey }[] = [
  {
    id: "import",
    question: "vsDiscord.faq.import.q",
    answer: "vsDiscord.faq.import.a",
  },
  { id: "both", question: "vsDiscord.faq.both.q", answer: "vsDiscord.faq.both.a" },
  {
    id: "sound",
    question: "vsDiscord.faq.sound.q",
    answer: "vsDiscord.faq.sound.a",
  },
  {
    id: "catch",
    question: "vsDiscord.faq.catch.q",
    answer: "vsDiscord.faq.catch.a",
  },
];

/** What pqp does, before the table: the three things the page is about. */
const DOES: { id: string; icon: LucideIcon; title: MessageKey; body: MessageKey }[] = [
  {
    id: "screen",
    icon: MonitorUp,
    title: "vsDiscord.pqp.screen.title",
    body: "vsDiscord.pqp.screen.body",
  },
  {
    id: "watch",
    icon: Tv,
    title: "vsDiscord.pqp.watch.title",
    body: "vsDiscord.pqp.watch.body",
  },
  {
    id: "import",
    icon: Import,
    title: "vsDiscord.pqp.import.title",
    body: "vsDiscord.pqp.import.body",
  },
];

const ROW_LABEL: Record<CompareFeature, MessageKey> = {
  price: "vsDiscord.row.price.label",
  openSource: "vsDiscord.row.openSource.label",
  selfHost: "vsDiscord.row.selfHost.label",
  screenShare: "vsDiscord.row.screenShare.label",
  screenAudio: "vsDiscord.row.screenAudio.label",
  watchParty: "vsDiscord.row.watchParty.label",
  layoutImport: "vsDiscord.row.layoutImport.label",
  apps: "vsDiscord.row.apps.label",
  ecosystem: "vsDiscord.row.ecosystem.label",
  maturity: "vsDiscord.row.maturity.label",
};

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

function CreateRoomButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const bypass = isDevAuthBypassEnabled();
  const classes = cn("cta-lift h-11 px-6 text-base", className);

  if (bypass) {
    return (
      <Button asChild className={classes}>
        <Link to="/app">{t("vsDiscord.cta.create")}</Link>
      </Button>
    );
  }

  return (
    <>
      <SignedOut>
        <SignUpButton mode="modal" forceRedirectUrl="/app">
          <Button className={classes} onClick={() => noteSignupCta("vs-discord", "")}>
            {t("vsDiscord.cta.create")}
          </Button>
        </SignUpButton>
      </SignedOut>
      <SignedIn>
        <Button asChild className={classes}>
          <Link to="/app">{t("vsDiscord.cta.create")}</Link>
        </Button>
      </SignedIn>
    </>
  );
}

/**
 * `/vs-discord`: a feature-by-feature comparison with Discord. Every Discord
 * line comes from `content/compare-facts.ts`, which gives it a source link and
 * the day it was checked, and the page says what Discord does better. Nothing
 * here is about Discord's conduct or circumstances, only what the product does.
 * Three beats: what pqp does, the full table (including the rows Discord
 * wins), and the honest summary where the CTA closes.
 */
export function VsDiscordPage() {
  const { t, locale } = useTranslation();
  const betaUrl = testflightUrl();
  const checked = formatCheckedDate(FACTS_CHECKED, locale);

  const rows = VS_DISCORD_FEATURES.map((feature) => ({
    feature,
    pqp: factFor("pqp", feature)!,
    discord: factFor("discord", feature)!,
  }));

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title={t("vsDiscord.seo.title")}
        description={t("vsDiscord.seo.description")}
        path="/vs-discord"
      />
      <MarketingNav />

      <main className="relative flex-1 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--glow-accent),transparent_55%)]"
          aria-hidden
        />

        <div className="relative mx-auto max-w-5xl px-5 pb-24 pt-14 sm:px-8 sm:pt-20">
          {/* The matchup. `pqp` bright, `Discord` dimmed, and the brand names
              never translate, so the poster is the same in every language. */}
          <h1 className="animate-rise text-center" style={stagger(0)}>
            <span className="flex flex-col items-center gap-2 sm:flex-row sm:items-baseline sm:justify-center sm:gap-5">
              <span className="font-brand text-6xl tracking-tight text-paper sm:text-7xl">
                pqp
              </span>
              <span className="inline-block -rotate-6 font-brand text-2xl text-signal sm:text-3xl">
                vs
              </span>
              <span className="font-brand text-6xl tracking-tight text-paper-muted sm:text-7xl">
                Discord
              </span>
            </span>
            <span className="mt-5 block text-balance font-display text-xl font-bold tracking-tight sm:text-2xl">
              {t("vsDiscord.hero.tagline")}
            </span>
          </h1>

          <p
            className="animate-rise mx-auto mt-6 max-w-2xl text-pretty text-center text-base leading-relaxed text-paper-muted sm:text-lg"
            style={stagger(1)}
          >
            {t("vsDiscord.hero.body")}
          </p>
          <p
            className="animate-rise mx-auto mt-4 max-w-2xl text-pretty text-center text-xs leading-relaxed text-paper-muted/80"
            style={stagger(1)}
          >
            {t("vsDiscord.hero.asOf", { date: checked })}
          </p>
          <div
            className="animate-rise mt-8 flex justify-center"
            style={stagger(2)}
          >
            <CreateRoomButton />
          </div>

          {/* What pqp does. */}
          <section
            className="animate-rise mt-20"
            style={stagger(3)}
            aria-labelledby="vs-discord-does"
          >
            <h2
              id="vs-discord-does"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("vsDiscord.pqp.title")}
            </h2>
            <ul className="mt-8 grid gap-4 md:grid-cols-3">
              {DOES.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col rounded-2xl border border-ink-4/60 bg-ink-2/60 p-6"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-signal/15 text-signal">
                    <item.icon aria-hidden className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-display text-lg font-bold tracking-tight">
                    {t(item.title)}
                  </h3>
                  <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                    {t(item.body)}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          {/* The full record, including the rows Discord wins. */}
          <section
            className="animate-rise mt-20"
            style={stagger(4)}
            aria-labelledby="vs-discord-scoreboard"
          >
            <h2
              id="vs-discord-scoreboard"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("vsDiscord.table.title")}
            </h2>

            {/* Desktop table. */}
            <div className="mt-8 hidden overflow-hidden rounded-2xl border border-ink-4 bg-ink-2/60 md:block">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">
                  {t("vsDiscord.table.caption")}
                </caption>
                <thead>
                  <tr className="border-b border-ink-4 bg-ink-3/80">
                    <th
                      scope="col"
                      className="w-[22%] px-5 py-4 text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted"
                    >
                      {t("vsDiscord.table.col.feature")}
                    </th>
                    <th
                      scope="col"
                      className="w-[39%] border-l border-signal/25 bg-signal/[0.07] px-5 py-4 font-brand text-lg tracking-tight text-signal"
                    >
                      {t("vsDiscord.table.col.pqp")}
                    </th>
                    <th
                      scope="col"
                      className="w-[39%] border-l border-ink-4 px-5 py-4 text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted"
                    >
                      {t("vsDiscord.table.col.discord")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.feature}
                      className="border-b border-ink-4/60 transition-colors duration-150 last:border-b-0 hover:bg-ink-3/30"
                    >
                      <th
                        scope="row"
                        className="px-5 py-4 align-top text-sm font-semibold text-paper"
                      >
                        {t(ROW_LABEL[row.feature])}
                      </th>
                      <td className="border-l border-signal/25 bg-signal/[0.05] px-5 py-4 align-top">
                        <VerdictCell
                          status={row.pqp.status}
                          body={row.pqp.value[locale]}
                        />
                      </td>
                      <td className="border-l border-ink-4 px-5 py-4 align-top">
                        <VerdictCell
                          status={row.discord.status}
                          body={row.discord.value[locale]}
                          sources={row.discord.sources}
                          muted
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile stacked cards */}
            <ul
              className="mt-8 space-y-3 md:hidden"
              aria-label={t("vsDiscord.table.caption")}
            >
              {rows.map((row) => (
                <li
                  key={row.feature}
                  className="overflow-hidden rounded-xl border border-ink-4 bg-ink-2/60"
                >
                  <p className="border-b border-ink-4/60 px-4 py-3 text-sm font-semibold text-paper">
                    {t(ROW_LABEL[row.feature])}
                  </p>
                  <div className="flex gap-3 border-l-2 border-signal/40 bg-signal/[0.05] px-4 py-3">
                    <span className="w-16 shrink-0 pt-px font-brand text-sm tracking-tight text-signal">
                      {t("vsDiscord.table.col.pqp")}
                    </span>
                    <VerdictCell
                      status={row.pqp.status}
                      body={row.pqp.value[locale]}
                    />
                  </div>
                  <div className="flex gap-3 border-t border-ink-4/60 px-4 py-3">
                    <span className="w-16 shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-paper-muted">
                      {t("vsDiscord.table.col.discord")}
                    </span>
                    <VerdictCell
                      status={row.discord.status}
                      body={row.discord.value[locale]}
                      sources={row.discord.sources}
                      muted
                    />
                  </div>
                </li>
              ))}
            </ul>

            <div className="mx-auto mt-10 max-w-2xl rounded-xl border border-ink-4 bg-ink-2/60 p-5 sm:p-6">
              <h3 className="font-display text-base font-bold tracking-tight">
                {t("vsDiscord.ahead.title")}
              </h3>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                {t("vsDiscord.ahead.body")}
              </p>
            </div>
          </section>

          {/* The FAQ. Real page copy, not schema bait: the same four pairs go
              out as FAQPage JSON-LD from the edge middleware, and the suite
              pins the copies together. */}
          <section
            className="animate-rise mt-20"
            style={stagger(5)}
            aria-labelledby="vs-discord-faq"
          >
            <h2
              id="vs-discord-faq"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("vsDiscord.faq.title")}
            </h2>
            <dl className="mx-auto mt-8 max-w-2xl space-y-4">
              {FAQ_ITEMS.map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-ink-4 bg-ink-2/60 p-5 sm:p-6"
                >
                  <dt className="font-display text-base font-bold tracking-tight text-paper">
                    {t(item.question)}
                  </dt>
                  <dd className="mt-2 text-pretty text-sm leading-relaxed text-paper-muted">
                    {t(item.answer)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {/* `#ios-beta` is linked from the footer on every marketing page, so
              the anchor exists whether or not the TestFlight URL does. */}
          <section
            id="ios-beta"
            className="animate-rise mt-20 scroll-mt-8 text-center"
            style={stagger(6)}
            aria-labelledby="vs-discord-closing"
          >
            <h2
              id="vs-discord-closing"
              className="text-balance font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("vsDiscord.closing.title")}
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-base leading-relaxed text-paper-muted sm:text-lg">
              {t("vsDiscord.closing.body")}
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <CreateRoomButton />
              {betaUrl && (
                <Button
                  asChild
                  variant="secondary"
                  className="cta-lift h-11 px-6 text-base"
                >
                  <a href={betaUrl} target="_blank" rel="noopener noreferrer">
                    {t("vsDiscord.cta.beta")}
                  </a>
                </Button>
              )}
            </div>
            {!betaUrl && (
              <p className="mx-auto mt-5 max-w-md text-pretty text-sm text-paper-muted">
                <span className="font-semibold text-paper">
                  {t("vsDiscord.cta.beta")}
                </span>
                {": "}
                {t("vsDiscord.cta.beta.hint")}
              </p>
            )}
            <p className="mx-auto mt-8 max-w-2xl text-pretty text-sm text-paper-muted">
              {t("vsDiscord.closing.tela.lead")}{" "}
              <Link
                to="/tela"
                className="underline decoration-paper-muted/40 underline-offset-4 transition-colors duration-150 hover:text-paper hover:decoration-paper/60"
              >
                {t("vsDiscord.closing.tela.link")}
              </Link>
            </p>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
