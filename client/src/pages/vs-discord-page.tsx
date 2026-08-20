import {
  SignUpButton,
  SignedIn,
  SignedOut,
} from "@clerk/clerk-react";
import { Ban, Check, Minus, X, type LucideIcon } from "lucide-react";
import { type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { Button } from "@/components/ui/button";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { testflightUrl } from "@/lib/testflight";
import { cn } from "@/lib/utils";

/** The featured card renders works/suspended itself, so the table needs three. */
type Verdict = "yes" | "no" | "partial";

interface ScoreRow {
  id: string;
  label: MessageKey;
  pqp: { verdict: Verdict; body: MessageKey };
  discord: { verdict: Verdict; body: MessageKey };
}

/**
 * The screen-share row is absent on purpose: it is the reason the page exists,
 * so it gets the featured card under the hero instead of a seat in the table.
 */
const ROWS: ScoreRow[] = [
  {
    id: "price",
    label: "vsDiscord.row.price.label",
    pqp: { verdict: "yes", body: "vsDiscord.row.price.pqp" },
    discord: { verdict: "yes", body: "vsDiscord.row.price.discord" },
  },
  {
    id: "openSource",
    label: "vsDiscord.row.openSource.label",
    pqp: { verdict: "yes", body: "vsDiscord.row.openSource.pqp" },
    discord: { verdict: "no", body: "vsDiscord.row.openSource.discord" },
  },
  {
    id: "selfHost",
    label: "vsDiscord.row.selfHost.label",
    pqp: { verdict: "yes", body: "vsDiscord.row.selfHost.pqp" },
    discord: { verdict: "no", body: "vsDiscord.row.selfHost.discord" },
  },
  {
    id: "ageGate",
    label: "vsDiscord.row.ageGate.label",
    pqp: { verdict: "yes", body: "vsDiscord.row.ageGate.pqp" },
    discord: { verdict: "yes", body: "vsDiscord.row.ageGate.discord" },
  },
  {
    id: "apps",
    label: "vsDiscord.row.apps.label",
    pqp: { verdict: "partial", body: "vsDiscord.row.apps.pqp" },
    discord: { verdict: "yes", body: "vsDiscord.row.apps.discord" },
  },
  {
    id: "ecosystem",
    label: "vsDiscord.row.ecosystem.label",
    pqp: { verdict: "partial", body: "vsDiscord.row.ecosystem.pqp" },
    discord: { verdict: "yes", body: "vsDiscord.row.ecosystem.discord" },
  },
  {
    id: "maturity",
    label: "vsDiscord.row.maturity.label",
    pqp: { verdict: "partial", body: "vsDiscord.row.maturity.pqp" },
    discord: { verdict: "yes", body: "vsDiscord.row.maturity.discord" },
  },
  {
    id: "region",
    label: "vsDiscord.row.region.label",
    pqp: { verdict: "yes", body: "vsDiscord.row.region.pqp" },
    discord: { verdict: "yes", body: "vsDiscord.row.region.discord" },
  },
];

const VERDICT: Record<
  Verdict,
  { icon: LucideIcon; label: MessageKey; className: string }
> = {
  yes: { icon: Check, label: "vsDiscord.chip.yes", className: "bg-success/15 text-success" },
  no: { icon: X, label: "vsDiscord.chip.no", className: "bg-ink-3 text-paper-muted" },
  partial: { icon: Minus, label: "vsDiscord.chip.partial", className: "bg-warning/15 text-warning" },
};

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

/**
 * One verdict: a small colour-coded icon and the phrase. The icon is decorative
 * — the text answers the row on its own — except where the phrase does not
 * literally state the verdict word, where a visually-hidden prefix restores for
 * a screen reader what the colour coding tells everyone else.
 */
function VerdictCell({
  verdict,
  body,
  muted = false,
}: {
  verdict: Verdict;
  body: string;
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const { icon: Icon, label, className } = VERDICT[verdict];
  const verdictWord = t(label);
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={cn(
          "mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
          className,
        )}
      >
        <Icon className="h-3 w-3" strokeWidth={3} />
      </span>
      <p
        className={cn(
          "text-sm leading-snug",
          muted ? "text-paper-muted" : "text-paper",
        )}
      >
        {!body.toLowerCase().startsWith(verdictWord.toLowerCase()) && (
          <span className="sr-only">{verdictWord}: </span>
        )}
        {body}
      </p>
    </div>
  );
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
          <Button className={classes}>{t("vsDiscord.cta.create")}</Button>
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
 * `/vs-discord` — honest scoreboard against Discord, built for the Brazil
 * screen-share gap. Claims are verified in the design spec; tone matches the
 * landing. Three beats: the matchup, the one verdict that matters (featured
 * card, where the CTA lives), then the full record — including the rows
 * Discord wins.
 */
export function VsDiscordPage() {
  const { t } = useTranslation();
  const betaUrl = testflightUrl();

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
          {/* The matchup. `pqp` bright, `Discord` dimmed — the hierarchy is
              the argument — and the brand names never translate, so the fight
              poster is the same in both languages. */}
          <h1 className="animate-rise text-center" style={stagger(0)}>
            <span className="flex flex-col items-center gap-2 sm:flex-row sm:items-baseline sm:justify-center sm:gap-5">
              <span className="font-brand text-6xl tracking-tight text-paper sm:text-7xl">
                pqp
              </span>
              <span
                className="inline-block -rotate-6 font-brand text-2xl text-signal sm:text-3xl"
              >
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

          {/* The reason this page exists, pulled out of the table. The CTA sits
              here because this card is the conversion moment, not the footer. */}
          <section
            className="animate-rise mt-14"
            style={stagger(2)}
            aria-labelledby="vs-discord-featured"
          >
            <h2
              id="vs-discord-featured"
              className="text-center text-xs font-semibold uppercase tracking-[0.22em] text-paper-muted"
            >
              {t("vsDiscord.row.screen.label")}
            </h2>
            <div className="mt-5 grid overflow-hidden rounded-2xl border border-ink-4 md:grid-cols-2">
              <div className="relative bg-signal/[0.07] p-6 sm:p-8">
                <div
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,var(--glow-accent),transparent_65%)]"
                  aria-hidden
                />
                <div className="relative">
                  <p className="font-brand text-lg tracking-tight text-signal">
                    pqp
                  </p>
                  <p className="mt-3 flex items-center gap-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
                    <span
                      aria-hidden
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-signal/15 text-signal"
                    >
                      <Check className="h-5 w-5" strokeWidth={3} />
                    </span>
                    {t("vsDiscord.chip.works")}
                  </p>
                  <p className="mt-3 text-pretty text-sm leading-relaxed text-paper-muted">
                    {t("vsDiscord.featured.pqpDetail")}
                  </p>
                  <CreateRoomButton className="mt-6" />
                </div>
              </div>
              <div className="border-t border-ink-4 bg-ink-2/60 p-6 sm:p-8 md:border-l md:border-t-0">
                <p className="pt-1 text-xs font-semibold uppercase tracking-[0.18em] text-paper-muted">
                  Discord
                </p>
                <p className="mt-3 flex items-center gap-3 font-display text-3xl font-bold tracking-tight text-danger sm:text-4xl">
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger"
                  >
                    <Ban className="h-5 w-5" strokeWidth={3} />
                  </span>
                  {t("vsDiscord.chip.suspended")}
                </p>
                <p className="mt-3 text-pretty text-sm leading-relaxed text-paper-muted">
                  {t("vsDiscord.featured.discordDetail")}
                </p>
              </div>
            </div>
            <p className="mx-auto mt-4 max-w-2xl text-pretty text-center text-xs leading-relaxed text-paper-muted/80">
              {t("vsDiscord.hero.disclaimer")}
            </p>
          </section>

          {/* The full record, including the rows Discord wins. */}
          <section
            className="animate-rise mt-20"
            style={stagger(3)}
            aria-labelledby="vs-discord-scoreboard"
          >
            <h2
              id="vs-discord-scoreboard"
              className="text-balance text-center font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("vsDiscord.table.title")}
            </h2>

            {/* Desktop table. The spec floated sticky column headers; dropped
                deliberately — eight rows fit in one screen, and the sticky the
                old page carried was inert inside this overflow-hidden wrapper
                anyway. */}
            <div className="mt-8 hidden overflow-hidden rounded-2xl border border-ink-4 bg-ink-2/60 md:block">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">
                  {t("vsDiscord.table.caption")}
                </caption>
                <thead>
                  <tr className="border-b border-ink-4 bg-ink-3/80">
                    <th
                      scope="col"
                      className="w-[34%] px-5 py-4 text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted"
                    >
                      {t("vsDiscord.table.col.feature")}
                    </th>
                    <th
                      scope="col"
                      className="w-[33%] border-l border-signal/25 bg-signal/[0.07] px-5 py-4 font-brand text-lg tracking-tight text-signal"
                    >
                      {t("vsDiscord.table.col.pqp")}
                    </th>
                    <th
                      scope="col"
                      className="w-[33%] border-l border-ink-4 px-5 py-4 text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted"
                    >
                      {t("vsDiscord.table.col.discord")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-ink-4/60 transition-colors duration-150 last:border-b-0 hover:bg-ink-3/30"
                    >
                      <th
                        scope="row"
                        className="px-5 py-4 align-top text-sm font-semibold text-paper"
                      >
                        {t(row.label)}
                      </th>
                      <td className="border-l border-signal/25 bg-signal/[0.05] px-5 py-4 align-top">
                        <VerdictCell
                          verdict={row.pqp.verdict}
                          body={t(row.pqp.body)}
                        />
                      </td>
                      <td className="border-l border-ink-4 px-5 py-4 align-top">
                        <VerdictCell
                          verdict={row.discord.verdict}
                          body={t(row.discord.body)}
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
              {ROWS.map((row) => (
                <li
                  key={row.id}
                  className="overflow-hidden rounded-xl border border-ink-4 bg-ink-2/60"
                >
                  <p className="border-b border-ink-4/60 px-4 py-3 text-sm font-semibold text-paper">
                    {t(row.label)}
                  </p>
                  <div className="flex gap-3 border-l-2 border-signal/40 bg-signal/[0.05] px-4 py-3">
                    <span className="w-16 shrink-0 pt-px font-brand text-sm tracking-tight text-signal">
                      {t("vsDiscord.table.col.pqp")}
                    </span>
                    <VerdictCell
                      verdict={row.pqp.verdict}
                      body={t(row.pqp.body)}
                    />
                  </div>
                  <div className="flex gap-3 border-t border-ink-4/60 px-4 py-3">
                    <span className="w-16 shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-paper-muted">
                      {t("vsDiscord.table.col.discord")}
                    </span>
                    <VerdictCell
                      verdict={row.discord.verdict}
                      body={t(row.discord.body)}
                      muted
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* `#ios-beta` is linked from the footer on every marketing page, so
              the anchor exists whether or not the TestFlight URL does. */}
          <section
            id="ios-beta"
            className="animate-rise mt-20 scroll-mt-8 text-center"
            style={stagger(4)}
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
                {" — "}
                {t("vsDiscord.cta.beta.hint")}
              </p>
            )}
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
