import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, Radio } from "lucide-react";
import type { LiveHlsStream } from "@pqp/shared";
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { StreamStartingSoon } from "@/components/voice/stream-starting-soon";
import { LivePill } from "@/components/watch-party/live-pill";
import {
  hlsModeOf,
  hlsPartTargetMs,
  watchPlayerMode,
} from "@/lib/hls-live-edge";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * ONE STAGE (2026-09-18, `docs/plans/WATCH_PARTY_UI.md` pass 3; host
 * primary/secondary revised 2026-09-19).
 *
 * The picture owns the screen, and every state of the broadcast is drawn
 * over it rather than in a bar above it.
 *
 * States, in the order a party goes through them:
 *
 * - `holding`: nobody has put anything up. The bubbles and "Segura que já
 *   vem", with the host's own line telling them what to do.
 * - `preparing`: somebody is sharing and the transcode has not produced a
 *   playlist yet. For the host, their own capture fills the stage with the
 *   sentence over its bottom edge; for a viewer, the same holding screen
 *   with the "already sharing, a few seconds" line.
 * - `live`: a playlist exists.
 *   - For a host who is SHARING, their own direct capture is the PRIMARY
 *     panel: it is the real-time truth, the thing they need to trust, and
 *     it is what they were staring at before. The audience's delayed
 *     `HlsWatchPlayer` sits beside it as a smaller, labelled monitor
 *     ("what the audience sees, a few seconds behind"), muted, shown by
 *     default and closeable. Before 2026-09-19 this was inverted: the host
 *     saw the ~10-20 s delayed audience feed as the whole stage and their
 *     own capture was a picture-in-picture behind an off-by-default toggle,
 *     so a host hosting a live party watched themselves well behind real
 *     time and could not tell.
 *   - For a host or co-host who is NOT sharing (a co-host who took the
 *     party over but has no capture of their own), there is nothing to show
 *     but the audience feed, so it becomes the primary panel, labelled as
 *     the audience's view.
 *   - The seatless viewer's `live` is drawn by `WatchChannelStage`, which
 *     owns the player, fullscreen and the watching presence; this
 *     component's `live` is the host side's and is not part of the audience
 *     experience.
 * - `reconnecting`: the presenter's publish dropped and is being rebuilt.
 *   The amber pill over whatever picture is still there.
 * - `ended`: the stream this person was watching stopped. A plain voice
 *   channel's bare share gets this; a watch party channel goes back to the
 *   panel's empty state instead (`watchPartySurface`).
 *
 * `data-testid="watch-party-waiting"` and `data-watch-party-waiting` stay on
 * the holding and preparing states: they are what the e2e spec and the
 * panel tests address, and a selector should survive a layout.
 */
export type WatchPartyStageState =
  | "holding"
  | "preparing"
  | "live"
  | "reconnecting"
  | "ended";

const AUDIENCE_MONITOR_KEY = "pqp:watch-party-audience-monitor";

/**
 * Whether the small "what the audience sees" monitor is shown beside the
 * host's own preview. Default ON: the delayed feed is genuinely useful (it
 * is the only way a host can confirm the audience is actually getting a
 * picture), and it is the panel a host would otherwise have no way to see.
 * It costs a second decode of the HLS ladder, so a host on a tight machine
 * can close it; the choice persists. Only "0" means hidden, so a fresh
 * browser and a read that throws both fall back to shown.
 */
function readAudienceMonitorPref(): boolean {
  try {
    return localStorage.getItem(AUDIENCE_MONITOR_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeAudienceMonitorPref(on: boolean): void {
  try {
    localStorage.setItem(AUDIENCE_MONITOR_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
}

function AudiencePlayer({
  liveStream,
  className,
}: {
  liveStream: LiveHlsStream;
  className?: string;
}) {
  // `hlsUrl` and `mode`/`partTargetMs` are one statement (LiveHlsStream):
  // the URL picks the LL bytes, the props pick the LL player. Omitting them
  // once left the host's audience view on conventional hls.js against an LL
  // playlist (2026-09-16). Same seam every audience path threads.
  return (
    <HlsWatchPlayer
      src={liveStream.hlsUrl}
      /* The picture only (§10.4): this stage draws the chrome. */
      layout="monitor"
      forceMuted
      delaySeconds={liveStream.delaySeconds}
      mode={watchPlayerMode(hlsModeOf(liveStream))}
      partTargetMs={hlsPartTargetMs(liveStream)}
      className={className}
    />
  );
}

/** A quiet label pill over a corner of a panel, so the host is never in
 * doubt which picture is which. */
function StageLabel({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "pointer-events-none absolute z-10 rounded-full bg-black/70 px-2.5 py-0.5 text-[11px] font-medium text-paper",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function WatchPartyStage({
  state,
  hostName,
  hostSide = false,
  captureStream = null,
  liveStream = null,
  footer,
  className,
}: {
  state: WatchPartyStageState;
  /** Who is running the show, for the viewer's copy. */
  hostName?: string;
  /** This person is the host or a co-host: the copy speaks to them. */
  hostSide?: boolean;
  /** The host's own share, when this is the host's stage. */
  captureStream?: MediaStream | null;
  /** The broadcast the audience gets, when there is one. */
  liveStream?: LiveHlsStream | null;
  /** A row under the picture: the audience count and the way out. */
  footer?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [audienceMonitorOn, setAudienceMonitorOn] = useState(
    readAudienceMonitorPref,
  );

  const picture = state === "live" || state === "reconnecting";
  const hasCapture = captureStream !== null;
  const hasAudience = picture && liveStream !== null;

  // The host's own capture is the PRIMARY panel whenever they are sharing:
  // it is the real-time truth. It also fills the stage while the transcode
  // has not started (`preparing`) and while the publish is being rebuilt.
  const captureIsPrimary = hasCapture && (picture || state === "preparing");
  // With no capture of our own (a co-host who took over and is not sharing),
  // the audience feed is the only picture, so it becomes the primary.
  const audienceIsPrimary = hasAudience && !hasCapture;
  // Beside the host's own preview, the audience feed is a smaller, labelled
  // monitor, shown by default.
  const audienceIsSecondary = hasAudience && hasCapture && audienceMonitorOn;
  // The one-tap way back to the monitor after closing it.
  const audienceCanReopen = hasAudience && hasCapture && !audienceMonitorOn;

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.srcObject !== captureStream) {
      video.srcObject = captureStream;
    }
  }, [captureStream, captureIsPrimary]);

  const waiting = state === "holding" || state === "preparing";
  const preparing = state === "preparing";

  return (
    <div
      data-testid="watch-party-stage"
      data-watch-party-stage={state}
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-black",
        className,
      )}
    >
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {audienceIsPrimary && liveStream ? (
          <AudiencePlayer liveStream={liveStream} className="h-full w-full" />
        ) : captureIsPrimary ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-contain"
            data-testid="watch-party-presenter-preview"
          />
        ) : (waiting || state === "ended") && !captureIsPrimary ? (
          <div
            data-testid="watch-party-waiting"
            data-watch-party-waiting={
              state === "ended" ? "ended" : preparing ? "preparing" : "idle"
            }
            className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden"
          >
            {state === "ended" ? (
              <div className="flex flex-col items-center gap-2 px-6 text-center">
                <p className="font-display text-lg font-bold text-paper">
                  {t("voice.watch.ended")}
                </p>
                <p className="max-w-sm text-xs text-paper-muted">
                  {t("voice.watch.endedHint")}
                </p>
              </div>
            ) : (
              <StreamStartingSoon
                caption={
                  preparing
                    ? t("watchParty.live.preparing")
                    : t("watchParty.live.waiting")
                }
              >
                <div className="flex flex-col items-center gap-2 px-6 text-center">
                  <Radio
                    className={cn(
                      "h-5 w-5 text-danger",
                      preparing && "motion-safe:animate-pulse",
                    )}
                    aria-hidden
                  />
                  {/* The specific sentence, kept even though the headline
                      already says "hang in there": a viewer who landed here
                      after a reload has no idea yet whether anyone is even
                      sharing, and the host needs their own line telling them
                      what to do about it. */}
                  <p className="max-w-sm text-xs text-paper-muted">
                    {preparing
                      ? hostSide
                        ? t("watchParty.live.preparingHost")
                        : t("watchParty.live.preparingBody", {
                            name: hostName ?? "",
                          })
                      : hostSide
                        ? t("watchParty.live.waitingHost")
                        : t("watchParty.live.waitingBody", {
                            name: hostName ?? "",
                          })}
                  </p>
                </div>
              </StreamStartingSoon>
            )}
          </div>
        ) : (
          // A picture state with nothing to draw yet (the host's capture
          // has not arrived): say so, quietly, instead of a black box.
          <span className="max-w-[16rem] px-3 text-center text-xs text-paper-muted">
            {t("watchParty.presenter.noPicture")}
          </span>
        )}

        {/* WHICH PICTURE THE PRIMARY PANEL IS. Top-left, out of the way of
            the reconnecting pill, which shifts down when both are up. */}
        {captureIsPrimary && (
          <StageLabel
            title={t("watchParty.presenter.selfMonitorHint")}
            className="left-3 top-3"
          >
            {t("watchParty.presenter.monitorSelf")}
          </StageLabel>
        )}
        {audienceIsPrimary && (
          <StageLabel
            title={t("watchParty.presenter.monitorAudienceHint")}
            className="left-3 top-3"
          >
            {t("watchParty.presenter.monitorAudience")}
          </StageLabel>
        )}

        {/* THE HOST'S CAPTURE WHILE THE TRANSCODE STARTS: the sentence over
            the bottom edge of their own picture, not a strip above it. */}
        {captureIsPrimary && preparing && (
          <p
            data-testid="watch-party-stage-preparing"
            className="pointer-events-none absolute inset-x-0 bottom-14 flex items-center justify-center gap-2 px-4 text-center text-xs text-paper"
          >
            <span className="rounded-full bg-black/70 px-3 py-1">
              <Radio
                className="mr-1.5 inline h-3 w-3 text-danger motion-safe:animate-pulse"
                aria-hidden
              />
              {t("watchParty.live.preparing")}
            </span>
          </p>
        )}

        {state === "reconnecting" && (
          <div
            data-testid="watch-party-stage-reconnecting"
            className={cn(
              "pointer-events-none absolute left-3",
              // Sits below the primary label when there is one.
              captureIsPrimary || audienceIsPrimary ? "top-11" : "top-3",
            )}
          >
            <LivePill variant="recovering" />
          </div>
        )}

        {/* THE AUDIENCE'S DELAYED FEED, beside the host's own preview: a
            small, labelled monitor so the host can see the audience is
            getting a picture, without mistaking it for real time. Muted, so
            they do not hear the film twice. */}
        {audienceIsSecondary && liveStream && (
          <div className="absolute bottom-16 right-3 w-40 overflow-hidden rounded-md border border-paper/20 bg-black shadow-lg sm:w-56">
            <div className="relative aspect-video w-full">
              <AudiencePlayer
                liveStream={liveStream}
                className="h-full w-full"
              />
              <StageLabel
                title={t("watchParty.presenter.monitorAudienceHint")}
                className="left-1.5 top-1.5 text-[10px]"
              >
                {t("watchParty.presenter.monitorAudience")}
              </StageLabel>
              <button
                type="button"
                title={t("watchParty.presenter.monitorOff")}
                aria-label={t("watchParty.presenter.monitorOff")}
                className="absolute right-1.5 top-1.5 z-10 flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] text-paper hover:bg-black/90"
                onClick={() => {
                  writeAudienceMonitorPref(false);
                  setAudienceMonitorOn(false);
                }}
                data-watch-party-audience-monitor
                aria-pressed={true}
              >
                <EyeOff className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </div>
        )}

        {/* Bring the audience monitor back after closing it. */}
        {audienceCanReopen && (
          <button
            type="button"
            title={t("watchParty.presenter.monitorAudienceHint")}
            className="absolute bottom-16 right-3 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-paper hover:bg-black/80"
            onClick={() => {
              writeAudienceMonitorPref(true);
              setAudienceMonitorOn(true);
            }}
            data-watch-party-audience-monitor
            aria-pressed={false}
          >
            <Eye className="h-3 w-3" aria-hidden />
            {t("watchParty.presenter.monitorOn")}
          </button>
        )}
      </div>
      {footer}
    </div>
  );
}
