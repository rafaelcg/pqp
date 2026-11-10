import type { JamInstrument } from "@pqp/shared";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Headphones,
  Loader2,
  Mic,
  RotateCcw,
  Sparkles,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import type { JamStudio } from "@/hooks/use-jam-studio";
import type { LatencyConfidence, LatencyMethod } from "@/lib/jam";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { levelBar, levelVerdict, type JamLevelVerdict } from "@/lib/jam-level";
import { liveBars } from "@/lib/jam-live";
import { audibleMs, MIN_AUDIBLE_MS, NUDGE_LIMIT_MS } from "@/lib/jam-take-edit";
import { formatClock } from "@/lib/jam-wall";
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
    <div role="radiogroup" aria-label={t("jam.studio.instrument")} className="flex flex-wrap gap-1.5">
      {options.map((instrument) => {
        const look = JAM_INSTRUMENT_LOOK[instrument];
        const Icon = look.icon;
        const on = instrument === value;
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
              "flex h-11 items-center gap-2 rounded-full px-4 text-sm font-bold outline-none transition-[background,color,box-shadow,transform] duration-[var(--duration-fast)] focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 active:scale-[0.96] disabled:opacity-50",
              on ? look.fill : "bg-surface-2 text-text-secondary hover:bg-border hover:text-text",
              !on && wanted.includes(instrument) && "ring-1 ring-inset ring-accent",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {t(look.nameKey as MessageKey)}
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
  const [verdict, setVerdict] = useState<JamLevelVerdict>("silent");
  useEffect(() => {
    if (!active) {
      return;
    }
    let shown = 0;
    let windowPeak = 0;
    let since = performance.now();
    const off = clock.subscribe((peak) => {
      shown = Math.max(peak, shown * 0.88);
      windowPeak = Math.max(windowPeak, peak);
      if (bar.current) {
        bar.current.style.transform = `scaleX(${levelBar(shown)})`;
      }
      const now = performance.now();
      if (now - since > 300) {
        const next = levelVerdict(windowPeak);
        setVerdict((before) => (before === next ? before : next));
        windowPeak = 0;
        since = now;
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
        aria-valuetext={t(`jam.studio.level.${verdict}` as MessageKey)}
        className="h-3 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          ref={bar}
          className={cn("h-full w-full origin-left rounded-full transition-colors duration-[var(--duration-base)]", tone)}
          style={{ transform: "scaleX(0)" }}
        />
      </div>
      <span className="text-xs text-text-tertiary" aria-live="polite">
        {t(`jam.studio.level.${verdict}` as MessageKey)}
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
  const words = useLatencyWords();
  const current = studio.latency?.current;
  if (!current || !Number.isFinite(current.roundTripMs)) {
    return null;
  }
  const ms = Math.round(current.roundTripMs * 10) / 10;
  const text = t("jam.latency.chipTitle", {
    ms,
    method: words.method(current.method),
    confidence: words.confidence(current.confidence),
  });
  return (
    <Tooltip label={text}>
      <span
        data-jam-latency-chip=""
        data-method={current.method}
        data-confidence={current.confidence}
        tabIndex={0}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs font-semibold tabular-nums text-text-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <Headphones className="h-3.5 w-3.5" aria-hidden />
        {t("jam.latency.chip", { ms })}
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            current.confidence === "high" ? "bg-success" : current.confidence === "medium" ? "bg-warning" : "bg-danger",
          )}
        />
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
              void studio.setManualLatency(typedMs).then(() => setTyped(""));
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
  const estimate = Math.round(studio.latency?.estimate.roundTripMs ?? 0);
  const current = Math.round(studio.latency?.current.roundTripMs ?? 0);
  const hasMeasure = studio.latency !== null && studio.latency.current.method !== "estimate";
  const failed = studio.check === "failed";
  return (
    <section
      aria-label={t("jam.latency.explain.title")}
      data-jam-latency-check=""
      className="flex flex-col gap-4 rounded-[var(--radius-panel)] bg-surface-1 p-5 ring-1 ring-inset ring-border"
    >
      <div className="flex items-start gap-4">
        <span className="relative mt-1 grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
          {measuring && (
            <span aria-hidden className="absolute inset-0 rounded-full bg-accent/40 motion-safe:animate-ping" />
          )}
          <Headphones className="relative h-5 w-5" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="font-display text-xl font-extrabold leading-tight text-text">{t("jam.latency.explain.title")}</h3>
          <p className="text-sm leading-relaxed text-text-secondary [text-wrap:pretty]">{t("jam.latency.explain.body")}</p>
        </div>
      </div>

      {measuring ? (
        <div role="status" className="flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-2 p-4 text-sm text-text">
          <Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden />
          {studio.checkMethod === "tap-along" ? t("jam.latency.measuring.tap") : t("jam.latency.measuring.mic")}
        </div>
      ) : (
        <div className="grid gap-2 @lg:grid-cols-2">
          <button
            type="button"
            onClick={() => void studio.measure("loopback")}
            data-jam-measure="loopback"
            className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-accent p-3.5 text-left text-on-accent outline-none transition-[background,transform] duration-[var(--duration-fast)] hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 active:scale-[0.98]"
          >
            <span className="flex items-center gap-2 text-sm font-bold">
              <Mic className="h-4 w-4" aria-hidden />
              {t("jam.latency.measure.mic")}
            </span>
            <span className="text-xs leading-snug opacity-80">{t("jam.latency.measure.micHint")}</span>
          </button>
          <button
            type="button"
            onClick={() => void studio.measure("tap-along")}
            data-jam-measure="tap-along"
            className="flex flex-col gap-1 rounded-[var(--radius-card)] bg-surface-2 p-3.5 text-left text-text outline-none transition-[background,transform] duration-[var(--duration-fast)] hover:bg-border focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 active:scale-[0.98]"
          >
            <span className="flex items-center gap-2 text-sm font-bold">
              <Volume2 className="h-4 w-4" aria-hidden />
              {t("jam.latency.measure.tap")}
            </span>
            <span className="text-xs leading-snug text-text-secondary">{t("jam.latency.measure.tapHint")}</span>
          </button>
        </div>
      )}

      {failed && !measuring && (
        <p role="alert" className="rounded-[var(--radius-control)] bg-warning-soft px-3 py-2 text-sm leading-snug text-on-warning-soft">
          {t("jam.latency.failed")}
        </p>
      )}

      {!measuring && (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <button
            type="button"
            onClick={studio.skipCheck}
            data-jam-skip-check=""
            className="h-11 self-start rounded-[var(--radius-control)] px-1 text-sm font-semibold text-text-secondary underline decoration-border-strong underline-offset-4 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {hasMeasure ? t("jam.latency.keep", { ms: current }) : t("jam.latency.skip")}
          </button>
          {!hasMeasure && (
            <p className="text-xs leading-snug text-text-tertiary [text-wrap:pretty]">
              {t("jam.latency.skipNote", { ms: estimate })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------- lanes */

/** The take being recorded, growing against the others on the same timeline. */
export function LiveLane({
  instrument,
  peaks,
  timelineEndMs,
  elapsedMs,
  label,
}: {
  instrument: JamInstrument;
  peaks: readonly number[];
  timelineEndMs: number;
  elapsedMs: number;
  label: string;
}) {
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const [ref, count] = useBarCount(5, 400);
  const slotMs = count > 0 ? timelineEndMs / count : 0;
  const bars = useMemo(() => liveBars(peaks, slotMs), [peaks, slotMs]);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={label}
      data-jam-live-lane=""
      className={cn("relative h-12 overflow-hidden rounded-[var(--radius-control)] ring-2 ring-danger", look.fill)}
    >
      <div className="absolute inset-y-1.5 left-0" style={{ width: `${Math.min(100, (elapsedMs / timelineEndMs) * 100)}%` }}>
        <JamBars bars={bars} className="h-full justify-start" barClassName="bg-on-inst" minPercent={10} />
      </div>
    </div>
  );
}

export function StudioLaneLabel({
  instrument,
  title,
  sub,
  recording,
}: {
  instrument: JamInstrument;
  title: string;
  sub: string;
  recording?: boolean;
}) {
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const Icon = look.icon;
  return (
    <div className="flex w-32 shrink-0 items-center gap-2 max-sm:w-24">
      <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", look.fill)}>
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-bold text-text">{title}</span>
        <span className={cn("truncate text-xs", recording ? "font-semibold text-danger" : "text-text-secondary")}>{sub}</span>
      </span>
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

/* ------------------------------------------------------------- review editor */

function Field({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-text-secondary">{label}</span>
        <span className="tabular-nums text-text-tertiary">{value}</span>
      </div>
      {children}
    </div>
  );
}

/** Trim, nudge and volume. Everything here is optional: posting needs none of it. */
export function ReviewEditor({ studio }: { studio: JamStudio }) {
  const { t } = useTranslation();
  const take = studio.take;
  const edits = studio.edits;
  if (!take || !edits) {
    return null;
  }
  const startMax = Math.max(take.trimStartMs, take.durationMs - edits.trimEndMs - MIN_AUDIBLE_MS);
  const endMax = Math.max(0, take.durationMs - edits.trimStartMs - MIN_AUDIBLE_MS);
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  return (
    <details
      className="group rounded-[var(--radius-card)] bg-surface-1 ring-1 ring-inset ring-border"
      data-jam-edit=""
    >
      <summary className="flex h-12 cursor-pointer list-none items-center justify-between gap-2 rounded-[var(--radius-card)] px-4 text-sm font-semibold text-text-secondary outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring [&::-webkit-details-marker]:hidden">
        <span>{t("jam.review.edit")}</span>
        <ChevronRight className="h-4 w-4 transition-transform duration-[var(--duration-base)] group-open:rotate-90" aria-hidden />
      </summary>
      <div className="grid gap-4 px-4 pb-4 @lg:grid-cols-2">
        <p className="text-xs leading-snug text-text-tertiary @lg:col-span-2">{t("jam.review.auto")}</p>
        <Field label={t("jam.review.trimStart")} value={`+${seconds(edits.trimStartMs - take.trimStartMs)}`}>
          <Slider
            variant="volume"
            min={take.trimStartMs}
            max={Math.round(startMax)}
            step={10}
            value={Math.round(edits.trimStartMs)}
            onValueChange={studio.setTrimStart}
            aria-label={t("jam.review.trimStart")}
          />
        </Field>
        <Field label={t("jam.review.trimEnd")} value={`-${seconds(edits.trimEndMs)}`}>
          <Slider
            variant="volume"
            min={0}
            max={Math.round(endMax)}
            step={10}
            value={Math.round(edits.trimEndMs)}
            onValueChange={studio.setTrimEnd}
            aria-label={t("jam.review.trimEnd")}
          />
        </Field>
        <Field label={t("jam.review.nudge")} value={t("jam.review.nudgeValue", { ms: `${edits.nudgeMs > 0 ? "+" : ""}${edits.nudgeMs}` })}>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={t("jam.review.nudgeEarlier")}
              onClick={() => studio.setNudge(edits.nudgeMs - 5)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] bg-surface-2 text-text outline-none hover:bg-border focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <Slider
              variant="volume"
              min={-NUDGE_LIMIT_MS}
              max={NUDGE_LIMIT_MS}
              step={1}
              value={edits.nudgeMs}
              onValueChange={studio.setNudge}
              aria-label={t("jam.review.nudge")}
            />
            <button
              type="button"
              aria-label={t("jam.review.nudgeLater")}
              onClick={() => studio.setNudge(edits.nudgeMs + 5)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] bg-surface-2 text-text outline-none hover:bg-border focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </Field>
        <Field label={t("jam.review.volume")} value={`${Math.round(edits.gain * 100)}%`}>
          <Slider
            variant="volume"
            min={0}
            max={200}
            step={1}
            value={Math.round(edits.gain * 100)}
            onValueChange={(value) => studio.setGain(value / 100)}
            aria-label={t("jam.review.volume")}
          />
        </Field>
        <div className="flex items-center justify-between gap-2 @lg:col-span-2">
          <span className="text-xs tabular-nums text-text-tertiary">
            {formatClock(audibleMs(take, edits))}
          </span>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={studio.resetEdits} disabled={!studio.edited}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {t("jam.review.reset")}
          </Button>
        </div>
      </div>
    </details>
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
