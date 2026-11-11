import type { JamInstrument } from "@pqp/shared";
import {
  Check,
  ChevronRight,
  Headphones,
  Loader2,
  Mic,
  Plus,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { featureHintEligible, rememberFeatureHint } from "@/lib/feature-hints";
import type { JamStudio } from "@/hooks/use-jam-studio";
import type { LatencyConfidence, LatencyMethod } from "@/lib/jam";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { judgeLevel, levelBar, type JamLevelVerdict, type SilenceClock } from "@/lib/jam-level";
import { createLiveBars } from "@/lib/jam-live";
import { cn } from "@/lib/utils";
import { JamBars, useBarCount } from "./jam-bars";

/** The small pieces of the studio: the pickers, the meter, the latency screens, the editor. */

/* ---------------------------------------------------------------- instrument */

export function InstrumentPicker({
  value,
  options,
  wanted,
  onChange,
  disabled,
}: {
  value: JamInstrument;
  options: readonly JamInstrument[];
  /** Instruments the song is asking for: marked, never forced. */
  wanted: readonly JamInstrument[];
  onChange: (next: JamInstrument) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t("jam.studio.instrument")}
      className="grid grid-cols-3 gap-2 sm:grid-cols-6"
    >
      {options.map((instrument) => {
        const look = JAM_INSTRUMENT_LOOK[instrument];
        const Icon = look.icon;
        const on = instrument === value;
        const asked = wanted.includes(instrument);
        return (
          <button
            key={instrument}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            data-jam-instrument={instrument}
            onClick={() => onChange(instrument)}
            className={cn(
              "relative flex h-[4.75rem] min-w-0 flex-col items-center justify-center gap-1.5 rounded-[var(--radius-panel)] text-[13px] font-extrabold sm:h-[5.5rem] sm:gap-2 sm:text-sm [@media(max-height:32rem)]:h-16 [@media(max-height:32rem)]:gap-0.5 [@media(max-height:32rem)]:text-xs outline-none transition-[background,color,box-shadow,transform] duration-[var(--duration-base)] ease-[var(--ease-emphasized)] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 active:scale-[0.96] disabled:opacity-50",
              on
                ? cn(look.fill, "shadow-[var(--shadow-2)] motion-safe:-translate-y-0.5")
                : "bg-surface-1 text-text-secondary ring-1 ring-inset ring-border hover:bg-surface-2 hover:text-text",
            )}
          >
            <span className={cn("grid h-10 w-10 place-items-center rounded-full transition-colors [@media(max-height:32rem)]:h-7 [@media(max-height:32rem)]:w-7", on ? "bg-on-inst" : look.fill)}>
              <Icon className={cn("h-5 w-5 [@media(max-height:32rem)]:h-4 [@media(max-height:32rem)]:w-4", on && look.ink)} aria-hidden />
            </span>
            {t(look.nameKey as MessageKey)}
            {asked && (
              // Asked for by the song: a small mark in the corner (never on the icon),
              // explained by the sentence above the picker.
              <span
                data-jam-asked=""
                role="img"
                aria-label={t("jam.studio.wanted")}
                className={cn(
                  "absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full",
                  "bg-accent text-on-accent ring-2 ring-surface-0",
                )}
              >
                <Plus className="h-3 w-3" strokeWidth={3.5} aria-hidden />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------- level */

export function LevelMeter({ clock, active }: { clock: JamStudio["levelClock"]; active: boolean }) {
  const { t } = useTranslation();
  const bar = useRef<HTMLDivElement | null>(null);
  // null: nothing to say (the input is not open yet, or it is only between notes)
  const [verdict, setVerdict] = useState<JamLevelVerdict | null>(null);
  useEffect(() => {
    if (!active) {
      setVerdict(null);
      return;
    }
    let shown = 0;
    let windowPeak = 0;
    let since = performance.now();
    let silence: SilenceClock = { silentSince: null };
    let said: JamLevelVerdict | null = null;
    const off = clock.subscribe((peak) => {
      shown = Math.max(peak, shown * 0.88);
      windowPeak = Math.max(windowPeak, peak);
      if (bar.current) {
        bar.current.style.transform = `scaleX(${levelBar(shown)})`;
      }
      const now = performance.now();
      // Judged on the loudest of the last 300 ms, so a note's tail is not silence;
      // and silence only counts once it has lasted (`judgeLevel`).
      if (now - since > 300) {
        const step = judgeLevel(silence, windowPeak, now);
        silence = step.clock;
        windowPeak = 0;
        since = now;
        if (step.verdict !== said) {
          said = step.verdict;
          setVerdict(step.verdict);
        }
      }
    });
    return off;
  }, [clock, active]);
  const tone =
    verdict === "good"
      ? "bg-success"
      : verdict === "hot"
        ? "bg-danger"
        : verdict === "low"
          ? "bg-warning"
          : "bg-text-tertiary";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-text-secondary">{t("jam.studio.level")}</span>
      <div
        role="meter"
        aria-label={t("jam.studio.level")}
        aria-valuetext={verdict ? t(`jam.studio.level.${verdict}` as MessageKey) : undefined}
        className="h-3 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          ref={bar}
          className={cn("h-full w-full origin-left rounded-full transition-colors duration-[var(--duration-base)]", tone)}
          style={{ transform: "scaleX(0)" }}
        />
      </div>
      <span className="min-h-4 text-xs text-text-secondary" aria-live="polite">
        {verdict ? t(`jam.studio.level.${verdict}` as MessageKey) : ""}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------- latency */

/** "medido pelo microfone", "alta": the source and the trust, in words. */
export function useLatencyWords() {
  const { t } = useTranslation();
  return {
    method: (method: LatencyMethod) => t(`jam.latency.method.${method}` as MessageKey),
    confidence: (confidence: LatencyConfidence) => t(`jam.latency.confidence.${confidence}` as MessageKey),
  };
}

/**
 * The number to report: always on screen in the studio, small, with where it
 * came from and how sure it is in its tooltip and its accessible name.
 */
export function LatencyChip({ studio }: { studio: JamStudio }) {
  const { t } = useTranslation();
  const current = studio.latency?.current;
  if (!current || !Number.isFinite(current.roundTripMs)) {
    return null;
  }
  const ms = Math.round(current.roundTripMs);
  const text = t(current.method === "estimate" ? "jam.latency.chipTitleEstimate" : "jam.latency.chipTitle", { ms });
  return (
    <Tooltip label={text}>
      <span
        data-jam-latency-chip=""
        data-method={current.method}
        data-confidence={current.confidence}
        tabIndex={0}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs font-semibold tabular-nums text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:hidden"
      >
        <Headphones className="h-3.5 w-3.5" aria-hidden />
        {t("jam.latency.chipLabel", { ms })}
        {current.method !== "estimate" && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
    </Tooltip>
  );
}

export function LatencyCard({ studio }: { studio: JamStudio }) {
  const { t } = useTranslation();
  const words = useLatencyWords();
  const [typed, setTyped] = useState("");
  const latency = studio.latency;
  if (!latency) {
    return null;
  }
  const current = latency.current;
  const ms = Math.round(current.roundTripMs);
  const measured = current.method !== "estimate";
  const typedMs = Number(typed.replace(",", "."));
  const typedOk = typed.trim() !== "" && Number.isFinite(typedMs) && typedMs >= 0 && typedMs <= 600;
  const hasManual = latency.stored.some((one) => one.method === "manual");
  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius-card)] bg-surface-2 p-3.5" data-jam-latency="">
      <div className="flex items-start gap-2.5">
        <Headphones className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
        <p className="text-sm leading-snug text-text">
          {measured ? t("jam.latency.measured", { ms }) : t("jam.latency.estimated", { ms })}
        </p>
      </div>
      {latency.output.suitability === "bluetooth" && (
        <p role="status" className="rounded-[var(--radius-control)] bg-warning-soft px-2.5 py-2 text-xs leading-snug text-on-warning-soft">
          {t("jam.latency.bluetooth")}
        </p>
      )}
      <Button variant="secondary" size="sm" className="self-start" onClick={studio.recheck} disabled={studio.phase !== "setup"}>
        {measured ? t("jam.latency.recalibrate") : t("jam.latency.calibrate")}
      </Button>
      <details className="group text-xs" data-jam-latency-details="">
        <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 font-semibold text-text-secondary outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 transition-transform duration-[var(--duration-base)] group-open:rotate-90" aria-hidden />
          {t("jam.latency.details")}
        </summary>
        <dl className="flex flex-col gap-1 pb-2 text-text-secondary">
          <div className="flex justify-between gap-3">
            <dt>{t("jam.latency.detail.source")}</dt>
            <dd className="text-right font-semibold text-text">{words.method(current.method)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>{t("jam.latency.detail.confidence")}</dt>
            <dd className="text-right font-semibold text-text">{words.confidence(current.confidence)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>{t("jam.latency.detail.roundTrip")}</dt>
            <dd className="text-right font-semibold tabular-nums text-text">{t("jam.latency.chip", { ms: Math.round(current.roundTripMs * 10) / 10 })}</dd>
          </div>
          {current.played > 0 && (
            <div className="flex justify-between gap-3">
              <dt>{t("jam.latency.detail.pulses")}</dt>
              <dd className="text-right tabular-nums text-text">
                {t("jam.latency.detail.pulsesValue", { accepted: current.accepted, played: current.played, spread: Math.round(current.spreadMs * 100) / 100 })}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <dt>{t("jam.latency.detail.estimate")}</dt>
            <dd className="text-right tabular-nums text-text">{t("jam.latency.chip", { ms: Math.round(latency.estimate.roundTripMs * 10) / 10 })}</dd>
          </div>
        </dl>
        <form
          className="flex flex-col gap-1.5 border-t border-border pt-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (typedOk) {
              void studio.setManualLatency(typedMs).then((ok) => ok && setTyped(""));
            }
          }}
        >
          <label className="flex flex-col gap-1.5 font-semibold text-text-secondary">
            {t("jam.latency.manual.label")}
            <span className="flex items-center gap-2">
              <input
                inputMode="decimal"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder={String(ms)}
                data-jam-manual-latency=""
                className="h-10 w-24 rounded-[var(--radius-control)] border border-border bg-surface-0 px-2.5 text-sm font-normal tabular-nums text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              />
              <Button type="submit" size="sm" disabled={!typedOk} data-jam-manual-use="">
                {t("jam.latency.manual.use")}
              </Button>
              {hasManual && (
                <Button type="button" variant="ghost" size="sm" onClick={() => void studio.setManualLatency(null)}>
                  {t("jam.latency.manual.clear")}
                </Button>
              )}
            </span>
          </label>
          {studio.manualLatencyFailed && (
            <p role="alert" className="font-normal leading-snug text-on-danger-soft">
              {t("jam.error.other")}
            </p>
          )}
          <p className="font-normal leading-snug text-text-tertiary">{t("jam.latency.manual.hint")}</p>
        </form>
      </details>
    </div>
  );
}

/**
 * The first-use screen. One idea: the sound takes a moment to leave the
 * headphones and come back through the microphone, we measure that moment once
 * per pair of devices and correct it by ourselves, so the part lands in time
 * with nothing to cut. Two ways to measure (the microphone hears the output, or
 * you tap along when it cannot) and a way out that says what it costs.
 */
export function LatencyCheck({ studio }: { studio: JamStudio }) {
  const { t } = useTranslation();
  const measuring = studio.check === "measuring";
  const current = Math.round(studio.latency?.current.roundTripMs ?? 0);
  const hasMeasure = studio.latency !== null && studio.latency.current.method !== "estimate";
  const failed = studio.check === "failed";
  // One line in the dock, right above the button it is about. A suggestion, not a
  // gate: the red button records either way (with the browser's estimate).
  return (
    <section
      aria-label={t("jam.latency.explain.title")}
      data-jam-latency-check=""
      className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-surface-2/70 px-3 py-2 ring-1 ring-inset ring-border sm:flex-row sm:items-center sm:gap-3"
    >
      <span className="flex min-w-0 flex-1 items-center gap-3">
      <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
        {measuring && <span aria-hidden className="absolute inset-0 rounded-full bg-accent/40 motion-safe:animate-ping" />}
        <Headphones className="relative h-4 w-4" aria-hidden />
      </span>
      <Tooltip label={t("jam.latency.explain.body")}>
        <p tabIndex={0} className="min-w-0 flex-1 text-[13px] leading-snug text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
          {measuring ? (
            studio.checkMethod === "tap-along" ? t("jam.latency.measuring.tap") : t("jam.latency.measuring.mic")
          ) : failed ? (
            <span role="alert">{studio.checkMethod === "tap-along" ? t("jam.latency.failed.tap") : t("jam.latency.failed")}</span>
          ) : (
            <>
              <span className="font-bold">{t("jam.latency.explain.title")}</span> <span className="[@media(max-height:32rem)]:hidden">{t("jam.latency.explain.short")}</span>
            </>
          )}
        </p>
      </Tooltip>
      </span>
      {measuring ? (
        <Loader2 className="h-4 w-4 shrink-0 text-text-secondary motion-safe:animate-spin" aria-hidden />
      ) : (
        <span className="flex shrink-0 items-center gap-1 max-sm:pl-11">
          <button
            type="button"
            onClick={() => void studio.measure("loopback")}
            data-jam-measure="loopback"
            className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold text-text outline-none ring-1 ring-inset ring-border-strong transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <Mic className="h-3.5 w-3.5" aria-hidden />
            {t("jam.latency.measure.mic")}
          </button>
          <Tooltip label={t("jam.latency.measure.tapHint")}>
            <button
              type="button"
              onClick={() => void studio.measure("tap-along")}
              data-jam-measure="tap-along"
              aria-label={t("jam.latency.measure.tap")}
              className="grid h-9 w-9 place-items-center rounded-full text-text-secondary outline-none transition-colors hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Volume2 className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={studio.skipCheck}
            data-jam-skip-check=""
            className="h-9 rounded-full px-3 text-[13px] font-semibold text-text-secondary outline-none transition-colors hover:bg-surface-3 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {hasMeasure ? t("jam.latency.keep", { ms: current }) : t("jam.latency.notNow")}
          </button>
        </span>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------------- tip */

/**
 * The studio's first-run guidance, drawn IN the studio rather than through the
 * corner queue. The queue gives its one slot to older standing cards first, and a
 * card that sits over the corner can cover "Mandar pra banda"; this one lives in
 * the page it explains, once, through the same store as every other hint
 * (`lib/feature-hints.ts`, id `jamStudio`).
 */
export function StudioTip() {
  const { t } = useTranslation();
  const [shown, setShown] = useState(() => featureHintEligible("jamStudio"));
  useEffect(() => {
    if (shown) {
      // Seen is seen: showing it is the impression, as for every other hint.
      rememberFeatureHint("jamStudio");
    }
  }, [shown]);
  if (!shown) {
    return null;
  }
  return (
    <aside
      data-jam-studio-tip=""
      aria-label={t("jam.hint.studio.title")}
      className="relative flex items-start gap-3 rounded-[var(--radius-card)] bg-accent-soft p-4 pr-12 text-on-accent-soft"
    >
      <Headphones className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-bold">{t("jam.hint.studio.title")}</h3>
        <p className="text-sm leading-snug [text-wrap:pretty]">{t("jam.hint.studio.body")}</p>
        <button
          type="button"
          onClick={() => setShown(false)}
          className="mt-1 h-10 self-start rounded-full bg-on-accent-soft px-4 text-xs font-bold text-accent-soft outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {t("featureHint.gotIt")}
        </button>
      </div>
      <button
        type="button"
        aria-label={t("featureHint.dismiss")}
        onClick={() => setShown(false)}
        className="absolute right-1.5 top-1.5 grid h-10 w-10 place-items-center rounded-full outline-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </aside>
  );
}

/* -------------------------------------------------------------------- lanes */

/** The take being recorded, growing against the others on the same timeline. */
export function LiveLane({
  instrument,
  peaks,
  version,
  timelineEndMs,
  elapsedMs,
  label,
}: {
  instrument: JamInstrument;
  peaks: readonly number[];
  /** Bumps whenever `peaks` (one array, pushed to) grew. */
  version: number;
  timelineEndMs: number;
  elapsedMs: number;
  label: string;
}) {
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const [ref, count] = useBarCount(5, 400);
  const slotMs = count > 0 ? timelineEndMs / count : 0;
  const fold = useRef<ReturnType<typeof createLiveBars> | null>(null);
  fold.current ??= createLiveBars();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the change signal for the mutable list
  const bars = useMemo(() => fold.current!(peaks, slotMs), [peaks, version, slotMs]);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      data-jam-live-lane=""
      className="relative h-14 overflow-hidden rounded-[var(--radius-control)] bg-surface-0/60 ring-2 ring-inset ring-danger"
    >
      {/* the take grows as a clip from song time 0, with a red edge where it is being written */}
      <div
        className={cn("absolute inset-y-0 left-0 overflow-hidden rounded-[var(--radius-control)]", look.fill)}
        style={{ width: `${Math.min(100, (elapsedMs / timelineEndMs) * 100)}%` }}
      >
        <div className="absolute inset-y-1.5 left-1 right-1.5">
          <JamBars bars={bars} className="h-full justify-start" barClassName="bg-on-inst" minPercent={10} />
        </div>
        <span aria-hidden className="jam-rec-dot absolute inset-y-0 right-0 w-1 bg-danger" />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- count-in */

/** The big number of the count-in, one swell per beat. */
export function Countdown({ beat, total, beatMs }: { beat: number; total: number; beatMs: number }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="assertive"
      data-jam-countdown=""
      className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-surface-0/70 backdrop-blur-[2px]"
    >
      <span className="sr-only">{t("jam.studio.countdown")}</span>
      {beat > 0 ? (
        <span
          key={beat}
          aria-hidden
          style={{ "--jam-beat": `${beatMs}ms` } as CSSProperties}
          className="jam-count-beat font-display text-[9rem] font-extrabold leading-none tabular-nums text-text"
        >
          {((beat - 1) % 4) + 1}
        </span>
      ) : (
        <span aria-hidden className="font-display text-2xl font-extrabold text-text-secondary">
          {t("jam.studio.countdown")}
        </span>
      )}
      <span className="absolute bottom-6 text-xs tabular-nums text-text-tertiary" aria-hidden>
        {beat}/{total}
      </span>
    </div>
  );
}

/* --------------------------------------------------------------------- done */

export function DoneOverlay({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    buttonRef.current?.focus();
  }, []);
  return (
    <div
      role="status"
      data-jam-done=""
      className="absolute inset-0 z-20 grid place-items-center bg-surface-0/90 p-6 backdrop-blur-sm"
    >
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <span className="relative grid h-24 w-24 place-items-center">
          <span aria-hidden className="jam-confirm-ring absolute inset-0 rounded-full ring-4 ring-accent" />
          <span className="jam-confirm-pop grid h-20 w-20 place-items-center rounded-full bg-accent text-on-accent">
            <Check className="h-10 w-10" strokeWidth={3} aria-hidden />
          </span>
        </span>
        <h2 className="font-display text-3xl font-extrabold text-text [text-wrap:balance]">{title}</h2>
        <p className="text-sm leading-relaxed text-text-secondary [text-wrap:pretty]">{body}</p>
        <Button ref={buttonRef} className="mt-1 h-12 gap-2 rounded-full px-6 text-base" onClick={onAction} data-jam-done-action="">
          <Sparkles className="h-4 w-4" aria-hidden />
          {action}
        </Button>
      </div>
    </div>
  );
}

/**
 * The stop button's ring while recording: it swells with what the microphone
 * hears, so the level is read where the eye already is. Written straight to
 * the element; under reduced motion it stays a still ring.
 */
export function LevelRing({ clock }: { clock: JamStudio["levelClock"] }) {
  const ring = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    let shown = 0;
    return clock.subscribe((peak) => {
      shown = Math.max(peak, shown * 0.85);
      const element = ring.current;
      if (element) {
        element.style.transform = `scale(${1 + Math.min(1, levelBar(shown)) * 0.16})`;
        element.style.opacity = String(Math.min(1, levelBar(shown)) * 0.7);
      }
    });
  }, [clock]);
  return <span ref={ring} aria-hidden className="pointer-events-none absolute -inset-1 rounded-full bg-danger/50" style={{ opacity: 0 }} />;
}
