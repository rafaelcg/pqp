import { MINIMUM_AGE_YEARS, type LivePreviewChannel } from "@pqp/shared";
import { Play, RotateCcw, UserPlus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BirthDateFields,
  EMPTY_DATE_PARTS,
  toIsoDate,
  type DateParts,
} from "@/components/user/birth-date-fields";
import {
  fetchLivePreviewListing,
  startLivePreview,
  type LivePreviewSource,
} from "@/lib/api";
import { intentStorage, stashLiveChannelIntent } from "@/lib/handle-intent";
import { useTranslation } from "@/lib/i18n";
import {
  formatPreviewCountdown,
  judgePreviewAge,
  phaseAfterStart,
  phaseOnWatch,
  previewSecondsLeft,
  readPreviewAgeMemory,
  readPreviewTicket,
  rememberPreviewAge,
  safeLocal,
  safeSession,
  stashLivePreviewAcquisition,
  writePreviewTicket,
  type LivePreviewPhase,
} from "@/lib/live-preview";
import { track } from "@/lib/track";
import { cn } from "@/lib/utils";
import { LivePreviewPlayer } from "./live-preview-player";

/** The sign-up button the panel hands its surface to wrap. */
export type LivePreviewSignUpButton = ReactElement<{
  onClick?: (event: MouseEvent) => void;
}>;

/** How often the strip asks again whether something went live or ended. */
const LISTING_REFRESH_MS = 30_000;

/**
 * "Ao vivo agora · Assistir", for a visitor with no account.
 *
 * Shown on a community's public page and on the signed-out invite gate, only
 * when the page's own answer said `livePreview: true` (the server's per-server
 * flag) and only while something is live. Everything it plays is decided by
 * the server (`services/live-preview.ts`): which channel, and until when.
 *
 * In order: the strip, the age question (the account gate's fields and
 * threshold, answered on this device and never sent), the film with a
 * countdown, and at the end the sign-up. Under the threshold it shows no
 * media at all. Mobile first: one column, the player at 16:9 across the full
 * width, every control a real button, nothing that pushes the page around
 * (the countdown floats over the picture).
 */
export function LivePreviewPanel({
  source,
  landing,
  surface,
  renderSignUp,
  onSignUpIntent,
}: {
  source: LivePreviewSource;
  /** The acquisition landing to record for a sign-up from here. */
  landing: string;
  /** For the funnel events. */
  surface: "community" | "invite";
  /**
   * Wraps the sign-up button in the surface's own control: Clerk's
   * `SignUpButton` carrying the redirect, or a dev-only link.
   */
  renderSignUp: (button: LivePreviewSignUpButton) => ReactNode;
  /** Anything else the surface stashes before sign-up (the join intent). */
  onSignUpIntent?: () => void;
}) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<LivePreviewChannel[] | null>(null);
  const [channel, setChannel] = useState<LivePreviewChannel | null>(null);
  const [phase, setPhase] = useState<LivePreviewPhase>({ kind: "idle" });
  const [parts, setParts] = useState<DateParts>(EMPTY_DATE_PARTS);
  const [ageError, setAgeError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const viewTracked = useRef(false);
  const endTracked = useRef(false);
  const restarts = useRef(0);
  const sourceKey = source.kind === "community" ? `c:${source.slug}` : `i:${source.code}`;

  // The listing: on mount, and again every 30 s while nothing is playing, so
  // a party that starts while the page is open shows up and one that ends
  // goes away.
  const watching = phase.kind === "watching" || phase.kind === "starting";
  useEffect(() => {
    if (watching) {
      return;
    }
    const controller = new AbortController();
    const load = () => {
      void fetchLivePreviewListing(source, { signal: controller.signal }).then((answer) => {
        if (!controller.signal.aborted) {
          setChannels(answer?.livePreview.channels ?? []);
        }
      });
    };
    load();
    const timer = window.setInterval(load, LISTING_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
    // `source` is identified by `sourceKey`; a new object with the same
    // target must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, watching]);

  const shown = channel ?? channels?.[0] ?? null;
  useEffect(() => {
    if (shown && !viewTracked.current) {
      viewTracked.current = true;
      track("live_preview_view", { surface });
    }
  }, [shown, surface]);

  const begin = useCallback(
    async (target: LivePreviewChannel) => {
      setPhase({ kind: "starting" });
      const result = await startLivePreview({
        channelId: target.id,
        ticket: readPreviewTicket(safeLocal(), target.id),
      });
      if (result.kind === "ok") {
        writePreviewTicket(safeLocal(), target.id, result.body.ticket);
        if (restarts.current === 0) {
          track("live_preview_play", { surface });
        }
      }
      setNow(Date.now());
      setPhase(phaseAfterStart(result));
    },
    [surface],
  );

  // The countdown, and the end of the window. The server's token dies at the
  // same instant; this is what makes the page say so instead of stalling.
  const expiresAt = phase.kind === "watching" ? phase.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) {
      return;
    }
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (at >= expiresAt) {
        setPhase({ kind: "ended" });
      }
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (phase.kind === "ended" && !endTracked.current) {
      endTracked.current = true;
      track("live_preview_ended", { surface });
    }
  }, [phase.kind, surface]);

  if (!shown) {
    return null;
  }

  const watch = (target: LivePreviewChannel) => {
    setChannel(target);
    const next = phaseOnWatch(readPreviewAgeMemory(safeSession(), safeLocal()));
    setPhase(next);
    if (next.kind === "starting") {
      void begin(target);
    }
  };

  const submitAge = () => {
    const verdict = judgePreviewAge(toIsoDate(parts));
    if (verdict === "invalid") {
      setAgeError(true);
      return;
    }
    setAgeError(false);
    // The verdict is remembered; the date is dropped right here.
    setParts(EMPTY_DATE_PARTS);
    rememberPreviewAge(verdict, safeSession(), safeLocal());
    if (verdict === "minor") {
      track("live_preview_age_declined", { surface });
      setPhase({ kind: "declined" });
      return;
    }
    void begin(shown);
  };

  const onPlayerUnavailable = () => {
    // Ask the server what happened rather than guess: the window ended, the
    // presenter restarted on a new session, or the party is over. Twice in a
    // row without a frame in between is an error, not a loop.
    if (restarts.current >= 2) {
      setPhase({ kind: "error" });
      return;
    }
    restarts.current += 1;
    void begin(shown);
  };

  const signUpButton = (wide = false) =>
    renderSignUp(
      <Button
        className={cn("cta-lift h-11 rounded-full px-5", wide && "w-full sm:w-auto")}
        onClick={() => {
          onSignUpIntent?.();
          const storage = intentStorage();
          stashLiveChannelIntent(storage, shown.id);
          stashLivePreviewAcquisition(storage, landing);
          track("live_preview_signup", { surface, at: phase.kind });
        }}
      >
        <UserPlus aria-hidden className="h-4 w-4" />
        {t("livePreview.cta.signUp")}
      </Button>,
    );

  return (
    <section
      data-live-preview={phase.kind}
      aria-label={t("livePreview.region")}
      className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-1 text-text"
    >
      {phase.kind === "idle" && (
        <ul className="divide-y divide-border">
          {(channels ?? [shown]).map((live) => (
            <li key={live.id} className="flex items-center gap-3 px-4 py-3">
              <span aria-hidden className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-danger">
                  {t("livePreview.liveNow")}
                </span>
                <span className="block truncate text-sm font-medium">#{live.name}</span>
              </span>
              <Button className="h-10 shrink-0 rounded-full px-4" onClick={() => watch(live)}>
                <Play aria-hidden className="h-4 w-4" />
                {t("livePreview.watch")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {phase.kind === "age" && (
        <form
          className="space-y-4 px-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            submitAge();
          }}
        >
          <div>
            <h2 className="font-display text-lg font-bold">{t("ageGate.title")}</h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t("ageGate.description", { age: MINIMUM_AGE_YEARS })}
            </p>
          </div>
          <BirthDateFields parts={parts} onChange={setParts} autoFocus compact />
          <p className="text-xs text-text-tertiary">{t("livePreview.age.note")}</p>
          {ageError && (
            <p role="alert" className="text-sm text-danger">
              {t("ageGate.error.badDate")}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button type="submit" disabled={!toIsoDate(parts)} className="h-11 rounded-full px-5">
              {t("ageGate.submit")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-11 rounded-full px-5"
              onClick={() => {
                setParts(EMPTY_DATE_PARTS);
                setAgeError(false);
                setPhase({ kind: "idle" });
              }}
            >
              {t("livePreview.age.cancel")}
            </Button>
          </div>
        </form>
      )}

      {phase.kind === "declined" && (
        <div className="space-y-2 px-4 py-4">
          <h2 className="font-display text-lg font-bold">
            {t("ageGate.blocked.title", { age: MINIMUM_AGE_YEARS })}
          </h2>
          <p className="text-sm text-text-secondary">
            {t("livePreview.declined.body", { age: MINIMUM_AGE_YEARS })}
          </p>
        </div>
      )}

      {(phase.kind === "starting" || phase.kind === "watching") && (
        <div>
          <div className="relative aspect-video w-full bg-surface-0">
            {phase.kind === "starting" ? (
              <Skeleton className="h-full w-full rounded-none" />
            ) : (
              <LivePreviewPlayer
                url={phase.hlsUrl}
                mode={phase.mode}
                onUnavailable={onPlayerUnavailable}
              />
            )}
            {phase.kind === "watching" && (
              // Floats over the picture so the page never moves under it.
              <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-surface-1 px-2.5 py-1 text-xs font-semibold tabular-nums text-text shadow-[var(--shadow-1)]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-danger" />
                {t("livePreview.countdown", {
                  time: formatPreviewCountdown(previewSecondsLeft(phase.expiresAt, now)),
                })}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 text-sm text-text-secondary">
              <span className="font-medium text-text">#{shown.name}</span>
              {" · "}
              {t("livePreview.watching.body")}
            </p>
            {signUpButton(true)}
          </div>
        </div>
      )}

      {phase.kind === "ended" && (
        <div className="space-y-3 px-4 py-5 text-center sm:text-left">
          <h2 className="font-display text-xl font-bold">{t("livePreview.ended.title")}</h2>
          <p className="text-sm text-text-secondary">{t("livePreview.ended.body")}</p>
          {signUpButton(true)}
        </div>
      )}

      {phase.kind === "gone" && (
        <div className="space-y-3 px-4 py-5">
          <h2 className="font-display text-lg font-bold">{t("livePreview.gone.title")}</h2>
          <p className="text-sm text-text-secondary">{t("livePreview.gone.body")}</p>
          {signUpButton(true)}
        </div>
      )}

      {phase.kind === "error" && (
        <div className="space-y-3 px-4 py-5">
          <p className="text-sm text-text-secondary">{t("livePreview.error.body")}</p>
          <Button
            variant="secondary"
            className="h-11 rounded-full px-5"
            onClick={() => {
              restarts.current = 0;
              void begin(shown);
            }}
          >
            <RotateCcw aria-hidden className="h-4 w-4" />
            {t("livePreview.error.retry")}
          </Button>
        </div>
      )}
    </section>
  );
}
