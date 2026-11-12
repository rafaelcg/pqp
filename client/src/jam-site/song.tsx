import type { PublicJamSongDetail } from "@pqp/shared";
import { ArrowLeftIcon as ArrowLeft, FlagIcon as Flag, Link2Icon as Link2 } from "./icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { detectLocale } from "@/lib/locale";
import type { JamInstrumentName } from "@/lib/jam-intent";
import { noteJamPlay } from "./api";
import { useAsk } from "./auth-sheet";
import { useHead } from "./head";
import { asInstrument, type Instrument } from "./instruments";
import { createPublicPlayer, warmJamEngine, type PublicPlayer } from "./player";
import { Link, mainOrigin, useJamRoute } from "./router";
import { jamCanonicalUrl, jamPath } from "./route";
import { CONTAINER } from "./shell";
import { SongLanes } from "./song-lanes";
import { SongStage } from "./song-stage";
import { SongTransport } from "./song-transport";
import { button, Skeleton } from "./ui";
import { useJamSong } from "./use-jam-data";
import { ago, compactCount, clock, cn, initials, listOf, instrumentName, personLabel } from "./util";

/** The song page: the mosaic, one play button, the lanes, where it was born. */

function SongSkeleton() {
  return (
    <div className={cn(CONTAINER, "pt-8")} aria-hidden="true" data-jam-song-skeleton="">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-4 h-14 w-2/3" />
      <Skeleton className="mt-8 aspect-[4/5] w-full rounded-[var(--radius-panel)] sm:aspect-video" />
    </div>
  );
}

function Message({ title, body, children }: { title: string; body?: string; children?: React.ReactNode }) {
  return (
    <div className={cn(CONTAINER, "py-24 text-center")} role="alert" data-jam-message="">
      <h1 className="text-2xl font-extrabold">{title}</h1>
      {body && <p className="mx-auto mt-2 max-w-md text-[15px] text-text-secondary">{body}</p>}
      <div className="mt-6 flex justify-center gap-3">{children}</div>
    </div>
  );
}

function OriginCard({ origin }: { origin: NonNullable<PublicJamSongDetail["song"]["origin"]> }) {
  const main = mainOrigin();
  return (
    <div className="mt-2 flex items-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface-1 p-3" data-jam-origin="">
      {origin.iconUrl ? (
        <img src={origin.iconUrl} alt="" className="h-10 w-10 shrink-0 rounded-[var(--radius-control)] object-cover" />
      ) : (
        <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] bg-surface-3 font-display text-sm font-extrabold">
          {initials(origin.name)}
        </span>
      )}
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate font-bold">{origin.name}</p>
        <p className="text-[13px] text-text-tertiary">{origin.slug ? jt("origin.community") : jt("origin.server")}</p>
      </div>
      {origin.slug && (
        <a href={`${main}/c/${origin.slug}`} className={button("secondary")}>
          {jt("origin.visit")}
        </a>
      )}
    </div>
  );
}

/**
 * Makes the player in an effect, not in render: React's strict mode mounts,
 * cleans up and mounts again in development, and a player disposed by that
 * first cleanup would never play. One player per song, let go when leaving it.
 */
function Loaded(props: { detail: PublicJamSongDetail; refresh: () => Promise<PublicJamSongDetail | null>; fromApp: boolean; appRecord: boolean }) {
  const { detail, refresh } = props;
  const [player, setPlayer] = useState<PublicPlayer | null>(null);
  useEffect(() => {
    const made = createPublicPlayer({
      tracks: detail.tracks,
      durationMs: detail.song.durationMs ?? 0,
      onFirstPlay: () => noteJamPlay(detail.song.id),
      refreshTracks: async () => (await refresh())?.tracks ?? null,
    });
    setPlayer(made);
    void warmJamEngine();
    // The home's play button sent us here to start it.
    if ((window.history.state as { autoplay?: boolean } | null)?.autoplay) {
      window.history.replaceState(null, "");
      made.toggle();
    }
    return () => {
      made.dispose();
      setPlayer(null);
    };
    // A refresh of the same song keeps its player: only another song makes a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.song.id]);
  if (!player) {
    return <SongSkeleton />;
  }
  return <Ready {...props} player={player} />;
}

function Ready({ detail, fromApp, appRecord, player }: { detail: PublicJamSongDetail; fromApp: boolean; appRecord: boolean; player: PublicPlayer }) {
  const { song, tracks } = detail;
  const { mount } = useJamRoute();
  const locale = detectLocale();
  const ask = useAsk();
  const [spot, setSpot] = useState<number | null>(null);
  const [shared, setShared] = useState<string | null>(null);


  const select = useCallback(
    (index: number | null) => {
      setSpot(index);
      player.setSolo(index === null ? null : (tracks[index]?.id ?? null));
    },
    [player, tracks],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && spot !== null && !document.querySelector("dialog[open]")) {
        select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spot, select]);

  const needs = useMemo(() => song.needs.map(asInstrument), [song.needs]);
  const need: Instrument | null = needs[0] ?? null;
  const record = useCallback(
    (instrument: Instrument | null) =>
      ask({ kind: "record", songId: song.id, instrument: (instrument ?? need) as JamInstrumentName | null }),
    [ask, song.id, need],
  );

  const share = async () => {
    const url = `${window.location.origin}${jamPath(mount, { kind: "song", songId: song.id })}`;
    const who = song.startedBy.handle ? `@${song.startedBy.handle}` : personLabel(song.startedBy);
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: song.title, text: jt("share.text", { title: song.title, who }), url });
        return;
      }
    } catch (error) {
      // The sheet was dismissed: nothing to say. Anything else falls to the copy.
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setShared(jt("share.copied"));
    } catch {
      setShared(url);
    }
    window.setTimeout(() => setShared(null), 3500);
  };

  useHead({
    title: jt("meta.songTitle", { title: song.title }),
    description: needs.length
      ? jt("meta.songNeeds", { title: song.title, list: listOf(needs.map(instrumentName), locale) })
      : jt("meta.songDescription", { title: song.title }),
    canonical: jamCanonicalUrl({ kind: "song", songId: song.id }),
  });

  const who = song.startedBy.handle ? `@${song.startedBy.handle}` : personLabel(song.startedBy);
  const duration = song.durationMs ?? 0;

  return (
    <div className={cn(CONTAINER, "pt-6 sm:pt-8")} data-jam-song={song.id}>
      <Link
        href={jamPath(mount, { kind: "home" })}
        className="inline-flex h-10 items-center gap-2 rounded-full pr-3 text-[15px] font-bold text-text-secondary outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <ArrowLeft className="h-[18px] w-[18px]" aria-hidden />
        {jt("song.back")}
      </Link>

      {fromApp && (
        <div className="mt-3 rounded-[var(--radius-card)] border border-border bg-surface-1 px-4 py-3" role="status" data-jam-from-app="">
          <p className="font-bold">{jt("fromApp.title")}</p>
          <p className="mt-0.5 text-sm text-text-secondary">{appRecord ? jt("fromApp.record") : jt("fromApp.body")}</p>
        </div>
      )}

      <div className="mt-4">
        {song.origin && (
          <p className="flex items-center gap-2 text-[15px] font-bold text-text-secondary" data-jam-origin-line="">
            {song.origin.iconUrl ? (
              <img src={song.origin.iconUrl} alt="" className="h-5 w-5 rounded-[var(--radius-tick)] object-cover" />
            ) : (
              <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-[var(--radius-tick)] bg-surface-3 text-[10px] font-extrabold">
                {initials(song.origin.name)}
              </span>
            )}
            {song.origin.name}
          </p>
        )}
        <h1 className="mt-1 break-words font-display text-[clamp(2.25rem,6vw,4rem)] font-extrabold leading-[1] tracking-[-0.025em]">
          {song.title}
        </h1>
        <p className="mt-2 text-[15px] text-text-tertiary">
          {song.artist ? `${song.artist} · ` : ""}
          {jt("song.startedBy", { who })} · {ago(song.publishedAt, locale)} · {jt("card.plays", { count: song.plays, countLabel: compactCount(song.plays, locale) })}
        </p>
      </div>

      <div className="mt-6">
        <SongStage
          tracks={tracks}
          need={need}
          player={player}
          spot={spot}
          onSpot={select}
          onRecord={(instrument) => record(instrument)}
          label={jt("stage.label")}
        />
        <SongTransport
          player={player}
          likes={song.likes}
          need={need}
          onLike={() => ask({ kind: "like", songId: song.id })}
          onShare={() => void share()}
          onRecord={() => record(need)}
          shared={shared}
        />
      </div>

      <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-14">
        <SongLanes
          tracks={tracks}
          needs={needs}
          durationMs={duration}
          player={player}
          spot={spot}
          onReport={() => ask({ kind: "reportPart", songId: song.id })}
        />
        <aside className="flex flex-col gap-6">
          {song.origin && (
            <section aria-labelledby="jam-origin-title">
              <h2 id="jam-origin-title" className="text-xs font-extrabold uppercase tracking-[0.08em] text-text-tertiary">
                {jt("origin.title")}
              </h2>
              <OriginCard origin={song.origin} />
            </section>
          )}
          <section>
            <h2 className="text-xs font-extrabold uppercase tracking-[0.08em] text-text-tertiary">{jt("how.title")}</h2>
            <p className="mt-2 text-[15px] leading-6 text-text-secondary">{jt("how.body", { who })}</p>
          </section>
          <div className="flex flex-wrap gap-1 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => void share()}
              data-jam-copy=""
              className={button("ghost", "md", "gap-2 px-3")}
            >
              <Link2 className="h-4 w-4" aria-hidden />
              {jt("share.copy")}
            </button>
            <button
              type="button"
              onClick={() => ask({ kind: "report", songId: song.id })}
              data-jam-report=""
              className={button("ghost", "md", "gap-2 px-3")}
            >
              <Flag className="h-4 w-4" aria-hidden />
              {jt("report.song")}
            </button>
          </div>
        </aside>
      </div>
      <span className="sr-only">{clock(duration)}</span>
    </div>
  );
}

/** The head of a song that is not (or not yet) there: the site's own, and kept out of search. */
function PlaceholderHead() {
  useHead({ title: jt("meta.homeTitle"), description: jt("meta.homeDescription"), noindex: true });
  return null;
}

export function SongPage({ songId }: { songId: string }) {
  const { state, retry, refresh } = useJamSong(songId);
  const { mount, search } = useJamRoute();
  const fromApp = search.get("from") === "app";
  const appRecord = search.get("record") === "1";

  if (state.status === "loading") {
    return (
      <>
        <PlaceholderHead />
        <SongSkeleton />
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        <PlaceholderHead />
        <Message title={jt("song.error")}>
          <button type="button" onClick={retry} className={button("secondary", "md")}>
            {jt("retry")}
          </button>
        </Message>
      </>
    );
  }
  if (state.status === "notFound") {
    return (
      <>
        <PlaceholderHead />
        <Message title={jt("song.notFound.title")} body={jt("song.notFound.body")}>
          <Link href={jamPath(mount, { kind: "home" })} className={button("primary", "md")}>
            {jt("song.notFound.cta")}
          </Link>
        </Message>
      </>
    );
  }
  return <Loaded key={state.detail.song.id} detail={state.detail} refresh={refresh} fromApp={fromApp} appRecord={appRecord} />;
}
