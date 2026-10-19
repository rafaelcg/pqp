import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { REGIONS, type LiveReading, type LiveState, type RegionId } from "@/lib/where-we-run";
import { relativeAge, useLiveStatus } from "./shared/live-status";
import { Eyebrow } from "./ui";

/**
 * "Onde a call roda", as one unboxed line inside Código: the label, the
 * three voice servers each with a dot and a live reading from the public
 * `/status.json`, and the way to the full page. No card, no entrance, and the
 * dots are still (a reading is a fact, not a heartbeat).
 *
 * HONESTY. A server is green only when the reading said "operational" for it.
 * Loading is neutral grey, and a key the endpoint did not report reads "no
 * reading". The state is always written out beside its dot, so colour is
 * never the only signal. A screen reader hears the one summary line (the
 * worst of the three) when the reading lands.
 *
 * WHEN IT HIDES. The strip draws nothing when the read failed
 * (`"unavailable"`) or when the endpoint knew none of the three servers.
 * `parseStatus` gives every region in `REGIONS` a state, with "unknown" for a
 * key it did not find (`lib/where-we-run.ts`), so "every region unknown" is
 * what a self-host without these servers looks like: three open circles for
 * cities it does not run. While the read is in flight it shows its loading
 * state. The caller keeps the `#where` anchor outside, so the anchor stays
 * when the strip goes.
 *
 * LAYOUT. Phones stack it (the label with its age, the three cities as rows,
 * the link). From `sm` the cities sit in a row beside the label and the link
 * wraps under; from `lg` it is one row, the link at the far end. The label's
 * age line is always drawn, so the strip keeps its height when the reading
 * lands.
 */

const CITY: Record<RegionId, MessageKey> = {
  gru: "home.where.city.gru",
  mia: "home.where.city.mia",
  lhr: "home.where.city.lhr",
};

type RowState = LiveState | "loading";

const STATE_LABEL: Record<RowState, MessageKey> = {
  operational: "home.where.state.operational",
  degraded: "home.where.state.degraded",
  down: "home.where.state.down",
  unknown: "home.where.state.unknown",
  loading: "home.where.state.loading",
};

const STATE_TEXT: Record<RowState, string> = {
  operational: "text-success",
  degraded: "text-warning",
  down: "text-danger",
  unknown: "text-paper-muted",
  loading: "text-paper-muted",
};

/** The one summary line, by the worst of the three (`summarise`). Read aloud only. */
const OVERALL_LINE: Record<LiveState, MessageKey> = {
  operational: "home.where.line.operational",
  degraded: "home.where.line.degraded",
  down: "home.where.line.down",
  unknown: "home.where.line.partial",
};

/** Whether the strip is on screen right now: the age line ticks only then. */
function useWatch<T extends Element>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: "0px 0px -12% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible] as const;
}

/** The hide rule above: a failed read, or a reading that knows none of the servers. */
function hides(reading: LiveReading | "unavailable" | null): boolean {
  if (reading === null) return false;
  if (reading === "unavailable") return true;
  return REGIONS.every((region) => reading.regions[region.id] === "unknown");
}

function rowState(reading: LiveReading | null, id: RegionId): RowState {
  return reading === null ? "loading" : reading.regions[id];
}

export function OndeStrip({ className }: { className?: string }) {
  const { t, locale } = useTranslation();
  const status = useLiveStatus();
  const [ref, visible] = useWatch<HTMLDivElement>();
  const hidden = hides(status);

  // The age line ("checked 3 min ago") keeps counting while the strip is on screen.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!visible || hidden) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(timer);
  }, [visible, hidden]);

  if (hidden) return null;
  const reading = status === "unavailable" ? null : status;

  // The age comes from `relativeAge` (`Intl.RelativeTimeFormat` in the reader's
  // language) and sits in the `{age}` slot of `home.where.checked`, so each
  // language keeps its own word order around it.
  let age: string | null = null;
  if (reading) {
    age = reading.checkedAt
      ? t("home.where.checked", { age: relativeAge(reading.checkedAt, intlLocale(locale), now) })
      : t("home.where.noTime");
  }

  return (
    <div
      ref={ref}
      className={cn(
        "flex flex-col gap-5 border-t border-white/[0.06] pt-7 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-12 sm:gap-y-4",
        className,
      )}
    >
      <div>
        <Eyebrow as="h3">{t("home.where.eyebrow")}</Eyebrow>
        {/* Always drawn, so the strip keeps its height when the reading lands. */}
        <p className="mt-1 text-xs text-paper-muted tabular-nums">{age ?? "\u00a0"}</p>
      </div>

      {/* Only the summary is live, and only for a screen reader: the age above
          ticks every few seconds while the strip is on screen. */}
      <p className="sr-only" aria-live="polite">
        {reading ? t(OVERALL_LINE[reading.overall]) : t("home.where.line.loading")}
      </p>

      <ul className="flex flex-col gap-3 sm:flex-row sm:gap-10">
        {REGIONS.map((region) => {
          const state = rowState(reading, region.id);
          return (
            <li key={region.id} className="flex items-center gap-2.5">
              <StateDot state={state} />
              <span className="font-display text-base font-bold text-paper">{t(CITY[region.id])}</span>
              <span className={cn("text-sm font-medium", STATE_TEXT[state])}>{t(STATE_LABEL[state])}</span>
            </li>
          );
        })}
      </ul>

      <Link
        to="/status"
        className="inline-flex min-h-10 items-center gap-1.5 self-start text-sm font-medium text-paper underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal sm:ml-auto sm:self-center"
      >
        {t("home.where.link")}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

/** A still dot: green, amber or red only on a reading, an open ring for "no reading", grey while loading. */
function StateDot({ state }: { state: RowState }) {
  if (state === "unknown") return <span aria-hidden className="h-2 w-2 shrink-0 rounded-full border border-paper-muted/70" />;
  if (state === "loading") return <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-paper-muted/40" />;
  return (
    <span
      aria-hidden
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        state === "operational" ? "bg-success" : state === "degraded" ? "bg-warning" : "bg-danger",
      )}
    />
  );
}
