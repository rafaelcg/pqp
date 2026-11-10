import type { Channel, JamInstrument } from "@pqp/shared";
import { CirclePause, CircleHelp, Menu as MenuIcon, Mic, Music2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FeatureHint, useFeatureHintEnabled } from "@/components/layout/feature-hint";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Tooltip } from "@/components/ui/tooltip";
import { useJamConfig } from "@/hooks/use-jam-config";
import type { NewSongDraft } from "@/hooks/use-jam-studio";
import { useTranslation } from "@/lib/i18n";
import { JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";
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
  type JamWallFilter,
  type JamWallSection,
} from "@/lib/jam-wall";
import { escapeOwnedByOverlay } from "@/lib/escape-unless-overlay";
import { cn } from "@/lib/utils";
import "./jam.css";
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
  | { mode: "over"; songId: string; instrument: JamInstrument }
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

  function onStart(result: JamStartResult) {
    setStartOpen(false);
    setStudio({ mode: "new", draft: result.draft, instrument: result.instrument });
  }

  const filterLabels: Record<JamWallFilter, string> = {
    all: t("jam.filter.all"),
    missing: t("jam.filter.missing"),
    ready: t("jam.filter.ready"),
  };

  const recordButton = canCreate ? (
    <Button
      onClick={beginSong}
      className="h-11 gap-2 rounded-full px-5 text-sm font-bold max-sm:px-4"
      data-jam-new-song=""
    >
      <Mic className="h-4 w-4" aria-hidden />
      <span className="max-sm:hidden">{t("jam.wall.record")}</span>
      <span className="sm:hidden">{t("jam.wall.recordShort")}</span>
    </Button>
  ) : null;

  const loading = state.status === "idle" || (state.status === "loading" && songs.length === 0);
  const failed = state.status === "error" && songs.length === 0;
  const empty = state.status === "ready" && songs.length === 0;
  const panelOpen = openSong !== null;

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 bg-surface-0"
      data-jam-pane={channelId}
      data-jam-uploads={config.uploads ? "on" : "off"}
    >
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("jam.title")} inert={studio !== null}>
        {/* One row on a wide screen. On a phone: the menu, the title and the one
            button on top, then the filters with the two small tools beside them
            (`order` and a full-width break do it without a second copy). */}
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-3 py-2.5 sm:px-5 md:gap-x-3">
          <button
            type="button"
            className="order-1 grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] hover:bg-surface-2 md:hidden"
            aria-label={t("chrome.openNav")}
            onClick={onOpenNav}
          >
            <MenuIcon className="h-5 w-5" aria-hidden />
          </button>
          <h1 className="order-2 flex items-center gap-2 font-display text-2xl font-extrabold text-text">
            <span aria-hidden className="grid h-8 w-8 place-items-center rounded-[10px] bg-inst-guitar text-on-inst">
              <Music2 className="h-[18px] w-[18px]" />
            </span>
            {t("jam.title")}
          </h1>
          <div className="order-3 ml-auto flex items-center gap-1 md:order-4">
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
            <div className="flex items-center gap-1 max-sm:hidden">{headerActions}</div>
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
          </div>
          <div aria-hidden className="order-4 h-0 basis-full md:hidden" />
          <RadioGroup<JamWallFilter>
            label={t("jam.filter.label")}
            variant="chips"
            value={filter}
            onValueChange={setFilter}
            options={FILTERS.map((value) => ({ value, label: filterLabels[value] }))}
            className="order-5 min-w-0 md:order-3"
          />
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
              className="grid grid-cols-2 gap-2.5 [grid-auto-rows:9.5rem] md:grid-cols-3 xl:grid-cols-4"
            >
              {[0, 1, 2, 3, 4].map((one) => (
                <li
                  key={one}
                  className={cn(
                    "animate-pulse rounded-[var(--radius-card)] bg-surface-2",
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

          {empty && (
            <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-5 text-center" data-jam-empty="">
              <JamHowToHero className="w-full rounded-[var(--radius-panel)]" />
              <div className="flex flex-col gap-1.5">
                <h2 className="font-display text-2xl font-extrabold text-text [text-wrap:balance]">{t("jam.wall.empty.title")}</h2>
                <p className="text-sm leading-relaxed text-text-secondary [text-wrap:pretty]">{t("jam.wall.empty.body")}</p>
              </div>
              {canCreate ? (
                <Button className="h-12 gap-2 rounded-full px-6 text-base font-bold" onClick={beginSong} data-jam-empty-record="">
                  <Mic className="h-5 w-5" aria-hidden />
                  {t("jam.wall.empty.cta")}
                </Button>
              ) : null}
            </div>
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
                      "grid grid-cols-2 gap-2.5 [grid-auto-flow:dense] [grid-auto-rows:9.5rem] md:grid-cols-3",
                      !panelOpen && "xl:grid-cols-4",
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
                        onNear={() => loadJamDetailLazy(channelId, tile.song.id)}
                        onOpen={() => {
                          setFreshTrackId(null);
                          setOpenSongId(tile.song.id);
                        }}
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
          className="absolute inset-0 z-20 bg-surface-1 lg:static lg:z-auto lg:w-[26rem] lg:shrink-0 lg:border-l lg:border-border"
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
            onRecord={(instrument) => setStudio({ mode: "over", songId: openSong.id, instrument })}
            onClose={() => setOpenSongId(null)}
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
            studio.mode === "over" && studioSong && studioDetail
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
