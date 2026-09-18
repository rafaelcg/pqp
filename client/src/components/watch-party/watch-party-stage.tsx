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
 * ONE STAGE (2026-09-18, `docs/plans/WATCH_PARTY_UI.md` pass 3).
 *
 * The picture owns the screen, and every state of the broadcast is drawn
 * over it rather than in a bar above it. Before this there were three
 * surfaces for one pane: the panel's waiting placeholder (a holding screen
 * with the go-live checklist repeated inside it), the presenter's
 * two-monitor layout (a small "Sua tela", a small "Público" that was off by
 * default, both black most of the time, and the activity log under them),
 * and the viewer's player. The host never saw the picture the audience got
 * unless they switched a monitor on, and the one thing they were waiting
 * for, the transcode, was a grey sentence in a strip.
 *
 * States, in the order a party goes through them:
 *
 * - `holding`: nobody has put anything up. The bubbles and "Segura que já
 *   vem", with the host's own line telling them what to do.
 * - `preparing`: somebody is sharing and the transcode has not produced a
 *   playlist yet. For the host, their own capture fills the stage with the
 *   sentence over its bottom edge; for a viewer, the same holding screen
 *   with the "already sharing, a few seconds" line.
 * - `live`: a playlist exists. The host sees what the audience sees, the
 *   `HlsWatchPlayer` at real delay, muted (they hear their own tab); their
 *   own capture is a small picture-in-picture they can switch on. The
 *   seatless viewer's `live` is drawn by `WatchChannelStage`, which owns
 *   the player, fullscreen and the watching presence; this component's
 *   `live` is the host's.
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

const SELF_MONITOR_KEY = "pqp:watch-party-self-monitor";

/**
 * The host's own capture as a picture-in-picture over the audience view.
 * Default OFF once the audience view is up: the host already has that
 * picture in the tab they are sharing, and a second decode of it costs the
 * machine that is also encoding the share. (Before the audience view is up
 * the capture IS the stage, and no preference applies.)
 */
function readSelfMonitorPref(): boolean {
  try {
    return localStorage.getItem(SELF_MONITOR_KEY) === "1";
  } catch {
    return false;
  }
}
function writeSelfMonitorPref(on: boolean): void {
  try {
    localStorage.setItem(SELF_MONITOR_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
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
  const pipRef = useRef<HTMLVideoElement>(null);
  const [selfMonitorOn, setSelfMonitorOn] = useState(readSelfMonitorPref);

  const picture = state === "live" || state === "reconnecting";
  const audienceView = picture && liveStream !== null;
  // The capture fills the stage while there is no audience view yet (the
  // host sharing into a transcode that has not started, or reconnecting
  // with no playlist), and is the PiP once there is.
  const captureFills =
    captureStream !== null &&
    !audienceView &&
    (picture || state === "preparing");
  const capturePip =
    audienceView && captureStream !== null && selfMonitorOn;

  useEffect(() => {
    const video = captureFills ? videoRef.current : capturePip ? pipRef.current : null;
    if (video && video.srcObject !== captureStream) {
      video.srcObject = captureStream;
    }
  }, [captureStream, captureFills, capturePip]);

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
        {audienceView && liveStream ? (
          // `hlsUrl` and `mode`/`partTargetMs` are one statement (LiveHlsStream):
          // the URL picks the LL bytes, the props pick the LL player. Omitting
          // them once left the host's audience view on conventional hls.js
          // against an LL playlist (2026-09-16). Same seam every audience
          // path threads.
          <HlsWatchPlayer
            src={liveStream.hlsUrl}
            layout="tile"
            forceMuted
            delaySeconds={liveStream.delaySeconds}
            mode={watchPlayerMode(hlsModeOf(liveStream))}
            partTargetMs={hlsPartTargetMs(liveStream)}
            className="h-full w-full"
          />
        ) : captureFills ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-contain"
            data-testid="watch-party-presenter-preview"
          />
        ) : (waiting || state === "ended") && !captureFills ? (
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

        {/* THE HOST'S CAPTURE WHILE THE TRANSCODE STARTS: the sentence over
            the bottom edge of their own picture, not a strip above it. */}
        {captureFills && preparing && (
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
            className="pointer-events-none absolute left-3 top-3"
          >
            <LivePill variant="recovering" />
          </div>
        )}

        {/* PICTURE-IN-PICTURE OF THE HOST'S OWN CAPTURE, over the audience
            view. Bottom-left, above the bar. */}
        {capturePip && (
          <div className="pointer-events-none absolute bottom-16 left-3 aspect-video w-40 overflow-hidden rounded-md border border-paper/20 bg-black shadow-lg">
            <video
              ref={pipRef}
              autoPlay
              muted
              playsInline
              className="h-full w-full object-contain"
              data-testid="watch-party-presenter-preview"
            />
          </div>
        )}
        {audienceView && captureStream && (
          <button
            type="button"
            aria-pressed={selfMonitorOn}
            title={t("watchParty.presenter.selfMonitorHint")}
            className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-paper hover:bg-black/80"
            onClick={() => {
              setSelfMonitorOn((on) => {
                writeSelfMonitorPref(!on);
                return !on;
              });
            }}
            data-watch-party-self-monitor
          >
            {selfMonitorOn ? (
              <EyeOff className="h-3 w-3" aria-hidden />
            ) : (
              <Eye className="h-3 w-3" aria-hidden />
            )}
            {selfMonitorOn
              ? t("watchParty.presenter.monitorOff")
              : t("watchParty.presenter.selfMonitorOn")}
          </button>
        )}
      </div>
      {footer}
    </div>
  );
}
