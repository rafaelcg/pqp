import { useEffect, useState, type ReactNode } from "react";
import { Youtube } from "lucide-react";
import type { WatchPartyState } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { WatchPartyComposer } from "@/components/watch-party/watch-party-composer";
import { WatchPartyControls } from "@/components/watch-party/watch-party-controls";
import { WatchPartyFailure } from "@/components/watch-party/watch-party-failure";
import { WatchPartyJoin } from "@/components/watch-party/watch-party-join";
import type { PlayerFailure } from "@/lib/watch-party/player";
import type { ParsedYouTubeLink } from "@/lib/watch-party/state";
import {
  keepsJoined,
  showsComposer,
  showsPartyEditing,
  showsPlayer,
  transportAvailability,
  watchPartyView,
} from "@/components/watch-party/watch-party-view";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The watch party, as it appears inside a voice channel.
 *
 * WHERE THIS GOES. It is a sibling of `ScreenStage`, in the voice channel's
 * right-hand column above the transcript, and it is shaped like one on
 * purpose: a band across the top of the pane that the chat reflows underneath.
 * A watch party is a thing a voice channel is doing, in the same sense that a
 * screen share is, and it belongs in the same slot rather than in a dialog that
 * covers the conversation people are having about the video. It is deliberately
 * not in the `VoicePanel` column on the left, which is 20rem wide and where a
 * 16:9 player would be the size of a postage stamp.
 *
 * WHY THE PLAYER ARRIVES AS A `ReactNode`. This module owns none of the
 * YouTube integration. The container passes the player element in and this
 * component decides *whether it is mounted at all*, which is the entire join
 * gate: React does not run the element's effects until it is rendered, so
 * before the click there is no iframe, no request to Google, and nothing for
 * autoplay policy to have an opinion about.
 *
 * THIS FILE CONTAINS NO SYNC LOGIC. No `rev` is compared, no drift is
 * corrected, no URL is parsed. Exactly two pieces of state are local and never
 * leave the machine: whether this person has clicked in, and whether the paste
 * form is open. The failure is local too, but it is owned upstream because the
 * player is the thing that observes it.
 */
export interface WatchPartyStageProps {
  /** The channel's shared state, or null when there is no party. */
  party: WatchPartyState | null;
  /**
   * The YouTube player element, owned by the container and mounted only once
   * this person has joined.
   */
  player: ReactNode;
  /**
   * This person's player failed, as `lib/watch-party/player.ts` described it.
   * Local. Never dispatched, and `state.ts` holds the matching `playerFailed`
   * flag that stops it being written even if something here forgot.
   */
  failure?: PlayerFailure | null;
  /** Display name of `party.actorId`, resolved by the container from the voice roster. */
  actorName?: string | null;
  /** Whether `party.actorId` is this machine's peer. */
  actorIsSelf?: boolean;
  /** Overridden only in tests. `state.ts`'s parser is the real one. */
  parseVideoUrl?: (input: string) => ParsedYouTubeLink | null;
  /** The parsed link, `startMs` included. */
  onLoadVideo: (link: ParsedYouTubeLink) => void;
  onPlay: () => void;
  onPause: () => void;
  /**
   * Jump by a delta rather than to an absolute position.
   *
   * The UI does not know where the video is: the position lives inside a
   * cross-origin iframe that only `player` can read and only `state` tracks.
   * Asking for "ten seconds back" keeps the arithmetic where the number is.
   */
  onSkip: (deltaMs: number) => void;
  onEndParty: () => void;
  /** Fired inside the join click, while the user activation is fresh. */
  onJoinPlayback?: () => void;
  /** Rebuild the player. Only ever offered for a reason a retry can change. */
  onRetryPlayback?: () => void;
}

export function WatchPartyStage({
  party,
  player,
  failure = null,
  actorName = null,
  actorIsSelf = false,
  parseVideoUrl,
  onLoadVideo,
  onPlay,
  onPause,
  onSkip,
  onEndParty,
  onJoinPlayback,
  onRetryPlayback,
}: WatchPartyStageProps) {
  const { t } = useTranslation();
  const [composing, setComposing] = useState(false);
  /**
   * The gesture, kept per person and per party.
   *
   * It survives a change of video on purpose. Browser autoplay policy is
   * sticky per document: once somebody has clicked anything, the page keeps
   * that activation, so asking again when the channel swaps to a second video
   * would be a gate that no longer gates anything, and it would put a click
   * between a group and the next thing they chose to watch together. It is
   * dropped when the party is torn down, which is a new party and a new
   * decision.
   */
  const [joined, setJoined] = useState(false);

  const partyOpen = party !== null;
  useEffect(() => {
    if (!partyOpen) {
      setJoined((current) => keepsJoined(current, null));
      setComposing(false);
    }
  }, [partyOpen]);

  const videoId = party?.videoId ?? null;
  useEffect(() => {
    // A video landed, from this machine or from anybody else. The form has
    // done its job and gets out of the way.
    if (videoId !== null) {
      setComposing(false);
    }
  }, [videoId]);

  const view = watchPartyView({
    party,
    joined,
    // The view only needs to know *that* it failed and which sentence to pick.
    // The rest of the failure goes to the card.
    failure: failure?.reason ?? null,
    composing,
  });

  if (view.kind === "launcher") {
    // One line, the height of a toolbar. A voice channel is used without a
    // watch party far more often than with one, and a poster-sized invitation
    // above every transcript would be rent charged to the common case.
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-panel-hover bg-ink px-3 py-1.5">
        <Youtube
          className="h-4 w-4 shrink-0 text-paper-muted"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-xs text-paper-muted">
          {t("watchParty.launcher.body")}
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => setComposing(true)}
        >
          {t("watchParty.launcher.cta")}
        </Button>
      </div>
    );
  }

  const composerOpen = showsComposer(view, composing);
  const editing = showsPartyEditing(view);

  return (
    <section
      aria-label={t("watchParty.label")}
      className={cn(
        "flex shrink-0 flex-col border-b border-panel-hover bg-ink",
        view.kind === "watching" ? "max-h-[55%] min-h-[220px]" : "min-h-[180px]",
      )}
    >
      {showsPlayer(view) ? (
        /* The player's own box, and nothing of ours inside it. No scrim, no
           overlay, no badge in the corner: the IFrame API terms are explicit
           that the chrome is not ours to cover, and every layout idea that
           wanted to was dropped rather than worked around. */
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
          <div className="aspect-video h-full max-h-full max-w-full">
            {player}
          </div>
        </div>
      ) : view.kind === "failed" && failure !== null && party?.videoId ? (
        <WatchPartyFailure
          failure={failure}
          videoId={party.videoId}
          positionMs={party.positionMs}
          onRetry={onRetryPlayback}
        />
      ) : view.kind === "join" && party !== null ? (
        <WatchPartyJoin
          status={party.status}
          onJoin={() => {
            // Synchronous, inside the activation. The player mounts on the
            // very next commit and needs the click to still count.
            onJoinPlayback?.();
            setJoined(true);
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <WatchPartyComposer
            variant="start"
            autoFocus
            parseVideoUrl={parseVideoUrl}
            onLoadVideo={onLoadVideo}
            onCancel={party === null ? () => setComposing(false) : undefined}
          />
        </div>
      )}

      {/* The strip form: swapping the video without unmounting the player, so
          nobody has to leave the party in order to type a link. */}
      {composerOpen && view.kind !== "compose" && (
        <div className="shrink-0 border-t border-panel-hover px-3 py-2">
          <WatchPartyComposer
            variant="change"
            autoFocus
            parseVideoUrl={parseVideoUrl}
            onLoadVideo={onLoadVideo}
            onCancel={() => setComposing(false)}
          />
        </div>
      )}

      {/* Everywhere except the join card, which is one invitation and does not
          need a second status line repeating its own headline underneath.
          `videoId: null` is included on purpose: a party whose video somebody
          else cleared would otherwise have no way out of it at all. */}
      {party !== null && view.kind !== "join" && (
        <WatchPartyControls
          status={party.status}
          actorName={actorName}
          actorIsSelf={actorIsSelf}
          transport={transportAvailability(view)}
          onPlay={onPlay}
          onPause={onPause}
          onSkip={onSkip}
          // Swapping the video only makes sense when there is one, and when the
          // form is not already open below.
          onChangeVideo={
            editing && !composerOpen ? () => setComposing(true) : undefined
          }
          // Offered to anybody in the channel, which is the same no-host stance
          // the wire contract takes about pausing: a group watching something
          // together does not ask permission.
          onEndParty={onEndParty}
        />
      )}
    </section>
  );
}
