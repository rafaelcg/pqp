import { parseMusicInput, type MusicResolved } from "@pqp/shared";
import {
  MagnifyingGlass,
  Plus as PlusGlyph,
  Queue,
} from "@phosphor-icons/react";
import { ListStart, Plus, Search } from "lucide-react";
import { IconSwap } from "@/components/ui/icon";
import {
  MUSIC_COVER_REDESIGN,
  MUSIC_ICON_REDESIGN,
  MUSIC_MUTED_REDESIGN,
  MUSIC_ROW_HIGHLIGHT_REDESIGN,
  MUSIC_ROW_REDESIGN,
  MUSIC_TEXT_REDESIGN,
} from "@/components/voice/music-classes";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, resolveMusic, searchMusic } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import {
  addTrack,
  addTracks,
  getMusicSnapshot,
  moveTrackTo,
  musicSessionChannelId,
  useMusic,
  type MusicAddOutcome,
} from "@/lib/music-store";
import { readMusicRecent, rememberMusicRecent } from "@/lib/music-recent";
import { cn } from "@/lib/utils";
import { formatMusicClock } from "@/components/voice/music-now-playing";

/**
 * LIVE SEARCH, WITHIN THE LIMITER.
 *
 * `GET /api/music/search` is rate limited per user at 20 burst and then one
 * every two seconds, so the field asks only once the typing stops, never for
 * the same text twice, and never below the floor. Two characters is the floor
 * rather than three because bands are called U2 and MC.
 */
export const LIVE_SEARCH_DEBOUNCE_MS = 350;
export const LIVE_SEARCH_MIN_CHARS = 2;

/** Past this a result is a concert or a mix, not a song, and says so. */
export const MUSIC_LONG_VIDEO_MS = 20 * 60 * 1000;

export function shouldResolveQuery(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (/^https?:\/\//i.test(trimmed) || /^spotify:/i.test(trimmed)) {
    return true;
  }
  const parsed = parseMusicInput(trimmed);
  return parsed !== null && parsed.kind !== "search";
}

/** Add a resolved track at the front of the queue (two writes). */
/**
 * WHAT TO TELL SOMEBODY WHEN A LOOKUP FAILS.
 *
 * One mapping rather than two: this was written out in both the search
 * handler and the paste handler, and the two had already drifted — 429
 * was a rate limit in neither of them, so the per-user limiter told
 * people the whole feature was unavailable. The field searches as you
 * type, so that refusal is the one they actually meet.
 */
export function musicErrorKey(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) {
    return "music.error.upstream";
  }
  if (error.status === 404) {
    return "music.error.notFound";
  }
  if (error.status === 400) {
    return "music.error.unsupported";
  }
  if (error.status === 429) {
    return "music.error.busy";
  }
  return "music.error.upstream";
}

export function queueResolvedNext(resolved: MusicResolved): MusicAddOutcome {
  const before = new Set((getMusicSnapshot().state?.queue ?? []).map((track) => track.id));
  const outcome = addTrack(resolved);
  if (outcome === "queued") {
    const added = getMusicSnapshot().state?.queue.find((track) => !before.has(track.id));
    if (added) {
      moveTrackTo(added.id, 0);
    }
  }
  return outcome;
}

export function MusicSearchPicker({
  compact = false,
  chrome = "default",
  size = "sheet",
  canManage = false,
  autoFocus = false,
  recents = false,
  onQueryActive,
  onEmptyEscape,
}: {
  compact?: boolean;
  /** Member-list field: icon in the box, paper tokens, square result thumbs. */
  chrome?: "default" | "rail";
  /**
   * The call stage's queue draws the field and the results at the stage's
   * size: `stage` in its column, `hero` alone on the stage with nothing on.
   */
  size?: "sheet" | "stage" | "hero";
  canManage?: boolean;
  autoFocus?: boolean;
  /**
   * With the field empty, offer this person's recent picks (`music-recent`).
   * The stage passes it only when the room has no history of its own.
   */
  recents?: boolean;
  onQueryActive?: (active: boolean) => void;
  onEmptyEscape?: () => void;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<MusicResolved[] | null>(null);
  /** The text these results answer, so a stale list cannot be added by Enter. */
  const [resultsFor, setResultsFor] = useState("");
  const [highlight, setHighlight] = useState(0);
  /**
   * A pasted link on the stage: what it is, before it goes in. One track, or
   * a playlist's tracks. Elsewhere (the sheet, the drawer) a link still goes
   * straight in, where there is no room for a card.
   */
  const [preview, setPreview] = useState<{ tracks: MusicResolved[] } | null>(null);
  const [recentTracks] = useState<MusicResolved[]>(() => (recents ? readMusicRecent() : []));
  const nothingOn = !useMusic().state?.current;
  const rail = chrome === "rail";
  const big = size !== "sheet";
  const hero = size === "hero";
  const showRecents =
    recents && big && !query.trim() && results === null && preview === null && recentTracks.length > 0;
  const rows = results ?? (showRecents ? recentTracks : null);
  const lastQueried = useRef("");
  const runId = useRef(0);
  // An edit to the field retires a link still resolving, so a late answer
  // never puts a preview of the old link under new text.
  const resolveId = useRef(0);

  useEffect(() => {
    onQueryActive?.(Boolean(query.trim()) || results !== null);
  }, [onQueryActive, query, results]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 2_500);
    return () => clearTimeout(timer);
  }, [notice]);

  const tellOutcome = useCallback(
    (outcome: MusicAddOutcome) => {
      if (
        outcome === "queued" ||
        outcome === "playing" ||
        outcome === "playing-dropped"
      ) {
        setNotice(
          outcome === "playing-dropped"
            ? t("music.startedAndDropped")
            : t("music.queued"),
        );
        setQuery("");
        setResults(null);
        setResultsFor("");
        lastQueried.current = "";
      } else if (outcome === "full") {
        setNotice(t("music.full"));
      }
    },
    [t],
  );

  const addResolved = useCallback(
    (track: MusicResolved, playNext = false) => {
      const outcome = playNext ? queueResolvedNext(track) : addTrack(track);
      if (outcome === "queued" || outcome === "playing" || outcome === "playing-dropped") {
        rememberMusicRecent([track]);
      }
      tellOutcome(outcome);
    },
    [tellOutcome],
  );

  const runResolve = useCallback(
    async (text: string) => {
      const room = musicSessionChannelId();
      /*
       * A search may still be in flight, and its answer would land on top
       * of what this paste resolves to. `runId` is the same guard
       * `runSearch` checks, so bumping it here retires that answer.
       */
      runId.current += 1;
      resolveId.current += 1;
      const mine = resolveId.current;
      try {
        const { track, tracks } = await resolveMusic(text);
        if (resolveId.current !== mine || room === null || musicSessionChannelId() !== room) {
          return;
        }
        if (big) {
          setResults(null);
          setResultsFor("");
          setPreview({ tracks: tracks && tracks.length > 1 ? tracks : [track] });
          return;
        }
        if (tracks && tracks.length > 1) {
          const outcome = addTracks(tracks);
          if (outcome.added === 0) {
            setNotice(t("music.full"));
          } else {
            setNotice(
              outcome.dropped > 0
                ? t("music.queuedManyDropped", { count: outcome.added, dropped: outcome.dropped })
                : t("music.queuedMany", { count: outcome.added }),
            );
            setQuery("");
            setResults(null);
            setResultsFor("");
            lastQueried.current = "";
          }
        } else {
          tellOutcome(addTrack(track));
        }
      } catch (error) {
        if (resolveId.current === mine) {
          setNotice(t(musicErrorKey(error)));
        }
      }
    },
    [big, t, tellOutcome],
  );

  const confirmPreview = useCallback(() => {
    if (!preview) {
      return;
    }
    const [only] = preview.tracks;
    setPreview(null);
    if (preview.tracks.length === 1 && only) {
      addResolved(only);
      return;
    }
    const outcome = addTracks(preview.tracks);
    if (outcome.added === 0) {
      setNotice(t("music.full"));
      return;
    }
    rememberMusicRecent(preview.tracks.slice(0, 1));
    setNotice(
      outcome.dropped > 0
        ? t("music.queuedManyDropped", { count: outcome.added, dropped: outcome.dropped })
        : t("music.queuedMany", { count: outcome.added }),
    );
    setQuery("");
    lastQueried.current = "";
  }, [addResolved, preview, t]);

  const runSearch = useCallback(
    async (text: string) => {
      const room = musicSessionChannelId();
      /* A slower answer to an older query must not land on a newer one. */
      runId.current += 1;
      const mine = runId.current;
      const stale = () =>
        runId.current !== mine || room === null || musicSessionChannelId() !== room;
      try {
        const { tracks } = await searchMusic(text);
        if (stale()) {
          return;
        }
        setResults(tracks.slice(0, 5));
        setResultsFor(text);
        setHighlight(0);
        if (tracks.length === 0) {
          setNotice(t("music.error.notFound"));
        }
      } catch (error) {
        if (stale()) {
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          // The only one that also empties the list: nothing matched.
          setResults([]);
          setResultsFor(text);
        }
        setNotice(t(musicErrorKey(error)));
      }
    },
    [t],
  );

  /*
   * Typing searches on its own. It deliberately does not raise `busy`: that
   * disables the field, and a field that goes dead under the caret is worse
   * than a slow list. A link is never live-searched, because resolving one
   * ADDS it, and half a pasted URL is not a song.
   */
  useEffect(() => {
    const text = query.trim();
    if (
      text.length < LIVE_SEARCH_MIN_CHARS ||
      shouldResolveQuery(text) ||
      text === lastQueried.current
    ) {
      return;
    }
    const timer = setTimeout(() => {
      lastQueried.current = text;
      void runSearch(text);
    }, LIVE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const submit = useCallback(async () => {
    const text = query.trim();
    if (preview) {
      confirmPreview();
      return;
    }
    if (!text && showRecents) {
      const pick = recentTracks[highlight] ?? recentTracks[0];
      if (pick) {
        addResolved(pick);
      }
      return;
    }
    if (!text || busy) {
      return;
    }
    if (results && results.length > 0 && resultsFor === text) {
      const pick = results[highlight] ?? results[0];
      if (pick) {
        addResolved(pick);
      }
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (shouldResolveQuery(text)) {
        await runResolve(text);
      } else {
        lastQueried.current = text;
        await runSearch(text);
      }
    } finally {
      setBusy(false);
    }
  }, [
    addResolved,
    busy,
    confirmPreview,
    highlight,
    preview,
    query,
    recentTracks,
    results,
    resultsFor,
    runResolve,
    runSearch,
    showRecents,
  ]);

  /*
   * A pasted link resolves at once. Only a paste, never a keystroke: somebody
   * typing a URL by hand would otherwise fire a resolve at every character
   * that happens to parse, and each one costs the upstream budget.
   */
  const onFieldPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const field = event.currentTarget;
    const pasted = event.clipboardData?.getData("text") ?? "";
    const next = (
      field.value.slice(0, field.selectionStart ?? field.value.length) +
      pasted +
      field.value.slice(field.selectionEnd ?? field.value.length)
    ).trim();
    if (!next || !shouldResolveQuery(next) || busy) {
      return;
    }
    event.preventDefault();
    setQuery(next);
    setBusy(true);
    setNotice(null);
    void (async () => {
      try {
        await runResolve(next);
      } finally {
        setBusy(false);
      }
    })();
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && rows && rows.length > 0) {
      event.preventDefault();
      setHighlight((index) => Math.min(rows.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp" && rows && rows.length > 0) {
      event.preventDefault();
      setHighlight((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (preview) {
        setPreview(null);
        setQuery("");
        return;
      }
      if (results) {
        setResults(null);
        setResultsFor("");
        return;
      }
      if (!query.trim()) {
        onEmptyEscape?.();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  };

  /*
   * The old list stays under the caret while the next one is on its way, so
   * the panel does not blink on every keystroke. `resultsFor` is what keeps
   * Enter honest about which text those rows answer.
   */
  const onQueryChange = (value: string) => {
    setQuery(value);
    setPreview(null);
    resolveId.current += 1;
    if (results && !value.trim()) {
      setResults(null);
      setResultsFor("");
    }
  };

  /*
   * The visible placeholder is the one sentence that says the field takes
   * both a link and a search, so it is only shortened where it genuinely
   * does not fit: the drawer is 240px wide.
   */
  const placeholder = rail
    ? t("music.placeholder.short")
    : big
      ? t("music.placeholder.stage")
      : compact
      ? t("music.placeholder.field")
      : t("music.placeholder");

  const fieldProps = {
    value: query,
    autoFocus,
    disabled: busy,
    placeholder,
    "aria-label": t("music.placeholder"),
    role: "combobox" as const,
    "aria-expanded": rows !== null,
    "aria-controls": listId,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant":
      rows && rows[highlight] ? `${listId}-${highlight}` : undefined,
    onKeyDown: onFieldKeyDown,
    onPaste: onFieldPaste,
    onFocus: (event: { currentTarget: HTMLInputElement }) => {
      event.currentTarget.scrollIntoView({ block: "nearest" as const });
    },
  };

  /*
   * NOT A FORM. The in-call panel renders inside the composer's own form,
   * and a form inside a form is invalid HTML: the browser ran a real
   * navigation on submit, which reloaded the SPA and dropped the person
   * out of the voice call. Enter is handled on the field, and the + is an
   * ordinary button calling the same path.
   */
  return (
    <div data-music-search="" role="search" className="space-y-1">
      <div className={cn("flex items-center gap-1.5", rail && "relative")}>
        {rail ? (
          <>
            <IconSwap
              off={Search}
              on={MagnifyingGlass}
              kind="symbol"
              size="sm"
              offClassName="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-paper-muted"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
            />
            <input
              {...fieldProps}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className={cn(
                "h-8 w-full appearance-none rounded-xl bg-ink-2 pl-9 pr-3 text-sm text-paper placeholder:text-paper-muted",
                "focus:outline-none focus:ring-2 focus:ring-signal/60",
                "[&::-webkit-search-cancel-button]:hidden",
                // Under the redesign: the input's well, in the drawer as in the sheet.
                "redesign:rounded-[var(--input-radius,var(--radius-control))] redesign:border redesign:border-[color:var(--input-border)] redesign:bg-[color:var(--input-bg)] redesign:text-text redesign:placeholder:text-text-tertiary redesign:focus:ring-[color:var(--input-ring,var(--color-focus-ring))]",
              )}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </>
        ) : (
          <>
            <Input
              {...fieldProps}
              className={cn(
                "h-8 text-xs",
                big && "h-10 text-[13px]",
                hero && "h-12 px-4 text-[15px]",
              )}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            {!big && (
              <Tooltip label={t("music.add")}>
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className={cn(
                    "h-8 w-8 shrink-0 redesign:h-[var(--control-sm)] redesign:w-[var(--control-sm)] redesign:disabled:border-transparent redesign:disabled:bg-transparent",
                    big && "h-10 w-10 redesign:h-10 redesign:w-10",
                    hero && "h-12 w-12 redesign:h-12 redesign:w-12",
                  )}
                  disabled={busy || !query.trim()}
                  onClick={() => void submit()}
                >
                  <IconSwap off={Plus} on={PlusGlyph} kind="symbol" size="sm" offClassName="h-4 w-4" />
                </Button>
              </Tooltip>
            )}
          </>
        )}
      </div>
      {preview && (
        <MusicLinkPreview
          tracks={preview.tracks}
          nothingOn={nothingOn}
          hero={hero}
          onConfirm={confirmPreview}
          onCancel={() => {
            setPreview(null);
            setQuery("");
          }}
        />
      )}
      {showRecents && (
        <p className="px-1 pt-2 text-[12px] font-semibold text-text-secondary">{t("music.recent.title")}</p>
      )}
      {rows && rows.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={showRecents ? t("music.recent.title") : t("music.search.results")}
          className={cn("space-y-0.5", big && "pt-1")}
        >
          {rows.map((track, index) =>
            big ? (
              <StageResultRow
                key={`${track.videoId}-${index}`}
                id={`${listId}-${index}`}
                track={track}
                highlighted={index === highlight}
                hero={hero}
                enterHint={nothingOn ? t("music.search.enterPlay") : t("music.search.enterQueue")}
                canManage={canManage}
                onPick={() => addResolved(track)}
                onPlayNext={() => addResolved(track, true)}
                onHover={() => setHighlight(index)}
              />
            ) : (
            <li
              key={`${track.videoId}-${index}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              className={cn(
                "group/hit flex items-center gap-2 rounded-md px-1 py-1",
                big && "h-12 gap-2.5 rounded-lg p-1 pr-1.5 redesign:rounded-lg redesign:px-1",
                index === highlight
                  ? rail
                    ? "bg-ink-3"
                    : "bg-accent/12"
                  : rail
                    ? "hover:bg-ink-3"
                    : "hover:bg-surface-2",
                MUSIC_ROW_REDESIGN,
                index === highlight && MUSIC_ROW_HIGHLIGHT_REDESIGN,
              )}
            >
              <button
                type="button"
                className={cn("flex min-w-0 flex-1 items-center gap-2 text-left", big && "gap-2.5")}
                onClick={() => addResolved(track)}
                onMouseEnter={() => setHighlight(index)}
              >
                <span
                  className={cn(
                    "relative h-8 w-8 shrink-0 overflow-hidden rounded-md",
                    rail ? "bg-ink-3" : "bg-surface-2",
                    MUSIC_COVER_REDESIGN,
                    big && "h-10 w-10 rounded redesign:rounded",
                  )}
                >
                  {track.thumbnailUrl ? (
                    <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    big && "text-[13px] font-medium",
                    hero && "text-[14px]",
                    rail ? "text-paper" : "text-text",
                    MUSIC_TEXT_REDESIGN,
                  )}
                >
                  {track.title}
                </span>
                {track.durationMs ? (
                  <span
                    className={cn(
                      "shrink-0 tabular-nums text-[11px]",
                      rail ? "text-paper-muted" : "text-text-tertiary",
                      MUSIC_MUTED_REDESIGN,
                    )}
                  >
                    {formatMusicClock(track.durationMs)}
                  </span>
                ) : null}
              </button>
              {canManage && (
                <Tooltip label={t("music.playNext")}>
                  <button
                    type="button"
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-md opacity-0 group-hover/hit:opacity-100 group-focus-within/hit:opacity-100 [@media(hover:none)]:opacity-100",
                      rail
                        ? "text-paper-muted hover:bg-ink-2 hover:text-paper"
                        : "text-text-tertiary hover:bg-surface-3 hover:text-text",
                      MUSIC_ICON_REDESIGN,
                    )}
                    onClick={() => addResolved(track, true)}
                  >
                    <IconSwap off={ListStart} on={Queue} kind="symbol" size="sm" offClassName="h-4 w-4" />
                  </button>
                </Tooltip>
              )}
            </li>
            ),
          )}
        </ul>
      )}
      {notice && (
        <p
          role="status"
          className={cn("text-[11px]", rail ? "text-paper-muted" : "text-text-secondary", MUSIC_MUTED_REDESIGN)}
        >
          {notice}
        </p>
      )}
    </div>
  );
}

/** The cover at 16:9, which is what a YouTube result is, with its length on it. */
function StageCover({ track, wide }: { track: MusicResolved; wide: boolean }) {
  return (
    <span
      className={cn(
        "relative aspect-video shrink-0 overflow-hidden rounded-md bg-surface-2",
        wide ? "w-20" : "w-[72px]",
      )}
    >
      {track.thumbnailUrl ? (
        <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
      ) : null}
      {track.durationMs ? (
        <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] font-semibold leading-4 tabular-nums text-white">
          {formatMusicClock(track.durationMs)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A search result on the stage: the uploader under the title tells two
 * uploads of one song apart, a concert says it is long, and the highlighted
 * row says what Enter does with it.
 */
function StageResultRow({
  id,
  track,
  highlighted,
  hero,
  enterHint,
  canManage,
  onPick,
  onPlayNext,
  onHover,
}: {
  id: string;
  track: MusicResolved;
  highlighted: boolean;
  hero: boolean;
  enterHint: string;
  canManage: boolean;
  onPick: () => void;
  onPlayNext: () => void;
  onHover: () => void;
}) {
  const { t } = useTranslation();
  const long = (track.durationMs ?? 0) > MUSIC_LONG_VIDEO_MS;
  return (
    <li
      id={id}
      role="option"
      aria-selected={highlighted}
      className={cn(
        "group/hit flex items-center gap-2 rounded-lg p-1.5 pr-2 hover:bg-surface-2",
        highlighted && "bg-surface-2",
        MUSIC_ROW_REDESIGN,
        highlighted && MUSIC_ROW_HIGHLIGHT_REDESIGN,
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onPick}
        onMouseEnter={onHover}
      >
        <StageCover track={track} wide={hero} />
        <span className="min-w-0 flex-1">
          <span
            className={cn("block truncate font-medium text-text", hero ? "text-[14px]" : "text-[13px]")}
            title={track.title}
          >
            {track.title}
          </span>
          {track.channel || long ? (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-text-tertiary">
              {track.channel ? <span className="min-w-0 truncate">{track.channel}</span> : null}
              {long ? (
                <span className="shrink-0 rounded bg-surface-3 px-1.5 text-[11px] font-medium leading-[18px] text-text-secondary">
                  {t("music.search.long")}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        {highlighted ? (
          <span
            data-music-enter-hint=""
            className="hidden shrink-0 items-center gap-1.5 text-[12px] text-text-tertiary [@media(hover:hover)]:flex"
          >
            <kbd className="rounded border border-[color:var(--card-border)] px-1 font-sans text-[11px] leading-[18px] text-text-secondary">
              Enter
            </kbd>
            {enterHint}
          </span>
        ) : null}
      </button>
      {canManage && (
        <Tooltip label={t("music.playNext")}>
          <button
            type="button"
            aria-label={t("music.playNext")}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-0 hover:bg-surface-3 hover:text-text group-hover/hit:opacity-100 group-focus-within/hit:opacity-100 [@media(hover:none)]:opacity-100",
              MUSIC_ICON_REDESIGN,
            )}
            onClick={onPlayNext}
          >
            <IconSwap off={ListStart} on={Queue} kind="symbol" size="sm" offClassName="h-4 w-4" />
          </button>
        </Tooltip>
      )}
    </li>
  );
}

/**
 * A pasted link on the stage, before it goes in: one card with the cover,
 * the title and the length, or the playlist's size, and one action.
 */
function MusicLinkPreview({
  tracks,
  nothingOn,
  hero,
  onConfirm,
  onCancel,
}: {
  tracks: MusicResolved[];
  nothingOn: boolean;
  hero: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [first] = tracks;
  if (!first) {
    return null;
  }
  const many = tracks.length > 1;
  return (
    <div
      data-music-link-preview=""
      className="mt-2 flex flex-col gap-2 rounded-xl bg-surface-2 p-2 shadow-[inset_0_0_0_1px_var(--card-border)]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <StageCover track={first} wide={hero} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[14px] font-semibold leading-snug text-text" title={first.title}>
            {first.title}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-text-tertiary">
            {many ? t("music.preview.tracks", { count: tracks.length }) : first.channel ?? ""}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("music.preview.cancel")}
        </Button>
        {/* Lime only when nothing is on: with a track playing, the player's
            pause is the screen's one lime button. */}
        <Button
          type="button"
          size="sm"
          variant={nothingOn ? "default" : "secondary"}
          onClick={onConfirm}
        >
          {many
            ? t("music.preview.queueMany", { count: tracks.length })
            : nothingOn
              ? t("music.preview.play")
              : t("music.preview.queue")}
        </Button>
      </div>
    </div>
  );
}
