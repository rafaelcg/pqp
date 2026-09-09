import { useState } from "react";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import type { LiveHlsStream, VoiceRoomTransport } from "@pqp/shared";
import { OutboundVideoReadout } from "@/components/voice/outbound-video-readout";
import { useShareUplinkStrain } from "@/hooks/use-share-uplink-strain";
import { useTranslation } from "@/lib/i18n";
import type { VideoQuality } from "@/lib/video-quality";
import { cn } from "@/lib/utils";

/**
 * What the host is actually transmitting, and what the room is actually
 * getting. For the host only.
 *
 * ASSEMBLED, NOT INVENTED. Every number here already existed somewhere and was
 * unreachable from the one surface that wants them all at once:
 *
 *  - what leaves this machine is `OutboundVideoReadout`, which polls
 *    `getStats()` and already knows how to tell a ceiling the ROOM imposed
 *    from one the LINK imposed (`expectedCeilingBps`);
 *  - what the room receives is `LiveHlsStream.topHeight`, the tallest rung the
 *    ladder actually started for this session (PR 376), and `delaySeconds`;
 *  - whether the uplink is losing is `useShareUplinkStrain` from PRs 340/370;
 *  - the audience and the clock are the party's own.
 *
 * Nothing is recomputed here. A second opinion about a bitrate is a second
 * number to disagree with the first one.
 *
 * COLLAPSED BY DEFAULT, AND THE ONE LINE IS WHAT THE ROOM GETS. A host glances
 * at this to answer one question, "is what I am sending arriving", and the
 * honest single fact is the rung the audience is being served plus how many
 * people that is. The detail is one press away for when the answer is no.
 *
 * NEVER SHOWN TO VIEWERS. It is rendered only inside the host's own controls;
 * a viewer has no use for the presenter's encoder and no business knowing it.
 *
 * ONE HONEST GAP, stated rather than hidden: `useShareUplinkStrain` is
 * mesh-only by design (on the SFU the stats it reads mean something else and
 * it would blame a healthy uplink, which is exactly the bug PR 370 fixed). A
 * watch party big enough to matter is on LiveKit, so the strain line will
 * simply not appear there. That is the truthful behaviour, not a stub.
 */
export function WatchPartyTransmission({
  stream,
  wentLiveAt,
  audienceCount,
  isPresenting,
  quality,
  roomViewers,
  transport,
  now,
  className,
}: {
  /** The channel's live stream, or null while nothing is being transcoded. */
  stream: LiveHlsStream | null;
  wentLiveAt: string | null;
  audienceCount: number;
  /** This person's screen is the one on the stage. */
  isPresenting: boolean;
  quality: VideoQuality;
  /** People in the room, for the outbound readout's room-vs-link reasoning. */
  roomViewers: number;
  transport: VoiceRoomTransport | null;
  /** Injected so the minutes tick on the caller's clock and a test can fix it. */
  now: Date;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const strained = useShareUplinkStrain(
    isPresenting,
    quality,
    roomViewers,
    transport,
  );

  const height = stream?.topHeight ?? null;
  /**
   * THE ONE THING THE HOST CANNOT CHECK FOR THEMSELVES, and the reason this
   * component grew past a readout.
   *
   * The transcode carries the shared window and that window's OWN audio, and
   * nothing else: no microphone, no camera, from anybody. A host who shared a
   * whole screen or a window, or a tab without ticking its audio box, is
   * broadcasting a silent film while hearing it perfectly out of their own
   * speakers and talking to a seated room that hears them perfectly over
   * WebRTC. Nothing in either of those two experiences contains the fact.
   *
   * `unknown` is "the server did not say" (an older API, or a session adopted
   * across a deploy) and draws no warning: a false alarm during a film that is
   * playing fine is worse than no alarm.
   */
  const audioState = streamAudioState(stream);
  const silent = audioState === "none";
  const minutes = wentLiveAt
    ? Math.max(
        0,
        Math.floor((now.getTime() - Date.parse(wentLiveAt)) / 60_000),
      )
    : 0;

  const summary = !stream
    ? isPresenting
      ? t("watchParty.tx.collapsedPreparing")
      : t("watchParty.tx.collapsedIdle")
    : height === null
      ? t("watchParty.tx.collapsedPreparing")
      : audienceCount > 0
        ? t("watchParty.tx.collapsedRung", {
            height,
            count: audienceCount,
          })
        : t("watchParty.tx.collapsedRungZero", { height });

  return (
    <div
      data-testid="watch-party-transmission"
      data-tx-open={open ? "" : undefined}
      className={cn(
        "shrink-0 border-b border-ink-4/60 bg-ink-2/60 px-3 py-1.5",
        className,
      )}
    >
      <button
        type="button"
        data-testid="watch-party-tx-toggle"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11px] text-paper-muted hover:text-paper"
        onClick={() => setOpen((was) => !was)}
        title={open ? t("watchParty.tx.collapse") : t("watchParty.tx.expand")}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <span className="shrink-0 font-semibold uppercase tracking-wider">
          {t("watchParty.tx.title")}
        </span>
        <span data-testid="watch-party-tx-summary" className="truncate">
          {summary}
        </span>
        {/* IN THE COLLAPSED ROW, because the panel is collapsed by default and
            a warning only a host who expanded it can see is a warning nobody
            gets. It is the one line worth stealing the summary's space for. */}
        {silent && (
          <span
            data-testid="watch-party-tx-silent-pill"
            className="ml-auto flex shrink-0 items-center gap-1 text-warning"
          >
            <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
            <span className="hidden sm:inline">
              {t("watchParty.tx.silentPill")}
            </span>
          </span>
        )}
        {strained && !silent && (
          <TriangleAlert
            className="ml-auto h-3 w-3 shrink-0 text-warning"
            aria-hidden
          />
        )}
      </button>

      {open && (
        <dl className="mt-2 flex flex-col gap-1.5 text-[11px]">
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-paper-muted">
              {t("watchParty.tx.sending")}
            </dt>
            <dd className="min-w-0 flex-1 text-paper">
              {/* The component that already knows how to say this, including
                  which of the room and the link is holding it back. */}
              {/* `call.quality.unmeasured` rather than the Settings default:
                  a host reading this is mid-share, so "turn your camera on
                  during a call" would be a flat contradiction. Same key the
                  in-call quality menu passes, for the same reason. */}
              <OutboundVideoReadout
                idleKey="call.quality.unmeasured"
                quality={quality}
                viewers={roomViewers}
              />
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-paper-muted">
              {t("watchParty.tx.receiving")}
            </dt>
            <dd className="min-w-0 flex-1 text-paper">
              {height === null
                ? t("watchParty.tx.receivingUnknown")
                : t("watchParty.tx.receivingRung", {
                    height,
                    seconds: stream?.delaySeconds ?? 10,
                  })}
            </dd>
          </div>
          {/* The audio the AUDIENCE gets, which is a different question from
              the audio the room gets and has a different answer. */}
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-paper-muted">
              {t("watchParty.tx.audio")}
            </dt>
            <dd
              data-testid="watch-party-tx-audio"
              className={cn(
                "min-w-0 flex-1",
                silent ? "text-warning" : "text-paper",
              )}
            >
              {audioState === "unknown"
                ? t("watchParty.tx.audioUnknown")
                : audioState === "none"
                  ? t("watchParty.tx.audioNone")
                  : t("watchParty.tx.audioScreen")}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-paper-muted">
              {t("watchParty.tx.audience")}
            </dt>
            <dd className="min-w-0 flex-1 text-paper">{audienceCount}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-paper-muted">
              {t("watchParty.tx.uptime")}
            </dt>
            <dd className="min-w-0 flex-1 text-paper">
              {t("watchParty.tx.uptimeValue", { minutes })}
            </dd>
          </div>
          {strained && (
            <p
              data-testid="watch-party-tx-strained"
              className="flex items-start gap-1.5 text-warning"
            >
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {t("watchParty.tx.strained")}
            </p>
          )}
          {silent && (
            <p
              data-testid="watch-party-tx-silent"
              className="flex items-start gap-1.5 text-warning"
            >
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {t("watchParty.tx.silentFix")}
            </p>
          )}
          {/* STATED WHETHER OR NOT ANYTHING IS WRONG. The two audiences are on
              two different paths and the seated one is strictly richer; a host
              who never learns that assumes the stream carries whatever they
              can hear. This is the sentence that stops that assumption, and it
              costs one line whether or not the audio is fine. */}
          <p
            data-testid="watch-party-tx-carries"
            className="text-paper-muted"
          >
            {t("watchParty.tx.carries")}
          </p>
          <p className="text-paper-muted">
            {t("watchParty.tx.behind", {
              seconds: stream?.delaySeconds ?? 10,
            })}
          </p>
        </dl>
      )}
    </div>
  );
}

/**
 * What the SEATLESS audience is hearing, which is a different question from
 * what the room is hearing and often has a different answer.
 *
 * `"screen"`  the share went up with its own audio and the egress is carrying
 *             it. A film shared as a Chrome tab with the audio box ticked.
 * `"none"`    there is no audio track in the transcode at all. Every
 *             whole-screen and window capture (macOS Chrome cannot capture
 *             system audio), and any tab share where the box was left
 *             unticked. The audience is watching a silent film.
 * `"unknown"` the server did not say: an API older than `hasAudio`, or a
 *             session this process adopted across a restart rather than
 *             started, where the row carries the video track sid and not the
 *             audio one. Draws no warning on purpose.
 *
 * A function rather than an inline ternary because it is the whole of what
 * this panel exists to say, and the unit suite runs in `node` through
 * `react-dom/server`: the detail rows are behind a click nothing here can
 * make, so without this the only testable half would be the collapsed line.
 */
export function streamAudioState(
  stream: LiveHlsStream | null,
): "screen" | "none" | "unknown" {
  if (!stream || stream.hasAudio === undefined) {
    return "unknown";
  }
  return stream.hasAudio ? "screen" : "none";
}
