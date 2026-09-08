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
        {strained && (
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
        </dl>
      )}
    </div>
  );
}
