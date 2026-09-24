import { ArrowRight, ArrowUpRight } from "lucide-react";
import { type CSSProperties, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useScrollReveal } from "@/hooks/use-scroll-reveal";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { intlLocale } from "@/lib/locale";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn, getApiBaseUrl } from "@/lib/utils";
import {
  EDGE_CITIES,
  GRID,
  REGIONS,
  SAMPLE_CALLERS,
  arcPath,
  landDotsPath,
  parseStatus,
  project,
  regionById,
  visitorFromTimeZone,
  type Place,
  type LiveReading,
  type LiveState,
  type RegionId,
} from "@/lib/where-we-run";

/**
 * "Where pqp runs": the landing's proof that there is real infrastructure
 * behind the page. A dot map of the three voice boxes and the edge cities
 * that served a watch party, four numbers we actually measured, and a live
 * reading of the boxes from the public `/status.json`.
 *
 * HONESTY RULES. The live dot is never green unless the endpoint said so for
 * that box: loading, unreachable, or a key it did not report all read as "no
 * reading", in grey. No uptime percentage, because the page would be quoting
 * a figure the reader cannot audit. Every number in the tiles is from a run we
 * logged; if one stops being true, delete the tile rather than round it.
 *
 * MOTION. CSS only (`where-*` in `index.css`), on stroke-dashoffset and
 * opacity. The DOM is the finished picture: arcs drawn, dots lit. Reduced
 * motion and crawlers get it as is (`useScrollReveal` marks crawlers
 * `data-reveal-off`).
 */

const EYEBROW = "font-display text-xs font-bold uppercase tracking-[0.22em] text-accent";

const CITY_KEY: Record<RegionId, MessageKey> = {
  gru: "landing.where.city.gru",
  mia: "landing.where.city.mia",
  lhr: "landing.where.city.lhr",
};

const ROLE_KEY: Record<RegionId, MessageKey> = {
  gru: "landing.where.role.gru",
  mia: "landing.where.role.mia",
  lhr: "landing.where.role.lhr",
};

const STATE_KEY: Record<LiveState, MessageKey> = {
  operational: "landing.where.state.operational",
  degraded: "landing.where.state.degraded",
  down: "landing.where.state.down",
  unknown: "landing.where.state.unknown",
};

const STATE_DOT: Record<LiveState, string> = {
  operational: "bg-success",
  degraded: "bg-warning",
  down: "bg-danger",
  unknown: "bg-text-tertiary/50",
};

/** Where each label sits relative to its marker, so none leaves the map. */
const LABEL_SIDE: Record<RegionId, "left" | "right"> = {
  gru: "right",
  mia: "left",
  lhr: "right",
};

const TILES: {
  value: MessageKey;
  label: MessageKey;
  body: MessageKey;
}[] = [
  {
    value: "landing.where.tile.latency.value",
    label: "landing.where.tile.latency.label",
    body: "landing.where.tile.latency.body",
  },
  {
    value: "landing.where.tile.edge.value",
    label: "landing.where.tile.edge.label",
    body: "landing.where.tile.edge.body",
  },
  {
    value: "landing.where.tile.load.value",
    label: "landing.where.tile.load.label",
    body: "landing.where.tile.load.body",
  },
  {
    value: "landing.where.tile.open.value",
    label: "landing.where.tile.open.label",
    body: "landing.where.tile.open.body",
  },
];

type Live = { kind: "idle" } | { kind: "loading" } | { kind: "unavailable" } | ({ kind: "ok" } & LiveReading);

const VIEW_W = GRID.cols - 1;
const VIEW_H = GRID.rows - 1;

function pct(n: number, of: number): string {
  return `${(n / of) * 100}%`;
}

function delay(ms: number): CSSProperties {
  return { "--d": ms } as CSSProperties;
}

/**
 * One read of `/status.json`, the first time the section comes near the
 * viewport. Not polled: a landing visitor is not watching an incident, and
 * the endpoint is rate limited per address.
 */
function useLiveReading(target: RefObject<HTMLElement | null>): Live {
  const [live, setLive] = useState<Live>({ kind: "idle" });
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setLive({ kind: "loading" });
      timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`${getApiBaseUrl()}/status.json`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        const reading = parseStatus(await res.json());
        if (cancelled) return;
        setLive(reading ? { kind: "ok", ...reading } : { kind: "unavailable" });
      } catch {
        if (!cancelled) setLive({ kind: "unavailable" });
      } finally {
        clearTimeout(timer);
      }
    };
    if (typeof IntersectionObserver !== "function") {
      void load();
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io.disconnect();
            void load();
          }
        },
        { rootMargin: "400px 0px" },
      );
      io.observe(el);
      return () => {
        cancelled = true;
        clearTimeout(timer);
        controller.abort();
        io.disconnect();
      };
    }
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [target]);
  return live;
}

function regionState(live: Live, id: RegionId): LiveState {
  return live.kind === "ok" ? live.regions[id] : "unknown";
}

export function WhereWeRun({ className }: { className?: string }) {
  const { t, locale } = useTranslation();
  const rootRef = useRef<HTMLElement>(null);
  useScrollReveal(rootRef);
  const live = useLiveReading(rootRef);

  const [visitor, setVisitor] = useState<Place | null>(null);
  useEffect(() => {
    try {
      setVisitor(visitorFromTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
    } catch {
      setVisitor(null);
    }
  }, []);

  const dots = useMemo(() => landDotsPath(), []);
  const ambient = useMemo(
    () =>
      SAMPLE_CALLERS.map((caller) => ({
        from: project(caller),
        d: arcPath(project(caller), project(regionById(caller.region))),
      })),
    [],
  );
  const mine = useMemo(() => {
    if (!visitor) return null;
    const from = project(visitor);
    const to = project(regionById(visitor.region));
    // Next door to a box (under ~4 grid steps): no arc worth drawing, the
    // "you" ring beside the box says it.
    const near = Math.hypot(to.x - from.x, to.y - from.y) < 4;
    return { region: visitor.region, from, d: near ? null : arcPath(from, to) };
  }, [visitor]);

  const overall: LiveState = live.kind === "ok" ? live.overall : "unknown";
  const statusLine =
    live.kind === "ok"
      ? t(
          overall === "operational"
            ? "landing.where.live.allUp"
            : overall === "degraded"
              ? "landing.where.live.degraded"
              : overall === "down"
                ? "landing.where.live.down"
                : "landing.where.live.partial",
        )
      : live.kind === "unavailable"
        ? t("landing.where.live.unavailable")
        : t("landing.where.live.checking");
  const checkedAt =
    live.kind === "ok" && live.checkedAt
      ? new Intl.DateTimeFormat(intlLocale(locale), { hour: "2-digit", minute: "2-digit" }).format(
          live.checkedAt,
        )
      : null;

  return (
    <section
      ref={rootRef}
      id="where"
      aria-labelledby="where-title"
      className={cn("scroll-mt-20 px-5 py-20 sm:px-8 sm:py-28", className)}
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-x-14 lg:gap-y-8">
          <div className="lg:col-span-5 lg:row-start-1 lg:self-end" data-reveal>
            <p className={cn(EYEBROW, "vem-rise")} style={delay(0)}>
              {t("landing.where.eyebrow")}
            </p>
            <h2
              id="where-title"
              className="vem-rise mt-3 text-balance font-display text-3xl font-bold tracking-tight text-text sm:text-4xl md:text-5xl"
              style={delay(80)}
            >
              {t("landing.where.title")}
            </h2>
            <p
              className="vem-rise mt-4 text-pretty text-lg text-text-secondary"
              style={delay(160)}
            >
              {t("landing.where.body")}
            </p>

          </div>

          <figure className="lg:col-span-7 lg:col-start-6 lg:row-span-2 lg:row-start-1 lg:self-center" data-reveal>
            <div
              className="vem-fade relative overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 p-3 sm:p-5"
              style={delay(120)}
            >
              <div className="relative" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}>
                <svg
                  viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                  className="absolute inset-0 h-full w-full overflow-visible"
                  role="img"
                  aria-labelledby="where-map-title"
                >
                  <title id="where-map-title">{t("landing.where.map.alt")}</title>
                  <path
                    d={dots}
                    className="text-text-tertiary"
                    stroke="currentColor"
                    strokeOpacity={0.35}
                    strokeWidth={0.5}
                    strokeLinecap="round"
                    fill="none"
                  />
                  <g className="text-accent" fill="none" stroke="currentColor" strokeLinecap="round">
                    {ambient.map((arc, i) => (
                      <path
                        key={i}
                        d={arc.d}
                        pathLength={1}
                        strokeWidth={0.28}
                        strokeOpacity={0.45}
                        className="where-arc"
                        style={delay(600 + i * 700)}
                      />
                    ))}
                    {mine?.d && (
                      <path
                        d={mine.d}
                        pathLength={1}
                        strokeWidth={0.5}
                        className="where-arc where-arc-mine"
                        style={delay(300)}
                      />
                    )}
                  </g>
                  <g className="text-text-secondary" fill="currentColor">
                    {ambient.map((arc, i) => (
                      <circle key={i} cx={arc.from.x} cy={arc.from.y} r={0.35} opacity={0.6} />
                    ))}
                  </g>
                  <g className="text-accent" fill="currentColor">
                    {EDGE_CITIES.map((city, i) => {
                      const p = project(city);
                      return (
                        <circle
                          key={i}
                          cx={p.x}
                          cy={p.y}
                          r={0.55}
                          className="where-twinkle"
                          style={delay(i * 450)}
                        />
                      );
                    })}
                  </g>
                  {mine && (
                    <g className="text-accent">
                      <circle cx={mine.from.x} cy={mine.from.y} r={0.8} fill="currentColor" />
                      <circle
                        cx={mine.from.x}
                        cy={mine.from.y}
                        r={1.6}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={0.25}
                      />
                    </g>
                  )}
                </svg>

                {REGIONS.map((region) => {
                  const p = project(region);
                  const state = regionState(live, region.id);
                  const side = LABEL_SIDE[region.id];
                  return (
                    <div
                      key={region.id}
                      className="absolute"
                      style={{ left: pct(p.x, VIEW_W), top: pct(p.y, VIEW_H) }}
                      aria-hidden
                    >
                      <span className="absolute -left-2 -top-2 h-4 w-4 rounded-full bg-accent/30 vem-ring" style={delay(0)} />
                      <span className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full border-2 border-surface-1 bg-accent" />
                      <span
                        className={cn(
                          "absolute top-0 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface-0/90 px-2 py-0.5 text-[11px] font-semibold text-text sm:text-xs",
                          side === "right" ? "left-3" : "right-3",
                        )}
                      >
                        <span className={cn("h-1.5 w-1.5 rounded-full", STATE_DOT[state])} />
                        {t(CITY_KEY[region.id])}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <figcaption className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-text-tertiary">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-accent" aria-hidden />
                {t("landing.where.legend.voice")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent/70" aria-hidden />
                {t("landing.where.legend.edge")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-px w-4 bg-accent/60" aria-hidden />
                {t("landing.where.legend.call")}
              </span>
              {mine && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full border border-accent" aria-hidden />
                  {t("landing.where.legend.you")}
                </span>
              )}
            </figcaption>
          </figure>

          <div className="lg:col-span-5 lg:row-start-2" data-reveal>
            <ul className="vem-rise space-y-3" style={delay(240)}>
              {REGIONS.map((region) => {
                const state = regionState(live, region.id);
                const isMine = mine?.region === region.id;
                return (
                  <li
                    key={region.id}
                    className="flex items-center gap-3 rounded-[var(--radius-panel)] border border-border bg-surface-1 px-4 py-3"
                  >
                    <span className="relative grid h-2.5 w-2.5 shrink-0 place-items-center" aria-hidden>
                      <span className={cn("h-2.5 w-2.5 rounded-full", STATE_DOT[state])} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-display font-bold text-text">{t(CITY_KEY[region.id])}</span>
                        {isMine && (
                          <span className="text-xs font-medium text-accent">
                            {t("landing.where.nearestYou")}
                          </span>
                        )}
                      </span>
                      <span className="block text-sm text-text-tertiary">{t(ROLE_KEY[region.id])}</span>
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-xs font-medium",
                        state === "operational" ? "text-success" : "text-text-tertiary",
                        state === "degraded" && "text-warning",
                        state === "down" && "text-danger",
                      )}
                    >
                      {t(STATE_KEY[state])}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="vem-rise mt-3 text-sm text-text-tertiary" style={delay(300)} aria-live="polite">
              {statusLine}
              {checkedAt && (
                <>
                  {" "}
                  <span className="tabular-nums">{t("landing.where.live.checkedAt", { time: checkedAt })}</span>
                </>
              )}
              <span aria-hidden className="mx-1.5 text-text-tertiary/60">
                ·
              </span>
              <Link
                to="/status"
                className="font-medium text-text-secondary underline decoration-text-tertiary/40 underline-offset-4 transition-colors duration-[var(--duration-fast)] hover:text-text hover:decoration-text/60"
              >
                {t("landing.where.live.link")}
              </Link>
            </p>
          </div>

        </div>

        <ul className="mt-14 grid gap-4 sm:grid-cols-2 lg:mt-20 lg:grid-cols-4" data-reveal>
          {TILES.map((tile, i) => (
            <li
              key={tile.value}
              className="vem-rise flex flex-col rounded-[var(--radius-panel)] border border-border bg-surface-1 p-5"
              style={delay(i * 90)}
            >
              <p className="font-display text-3xl font-bold tracking-tight text-text tabular-nums">
                {t(tile.value)}
              </p>
              <p className="mt-1 text-sm font-semibold text-accent">{t(tile.label)}</p>
              <p className="mt-3 text-pretty text-sm text-text-tertiary">{t(tile.body)}</p>
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <a
            href={SOURCE_REPO_URL}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-10 items-center gap-1.5 font-medium text-accent hover:underline"
          >
            {t("landing.where.link.code")} <ArrowUpRight className="h-4 w-4" aria-hidden />
          </a>
          <Link
            to="/status"
            className="inline-flex min-h-10 items-center gap-1.5 font-medium text-accent hover:underline"
          >
            {t("landing.where.link.status")} <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}
