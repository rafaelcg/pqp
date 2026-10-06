import { ChevronDown, ChevronUp, MonitorPlay } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  FeatureHint,
  useFeatureHintEnabled,
} from "@/components/layout/feature-hint";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  watchNowAge,
  type WatchNowStream,
} from "@/lib/watch-now";
import { cn } from "@/lib/utils";

/**
 * "X is sharing in #channel, N watching, Assistir": the strip that answers
 * "cadê o filme?". `docs/plans/WATCH_NOW.md` has the rules; this draws them.
 *
 * CALM, NOT LOUD. It sits above the transcript like the arrival strip, in the
 * same accent-soft surface, and has ONE primary action. It is a region with a
 * quiet live status that speaks only when the HEADLINE stream changes: the
 * count and the age tick in `aria-hidden` text, because a screen reader
 * announcing "38 assistindo, 39 assistindo" for a whole film is the thing that
 * gets an accessibility feature turned off. It is never an alert: nothing here
 * is worth interrupting someone for.
 *
 * IT GOES SMOOTHLY AND IT GOES WITHOUT MOTION. The exit collapses the row over
 * `--duration-base`; under `prefers-reduced-motion` it just goes. The rows
 * beneath never jump twice.
 */

export interface WatchNowBannerProps {
  /** Visible streams, headline first (`visibleWatchNowStreams`). */
  streams: readonly WatchNowStream[];
  /** `Assistir` / `Voltar pra transmissão` pressed for this stream. */
  onWatch: (stream: WatchNowStream) => void;
  /** `Agora não`: hide this stream until it ends. */
  onDismiss: (stream: WatchNowStream) => void;
  /** The channel whose join is in flight, if any. */
  joiningChannelId?: string | null;
  /** Why the last join failed, already in the person's language. */
  failure?: string | null;
  /** The one-time newcomer hint is allowed to draw under the strip. */
  hintAllowed?: boolean;
  /** Test seam: the clock the age is read from. */
  now?: number;
}

const EXIT_MS = 220;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useMinuteClock(enabled: boolean, override?: number): number {
  const [now, setNow] = useState(() => override ?? Date.now());
  useEffect(() => {
    if (!enabled || override !== undefined) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled, override]);
  return override ?? now;
}

export function WatchNowBanner({
  streams,
  onWatch,
  onDismiss,
  joiningChannelId = null,
  failure = null,
  hintAllowed = false,
  now: nowOverride,
}: WatchNowBannerProps) {
  const { t } = useTranslation();
  // Hold the last non-empty list through the exit, so the strip collapses
  // around what it was showing instead of emptying first.
  const [held, setHeld] = useState<readonly WatchNowStream[]>(streams);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (streams.length > 0) {
      setHeld(streams);
      setLeaving(false);
      return;
    }
    if (held.length === 0) {
      return;
    }
    if (prefersReducedMotion()) {
      setHeld([]);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setHeld([]);
      setLeaving(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
    // `held` is read only to know whether there is anything to animate out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams]);

  const shown = streams.length > 0 ? streams : held;
  const [headline, ...rest] = shown;
  const [open, setOpen] = useState(false);
  const now = useMinuteClock(shown.length > 0, nowOverride);

  // The quiet announcement: set AFTER the region exists, only when the
  // headline stream changes.
  const [announcement, setAnnouncement] = useState("");
  const announcedKey = useRef<string | null>(null);
  const headlineKey = streams[0]?.key ?? null;
  const headlineSharer = streams[0]?.sharerName;
  const headlinePlace = streams[0]?.place;
  const headlineKind = streams[0]?.kind;
  useEffect(() => {
    if (headlineKey === announcedKey.current) {
      return;
    }
    announcedKey.current = headlineKey;
    if (!headlineKey || !headlineSharer) {
      setAnnouncement("");
      return;
    }
    setAnnouncement(
      headlineKind === "party"
        ? t("watchNow.announce.party", {
            name: headlineSharer,
            party: headlinePlace ?? "",
          })
        : headlineKind === "call"
          ? t("watchNow.announce.call", { name: headlineSharer })
          : t("watchNow.announce.voice", {
              name: headlineSharer,
              channel: headlinePlace ?? "",
            }),
    );
  }, [headlineKey, headlineSharer, headlinePlace, headlineKind, t]);

  useEffect(() => {
    if (rest.length === 0) {
      setOpen(false);
    }
  }, [rest.length]);

  const hintEnabled = useFeatureHintEnabled("watchNow");

  if (!headline) {
    return null;
  }

  return (
    <section
      data-watch-now-banner=""
      data-watch-now-leaving={leaving ? "" : undefined}
      aria-label={t("watchNow.region")}
      className={cn(
        "relative grid shrink-0 motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-[var(--duration-base)] motion-safe:ease-[var(--ease-emphasized)]",
        leaving ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
      )}
    >
      <div className="relative min-h-0 overflow-hidden">
        <p role="status" className="sr-only" data-watch-now-status="">
          {announcement}
        </p>
        <Row
          stream={headline}
          now={now}
          joining={joiningChannelId === headline.channelId}
          onWatch={onWatch}
          onDismiss={onDismiss}
          primary
        />
        {failure && (
          <p
            data-watch-now-failure=""
            className="border-b border-border bg-accent-soft px-4 pb-3 text-sm text-danger"
          >
            {t("watchNow.failed")} {failure}
          </p>
        )}
        {rest.length > 0 && (
          <div className="border-b border-border bg-accent-soft px-4 pb-2">
            <button
              type="button"
              data-watch-now-more=""
              aria-expanded={open}
              aria-controls="watch-now-list"
              onClick={() => setOpen((value) => !value)}
              className="relative inline-flex min-h-8 items-center gap-1 rounded-[var(--radius-control)] px-1 text-xs font-medium text-on-accent-soft/80 hover:text-on-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {t("watchNow.more", { count: rest.length })}
              {open ? (
                <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
              )}
            </button>
            {open && (
              <ul
                id="watch-now-list"
                aria-label={t("watchNow.listLabel")}
                className="mt-1 flex flex-col gap-1"
              >
                {rest.map((stream) => (
                  <li key={stream.key} data-watch-now-row="">
                    <Row
                      stream={stream}
                      now={now}
                      joining={joiningChannelId === stream.channelId}
                      onWatch={onWatch}
                      onDismiss={onDismiss}
                      compact
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {/* Outside the clipped row: the card hangs below the strip. */}
      {hintAllowed && hintEnabled && (
        <div className="pointer-events-none absolute left-3 top-full z-30 mt-1 [&>*]:pointer-events-auto">
          <FeatureHint id="watchNow" enabled body={t("watchNow.hint")} />
        </div>
      )}
    </section>
  );
}

function Row({
  stream,
  now,
  joining,
  onWatch,
  onDismiss,
  primary = false,
  compact = false,
}: {
  stream: WatchNowStream;
  now: number;
  joining: boolean;
  onWatch: (stream: WatchNowStream) => void;
  onDismiss: (stream: WatchNowStream) => void;
  primary?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const headline =
    stream.kind === "party"
      ? t("watchNow.headline.party", {
          name: stream.sharerName,
          party: stream.place ?? "",
        })
      : stream.kind === "call"
        ? t("watchNow.headline.call", { name: stream.sharerName })
        : t("watchNow.headline.voice", {
            name: stream.sharerName,
            channel: stream.place ?? "",
          });
  const age = watchNowAge(stream.startedAt, now);
  const meta = [
    stream.watching > 0
      ? t("watchNow.watching", { number: stream.watching })
      : null,
    age === null
      ? null
      : age.unit === "now"
        ? t("watchNow.age.now")
        : age.unit === "minutes"
          ? t("watchNow.age.minutes", { number: age.value })
          : t("watchNow.age.hours", { number: age.value }),
  ].filter((part): part is string => part !== null);
  const label = joining
    ? t("watchNow.joining")
    : stream.inRoom
      ? t("watchNow.back")
      : t("watchNow.watch");

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2",
        primary
          ? "border-b border-border bg-accent-soft px-4 py-3"
          : "rounded-[var(--radius-control)] bg-surface-1/60 px-2 py-1.5",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-accent text-on-accent",
          compact ? "h-6 w-6" : "h-8 w-8",
        )}
      >
        <MonitorPlay className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p
          className={cn(
            "text-pretty font-semibold text-on-accent-soft",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {headline}
        </p>
        {meta.length > 0 && (
          <p
            aria-hidden="true"
            className="mt-0.5 text-xs text-on-accent-soft/80"
          >
            {meta.join(" · ")}
          </p>
        )}
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          // On a phone the buttons take their own row under the text.
          "order-last w-full sm:order-none sm:w-auto",
        )}
      >
        <Button
          size="sm"
          data-watch-now-watch=""
          disabled={joining}
          aria-label={`${label}: ${headline}`}
          className="min-h-11 flex-1 sm:min-h-0 sm:flex-none"
          onClick={() => onWatch(stream)}
        >
          {label}
        </Button>
        {primary && (
          <Button
            size="sm"
            variant="ghost"
            data-watch-now-dismiss=""
            className="min-h-11 sm:min-h-0"
            onClick={() => onDismiss(stream)}
          >
            {t("watchNow.dismiss")}
          </Button>
        )}
      </div>
    </div>
  );
}
