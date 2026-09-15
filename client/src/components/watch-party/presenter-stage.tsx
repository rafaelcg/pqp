import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff, Hand, Users } from "lucide-react";
import type { LiveHlsStream } from "@pqp/shared";
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { UserAvatar } from "@/components/user/user-avatar";
import { Button } from "@/components/ui/button";
import {
  hlsModeOf,
  hlsPartTargetMs,
  watchPlayerMode,
} from "@/lib/hls-live-edge";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  useWatchPartyActivity,
  type ActivityEvent,
  type ActivityPerson,
} from "@/lib/watch-party-activity";

const MONITOR_KEY = "pqp:watch-party-audience-monitor";
const SELF_MONITOR_KEY = "pqp:watch-party-self-monitor";

function readMonitorPref(): boolean {
  try {
    return localStorage.getItem(MONITOR_KEY) === "1";
  } catch {
    return false;
  }
}
function writeMonitorPref(on: boolean): void {
  try {
    localStorage.setItem(MONITOR_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
}

// Self monitor defaults ON (it mirrors the old always-on preview), so unlike
// the audience monitor the stored value is only ever "0" — absence means on.
function readSelfMonitorPref(): boolean {
  try {
    return localStorage.getItem(SELF_MONITOR_KEY) !== "0";
  } catch {
    return true;
  }
}
function writeSelfMonitorPref(on: boolean): void {
  try {
    localStorage.setItem(SELF_MONITOR_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
}

/**
 * THE PRESENTER'S STAGE (2026-09-13, `docs/plans/WATCH_PARTY_PRESENTER_UI.md`
 * §6.4 and the live-layout pass). Once the host's own share is up, the
 * pane stops being a full-size mirror of their tab, which is a picture
 * they already have in the next window, and becomes what a streamer keeps
 * in front of them: a small monitor of what is going out, a second small
 * monitor of what the audience gets (the HLS at its real delay, silent,
 * opt-in because it is a second decode), and the activity of the room
 * under both. Chat is the other pane of the split.
 */
export function WatchPartyPresenterStage({
  stream,
  liveStream,
  channelId,
  audienceCount,
  hands,
  onInvite,
}: {
  stream: MediaStream | null;
  liveStream: LiveHlsStream | null;
  channelId: string;
  audienceCount: number;
  hands: readonly ActivityPerson[];
  onInvite?: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [monitorOn, setMonitorOn] = useState(readMonitorPref);
  const [selfMonitorOn, setSelfMonitorOn] = useState(readSelfMonitorPref);
  const events = useWatchPartyActivity({ channelId, audienceCount, hands });

  useEffect(() => {
    const video = videoRef.current;
    if (!selfMonitorOn) return;
    if (video && video.srcObject !== stream) {
      video.srcObject = stream;
    }
  }, [stream, selfMonitorOn]);

  return (
    <div
      data-testid="watch-party-presenter-stage"
      className="flex h-full min-h-0 flex-col gap-2 bg-ink p-2"
    >
      <div className="grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <Monitor
          label={t("watchParty.presenter.monitorSelf")}
          action={
            stream && (
              <button
                type="button"
                aria-pressed={selfMonitorOn}
                title={t("watchParty.presenter.selfMonitorHint")}
                className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-paper hover:bg-black/80"
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
            )
          }
        >
          {stream && selfMonitorOn ? (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="h-full w-full object-contain"
              data-testid="watch-party-presenter-preview"
            />
          ) : (
            <span className="max-w-[16rem] px-3 text-center text-xs text-paper-muted">
              {stream
                ? t("watchParty.presenter.selfMonitorHint")
                : t("watchParty.presenter.noPicture")}
            </span>
          )}
        </Monitor>
        <Monitor
          label={t("watchParty.presenter.monitorAudience")}
          action={
            liveStream && (
              <button
                type="button"
                aria-pressed={monitorOn}
                title={t("watchParty.presenter.monitorAudienceHint")}
                className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-paper hover:bg-black/80"
                onClick={() => {
                  setMonitorOn((on) => {
                    writeMonitorPref(!on);
                    return !on;
                  });
                }}
                data-watch-party-audience-monitor
              >
                {monitorOn ? (
                  <EyeOff className="h-3 w-3" aria-hidden />
                ) : (
                  <Eye className="h-3 w-3" aria-hidden />
                )}
                {monitorOn
                  ? t("watchParty.presenter.monitorOff")
                  : t("watchParty.presenter.monitorOn")}
              </button>
            )
          }
        >
          {liveStream && monitorOn ? (
            // `hlsUrl` and `mode`/`partTargetMs` are one statement
            // (`packages/shared` LiveHlsStream): the URL picks the LL
            // bytes, the props pick the LL player. Omitting them left the
            // host's "Público" preview on conventional hls.js against an
            // LL playlist — abort/retry storms of `part-*.m4s` /
            // `ll?_HLS_msn=` while WebRTC publish stayed healthy
            // (2026-09-16 ~00:30 Europe/London). Every audience path
            // already threads both; this is the same seam.
            <HlsWatchPlayer
              src={liveStream.hlsUrl}
              layout="mini"
              forceMuted
              delaySeconds={liveStream.delaySeconds}
              mode={watchPlayerMode(hlsModeOf(liveStream))}
              partTargetMs={hlsPartTargetMs(liveStream)}
              className="h-full w-full"
            />
          ) : (
            <span className="max-w-[16rem] px-3 text-center text-xs text-paper-muted">
              {liveStream
                ? t("watchParty.presenter.monitorAudienceHint")
                : t("watchParty.presenter.monitorWaiting")}
            </span>
          )}
        </Monitor>
      </div>

      <section
        data-testid="watch-party-activity"
        className="flex min-h-0 flex-1 flex-col rounded-lg border border-ink-4/60 bg-ink-2"
      >
        <h3 className="flex items-center gap-2 border-b border-ink-4/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          {t("watchParty.presenter.activity")}
          <span className="ml-auto flex items-center gap-1 font-normal normal-case tracking-normal text-paper-muted">
            <Users className="h-3 w-3" aria-hidden />
            {audienceCount}
          </span>
        </h3>
        <ol className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-1.5 text-xs">
          {events.length === 0 && (
            <li className="px-1 py-2 text-paper-muted">
              {t("watchParty.presenter.activityEmpty")}
            </li>
          )}
          {events.map((event) => (
            <ActivityRow key={event.id} event={event} onInvite={onInvite} />
          ))}
        </ol>
      </section>
    </div>
  );
}

function Monitor({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-black">
      {children}
      <span className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-paper-muted">
        {label}
      </span>
      {action && <span className="absolute right-2 top-2">{action}</span>}
    </div>
  );
}

function ActivityRow({
  event,
  onInvite,
}: {
  event: ActivityEvent;
  onInvite?: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const time = new Date(event.at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md px-1.5 py-1",
        event.kind === "hand" && "bg-signal/10",
      )}
      data-watch-party-activity={event.kind}
    >
      {event.kind === "hand" ? (
        <>
          <UserAvatar
            name={event.person.displayName}
            avatarUrl={event.person.avatarUrl}
            rounded="full"
            className="h-5 w-5 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-paper">
            <Hand className="mr-1 inline h-3 w-3 text-signal" aria-hidden />
            {t("watchParty.presenter.activityHand", {
              name: event.person.displayName,
            })}
          </span>
          {onInvite && (
            <Button
              type="button"
              size="sm"
              onClick={() => onInvite(event.person.userId)}
              data-watch-party-activity-invite
            >
              {t("watchParty.stage.invite")}
            </Button>
          )}
        </>
      ) : event.kind === "audience" ? (
        <span className="min-w-0 flex-1 truncate text-paper-muted">
          <Users className="mr-1 inline h-3 w-3" aria-hidden />
          {t("watchParty.presenter.activityAudience", {
            count: event.delta,
            total: event.total,
          })}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">
          {event.items.map((item) => (
            <span key={item.emoji} className="mr-2">
              {item.emoji}
              {item.count > 1 && (
                <span className="ml-0.5 text-paper-muted">×{item.count}</span>
              )}
            </span>
          ))}
        </span>
      )}
      <span className="shrink-0 tabular-nums text-text-tertiary">{time}</span>
    </li>
  );
}
