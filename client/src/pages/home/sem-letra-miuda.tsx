import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { type MessageKey, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { rich } from "./rich";
import { CONTAINER, Eyebrow, HEADER_GAP_SUPPORT, Section, SectionHeader } from "./ui";

/**
 * "Ainda em obra": the page's quiet section. Plain words, no jokes, and on
 * purpose no effect: no motion, no tilt, no glow, no lime, no numbers on the
 * lists (they are not a sequence, so the hairline rows are enough). It is a
 * support section (`weight="support"`: tighter padding, smaller headline). It
 * earns the claims above it by stating, with a date, what is missing and what
 * Discord does better today.
 */

/** The day this list was last checked against the product. Change it with the list. */
const UPDATED_ISO = "2026-10-16";

const INLINE_LINK =
  "text-paper underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

/** A `{link}` slot in a body, filled with the page's address as its label. */
type BodyLink = { to: string; label: string };

type Item = { id: string; lead: MessageKey; body: MessageKey; link?: BodyLink };

/* What the import brings and where it runs is said once, under the import
 * demo in Mudança, so it is not repeated here. */
const NOT_YET = [
  {
    id: "iphone",
    lead: "home.limits.iphone.lead",
    body: "home.limits.iphone.body",
    link: { to: "/beta", label: "pqp.gg/beta" },
  },
  {
    id: "party",
    lead: "home.limits.party.lead",
    body: "home.limits.party.body",
    link: { to: "/watch-party", label: "pqp.gg/watch-party" },
  },
  { id: "bots", lead: "home.limits.bots.lead", body: "home.limits.bots.body" },
  { id: "sound", lead: "home.limits.sound.lead", body: "home.limits.sound.body" },
] as const satisfies readonly Item[];

const DISCORD_BETTER = [
  { id: "apps", lead: "home.limits.discord.apps.lead", body: "home.limits.discord.apps.body" },
  { id: "bots", lead: "home.limits.discord.bots.lead", body: "home.limits.discord.bots.body" },
  { id: "road", lead: "home.limits.discord.road.lead", body: "home.limits.discord.road.body" },
] as const satisfies readonly Item[];

export function SemLetraMiuda() {
  const { t, locale } = useTranslation();
  // Noon UTC, formatted in UTC: the same calendar day in every time zone.
  const updated = new Intl.DateTimeFormat(locale === "en" ? "en-US" : intlLocale(locale), {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${UPDATED_ISO}T12:00:00Z`));

  const body = ({ body: key, link }: Item): ReactNode =>
    link
      ? rich(t(key), {
          link: (
            <Link to={link.to} className={INLINE_LINK}>
              {link.label}
            </Link>
          ),
        })
      : t(key);

  return (
    <Section id="limites" labelledBy="limites-title" weight="support">
      <div className={CONTAINER}>
        <SectionHeader
          eyebrow={t("home.limits.eyebrow")}
          titleId="limites-title"
          title={rich(t("home.limits.title"), { accent: t("home.limits.titleAccent") })}
          lede={
            <>
              {t("home.limits.lede")}
              <span className="mt-4 block font-mono text-xs text-paper-muted">
                {rich(t("home.limits.updated"), { date: <time dateTime={UPDATED_ISO}>{updated}</time> })}
              </span>
            </>
          }
        />

        <div className={cn(HEADER_GAP_SUPPORT, "grid gap-12 lg:grid-cols-12 lg:gap-12")}>
          <div className="lg:col-span-7">
            <Column
              title={t("home.limits.notYet.title")}
              items={NOT_YET.map((item) => ({ id: item.id, lead: t(item.lead), body: body(item) }))}
            />
          </div>

          <div className="lg:sticky lg:top-28 lg:col-span-5 lg:col-start-8 lg:self-start">
            <Column
              title={t("home.limits.discord.title")}
              items={DISCORD_BETTER.map((item) => ({ id: item.id, lead: t(item.lead), body: t(item.body) }))}
            />
            <Link
              to="/vs-discord"
              className="mt-8 inline-flex min-h-10 items-center gap-2 text-[15px] font-medium text-paper underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              {t("home.limits.compare")}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </div>
    </Section>
  );
}

function Column({ title, items }: { title: string; items: { id: string; lead: string; body: ReactNode }[] }) {
  return (
    <div>
      {/* A column label, not a headline: the muted eyebrow, still a level-3 heading. */}
      <Eyebrow as="h3" className="border-b border-white/[0.1] pb-4">
        {title}
      </Eyebrow>
      <ul className="divide-y divide-white/[0.06]">
        {items.map((item) => (
          <li key={item.id} className="py-6">
            <p className="font-display text-lg font-semibold leading-snug text-paper text-pretty">{item.lead}</p>
            <p className="mt-2 leading-relaxed text-paper-muted text-pretty">{item.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
