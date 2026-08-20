import {
  SignUpButton,
  SignedIn,
  SignedOut,
} from "@clerk/clerk-react";
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

type ChipKind = "works" | "suspended" | "yes" | "no" | "partial";

interface ScoreRow {
  id: string;
  label: MessageKey;
  pqp: { chip: ChipKind; body: MessageKey };
  discord: { chip: ChipKind; body: MessageKey };
}

const ROWS: ScoreRow[] = [
  {
    id: "screen",
    label: "vsDiscord.row.screen.label",
    pqp: { chip: "works", body: "vsDiscord.row.screen.pqp" },
    discord: { chip: "suspended", body: "vsDiscord.row.screen.discord" },
  },
  {
    id: "price",
    label: "vsDiscord.row.price.label",
    pqp: { chip: "yes", body: "vsDiscord.row.price.pqp" },
    discord: { chip: "yes", body: "vsDiscord.row.price.discord" },
  },
  {
    id: "openSource",
    label: "vsDiscord.row.openSource.label",
    pqp: { chip: "yes", body: "vsDiscord.row.openSource.pqp" },
    discord: { chip: "no", body: "vsDiscord.row.openSource.discord" },
  },
  {
    id: "selfHost",
    label: "vsDiscord.row.selfHost.label",
    pqp: { chip: "yes", body: "vsDiscord.row.selfHost.pqp" },
    discord: { chip: "no", body: "vsDiscord.row.selfHost.discord" },
  },
  {
    id: "ageGate",
    label: "vsDiscord.row.ageGate.label",
    pqp: { chip: "yes", body: "vsDiscord.row.ageGate.pqp" },
    discord: { chip: "partial", body: "vsDiscord.row.ageGate.discord" },
  },
  {
    id: "apps",
    label: "vsDiscord.row.apps.label",
    pqp: { chip: "partial", body: "vsDiscord.row.apps.pqp" },
    discord: { chip: "yes", body: "vsDiscord.row.apps.discord" },
  },
  {
    id: "ecosystem",
    label: "vsDiscord.row.ecosystem.label",
    pqp: { chip: "partial", body: "vsDiscord.row.ecosystem.pqp" },
    discord: { chip: "yes", body: "vsDiscord.row.ecosystem.discord" },
  },
  {
    id: "maturity",
    label: "vsDiscord.row.maturity.label",
    pqp: { chip: "partial", body: "vsDiscord.row.maturity.pqp" },
    discord: { chip: "yes", body: "vsDiscord.row.maturity.discord" },
  },
  {
    id: "region",
    label: "vsDiscord.row.region.label",
    pqp: { chip: "yes", body: "vsDiscord.row.region.pqp" },
    discord: { chip: "yes", body: "vsDiscord.row.region.discord" },
  },
];

const CHIP_KEY: Record<ChipKind, MessageKey> = {
  works: "vsDiscord.chip.works",
  suspended: "vsDiscord.chip.suspended",
  yes: "vsDiscord.chip.yes",
  no: "vsDiscord.chip.no",
  partial: "vsDiscord.chip.partial",
};

const CHIP_CLASS: Record<ChipKind, string> = {
  works: "border-signal/40 bg-signal/15 text-signal",
  suspended: "border-danger/40 bg-danger/15 text-danger",
  yes: "border-success/40 bg-success/15 text-success",
  no: "border-ink-4 bg-ink-3 text-paper-muted",
  partial: "border-warning/40 bg-warning/15 text-warning",
};

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

function StatusChip({ kind }: { kind: ChipKind }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        CHIP_CLASS[kind],
      )}
    >
      {t(CHIP_KEY[kind])}
    </span>
  );
}

function CreateRoomButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const bypass = isDevAuthBypassEnabled();

  if (bypass) {
    return (
      <Button asChild className={cn("cta-lift", className)}>
        <Link to="/app">{t("vsDiscord.cta.create")}</Link>
      </Button>
    );
  }

  return (
    <>
      <SignedOut>
        <SignUpButton mode="modal" forceRedirectUrl="/app">
          <Button className={cn("cta-lift", className)}>
            {t("vsDiscord.cta.create")}
          </Button>
        </SignUpButton>
      </SignedOut>
      <SignedIn>
        <Button asChild className={cn("cta-lift", className)}>
          <Link to="/app">{t("vsDiscord.cta.create")}</Link>
        </Button>
      </SignedIn>
    </>
  );
}

/**
 * `/vs-discord` — honest scoreboard against Discord, built for the Brazil
 * screen-share gap. Claims are verified in the design spec; tone matches the
 * landing. The scoreboard is the page; there is no photo hero.
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
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(209,255,77,0.08),transparent_55%)]"
          aria-hidden
        />

        <div className="relative mx-auto max-w-4xl px-5 pb-20 pt-12 sm:px-8 sm:pt-16">
          <p
            className="animate-rise font-brand text-5xl tracking-tight sm:text-6xl"
            style={stagger(0)}
          >
            pqp
          </p>
          <h1
            className="animate-rise mt-5 max-w-3xl font-display text-3xl font-bold leading-[1.08] tracking-tight sm:text-4xl md:text-5xl"
            style={stagger(1)}
          >
            {t("vsDiscord.hero.title")}
          </h1>
          <p
            className="animate-rise mt-5 max-w-2xl text-base leading-relaxed text-paper-muted sm:text-lg"
            style={stagger(2)}
          >
            {t("vsDiscord.hero.body")}
          </p>
          <p
            className="animate-rise mt-3 max-w-2xl text-xs leading-relaxed text-paper-muted/80"
            style={stagger(3)}
          >
            {t("vsDiscord.hero.disclaimer")}
          </p>

          {/* Desktop table */}
          <div
            className="animate-rise mt-12 hidden overflow-hidden rounded-2xl border border-ink-4 bg-ink-2/60 shadow-[0_0_0_1px_rgba(209,255,77,0.06)] md:block"
            style={stagger(4)}
          >
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">
                {t("vsDiscord.table.caption")}
              </caption>
              <thead>
                <tr className="border-b border-ink-4 bg-ink-3/80">
                  <th
                    scope="col"
                    className="sticky top-0 px-5 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted"
                  >
                    {t("vsDiscord.table.col.feature")}
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 border-l border-signal/25 bg-signal/[0.07] px-5 py-3.5 font-brand text-lg tracking-tight text-signal"
                  >
                    {t("vsDiscord.table.col.pqp")}
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 border-l border-ink-4 px-5 py-3.5 text-xs font-semibold uppercase tracking-[0.16em] text-paper-muted"
                  >
                    {t("vsDiscord.table.col.discord")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-ink-4/80 last:border-b-0"
                  >
                    <th
                      scope="row"
                      className="px-5 py-4 align-top font-semibold text-paper"
                    >
                      {t(row.label)}
                    </th>
                    <td className="border-l border-signal/20 bg-signal/[0.04] px-5 py-4 align-top">
                      <div className="flex flex-col gap-2">
                        <StatusChip kind={row.pqp.chip} />
                        <p className="text-sm leading-snug text-paper">
                          {t(row.pqp.body)}
                        </p>
                      </div>
                    </td>
                    <td className="border-l border-ink-4 px-5 py-4 align-top">
                      <div className="flex flex-col gap-2">
                        <StatusChip kind={row.discord.chip} />
                        <p className="text-sm leading-snug text-paper-muted">
                          {t(row.discord.body)}
                        </p>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked cards */}
          <ul
            className="animate-rise mt-10 space-y-3 md:hidden"
            style={stagger(4)}
            aria-label={t("vsDiscord.table.caption")}
          >
            {ROWS.map((row) => (
              <li
                key={row.id}
                className="rounded-xl border border-ink-4 bg-ink-2/60 p-4"
              >
                <p className="text-sm font-semibold text-paper">
                  {t(row.label)}
                </p>
                <div className="mt-3 space-y-3">
                  <div className="rounded-lg border border-signal/25 bg-signal/[0.06] p-3">
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="font-brand text-base text-signal">
                        {t("vsDiscord.table.col.pqp")}
                      </span>
                      <StatusChip kind={row.pqp.chip} />
                    </div>
                    <p className="text-sm text-paper">{t(row.pqp.body)}</p>
                  </div>
                  <div className="rounded-lg border border-ink-4 bg-ink-3/40 p-3">
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-paper-muted">
                        {t("vsDiscord.table.col.discord")}
                      </span>
                      <StatusChip kind={row.discord.chip} />
                    </div>
                    <p className="text-sm text-paper-muted">
                      {t(row.discord.body)}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <section
            className="animate-rise mt-16 max-w-2xl"
            style={stagger(5)}
            aria-labelledby="vs-discord-closing"
          >
            <h2
              id="vs-discord-closing"
              className="font-display text-2xl font-bold tracking-tight sm:text-3xl"
            >
              {t("vsDiscord.closing.title")}
            </h2>
            <p className="mt-4 text-base leading-relaxed text-paper-muted sm:text-lg">
              {t("vsDiscord.closing.body")}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <CreateRoomButton />
              {betaUrl ? (
                <Button asChild variant="secondary" className="cta-lift">
                  <a href={betaUrl} target="_blank" rel="noopener noreferrer">
                    {t("vsDiscord.cta.beta")}
                  </a>
                </Button>
              ) : (
                <p
                  id="ios-beta"
                  className="max-w-xs text-sm text-paper-muted"
                >
                  <span className="font-semibold text-paper">
                    {t("vsDiscord.cta.beta")}
                  </span>
                  {" — "}
                  {t("vsDiscord.cta.beta.hint")}
                </p>
              )}
            </div>
          </section>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
