import type { JamInstrument, JamSongSummary } from "@pqp/shared";
import { Loader2, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { jamSongRoutePath, messageLinkState } from "@/lib/app-route";
import { useTranslation } from "@/lib/i18n";
import type { JamEngine } from "@/lib/jam";
import { holdJamEngineForHandoff, toggleJamCardSong, useJamCardPlayer, type JamCardPlayState } from "@/lib/jam-chat-player";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import type { JamSongLink } from "@/lib/jam-share";
import type { JamCardState } from "@/lib/jam-share-card";
import { formatClock, songNeed } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { bandOrder } from "./jam-art";
import { JamCoverPhoto, useJamCover, type JamCoverState } from "./jam-cover";
import { useNeedLabel } from "./jam-need";

/**
 * A Jam song pasted into chat, drawn as one quiet row under the message: its
 * picture, the title, who is on it and what is still missing, and a round button
 * that plays the song right there (through the Jam's one player: the wall and the
 * sidebar row show it playing too). The whole card opens the song.
 *
 * Two focus stops, not nested: the title is the link that opens the song (its
 * `::after` covers the card) and the round button sits above it.
 *
 * What it draws comes from the song detail read, which the server refuses for
 * anybody who may not open the song. A viewer who gets no card keeps the plain
 * link (the row decides, `message-list.tsx`).
 */

const INSTRUMENT_DOT = "grid h-4 w-4 shrink-0 place-items-center rounded-full";

function people(song: JamSongSummary, anonymous: string): string {
  const names = song.contributors.length > 0 ? song.contributors.map((one) => one.name ?? anonymous) : [song.authorName ?? anonymous];
  const first = names[0] ?? anonymous;
  const more = Math.max(0, (song.contributorCount || names.length) - 1);
  return more > 0 ? `${first} +${more}` : first;
}

/** Whole seconds of the shared player's position, only while this card's song is the one it holds. */
function useCardClock(engine: JamEngine | null): { seconds: number; durationMs: number } | null {
  const [clock, setClock] = useState<{ seconds: number; durationMs: number } | null>(null);
  useEffect(() => {
    if (!engine) {
      setClock(null);
      return;
    }
    return engine.player.subscribe((tick) => {
      const seconds = Math.floor(tick.positionMs / 1000);
      setClock((before) =>
        before && before.seconds === seconds && before.durationMs === tick.durationMs ? before : { seconds, durationMs: tick.durationMs },
      );
    });
  }, [engine]);
  return clock;
}

/**
 * The song's picture at card size: the cover its owner chose, else the band as flat lanes (one
 * per instrument in its colour, a dashed one for each part still missing). Flat on purpose: the
 * wall's art has a soft light in it, and a chat row has no use for one.
 */
function CardPicture({ song, cover, missing }: { song: JamSongSummary; cover: JamCoverState; missing: readonly JamInstrument[] }) {
  if (cover.src !== null && cover.status !== "failed") {
    return <JamCoverPhoto cover={cover} eager />;
  }
  const present = bandOrder(song.instruments);
  return (
    <span aria-hidden="true" data-jam-card-band="" className="absolute inset-0 flex flex-col justify-center gap-[3px] bg-surface-2 p-[7px]">
      {present.slice(0, 5).map((instrument) => (
        <span key={instrument} className={cn("min-h-[5px] flex-1 rounded-full", JAM_INSTRUMENT_LOOK[instrument].fill)} />
      ))}
      {missing.slice(0, 5 - Math.min(present.length, 5)).map((instrument) => (
        <span key={`missing-${instrument}`} className={cn("min-h-[5px] flex-1 rounded-full border border-dashed border-current", JAM_INSTRUMENT_LOOK[instrument].ink)} />
      ))}
    </span>
  );
}

export function JamLinkCardView({ song, href, onOpen }: { song: JamSongSummary; href: string; onOpen: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  const { t } = useTranslation();
  const needLabel = useNeedLabel();
  const cover = useJamCover(song.coverUrl);
  const player = useJamCardPlayer(song.id);
  const clock = useCardClock(player.engine);
  const need = songNeed(song);
  const present = bandOrder(song.instruments);
  const missing = need.kind === "missing" ? need.instruments : [];
  const who = people(song, t("jam.tile.anonymous"));
  const needText = missing.length > 0 ? needLabel(need) : "";
  const length = clock ? clock.durationMs : (song.mixDurationMs ?? 0);
  const timeLabel = clock ? `${formatClock(clock.seconds * 1000)} / ${formatClock(length)}` : length > 0 ? formatClock(length) : "";
  const state: JamCardPlayState = player.state;
  const label = [song.title, song.artist ?? t("jam.original"), who, needText].filter(Boolean).join(", ");

  return (
    <article
      data-jam-link-card={song.id}
      data-state={state}
      className={cn(
        "@container/jamcard group/jamcard relative isolate mt-1.5 flex h-[72px] w-full max-w-[26rem] items-center gap-2.5 rounded-[var(--radius-card)] border border-border bg-surface-1 p-2 pr-2.5",
        "transition-colors duration-[var(--duration-fast)] hover:border-border-strong hover:bg-surface-2",
        "has-[[data-jam-card-open]:focus-visible]:border-transparent has-[[data-jam-card-open]:focus-visible]:ring-2 has-[[data-jam-card-open]:focus-visible]:ring-focus-ring",
      )}
    >
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[var(--radius-control)] @max-[20rem]/jamcard:h-12 @max-[20rem]/jamcard:w-12">
        <CardPicture song={song} cover={cover} missing={missing} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <a
          href={href}
          onClick={onOpen}
          aria-label={label}
          data-jam-card-open=""
          className="block min-w-0 truncate font-display text-[15px] font-bold leading-5 text-text no-underline outline-none after:absolute after:inset-0 after:content-['']"
        >
          {song.title}
        </a>
        <div className="flex min-w-0 items-baseline text-[13px] leading-[18px] text-text-secondary">
          {/* a phone's card drops the artist before the people: the people are the point of a Jam */}
          <span className="min-w-0 flex-1 truncate">
            {song.artist && <span className="@max-[20rem]/jamcard:hidden">{song.artist} · </span>}
            {who}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1 text-xs font-semibold leading-[18px] text-text-secondary">
          {/* with a part missing, or the clock running, a narrow card keeps only that */}
          <span className={cn("flex shrink-0 items-center gap-1", (needText || clock) && "@max-[20rem]/jamcard:hidden")}>
            {present.map((instrument) => {
              const look = JAM_INSTRUMENT_LOOK[instrument];
              const Icon = look.icon;
              return (
                <span key={instrument} className={cn(INSTRUMENT_DOT, look.fill)} aria-hidden="true">
                  <Icon className="h-2.5 w-2.5" />
                </span>
              );
            })}
          </span>
          {missing.map((instrument) => {
            const look = JAM_INSTRUMENT_LOOK[instrument];
            const Icon = look.icon;
            return (
              <span key={`missing-${instrument}`} className={cn(INSTRUMENT_DOT, "border border-dashed border-current", look.ink)} aria-hidden="true">
                <Icon className="h-2.5 w-2.5" />
              </span>
            );
          })}
          {needText && <span className="ml-1 min-w-0 truncate first-letter:uppercase @max-[20rem]/jamcard:ml-0">{needText}</span>}
          {state === "failed" ? (
            <span className="ml-auto shrink-0 pl-2 text-xs font-semibold" role="status">
              {t("jam.card.playFailed")}
            </span>
          ) : (
            timeLabel && (
              <span className={cn("ml-auto shrink-0 pl-2 font-normal tabular-nums text-text-tertiary", !clock && "@max-[20rem]/jamcard:hidden")}>
                {timeLabel}
              </span>
            )
          )}
        </div>
      </div>
      <button
        type="button"
        data-jam-card-play=""
        aria-label={state === "playing" ? t("jam.song.pause") : t("jam.song.play", { title: song.title })}
        aria-busy={state === "loading" ? true : undefined}
        onClick={() => toggleJamCardSong(song.id)}
        className={cn(
          "relative z-[2] grid h-10 w-10 shrink-0 place-items-center rounded-full outline-none @max-[20rem]/jamcard:h-9 @max-[20rem]/jamcard:w-9",
          "transition-[transform,background-color,color] duration-[var(--duration-fast)] motion-safe:active:scale-95",
          "focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
          state === "playing" || state === "paused" || state === "loading"
            ? "bg-accent text-on-accent hover:bg-accent-hover"
            : "bg-text text-surface-0 hover:bg-accent hover:text-on-accent focus-visible:bg-accent focus-visible:text-on-accent",
        )}
      >
        {state === "loading" ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : state === "playing" ? (
          <Pause className="h-4 w-4" fill="currentColor" aria-hidden="true" />
        ) : (
          <Play className="ml-0.5 h-4 w-4" fill="currentColor" aria-hidden="true" />
        )}
      </button>
    </article>
  );
}

export function JamLinkCardSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-jam-link-card-skeleton=""
      className="mt-1.5 flex h-[72px] w-full max-w-[26rem] items-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface-1 p-2 pr-3"
    >
      <Skeleton className="h-14 w-14 shrink-0 rounded-[var(--radius-control)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
    </div>
  );
}

function NavigatingCard({ song }: { song: JamSongSummary }) {
  const navigate = useNavigate();
  // The song's own address (its channel and server from the song, not from the pasted text).
  const path = jamSongRoutePath(song.serverId, song.channelId, song.id);
  const onOpen = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Let the browser keep its own new-tab and copy-link gestures.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      holdJamEngineForHandoff(song.id);
      navigate(path, { state: messageLinkState() });
    },
    [navigate, path, song.id],
  );
  return <JamLinkCardView song={song} href={path} onOpen={onOpen} />;
}

/** The card for a resolved state. The row owns the state (it decides whether the bare link is still worth showing). */
export function JamLinkCard({ link, state }: { link: JamSongLink; state: JamCardState }) {
  const inRouter = useInRouterContext();
  if (state.status === "loading") {
    return <JamLinkCardSkeleton />;
  }
  if (state.status !== "ok") {
    return null;
  }
  return inRouter ? (
    <NavigatingCard song={state.card.song} />
  ) : (
    <JamLinkCardView song={state.card.song} href={link.url} onOpen={() => undefined} />
  );
}
