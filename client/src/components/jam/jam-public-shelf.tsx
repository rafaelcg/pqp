import type { PublicJamSong } from "@pqp/shared";
import { useEffect, useState } from "react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { fetchPublicJams } from "@/lib/jam-public-api";
import { jamSiteHomeUrl } from "@/lib/jam-public-links";
import { openPublicJamById } from "@/lib/jam-public-nav";
import { useJamPublicMe } from "@/lib/jam-public-store";
import { cn } from "@/lib/utils";

/**
 * The public jams, as one quiet row under a channel's own songs: a few cards
 * and a link to the whole list on the public site. Nothing at all while the
 * flag is off or there is nothing to show, and never a loading state: a shelf
 * that appears late is better than a place held for something that may not come.
 */

const SHELF_SIZE = 10;

/**
 * The songs the shelf would show, minus those the channel already shows on its
 * own wall (a song its own server made public is not a discovery).
 */
export function useJamPublicShelf(ownIds: ReadonlySet<string>): PublicJamSong[] {
  const me = useJamPublicMe();
  const [songs, setSongs] = useState<PublicJamSong[]>([]);
  useEffect(() => {
    if (!me.enabled) {
      setSongs([]);
      return;
    }
    let cancelled = false;
    void fetchPublicJams({ sort: "top", limit: SHELF_SIZE + 4 }).then(
      (page) => {
        if (!cancelled) setSongs(page.songs);
      },
      () => {
        if (!cancelled) setSongs([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [me.enabled]);
  return songs.filter((song) => !ownIds.has(song.id)).slice(0, SHELF_SIZE);
}

export function JamPublicShelf({ songs, titled }: { songs: readonly PublicJamSong[]; titled: boolean }) {
  const { t } = useTranslation();
  if (songs.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="jam-public-shelf" data-jam-public-shelf="" className={cn(titled ? "mt-8" : "mt-6")}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h2 id="jam-public-shelf" className="font-display text-lg font-extrabold text-text">
          {t("jam.public.shelf.title")}
        </h2>
        <a
          href={jamSiteHomeUrl()}
          target="_blank"
          rel="noreferrer"
          data-jam-public-all=""
          className="inline-flex min-h-8 items-center rounded-sm text-[13px] font-bold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:min-h-11"
        >
          {t("jam.public.shelf.all")}
        </a>
      </div>
      <ul className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-2 [scrollbar-width:none] sm:-mx-5 sm:px-5 [&::-webkit-scrollbar]:hidden">
        {songs.map((song) => (
          <li key={song.id} className="w-36 shrink-0">
            <ShelfCard song={song} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ShelfCard({ song }: { song: PublicJamSong }) {
  const { t } = useTranslation();
  const need = song.needs[0];
  const who = song.parts[0]?.person.name ?? song.startedBy.name;
  return (
    <button
      type="button"
      onClick={() => openPublicJamById(song.id)}
      data-jam-public-card={song.id}
      className="group flex w-full flex-col gap-2 rounded-[var(--radius-panel)] text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <ShelfArt song={song} />
      <span className="flex min-w-0 flex-col leading-snug">
        <span className="truncate text-sm font-bold text-text group-hover:underline">{song.title}</span>
        <span className="truncate text-[13px] text-text-secondary">{song.artist ?? who}</span>
        {need ? (
          <span className="truncate text-[13px] font-semibold text-text-secondary">
            {t(JAM_INSTRUMENT_LOOK[need].missingKey as MessageKey)}
          </span>
        ) : (
          <span className="truncate text-[13px] text-text-tertiary">
            {t("jam.public.shelf.people", { count: song.parts.length, countLabel: song.parts.length })}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The cover when it passed the scanner. Otherwise a small square per part in its
 * instrument's colour and a dashed one for what it still asks for, in a 2 by 2
 * that is always the same size, so a song with one part is a quiet card and not
 * a block of colour.
 */
function ShelfArt({ song }: { song: PublicJamSong }) {
  const cells = [
    ...song.parts.map((part) => ({ instrument: part.instrument, need: false })),
    ...song.needs.map((instrument) => ({ instrument, need: true })),
  ].slice(0, 4);
  return (
    <span className="relative block aspect-square w-full overflow-hidden rounded-[var(--radius-panel)] bg-surface-2 ring-1 ring-inset ring-border">
      {song.coverUrl ? (
        <img src={song.coverUrl} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <span className="grid h-full w-full grid-cols-2 grid-rows-2 gap-1.5 p-2">
          {cells.map((cell, index) => {
            const look = JAM_INSTRUMENT_LOOK[cell.instrument];
            const Icon = look.icon;
            return (
              <span
                key={index}
                className={cn(
                  "grid place-items-center rounded-[var(--radius-control)]",
                  cell.need ? cn("border-2 border-dashed border-border-strong", look.ink) : look.fill,
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}
