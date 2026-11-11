import type { Channel, JamInstrument, JamSongSummary } from "@pqp/shared";
import { CirclePause, CircleHelp, Headphones, Menu as MenuIcon, Mic, Music2, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { FeatureHint, useFeatureHintEnabled } from "@/components/layout/feature-hint";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Tooltip } from "@/components/ui/tooltip";
import { useJamConfig } from "@/hooks/use-jam-config";
import type { NewSongDraft } from "@/hooks/use-jam-studio";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK, JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";
import { isJamStudioOpen, setJamHintContext } from "@/lib/jam-hint-context";
import { parseAppRoute } from "@/lib/app-route";
import { jamHistoryState, jamStepOf, type JamRouteMode } from "@/lib/jam-history";
import { pickInstrument } from "@/lib/jam-record";
import { rememberJamSeen } from "@/lib/jam-seen";
import { releaseJamEngine, unlockJamAudio } from "@/lib/jam-session";
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
  wallColumns,
  type JamWallFilter,
  type JamWallSection,
} from "@/lib/jam-wall";
import { escapeOwnedByOverlay } from "@/lib/escape-unless-overlay";
import { cn } from "@/lib/utils";
import "./jam.css";
import { coverGradient } from "./jam-art";
import { useElementWidth } from "./jam-bars";
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
  onRouteSongChange?: (songId: string | null, mode?: JamRouteMode) => void;
  onOpenNav: () => void;
  /** The channel header's usual buttons (settings, members). */
  headerActions?: ReactNode;
}

const FILTERS: readonly JamWallFilter[] = ["all", "missing", "ready"];
/**
 * The "Tão te chamando" strip above the wall. Off: with a handful of songs it
 * repeats what the tiles already say ("Falta guitarra") and crowds the page.
 */
const SHOW_CALLS_STRIP: boolean = false;

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
  function setOpenSongId(songId: string | null, mode?: JamRouteMode) {
    setOpenSongIdState(songId);
    setSongGone(false);
    setSongError(false);
    routeChange.current?.(songId, mode);
  }
  /** Opened by its tile's round button (or by posting a take): it starts playing. Opened by the card, or by a link, it waits. */
  const [openAutoplay, setOpenAutoplay] = useState(false);
  /** The tile's round button pressed on a song that is open already: the panel plays or pauses. */
  const [playNonce, setPlayNonce] = useState(0);
  const [studio, setStudio] = useState<StudioState | null>(null);
  const studioRef = useRef<StudioState | null>(null);
  const studioOpen = studio !== null;
  studioRef.current = studio;

  // ---- history: wall, song and studio are steps, so Back goes up one ----------
  // (`lib/jam-history.ts`). The router's location state says which Jam step the
  // current entry was pushed for; closing a step goes back when the Jam pushed it.
  const location = useLocation();
  const navigate = useNavigate();
  const step = jamStepOf(location.state);
  const stepRef = useRef(step);
  stepRef.current = step;
  const pathRef = useRef("");
  pathRef.current = `${location.pathname}${location.search}`;
  /** The step below the studio's entry: "song" when the Jam pushed the song under it. */
  const belowStudio = useRef<"song" | null>(null);
  /** The studio's own entry is on its way off (we called `navigate(-1)`). */
  const popping = useRef(false);
  /** Moves each time Back left the studio while it was open: the studio asks what to do with unsent work. */
  const [leaveTick, setLeaveTick] = useState(0);

  /** Close the open song: up one history step when the Jam pushed it, the address rewritten otherwise. */
  function closeSong() {
    setOpenPlaying(false);
    if (stepRef.current === "song" && studioRef.current === null) {
      setOpenSongId(null, "pop");
      navigate(-1);
      return;
    }
    setOpenSongId(null);
  }
  const closeSongRef = useRef(closeSong);
  closeSongRef.current = closeSong;

  /** Open the studio: a history step of its own, so Back asks before it throws a take away. */
  function openStudio(next: StudioState) {
    belowStudio.current = stepRef.current === "song" ? "song" : null;
    setStudio(next);
    navigate(pathRef.current, { state: jamHistoryState("studio") });
  }

  /**
   * Close the studio. When the Jam pushed its entry the entry comes off (Back);
   * after a Back there is nothing to take off. `toWall` also takes off the song
   * the Jam pushed under it.
   */
  function closeStudio(options: { toWall?: boolean } = {}) {
    const pushed = stepRef.current === "studio";
    setStudio(null);
    if (options.toWall) {
      popping.current = pushed;
      if (pushed && belowStudio.current === "song") {
        setOpenSongId(null, "pop");
        navigate(-2);
      } else if (!pushed && stepRef.current === "song") {
        setOpenSongId(null, "pop");
        navigate(-1);
      } else {
        // A song opened by a link has nothing of ours under it to take off: the
        // address becomes the wall's, on this very entry.
        setOpenSongId(null);
      }
      return;
    }
    if (!pushed) {
      return;
    }
    popping.current = true;
    navigate(-1);
  }

  // Back or Forward moved between the wall and a song: the panel follows the
  // address the browser is at now. The router's own state is read too late for a
  // quick Back after a click (it batches both into one update, and the app's
  // route effect then sees no change), so this reads the address itself.
  const openSongRef = useRef(openSongId);
  openSongRef.current = openSongId;
  useEffect(() => {
    const onPop = () => {
      if (studioRef.current !== null) {
        return;
      }
      const target = parseAppRoute(window.location.pathname);
      const songId = target?.kind === "channel" && target.channelId === channelId ? target.songId : null;
      if (songId !== openSongRef.current) {
        setOpenSongIdState(songId);
        setSongGone(false);
        setSongError(false);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [channelId]);
  // Back (or Forward) left the studio's entry while it is open: the studio
  // decides, because it knows whether a take or a recording is at stake.
  // Read from the browser's own event, not from the router's state: the router
  // batches a quick Keep-then-Back into one update and the second Back would go
  // unseen. `history.state.usr` is where the router keeps the entry's state.
  useEffect(() => {
    if (!studioOpen) {
      return;
    }
    const onPop = () => {
      if (popping.current) {
        return;
      }
      const entry = (window.history.state as { usr?: unknown } | null)?.usr;
      if (jamStepOf(entry) !== "studio") {
        setLeaveTick((before) => before + 1);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [studioOpen]);
  // An entry of the studio with no studio open (a reload, a Forward onto it)
  // lands on the step below it, never on a screen with nothing in it.
  useEffect(() => {
    if (step !== "studio") {
      popping.current = false;
      return;
    }
    if (studio === null && !popping.current) {
      popping.current = true;
      navigate(-1);
    }
  }, [step, studio, navigate]);
  /** Back was pressed and the person chose to stay: the studio gets its entry back. */
  function stayInStudio() {
    navigate(pathRef.current, { state: jamHistoryState("studio") });
  }
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
    // A link or Back opens a song and waits: only a card or its round button, or a take just posted, plays.
    setOpenAutoplay(false);
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
      // Escape in a full screen stage leaves the full screen first (a browser usually keeps that key to itself)
      if (document.fullscreenElement) {
        return;
      }
      closeSongRef.current();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openSongId, studio]);

  // Space plays and pauses the song, from anywhere on the wall that is not a field or a
  // control: the open song (playing or paused), else the card the keyboard is on, else the
  // first card. A card's own button is the one control that does not keep Space: it would
  // open and play THAT card, and the song already open comes first. Inside the open song's
  // panel the same rule means the same thing, which is what its own handler used to do.
  const spaceRef = useRef<() => void>(() => undefined);
  spaceRef.current = () => {
    unlockJamAudio();
    if (openSongId) {
      setPlayNonce((before) => before + 1);
      return;
    }
    const focused = document.activeElement?.closest("[data-jam-tile]")?.getAttribute("data-jam-tile");
    const target = focused ?? plan[0]?.song.id;
    if (target) {
      openFromTile(target, "play");
    }
  };
  const swallowSpaceUp = useRef(false);
  useEffect(() => {
    if (studio !== null) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== " " || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }
      if (escapeOwnedByOverlay(event) || isJamStudioOpen()) {
        return;
      }
      const target = event.target;
      if (target instanceof Element) {
        const onCard = target.closest("[data-jam-open]") !== null;
        if (
          !onCard &&
          target.closest(
            'input, textarea, select, button, a[href], summary, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="tab"], [role="combobox"], [role="button"]',
          )
        ) {
          return;
        }
      }
      event.preventDefault();
      swallowSpaceUp.current = true;
      spaceRef.current();
    }
    // A button acts on Space when the key comes UP (Firefox) or on the keydown's default (Chrome):
    // the keyup is cancelled too, so a card the key was handled on does not also click.
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === " " && swallowSpaceUp.current) {
        swallowSpaceUp.current = false;
        event.preventDefault();
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [studio]);

  // Closing a song hands focus back to the card that opened it: a keyboard user
  // lands where they were, not at the top of the page.
  const lastOpenId = useRef<string | null>(openSongId);
  useEffect(() => {
    const before = lastOpenId.current;
    lastOpenId.current = openSongId;
    if (!before || openSongId) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) {
        return;
      }
      document.querySelector<HTMLElement>(`[data-jam-tile="${before}"] [data-jam-open]`)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openSongId]);

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
  // The wall draws as many columns as its width holds, and plans its tiles for that
  // many, so the featured tile never leaves a hole beside it.
  const [wallRef, wallWidth] = useElementWidth();
  // With a song open the wall is the narrow side of the screen: one column, cards laid out as rows.
  const compact = openSongId !== null;
  const columns = compact ? 1 : wallColumns(wallWidth);
  const hasInvite = canCreate && filter === "all";
  const plan = useMemo(() => planTiles(shown, columns, hasInvite ? 1 : 0), [shown, columns, hasInvite]);

  // Peaks, videos and who is on each song come from the detail, which a tile
  // asks for when it comes near the screen (`onNear`, three at a time).

  const openSong = openSongId ? songs.find((song) => song.id === openSongId) ?? null : null;
  const openDetail = openSong ? state.details[openSong.id] : undefined;
  const wasThere = useRef<string | null>(null);
  const lastTitle = useRef("");
  /** The title of a song that was deleted while it was open. */
  const [deletedTitle, setDeletedTitle] = useState<string | null>(null);
  // The "deleted" notice says it once and leaves by itself.
  useEffect(() => {
    if (deletedTitle === null) {
      return;
    }
    const timer = window.setTimeout(() => setDeletedTitle(null), 6000);
    return () => window.clearTimeout(timer);
  }, [deletedTitle]);
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
      // The studio is over it: the song's panel goes when the studio does.
      if (studioOpen) {
        return;
      }
      wasThere.current = null;
      setDeletedTitle(lastTitle.current);
      closeSongRef.current();
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
  }, [openSongId, openSong, state.status, channelId, songTry, studioOpen]);

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
  function openFromTile(songId: string, via: "card" | "play") {
    // The click or the keypress is the gesture a browser wants before it lets a page make
    // sound: unlock the audio right here, not later from an effect.
    unlockJamAudio();
    if (songId === openSongId) {
      // Already open. The round button plays or pauses it; the card plays it unless it is
      // playing already (then it has nothing left to do).
      if (via === "play" || !openPlaying) {
        setPlayNonce((before) => before + 1);
      }
      return;
    }
    const go = () => {
      setFreshTrackId(null);
      setOpenAutoplay(true);
      setOpenSongId(songId, stepRef.current === "song" ? "swap" : "push");
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
    openStudio({ mode: "over", songId, instrument, chosen: true });
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
    openStudio({ mode: "new", draft: result.draft, instrument: result.instrument });
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
                <h1 className="font-display text-2xl font-extrabold tracking-[-0.01em] text-text">{t("jam.title")}</h1>
                {songs.length > 0 && (
                  <p className="truncate text-[13px] font-semibold text-text-tertiary max-sm:hidden" data-jam-wall-count="">
                    {t("jam.wall.songCount", { count: songs.length, countLabel: songs.length })}
                    {people > 0 && ` · ${t("jam.wall.people", { count: people, countLabel: people })}`}
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
                <div className={cn("relative", panelOpen && "lg:hidden")}>
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
              size="md"
              value={filter}
              onValueChange={setFilter}
              options={FILTERS.map((value) => ({ value, label: filterLabels[value] }))}
              className="min-w-0"
            />
          )}
        </header>

        {songGone && (
          <p
            role="status"
            data-jam-song-gone=""
            className="mx-3 mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-surface-1 px-3.5 py-3 text-sm text-text-secondary sm:mx-5"
          >
            {t("jam.wall.songGone")}
            <Button variant="ghost" size="sm" onClick={closeSong}>
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

        <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5" data-jam-wall="">
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
          {deletedTitle !== null && (
            <div className="pointer-events-none sticky top-0 z-30 -mb-px flex h-0 justify-center overflow-visible">
              <p
                role="status"
                data-jam-song-deleted-notice=""
                className="pointer-events-auto flex max-w-[min(32rem,100%)] animate-toast-in items-center gap-2.5 rounded-full bg-surface-3 py-1.5 pl-3.5 pr-1.5 text-sm font-semibold text-text shadow-[var(--shadow-2)]"
              >
                <Trash2 className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
                <span className="min-w-0 truncate">{t("jam.wall.songDeleted", { title: deletedTitle })}</span>
                <button
                  type="button"
                  onClick={() => setDeletedTitle(null)}
                  aria-label={t("jam.song.close")}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11 pointer-coarse:w-11"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </p>
            </div>
          )}
          <div ref={wallRef} className="mx-auto w-full max-w-[1720px]">

          {loading && (
            <ul
              aria-busy="true"
              aria-label={t("jam.wall.loading")}
              style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
              className="grid gap-3 sm:gap-4"
            >
              {Array.from({ length: columns * 2 }, (_, one) => (
                <li
                  key={one}
                  className="aspect-[4/5] rounded-[var(--radius-panel)] bg-surface-2 motion-safe:animate-pulse"
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

          {SHOW_CALLS_STRIP && !loading && !failed && !empty && canCreate && calls.length > 0 && filter !== "ready" && (
            <section aria-labelledby="jam-calls-title" className="mb-5 rounded-[var(--radius-panel)] bg-surface-1/60 px-3 pb-3 pt-2.5 ring-1 ring-inset ring-border" data-jam-calls="">
              <h2 id="jam-calls-title" className="mb-2 flex items-center gap-2 font-display text-base font-extrabold text-text">
                <span aria-hidden className="relative flex h-2.5 w-2.5">
                  <span className="jam-call-ping absolute inset-0 rounded-full bg-accent" />
                  <span className="relative h-2.5 w-2.5 rounded-full bg-accent" />
                </span>
                {t("jam.calls.title")}
              </h2>
              <ul className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
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
                    data-jam-grid=""
                    data-jam-columns={columns}
                    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                    className="grid gap-3 [grid-auto-flow:dense] sm:gap-4"
                  >
                    {plan.flatMap((tile, index) => [
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
                        onOpen={() => openFromTile(tile.song.id, "card")}
                        onPlay={() => openFromTile(tile.song.id, "play")}
                        compact={compact}
                      />,
                      // The invitation sits right after the first card, where it is seen, not at the very end
                      ...(hasInvite && index === 0
                        ? [<JamInviteTile key="invite" index={1} entrance={entrance} onRecord={beginSong} compact={compact} />]
                        : []),
                    ])}
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
        </div>
      </section>

      {openSong && (
        <div
          className="jam-panel-in absolute inset-0 z-20 bg-surface-1 max-sm:fixed max-sm:z-40 lg:static lg:z-auto lg:w-[min(50rem,62%)] lg:shrink-0 lg:border-l lg:border-border"
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
            autoplay={openAutoplay}
            playNonce={playNonce}
            onRecord={(instrument, chosen) => openStudio({ mode: "over", songId: openSong.id, instrument, chosen })}
            onPlayingChange={setOpenPlaying}
            onClose={() => {
              setOpenPlaying(false);
              closeSong();
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
          onClose={() => closeStudio()}
          onLeaveToWall={() => closeStudio({ toWall: true })}
          leaveTick={leaveTick}
          onStay={stayInStudio}
          onPosted={({ songId, trackId }) => {
            setFreshTrackId(trackId);
            setOpenAutoplay(true);
            if (studio.mode === "new") {
              // A new song: the studio's entry becomes the song's, so Back from
              // the song is the wall and not a studio that no longer exists.
              popping.current = stepRef.current === "studio";
              setStudio(null);
              setOpenSongId(songId, stepRef.current === "studio" ? "swap" : "push");
            } else {
              closeStudio();
              setOpenSongId(songId);
            }
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
        "group flex h-[3.75rem] w-[15rem] cursor-pointer items-center gap-3 rounded-[var(--radius-panel)] bg-surface-2 p-2 pr-3 text-left outline-none ring-1 ring-inset ring-border",
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
        <h2 className="font-display text-3xl font-extrabold tracking-[-0.01em] text-text [text-wrap:balance] sm:text-4xl">
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
