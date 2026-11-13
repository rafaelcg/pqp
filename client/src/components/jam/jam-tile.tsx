import type { JamSongSummary } from "@pqp/shared";
import { Check, Lock, Mic, Play, Plus, Users, Video } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { JamDetail } from "@/lib/jam-state";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { useJamStoreEpoch } from "@/lib/jam-store";
import { JAM_TILE_SPAN, songNeed, type JamNeed, type JamTileSize } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { useNeedLabel } from "./jam-need";
import { bandOrder, ContributorStack, Equalizer } from "./jam-art";
import { JamArtwork } from "./jam-artwork";
import { useJamCover } from "./jam-cover";

/**
 * One song on the wall, drawn from the song summary alone.
 *
 * ONE COMPOSITION, at every size and for every kind of song: the song's picture
 * on top, clean, and a footer of its own under it that holds everything that is
 * words (the title, who is on it, what it still needs) and the one round play
 * button. Nothing is drawn across the picture, so a cover photo with big
 * lettering of its own, a dark photo, a pale one, a mosaic of the band's faces
 * and the generated band of lanes all sit in the same card and none of them
 * collides with ours. The footer is a container: its labels switch to short
 * forms when the card is narrow, so a long title, a long "falta bateria e voz"
 * or Spanish never pushes the play button out of the card.
 *
 * The card is two actions that are NOT nested: the whole card opens the song
 * and starts it (a button stretched over it) and the round button plays or
 * pauses it (a second button above that, which changes nothing else).
 *
 * A tile with a video reads its song's detail (for the videos' addresses) once
 * it comes near the screen. A song with a cover never reads its videos.
 */

export interface JamTileProps {
  song: JamSongSummary;
  size: JamTileSize;
  detail?: JamDetail;
  index: number;
  /** Arrived while the wall was open: grows in and draws a ring. */
  fresh?: boolean;
  /** Played the staggered entrance (the wall's first paint). */
  entrance?: boolean;
  selected?: boolean;
  /** The open song, and it is playing: the card dances. */
  playing?: boolean;
  /** A tile with a video came near the screen: the wall reads its detail for the address. */
  onNear?: () => void;
  /** Open the song and start it (a song that is playing already is only opened). */
  onOpen: () => void;
  /** The round button: open the song and play it, or, when it is open already, play or pause it. */
  onPlay: () => void;
  /** A song is open beside the wall: the card is a row (a small picture, the words, play), not a square. */
  compact?: boolean;
}

function names(song: JamSongSummary, anonymous: string): string {
  const people = song.contributors.length > 0 ? song.contributors.map((one) => one.name ?? anonymous) : [song.authorName ?? anonymous];
  const first = people[0] ?? anonymous;
  const more = Math.max(0, (song.contributorCount || people.length) - 1);
  return more > 0 ? `${first} +${more}` : first;
}

export function JamTile({ song, size, detail, index, fresh, entrance, selected, playing, onNear, onOpen, onPlay, compact = false }: JamTileProps) {
  const { t } = useTranslation();
  const needLabel = useNeedLabel();
  const need = songNeed(song);
  const hero = size === "hero" && !compact;
  const cover = useJamCover(song.coverUrl);
  const covered = cover.src !== null && cover.status !== "failed";

  // Near the screen, once: only a tile with a video (and no cover) has anything to read.
  const tileRef = useRef<HTMLLIElement | null>(null);
  const [near, setNear] = useState(false);
  const storeEpoch = useJamStoreEpoch();
  useEffect(() => {
    const element = tileRef.current;
    if (!element || near || !song.hasVideo || covered) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, song.hasVideo, covered]);
  useEffect(() => {
    if (near) {
      onNear?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when it comes near, and again after the store was emptied for another account
  }, [near, storeEpoch]);

  const who = names(song, t("jam.tile.anonymous"));
  // The credit line: the artist when there is one, then who is on it ("Original" alone is noise)
  const subtitle = song.artist ?? t("jam.original");
  const credit = song.artist ? `${song.artist} · ${who}` : who;
  const closed = song.joinMode === "closed";
  const label = `${song.title}, ${subtitle}, ${who}, ${closed ? t("jam.tile.closed") : needLabel(need)}`;

  function hover(event: React.PointerEvent<HTMLElement>, on: boolean) {
    // A mouse over a song with people in it wakes their videos, muted; a touch and reduced motion do not.
    if (event.pointerType !== "mouse" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    // Only the first picture moves: the others stay still frames, so a hover is one decoder, not four.
    event.currentTarget.querySelectorAll<HTMLVideoElement>("video[data-jam-artwork-video]").forEach((video, index) => {
      if (on && index === 0) void video.play().catch(() => undefined);
      else video.pause();
    });
  }

  return (
    <li ref={tileRef} className={cn("flex min-w-0", JAM_TILE_SPAN[size])}>
      <article
        data-jam-tile={song.id}
        data-jam-tile-size={size}
        data-jam-tile-cover={covered ? "" : undefined}
        data-playing={playing ? "true" : undefined}
        onPointerEnter={(event) => hover(event, true)}
        onPointerLeave={(event) => hover(event, false)}
        style={{ "--jam-i": Math.min(index, 6) } as CSSProperties}
        className={cn(
          "group/card @container/tile relative isolate flex h-full w-full min-w-0 overflow-hidden rounded-[var(--radius-panel)] border border-border bg-surface-1 text-left",
          compact ? "flex-row items-center gap-3 p-2.5" : "flex-col",
          "transition-[transform,box-shadow,border-color] duration-[var(--duration-base)] ease-[var(--ease-standard)]",
          "has-[[data-jam-open]:focus-visible]:border-transparent has-[[data-jam-open]:focus-visible]:ring-2 has-[[data-jam-open]:focus-visible]:ring-focus-ring",
          "motion-safe:hover:-translate-y-1 hover:shadow-[var(--shadow-2)] hover:border-border-strong has-[[data-jam-tile-play]:active]:scale-100 active:scale-[0.99]",
          selected && "border-transparent ring-2 ring-accent",
          entrance && "jam-tile-in",
          fresh && "jam-tile-arrive",
        )}
      >
        {/* the picture: clean, nothing is drawn across it */}
        <div
          className={cn("relative shrink-0 overflow-hidden", compact ? "h-16 w-16 rounded-[var(--radius-card)]" : "aspect-square")}
          style={{ viewTransitionName: selected ? undefined : `jam-cover-${song.id}` } as CSSProperties}
        >
          <JamArtwork song={song} cover={cover} tracks={detail?.tracks} loadVideo={near} animate={Boolean(entrance || fresh)} eager={hero} />
        </div>

        {/* the footer: the words, the people, what it needs, and play */}
        <div
          className={cn(
            // not `relative`: the open button's overlay is sized by the CARD, so the whole card opens
            "flex min-w-0 flex-col bg-surface-1",
            compact ? "flex-1 gap-0.5 bg-transparent" : hero ? "flex-1 gap-2.5 p-4 @min-[22rem]/tile:p-5" : "flex-1 gap-1.5 p-3",
          )}
        >
          <button
            type="button"
            onClick={onOpen}
            aria-label={label}
            aria-current={selected ? "true" : undefined}
            data-jam-open=""
            className="min-w-0 text-left outline-none after:absolute after:inset-0 after:z-[1] after:content-['']"
          >
            <span
              className={cn(
                "line-clamp-2 font-display font-extrabold leading-[1.12] tracking-[-0.01em] text-text [overflow-wrap:anywhere] [text-wrap:balance]",
                hero ? "text-2xl @min-[22rem]/tile:text-3xl" : "text-[15px] @min-[14rem]/tile:text-base",
              )}
            >
              {song.title}
            </span>
          </button>

          <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-text-secondary">
            <ContributorStack
              people={song.contributors}
              total={song.contributorCount}
              size="xs"
              ringClassName="ring-surface-1"
              className="shrink-0"
            />
            <span className="min-w-0 truncate">{credit}</span>
            {song.hasVideo && <Video className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />}
          </div>

          {hero && <InstrumentDots song={song} need={need} />}

          {/* what it needs, and play: the last line of the card, whatever its size */}
          <div className="mt-auto flex min-w-0 items-center justify-between gap-2">
            <TileStatus need={need} closed={closed} compact={compact} className="min-w-0 flex-1" />
            {!compact && <PlayButton hero={hero} playing={Boolean(playing)} title={song.title} onPlay={onPlay} />}
          </div>
        </div>
        {compact && <PlayButton hero={false} playing={Boolean(playing)} title={song.title} onPlay={onPlay} />}

        {fresh && (
          <span
            aria-hidden="true"
            className="jam-arrive-ring pointer-events-none absolute inset-0 z-[2] rounded-[var(--radius-panel)] ring-2 ring-accent"
          />
        )}
      </article>
    </li>
  );
}

/** The featured card's own row: one dot per instrument on the song, and a dashed one for each still missing. */
function InstrumentDots({ song, need }: { song: JamSongSummary; need: JamNeed }) {
  const { t } = useTranslation();
  const present = bandOrder(song.instruments);
  const missing = need.kind === "missing" ? need.instruments : [];
  if (present.length + missing.length === 0) {
    return null;
  }
  const names = [
    ...present.map((one) => t(JAM_INSTRUMENT_LOOK[one].nameKey as MessageKey)),
    ...missing.map((one) => t(JAM_INSTRUMENT_LOOK[one].missingKey as MessageKey)),
  ].join(", ");
  return (
    <span role="img" aria-label={names} className="flex flex-wrap items-center gap-1.5">
      {present.map((instrument) => {
        const look = JAM_INSTRUMENT_LOOK[instrument];
        const Icon = look.icon;
        return (
          <span key={instrument} className={cn("grid h-7 w-7 place-items-center rounded-full", look.fill)}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        );
      })}
      {missing.map((instrument) => {
        const look = JAM_INSTRUMENT_LOOK[instrument];
        const Icon = look.icon;
        return (
          <span
            key={`missing-${instrument}`}
            className={cn("grid h-7 w-7 place-items-center rounded-full border-2 border-dashed border-current", look.ink)}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
        );
      })}
    </span>
  );
}

/** The round play button: its own control above the card's open button, 44px on a touch screen. */
function PlayButton({ hero, playing, title, onPlay }: { hero: boolean; playing: boolean; title: string; onPlay: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onPlay}
      data-jam-tile-play=""
      aria-label={playing ? t("jam.song.pause") : t("jam.song.play", { title })}
      className={cn(
        "relative z-[2] grid shrink-0 place-items-center rounded-full outline-none",
        "transition-[transform,background-color,color] duration-[var(--duration-base)] ease-[var(--ease-emphasized)] motion-safe:hover:scale-110 active:scale-95",
        "focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
        hero ? "h-12 w-12" : "h-9 w-9 @max-[10rem]/tile:h-8 @max-[10rem]/tile:w-8 after:absolute after:-inset-1 after:content-['']",
        playing
          ? "bg-accent text-on-accent"
          : hero
            ? "bg-accent text-on-accent"
            : "bg-surface-3 text-text hover:bg-text hover:text-surface-0 focus-visible:bg-text focus-visible:text-surface-0",
      )}
    >
      {playing ? <Equalizer /> : <Play className={cn("ml-0.5", hero ? "h-5 w-5" : "h-4 w-4")} fill="currentColor" aria-hidden />}
    </button>
  );
}

/**
 * What the song still needs, in one line under the people. A missing part is a
 * chip with the instrument's own colour as its mark and the words in the text
 * colour (so it reads in both themes); open, ready and closed are quiet lines.
 * Narrow cards switch to a shorter form instead of cutting a word in half.
 */
function TileStatus({ need, closed, className, compact = false }: { need: JamNeed; closed: boolean; className?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const label = useNeedLabel();
  if (need.kind === "missing" && !closed) {
    const first = need.instruments[0]!;
    const look = JAM_INSTRUMENT_LOOK[first];
    const Icon = look.icon;
    const count = need.instruments.length;
    const long = count >= 3 ? t("jam.needs.missingCount", { count, countLabel: count }) : label(need);
    const short = count === 1 ? label(need) : t("jam.needs.missingShort", { count, countLabel: count });
    // the narrowest card (two to a row on a phone): the instrument's name alone, or how many
    const micro = count === 1 ? t(look.nameKey as MessageKey) : t("jam.needs.missingMicro", { count, countLabel: count });
    return (
      <span
        data-jam-need="missing"
        className={cn("inline-flex h-7 w-fit min-w-0 max-w-full items-center gap-1.5 rounded-full bg-surface-2 py-0.5 pl-0.5 pr-2.5 text-xs font-bold text-text @max-[10rem]/tile:gap-1 @max-[10rem]/tile:pr-2", className)}
      >
        <span className={cn("relative grid h-6 w-6 shrink-0 place-items-center rounded-full", look.fill, count > 1 && "@max-[10rem]/tile:hidden")}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span className="absolute -right-1 -top-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-surface-2 text-text">
            <Plus className="h-2.5 w-2.5" strokeWidth={3.5} aria-hidden />
          </span>
        </span>
        <span className={cn("truncate first-letter:uppercase @max-[14rem]/tile:hidden", compact && "hidden")}>{long}</span>
        <span className={cn("hidden truncate first-letter:uppercase @max-[14rem]/tile:inline @max-[10rem]/tile:hidden", compact && "inline")}>{short}</span>
        <span className="hidden truncate first-letter:uppercase @max-[10rem]/tile:inline">{micro}</span>
      </span>
    );
  }
  if (need.kind === "open" && !closed) {
    return <span className={className} aria-hidden="true" />;
  }
  const Icon = closed ? Lock : need.kind === "ready" ? Check : need.kind === "open" ? Users : Mic;
  const long = closed ? t("jam.tile.closed") : label(need);
  const short = closed ? t("jam.tile.closed") : need.kind === "open" ? t("jam.needs.openShort") : need.kind === "empty" ? t("jam.needs.emptyShort") : long;
  return (
    <span
      data-jam-need={need.kind}
      className={cn("inline-flex h-7 w-fit min-w-0 max-w-full items-center gap-1.5 text-[13px] font-semibold text-text-secondary", className)}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} aria-hidden data-jam-tile-closed={closed ? "" : undefined} />
      <span className={cn("truncate first-letter:uppercase @max-[14rem]/tile:hidden", compact && "hidden")}>{long}</span>
      <span className={cn("hidden truncate first-letter:uppercase @max-[14rem]/tile:inline", compact && "inline")}>{short}</span>
    </span>
  );
}

/** The last tile: an invitation to record, not a song. Sits in the grid like a card. */
export function JamInviteTile({
  index,
  entrance,
  disabled,
  onRecord,
  compact = false,
}: {
  index: number;
  entrance?: boolean;
  disabled?: boolean;
  onRecord: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex min-w-0">
      <button
        type="button"
        onClick={onRecord}
        disabled={disabled}
        data-jam-invite=""
        style={{ "--jam-i": Math.min(index, 6) } as CSSProperties}
        className={cn(
          "group flex w-full min-w-0 items-center justify-center rounded-[var(--radius-panel)] border-2 border-dashed border-border-strong text-center text-text-secondary outline-none transition-[transform,background,color,border-color] duration-[var(--duration-base)] hover:border-accent hover:bg-surface-1 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
          compact ? "min-h-16 flex-row gap-3 p-2.5" : "min-h-40 flex-col gap-2.5 p-4",
          entrance && "jam-tile-in",
        )}
      >
        <span className={cn("relative grid shrink-0 place-items-center rounded-full bg-accent text-on-accent transition-transform duration-[var(--duration-base)] ease-[var(--ease-emphasized)] motion-safe:group-hover:scale-110", compact ? "h-10 w-10" : "h-12 w-12")}>
          <Mic className="relative h-5 w-5" aria-hidden="true" />
        </span>
        <span className={cn("flex min-w-0 flex-col", compact ? "items-start text-left" : "items-center")}>
          <span className="font-display text-base font-extrabold text-text">{t("jam.tile.invite")}</span>
          <span className="text-[13px] text-text-secondary">{t("jam.tile.inviteHint")}</span>
        </span>
      </button>
    </li>
  );
}
