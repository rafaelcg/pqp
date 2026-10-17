import { ArrowRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { REGIONS, type LiveReading, type LiveState, type RegionId } from "@/lib/where-we-run";
import { ageLabel, useLiveStatus } from "../shared/live-status";
import { CARD, Eyebrow } from "./ui";

/**
 * "Onde a call roda", as one strip inside Código: the three voice servers and
 * a live reading of each from the public `/status.json`, plus the way to the
 * full page.
 *
 * HONESTY. A server is green only when the reading said "operational" for it.
 * Loading is neutral grey, a failed read says so, and a key the endpoint did
 * not report reads "Sem leitura".
 *
 * LAYOUT. Phones stack it (the reading, the three cities as rows, the link).
 * From `sm` the reading and the link share the top line and the cities sit in
 * three columns under them; from `lg` it is one row.
 */

const CITY: Record<RegionId, string> = { gru: "São Paulo", mia: "Miami", lhr: "Londres" };

type RowState = LiveState | "loading";

const STATE_LABEL: Record<RowState, string> = {
  operational: "No ar",
  degraded: "Instável",
  down: "Fora do ar",
  unknown: "Sem leitura",
  loading: "Conferindo",
};

const STATE_TEXT: Record<RowState, string> = {
  operational: "text-success",
  degraded: "text-warning",
  down: "text-danger",
  unknown: "text-paper-muted",
  loading: "text-paper-muted",
};

/** Whether the strip is on screen right now: the clock and the ping run only then. */
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

function rowState(reading: LiveReading | "unavailable" | null, id: RegionId): RowState {
  if (reading === null) return "loading";
  if (reading === "unavailable") return "unknown";
  return reading.regions[id];
}

export function OndeStrip({ className }: { className?: string }) {
  const reading = useLiveStatus();
  const [ref, visible] = useWatch<HTMLDivElement>();

  // "verificado há N min" keeps counting while the strip is on screen.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!visible) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 20_000);
    return () => clearInterval(timer);
  }, [visible]);

  return (
    <div
      ref={ref}
      className={cn(
        CARD,
        "grid gap-5 px-7 py-6 sm:grid-cols-[1fr_auto] sm:px-9 lg:grid-cols-[16rem_1fr_auto] lg:items-center lg:gap-0",
        className,
      )}
    >
      <div className="lg:pr-6">
        <Eyebrow tone="muted" as="h3">Onde a call roda</Eyebrow>
        <Reading reading={reading} now={now} animate={visible} />
      </div>

      <ul className="grid border-t border-white/[0.06] sm:col-span-2 sm:row-start-2 sm:grid-cols-3 sm:pt-5 lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:border-l lg:border-t-0 lg:pt-0">
        {REGIONS.map((region) => {
          const state = rowState(reading, region.id);
          return (
            <li
              key={region.id}
              className="flex items-center justify-between gap-3 border-b border-white/[0.06] py-3.5 sm:flex-col sm:items-start sm:justify-start sm:gap-1.5 sm:border-b-0 sm:border-l sm:py-0 sm:pl-5 sm:first:border-l-0 sm:first:pl-0 lg:py-1 lg:first:pl-6"
            >
              <span className="font-display text-lg font-bold text-paper">{CITY[region.id]}</span>
              <span className={cn("inline-flex items-center gap-2 text-sm font-medium", STATE_TEXT[state])}>
                <StateDot state={state} />
                {STATE_LABEL[state]}
              </span>
            </li>
          );
        })}
      </ul>

      <Link
        to="/status"
        className="inline-flex min-h-10 items-center gap-1.5 self-start justify-self-start text-sm font-medium text-paper underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal sm:col-start-2 sm:row-start-1 sm:justify-self-end lg:col-start-3 lg:self-center lg:pl-6"
      >
        Ver em /status
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

/** The one live summary, and how old the reading is. */
function Reading({
  reading,
  now,
  animate,
}: {
  reading: LiveReading | "unavailable" | null;
  now: Date;
  animate: boolean;
}) {
  let dot = "bg-paper-muted/50";
  let ping = false;
  let line: ReactNode = "Conferindo agora…";
  let age: string | null = null;
  if (reading === "unavailable") {
    line = "Não deu pra ler o status agora.";
  } else if (reading) {
    age = reading.checkedAt ? `verificado ${ageLabel(reading.checkedAt, now)}` : "sem horário da leitura";
    line =
      reading.overall === "operational"
        ? "Os três no ar"
        : reading.overall === "down"
          ? "Tem servidor fora do ar"
          : reading.overall === "degraded"
            ? "Tem servidor instável"
            : "Nem todos responderam";
    dot =
      reading.overall === "operational"
        ? "bg-success"
        : reading.overall === "down"
          ? "bg-danger"
          : reading.overall === "degraded"
            ? "bg-warning"
            : "bg-paper-muted/50";
    ping = animate && reading.overall === "operational";
  }

  return (
    <div className="mt-3 text-sm" aria-live="polite">
      <p className="flex items-center gap-2.5 text-paper">
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          {ping && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
          )}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              dot,
              reading === null && "motion-safe:animate-pulse",
            )}
          />
        </span>
        {line}
      </p>
      {/* Always drawn, so the strip keeps its height when the reading lands. */}
      <p className="mt-1 pl-[1.125rem] text-xs text-paper-muted tabular-nums">{age ?? "\u00a0"}</p>
    </div>
  );
}

function StateDot({ state }: { state: RowState }) {
  if (state === "unknown") return <span aria-hidden className="h-2 w-2 rounded-full border border-paper-muted/70" />;
  if (state === "loading")
    return <span aria-hidden className="h-2 w-2 rounded-full bg-paper-muted/40 motion-safe:animate-pulse" />;
  return (
    <span
      aria-hidden
      className={cn(
        "h-2 w-2 rounded-full",
        state === "operational" ? "bg-success" : state === "degraded" ? "bg-warning" : "bg-danger",
      )}
    />
  );
}
