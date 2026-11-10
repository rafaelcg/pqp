import type { Channel, JamInstrument, JamSongSummary } from "@pqp/shared";
import { CirclePause, CircleHelp, Headphones, Menu as MenuIcon, Mic, Music2, Plus, RefreshCw, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { FeatureHint, useFeatureHintEnabled } from "@/components/layout/feature-hint";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Tooltip } from "@/components/ui/tooltip";
import { useJamConfig } from "@/hooks/use-jam-config";
import type { NewSongDraft } from "@/hooks/use-jam-studio";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK, JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";
import { setJamHintContext } from "@/lib/jam-hint-context";
import { pickInstrument } from "@/lib/jam-record";
import { rememberJamSeen } from "@/lib/jam-seen";
import { releaseJamEngine } from "@/lib/jam-session";
import { fetchJamSong } from "@/lib/jam-api";
import {
  loadJamChannel,
  loadJamDetail,
  loadJamDetailLazy,
  loadMoreJamSongs,
  jamStoreEpoch,
  putJamSongOnWall,
  useJamChannel,
} from "@/lib/jam-store";
import {
  filterSongs,
  latestActivity,
  planTiles,
  songNeed,
  type JamWallFilter,
  type JamWallSection,
} from "@/lib/jam-wall";
import { escapeOwnedByOverlay } from "@/lib/escape-unless-overlay";
import { cn } from "@/lib/utils";
import "./jam.css";
import { coverGradient } from "./jam-art";
import { JamHowToDialog, JamHowToHero } from "./jam-howto";
import { JamSongPanel } from "./jam-song-panel";
import { JamStartSheet, type JamStartResult } from "./jam-start-sheet";
import { JamStudio } from "./jam-studio";
import { JamInviteTile, JamTile } from "./jam-tile";

/**
 * The Jam: a channel presented as an app. Opening it shows the wall, the
 * server's songs as tiles of different sizes; tapping a tile opens the song
 * beside the wall (over it on a phone); "Gravar por cima" and "Gravar uma
 * música" open the studio over everything.
 *
 * App mounts this in the main pane for a `jam` channel, has already sent
 * `join-channel` for it (so the jam frames reach `lib/jam-store.ts` through
 * `lib/jam-frames.ts`) and passes down what only App knows.
 *
 * THE WALL TAKES SECTIONS. The songs are one `JamWallSection`; the public songs
 * from jam.pqp.gg become a second one later, a heading and a list, without the
 * wall changing shape.
 */

export interface JamPaneProps {
  channel: Channel;
  server: { id: string; name: string };
  viewerId: string | null;
  /** SEND_MESSAGES on the jam channel: may start a song or add a track. */
  canPost: boolean;
  /**
   * The song in the address bar (`/channel/<jamId>/song/<songId>`), the same
   * arrangement as the forum's post. Omitted, the pane keeps its own.
   */
  routeSongId?: string | null;
  onRouteSongChange?: (songId: string | null) => void;
  onOpenNav: () => void;
  /** The channel header's usual buttons (settings, members). */
  headerActions?: ReactNode;
}

const FILTERS: readonly JamWallFilter[] = ["all", "missing", "ready"];

type StudioState =
  /** `chosen`: the person picked the instrument (a "falta baixo" call, a missing lane), so it is not re-guessed. */
  | { mode: "over"; songId: string; instrument: JamInstrument; chosen?: boolean }
  | { mode: "new"; draft: NewSongDraft; instrument: JamInstrument };

export function JamPane({
  channel,
  server,
  viewerId,
  canPost,
  routeSongId = null,
  onRouteSongChange,
  onOpenNav,
  headerActions,
}: JamPaneProps) {
  const { t } = useTranslation();
  const channelId = channel.id;
  const state = useJamChannel(channelId);
  const config = useJamConfig(server.id);
  const [filter, setFilter] = useState<JamWallFilter>("all");
  const [openSongId, setOpenSongIdState] = useState<string | null>(routeSongId);
  const [songGone, setSongGone] = useState(false);
  /** The song could not be read for a reason that may pass (network, server). */
  const [songError, setSongError] = useState(false);
  const [songTry, setSongTry] = useState(0);
  const routeChange = useRef(onRouteSongChange);
  routeChange.current = onRouteSongChange;
  /** Open or close a song, and say so to the address bar. */
  function setOpenSongId(songId: string | null) {
    setOpenSongIdState(songId);
    setSongGone(false);
    setSongError(false);
    routeChange.current?.(songId);
  }
  const [studio, setStudio] = useState<StudioState | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [howToOpen, setHowToOpen] = useState(false);
  const [freshTrackId, setFreshTrackId] = useState<string | null>(null);
  const [entrance, setEntrance] = useState(true);
  /** The open song is playing: its tile dances. */
  const [openPlaying, setOpenPlaying] = useState(false);
  const [freshSongs, setFreshSongs] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const wallHint = useFeatureHintEnabled("jamWall");

  const songs = state.songs;
  // Starting a song needs somewhere to put its first track.
  const canCreate = canPost && config.enabled && config.uploads;

  // The wall is on screen: the first-run queue may point at it, and the sidebar
  // dot is spent for everything up to now.
  useEffect(() => {
    setJamHintContext({ wall: true });
    return () => {
      setJamHintContext({ wall: false });
      void releaseJamEngine();
    };
  }, []);
  useEffect(() => {
    rememberJamSeen(channelId, latestActivity(songs));
  }, [channelId, songs]);

  // A link (or back and forward) put a song in the address bar: open it. A song
  // that is not on the first page is read by id, and one that does not exist
  // (deleted, or never in this Jam) says so instead of showing an empty panel.
  useEffect(() => {
    if (routeSongId === openSongId) {
      return;
    }
    setOpenSongIdState(routeSongId);
    setSongGone(false);
    setSongError(false);
  }, [routeSongId]); // eslint-disable-line react-hooks/exhaustive-deps -- follows the address only

  // Escape closes the open song, like every other panel, unless a dialog or the
  // studio owns the key.
  useEffect(() => {
    if (!openSongId || studio !== null) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || escapeOwnedByOverlay(event)) {
        return;
      }
      setOpenSongId(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openSongId, studio]);

  // Another channel, another wall.
  useEffect(() => {
    setOpenSongIdState(null);
    setStudio(null);
    setFilter("all");
  }, [channelId]);

  // The first paint staggers in; later changes do not replay it.
  useEffect(() => {
    const timer = window.setTimeout(() => setEntrance(false), 1400);
    return () => window.clearTimeout(timer);
  }, [channelId]);

  // A song that arrives while the wall is open grows in and is announced.
  const knownIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (state.status !== "ready") {
      return;
    }
    const ids = new Set(songs.map((song) => song.id));
    const before = knownIds.current;
    knownIds.current = ids;
    if (before === null) {
      return;
    }
    const arrived = songs.filter((song) => !before.has(song.id));
    if (arrived.length === 0) {
      return;
    }
    setFreshSongs((current) => new Set([...current, ...arrived.map((song) => song.id)]));
    setAnnouncement(t("jam.wall.arrived", { title: arrived[0]!.title }));
    const timer = window.setTimeout(() => {
      setFreshSongs((current) => {
        const next = new Set(current);
        for (const song of arrived) next.delete(song.id);
        return next;
      });
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [songs, state.status, t]);
  useEffect(() => {
    knownIds.current = null;
  }, [channelId]);

  const sections: JamWallSection[] = useMemo(
    () => [{ id: "server", songs: filterSongs(songs, filter) }],
    [songs, filter],
  );
  const shown = sections[0]!.songs;
  const plan = useMemo(() => planTiles(shown), [shown]);

  // Peaks, videos and who is on each song come from the detail, which a tile
  // asks for when it comes near the screen (`onNear`, three at a time).

  const openSong = openSongId ? songs.find((song) => song.id === openSongId) ?? null : null;
  const openDetail = openSong ? state.details[openSong.id] : undefined;
  const wasThere = useRef<string | null>(null);
  const lastTitle = useRef("");
  /** The title of a song that was deleted while it was open. */
  const [deletedTitle, setDeletedTitle] = useState<string | null>(null);
  useEffect(() => {
    if (openSong) {
      wasThere.current = openSong.id;
      lastTitle.current = openSong.title;
    }
  }, [openSong]);
  useEffect(() => {
    if (!openSongId || state.status !== "ready" || openSong) {
      return;
    }
    // Deleted under an open panel: close it, and say so.
    if (wasThere.current === openSongId) {
      wasThere.current = null;
      setDeletedTitle(lastTitle.current);
      setOpenSongId(null);
      return;
    }
    // Opened by a link: not on the first page, so read it by id.
    let cancelled = false;
    const asked = jamStoreEpoch();
    void fetchJamSong(openSongId).then(
      (answer) => {
        if (!cancelled && answer.song.channelId === channelId) {
          putJamSongOnWall(channelId, answer.song, asked);
        } else if (!cancelled) {
          setSongGone(true);
        }
      },
      (failure: unknown) => {
        if (cancelled) {
          return;
        }
        // Only the server saying "no such song for you" is gone; a dropped
        // connection or a 500 is a failure to try again.
        const status = (failure as { status?: unknown } | null)?.status;
        if (status === 404 || status === 403) {
          setSongGone(true);
        } else {
          setSongError(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [openSongId, openSong, state.status, channelId, songTry]);

  const liveStudioSong = studio?.mode === "over" ? (songs.find((song) => song.id === studio.songId) ?? null) : null;
  const liveStudioDetail = studio?.mode === "over" ? state.details[studio.songId] : undefined;
  // What the studio last knew of its song: when somebody deletes the song under a
  // recording, the studio keeps its title and its backing and says what happened,
  // instead of turning into "Nova música" and losing the band in the person's ear.
  const studioMemory = useRef<{ id: string; song: typeof liveStudioSong; detail: typeof liveStudioDetail } | null>(null);
  if (studio?.mode === "over") {
    if (liveStudioSong && liveStudioDetail) {
      studioMemory.current = { id: studio.songId, song: liveStudioSong, detail: liveStudioDetail };
    }
  } else {
    studioMemory.current = null;
  }
  const remembered = studio?.mode === "over" && studioMemory.current?.id === studio.songId ? studioMemory.current : null;
  const studioSong = liveStudioSong ?? remembered?.song ?? null;
  const studioDetail = liveStudioDetail ?? remembered?.detail;
  const studioSongDeleted =
    studio?.mode === "over" && !liveStudioSong && remembered !== null && state.status === "ready";

  function beginSong() {
    setStartOpen(true);
  }

  /**
   * A tile opens its song, and the tile's cover travels into the panel's (a
   * View Transition, where the browser has one and motion is welcome; the tile
   * and the panel's cover share a `view-transition-name`).
   */
  function openFromTile(songId: string) {
    const go = () => {
      setFreshTrackId(null);
      setOpenSongId(songId);
    };
    const doc = document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof doc.startViewTransition !== "function" || still) {
      go();
      return;
    }
    const root = document.documentElement;
    root.dataset.jamTransition = "";
    try {
      const transition = doc.startViewTransition(() => flushSync(go));
      void transition.finished.finally(() => {
        delete root.dataset.jamTransition;
      });
    } catch {
      delete root.dataset.jamTransition;
      go();
    }
  }

  /** "Falta voz em In Bloom": the song opens behind, the studio over it, on that instrument. One click. */
  function answerCall(songId: string, instrument: JamInstrument) {
    setFreshTrackId(null);
    setOpenSongId(songId);
    void loadJamDetail(channelId, songId);
    setStudio({ mode: "over", songId, instrument, chosen: true });
  }

  const calls = useMemo(
    () =>
      songs
        .filter((song) => song.joinMode === "wanted" && songNeed(song).kind === "missing")
        .slice(0, 3)
        .map((song) => {
          const need = songNeed(song);
          return { song, instruments: need.kind === "missing" ? need.instruments : [] };
        }),
    [songs],
  );
  const people = useMemo(() => {
    const ids = new Set<string>();
    for (const song of songs) for (const one of song.contributors) ids.add(one.id);
    return ids.size;
  }, [songs]);

  function onStart(result: JamStartResult) {
    setStartOpen(false);
    setStudio({ mode: "new", draft: result.draft, instrument: result.instrument });
  }

  const filterLabels: Record<JamWallFilter, string> = {
    all: t("jam.filter.all"),
    missing: t("jam.filter.missing"),
    ready: t("jam.filter.ready"),
  };

  const panelOpen = openSong !== null;
  const recordButton = canCreate ? (
    <Button
      onClick={beginSong}
      className="h-11 gap-2 rounded-full px-5 text-sm font-bold max-sm:px-4"
      data-jam-new-song=""
    >
      <Mic className="h-4 w-4" aria-hidden />
      <span className={cn("max-sm:hidden", panelOpen && "lg:hidden")}>{t("jam.wall.record")}</span>
      <span className={cn("sm:hidden", panelOpen && "lg:inline")}>{t("jam.wall.recordShort")}</span>
    </Button>
  ) : null;

  const loading = state.status === "idle" || (state.status === "loading" && songs.length === 0);
  const failed = state.status === "error" && songs.length === 0;
  const empty = state.status === "ready" && songs.length === 0;

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 bg-surface-0"
      data-jam-pane={channelId}
      data-jam-uploads={config.uploads ? "on" : "off"}
    >
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("jam.title")} inert={studio !== null}>
        {/* Two rows everywhere: the title with its tools and the one button, then
            the filters. An empty wall has nothing to filter and its own big
            button, so it shows neither. */}
        <header className="flex flex-col gap-2 border-b border-border px-3 pb-2.5 pt-2.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] hover:bg-surface-2 md:hidden"
              aria-label={t("chrome.openNav")}
              onClick={onOpenNav}
            >
              <MenuIcon className="h-5 w-5" aria-hidden />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <span
                aria-hidden
                className={cn(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-card)] text-on-inst shadow-[var(--shadow-2)]",
                  coverGradient(["guitar", "bass", "vocals"]),
                )}
              >
                <Music2 className="h-5 w-5" />
              </span>
              <div className="flex min-w-0 flex-col leading-tight">
                <h1 className="font-display text-2xl font-extrabold tracking-tight text-text">{t("jam.title")}</h1>
                {songs.length > 0 && (
                  <p className="truncate text-[13px] font-semibold text-text-tertiary max-sm:hidden" data-jam-wall-count="">
                    {t("jam.wall.count", { count: songs.length, countLabel: songs.length, people })}
                  </p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Tooltip label={t("jam.wall.howItWorks")}>
                <button
                  type="button"
                  onClick={() => setHowToOpen(true)}
                  aria-label={t("jam.wall.howItWorks")}
                  data-jam-howto=""
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <CircleHelp className="h-5 w-5" aria-hidden />
                </button>
              </Tooltip>
              <div className={cn("flex items-center gap-1 max-sm:hidden", panelOpen && "lg:hidden")}>{headerActions}</div>
              {!empty && (
                <div className="relative">
                  {recordButton}
                  <div className="absolute right-0 top-full z-30 mt-2">
                    <FeatureHint
                      id="jamWall"
                      enabled={wallHint && canCreate && songs.length > 0 && !panelOpen && studio === null}
                      title={t("jam.hint.wall.title")}
                      body={t("jam.hint.wall.body")}
                      hero={<JamHowToHero className="h-28 rounded-t-[inherit]" />}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
          {!empty && !loading && (
            <RadioGroup<JamWallFilter>
              label={t("jam.filter.label")}
              variant="chips"
              size="sm"
              value={filter}
              onValueChange={setFilter}
              options={FILTERS.map((value) => ({ value, label: filterLabels[value] }))}
              className="min-w-0"
            />
          )}
        </header>

        {deletedTitle !== null && (
          <p
            role="status"
            data-jam-song-deleted-notice=""
            className="mx-3 mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-surface-1 px-3.5 py-3 text-sm text-text-secondary sm:mx-5"
          >
            {t("jam.wall.songDeleted", { title: deletedTitle })}
            <Button variant="ghost" size="sm" onClick={() => setDeletedTitle(null)}>
              {t("jam.song.close")}
            </Button>
          </p>
        )}
        {songGone && (
          <p
            role="status"
            data-jam-song-gone=""
            className="mx-3 mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-surface-1 px-3.5 py-3 text-sm text-text-secondary sm:mx-5"
          >
            {t("jam.wall.songGone")}
            <Button variant="ghost" size="sm" onClick={() => setOpenSongId(null)}>
              {t("jam.song.close")}
            </Button>
          </p>
        )}
        {songError && (
          <p
            role="alert"
            data-jam-song-error=""
            className="mx-3 mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-danger-soft px-3.5 py-3 text-sm text-on-danger-soft sm:mx-5"
          >
            {t("jam.wall.songError")}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSongError(false);
                setSongTry((before) => before + 1);
              }}
            >
              {t("jam.wall.retry")}
            </Button>
          </p>
        )}
        {config.loaded && !config.enabled && (
          <p
            role="status"
            data-jam-paused=""
            className="mx-3 mt-3 flex items-center gap-2.5 rounded-[var(--radius-card)] bg-surface-1 px-3.5 py-3 text-sm text-text-secondary sm:mx-5"
          >
            <CirclePause className="h-4 w-4 shrink-0" aria-hidden />
            {t("jam.wall.paused")}
          </p>
        )}
        {config.loaded && config.enabled && !config.uploads && (
          <p role="status" className="mx-3 mt-3 rounded-[var(--radius-card)] bg-warning-soft px-3.5 py-3 text-sm text-on-warning-soft sm:mx-5">
            {t("jam.wall.uploadsOff")}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5" data-jam-wall="">
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>

          {loading && (
            <ul
              aria-busy="true"
              aria-label={t("jam.wall.loading")}
              className="grid grid-cols-2 gap-3 [grid-auto-rows:10.5rem] md:grid-cols-3 xl:grid-cols-4"
            >
              {[0, 1, 2, 3, 4].map((one) => (
                <li
                  key={one}
                  className={cn(
                    "rounded-[var(--radius-panel)] bg-surface-2 motion-safe:animate-pulse",
                    one === 0 && "col-span-2 row-span-2",
                  )}
                />
              ))}
            </ul>
          )}

          {failed && (
            <div role="alert" className="grid min-h-[40vh] place-items-center text-center">
              <div className="flex max-w-xs flex-col items-center gap-3">
                <p className="text-sm text-text-secondary">{t("jam.wall.loadError")}</p>
                <Button variant="secondary" className="gap-2" onClick={() => void loadJamChannel(channelId, { force: true })}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  {t("jam.wall.retry")}
                </Button>
              </div>
            </div>
          )}

          {empty && <JamEmptyWall canCreate={canCreate} onRecord={beginSong} />}

          {!loading && !failed && !empty && canCreate && calls.length > 0 && filter !== "ready" && (
            <section aria-labelledby="jam-calls-title" className="mb-5" data-jam-calls="">
              <h2 id="jam-calls-title" className="mb-2 flex items-center gap-2 font-display text-base font-extrabold text-text">
                <span aria-hidden className="relative flex h-2.5 w-2.5">
                  <span className="jam-call-ping absolute inset-0 rounded-full bg-accent" />
                  <span className="relative h-2.5 w-2.5 rounded-full bg-accent" />
                </span>
                {t("jam.calls.title")}
              </h2>
              <ul className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:-mx-5 sm:px-5 [scrollbar-width:none]">
                {calls.flatMap(({ song, instruments }) =>
                  instruments.slice(0, 1).map((instrument) => (
                    <li key={`${song.id}-${instrument}`} className="shrink-0">
                      <JamCallCard song={song} instrument={instrument} onAnswer={() => answerCall(song.id, instrument)} />
                    </li>
                  )),
                )}
              </ul>
            </section>
          )}

          {!loading && !failed && !empty &&
            sections.map((section) => (
              <section key={section.id} aria-label={t("jam.wall.songs")}>
                {shown.length === 0 ? (
                  <p className="grid min-h-[30vh] place-items-center text-center text-sm text-text-secondary">
                    {t("jam.wall.emptyFilter")}
                  </p>
                ) : (
                  <ul
                    className={cn(
                      "grid grid-cols-2 gap-3 [grid-auto-flow:dense] [grid-auto-rows:10.5rem]",
                      panelOpen ? "2xl:grid-cols-3" : "md:grid-cols-3 xl:grid-cols-4",
                    )}
                  >
                    {plan.map((tile, index) => (
                      <JamTile
                        key={tile.song.id}
                        song={tile.song}
                        size={tile.size}
                        detail={state.details[tile.song.id]}
                        index={index}
                        entrance={entrance}
                        fresh={freshSongs.has(tile.song.id)}
                        selected={tile.song.id === openSongId}
                        playing={tile.song.id === openSongId && openPlaying}
                        onNear={() => loadJamDetailLazy(channelId, tile.song.id)}
                        onOpen={() => openFromTile(tile.song.id)}
                      />
                    ))}
                    {canCreate && filter === "all" && (
                      <JamInviteTile index={plan.length} entrance={entrance} onRecord={beginSong} />
                    )}
                  </ul>
                )}
                {state.nextCursor && (
                  <div className="mt-4 flex justify-center">
                    <Button variant="secondary" onClick={() => void loadMoreJamSongs(channelId)}>
                      {t("jam.wall.more")}
                    </Button>
                  </div>
                )}
              </section>
            ))}
        </div>
      </section>

      {openSong && (
        <div
          className="jam-panel-in absolute inset-0 z-20 bg-surface-1 lg:static lg:z-auto lg:w-[min(42rem,60%)] lg:shrink-0 lg:border-l lg:border-border"
          data-jam-song-panel=""
          inert={studio !== null}
        >
          <JamSongPanel
            key={openSong.id}
            channelId={channelId}
            song={openSong}
            detail={openDetail}
            viewerId={viewerId}
            // The flag only: recording is gated by what the server says this viewer may
            // ADD (`viewer.addableInstruments`, which already needs SEND_MESSAGES), so a
            // song author or moderator without it still manages the mix and their takes.
            enabled={config.enabled}
            uploads={config.uploads}
            freshTrackId={freshTrackId}
            onRecord={(instrument, chosen) => setStudio({ mode: "over", songId: openSong.id, instrument, chosen })}
            onPlayingChange={setOpenPlaying}
            onClose={() => {
              setOpenPlaying(false);
              setOpenSongId(null);
            }}
          />
        </div>
      )}

      {studio && (
        <JamStudio
          channelId={channelId}
          song={studio.mode === "over" ? studioSong : null}
          tracks={studio.mode === "over" ? (studioDetail?.tracks ?? []) : []}
          draft={studio.mode === "new" ? studio.draft : null}
          viewerId={viewerId}
          canSwitchMix={studioDetail ? studioDetail.viewer.isAuthor || studioDetail.viewer.canModerate : false}
          songDeleted={studioSongDeleted}
          addable={
            studio.mode === "over"
              ? (studioDetail?.viewer.addableInstruments ?? [studio.instrument])
              : JAM_INSTRUMENT_ORDER
          }
          initialInstrument={
            studio.mode === "over" && !studio.chosen && studioSong && studioDetail
              ? (pickInstrument(studioSong, studioDetail.viewer.addableInstruments, []) ?? studio.instrument)
              : studio.instrument
          }
          onClose={() => setStudio(null)}
          onPosted={({ songId, trackId }) => {
            setStudio(null);
            setFreshTrackId(trackId);
            setOpenSongId(songId);
            void loadJamDetail(channelId, songId, { force: true });
          }}
        />
      )}

      <JamStartSheet open={startOpen} onClose={() => setStartOpen(false)} onStart={onStart} />
      <JamHowToDialog open={howToOpen} onClose={() => setHowToOpen(false)} />
    </div>
  );
}

/**
 * "Falta voz em In Bloom": a song asking for an instrument, as a card in that
 * instrument's colour. One click opens the studio on it, the song already
 * loaded behind.
 */
function JamCallCard({
  song,
  instrument,
  onAnswer,
}: {
  song: JamSongSummary;
  instrument: JamInstrument;
  onAnswer: () => void;
}) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[instrument];
  const Icon = look.icon;
  return (
    <button
      type="button"
      onClick={onAnswer}
      data-jam-call={`${song.id}:${instrument}`}
      className={cn(
        "group flex h-[3.75rem] w-[15rem] items-center gap-3 rounded-[var(--radius-panel)] bg-surface-1 p-2 pr-3 text-left outline-none ring-1 ring-inset ring-border",
        "transition-[transform,box-shadow,background-color] duration-[var(--duration-base)] ease-[var(--ease-standard)] hover:bg-surface-2 motion-safe:hover:-translate-y-0.5 hover:shadow-[var(--shadow-2)] active:scale-[0.98]",
        "focus-visible:ring-2 focus-visible:ring-focus-ring",
      )}
    >
      <span className={cn("relative grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-card)]", look.fill)}>
        <Icon className="h-5 w-5" aria-hidden />
        <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-surface-1 ring-2 ring-surface-1">
          <Plus className={cn("h-3.5 w-3.5", look.ink)} strokeWidth={3} aria-hidden />
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className={cn("truncate text-sm font-extrabold first-letter:uppercase", look.ink)}>{t(look.missingKey as MessageKey)}</span>
        <span className="truncate text-[13px] font-semibold text-text-secondary">{t("jam.calls.in", { title: song.title })}</span>
      </span>
      <Mic
        className="h-4 w-4 shrink-0 text-text-tertiary transition-[color,transform] duration-[var(--duration-base)] group-hover:text-accent motion-safe:group-hover:scale-110"
        aria-hidden
      />
    </button>
  );
}

/**
 * The first visit: no songs yet. The picture of what a Jam is (lanes stacking
 * up), the one button, and three steps in plain words.
 */
function JamEmptyWall({ canCreate, onRecord }: { canCreate: boolean; onRecord: () => void }) {
  const { t } = useTranslation();
  const steps = [
    { icon: Headphones, title: t("jam.howto.one.title"), body: t("jam.howto.one.body") },
    { icon: Mic, title: t("jam.howto.two.title"), body: t("jam.howto.two.body") },
    { icon: Send, title: t("jam.howto.three.title"), body: t("jam.howto.three.body") },
  ];
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-center justify-center gap-7 py-6 text-center" data-jam-empty="">
      <JamHowToHero className="w-full max-w-lg rounded-[var(--radius-panel)] shadow-[var(--shadow-2)] ring-1 ring-inset ring-border" big />
      <div className="flex max-w-xl flex-col gap-2">
        <h2 className="font-display text-3xl font-extrabold tracking-tight text-text [text-wrap:balance] sm:text-4xl">
          {t("jam.wall.empty.title")}
        </h2>
        <p className="text-base leading-relaxed text-text-secondary [text-wrap:pretty]">{t("jam.wall.empty.body")}</p>
      </div>
      {canCreate ? (
        <Button className="h-14 gap-2.5 rounded-full px-8 text-base font-bold shadow-[var(--shadow-2)]" onClick={onRecord} data-jam-empty-record="">
          <Mic className="h-5 w-5" aria-hidden />
          {t("jam.wall.empty.cta")}
        </Button>
      ) : null}
      <ol className="grid w-full gap-3 text-left sm:grid-cols-3">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <li
              key={step.title}
              style={{ "--jam-i": index + 3 } as CSSProperties}
              className="jam-tile-in flex flex-col gap-2 rounded-[var(--radius-panel)] bg-surface-1 p-4 ring-1 ring-inset ring-border"
            >
              <span className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="font-display text-sm font-extrabold tabular-nums text-text-tertiary">{index + 1}</span>
              </span>
              <h3 className="text-sm font-bold text-text">{step.title}</h3>
              <p className="text-sm leading-snug text-text-secondary [text-wrap:pretty]">{step.body}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
