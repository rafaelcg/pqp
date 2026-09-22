import { parseMusicInput, type MusicResolved } from "@pqp/shared";
import { ListStart, Plus, Search } from "lucide-react";
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
import { useTranslation } from "@/lib/i18n";
import {
  addTrack,
  addTracks,
  getMusicSnapshot,
  moveTrackTo,
  musicSessionChannelId,
  type MusicAddOutcome,
} from "@/lib/music-store";
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
  canManage = false,
  autoFocus = false,
  onQueryActive,
  onEmptyEscape,
}: {
  compact?: boolean;
  /** Member-list field: icon in the box, paper tokens, square result thumbs. */
  chrome?: "default" | "rail";
  canManage?: boolean;
  autoFocus?: boolean;
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
  const rail = chrome === "rail";
  const lastQueried = useRef("");
  const runId = useRef(0);

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
      try {
        const { track, tracks } = await resolveMusic(text);
        if (room === null || musicSessionChannelId() !== room) {
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
        if (error instanceof ApiError) {
          if (error.status === 404) {
            setNotice(t("music.error.notFound"));
          } else if (error.status === 400) {
            setNotice(t("music.error.unsupported"));
          } else {
            setNotice(t("music.error.upstream"));
          }
        } else {
          setNotice(t("music.error.upstream"));
        }
      }
    },
    [t, tellOutcome],
  );

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
          setResults([]);
          setResultsFor(text);
          setNotice(t("music.error.notFound"));
        } else if (error instanceof ApiError && error.status === 400) {
          setNotice(t("music.error.unsupported"));
        } else {
          setNotice(t("music.error.upstream"));
        }
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
  }, [addResolved, busy, highlight, query, results, resultsFor, runResolve, runSearch]);

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
    if (event.key === "ArrowDown" && results && results.length > 0) {
      event.preventDefault();
      setHighlight((index) => Math.min(results.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp" && results && results.length > 0) {
      event.preventDefault();
      setHighlight((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
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
    "aria-expanded": results !== null,
    "aria-controls": listId,
    "aria-autocomplete": "list" as const,
    "aria-activedescendant":
      results && results[highlight] ? `${listId}-${highlight}` : undefined,
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
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-paper-muted"
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
              )}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </>
        ) : (
          <>
            <Input
              {...fieldProps}
              className="h-8 text-xs"
              onChange={(event) => onQueryChange(event.target.value)}
            />
            <Tooltip label={t("music.add")}>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="h-8 w-8 shrink-0"
                disabled={busy || !query.trim()}
                onClick={() => void submit()}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </Tooltip>
          </>
        )}
      </div>
      {results && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("music.search.results")}
          className="space-y-0.5"
        >
          {results.map((track, index) => (
            <li
              key={`${track.videoId}-${index}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              className={cn(
                "group/hit flex items-center gap-2 rounded-md px-1 py-1",
                index === highlight
                  ? rail
                    ? "bg-ink-3"
                    : "bg-accent/12"
                  : rail
                    ? "hover:bg-ink-3"
                    : "hover:bg-surface-2",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => addResolved(track)}
                onMouseEnter={() => setHighlight(index)}
              >
                <span
                  className={cn(
                    "relative h-8 w-8 shrink-0 overflow-hidden rounded-md",
                    rail ? "bg-ink-3" : "bg-surface-2",
                  )}
                >
                  {track.thumbnailUrl ? (
                    <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    rail ? "text-paper" : "text-text",
                  )}
                >
                  {track.title}
                </span>
                {track.durationMs ? (
                  <span
                    className={cn(
                      "shrink-0 tabular-nums text-[11px]",
                      rail ? "text-paper-muted" : "text-text-tertiary",
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
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-md opacity-0 group-hover/hit:opacity-100 group-focus-within/hit:opacity-100",
                      rail
                        ? "text-paper-muted hover:bg-ink-2 hover:text-paper"
                        : "text-text-tertiary hover:bg-surface-3 hover:text-text",
                    )}
                    onClick={() => addResolved(track, true)}
                  >
                    <ListStart className="h-4 w-4" aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p
          role="status"
          className={cn("text-[11px]", rail ? "text-paper-muted" : "text-text-secondary")}
        >
          {notice}
        </p>
      )}
    </div>
  );
}
