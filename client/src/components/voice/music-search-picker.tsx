import { parseMusicInput, type MusicResolved } from "@pqp/shared";
import { ListStart, Plus } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
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
  variant = "queue",
  canManage = false,
}: {
  compact?: boolean;
  variant?: "start" | "queue";
  canManage?: boolean;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<MusicResolved[] | null>(null);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 2_500);
    return () => clearTimeout(timer);
  }, [notice]);

  const tellOutcome = useCallback(
    (outcome: MusicAddOutcome) => {
      if (outcome === "queued" || outcome === "playing") {
        setNotice(t("music.queued"));
        setQuery("");
        setResults(null);
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
      try {
        const { tracks } = await searchMusic(text);
        if (room === null || musicSessionChannelId() !== room) {
          return;
        }
        setResults(tracks.slice(0, 5));
        setHighlight(0);
        if (tracks.length === 0) {
          setNotice(t("music.error.notFound"));
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          setResults([]);
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

  const submit = useCallback(async () => {
    const text = query.trim();
    if (!text || busy) {
      return;
    }
    if (results && results.length > 0) {
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
        await runSearch(text);
      }
    } finally {
      setBusy(false);
    }
  }, [addResolved, busy, highlight, query, results, runResolve, runSearch]);

  const placeholder =
    variant === "start"
      ? t("music.placeholder.start")
      : compact
        ? t("music.placeholder.short")
        : t("music.placeholder");

  return (
    <form
      data-music-search=""
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1.5">
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (results) {
              setResults(null);
            }
          }}
          placeholder={placeholder}
          aria-label={t("music.placeholder")}
          role="combobox"
          aria-expanded={results !== null}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            results && results[highlight] ? `${listId}-${highlight}` : undefined
          }
          className="h-8 text-xs"
          disabled={busy}
          onKeyDown={(event) => {
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
            if (event.key === "Escape" && results) {
              event.preventDefault();
              setResults(null);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <Tooltip label={t("music.add")}>
          <Button
            type="submit"
            size="icon"
            variant="secondary"
            className="h-8 w-8 shrink-0"
            disabled={busy || !query.trim()}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </Button>
        </Tooltip>
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
                "flex items-center gap-1 rounded-[var(--radius-control)] px-1 py-1",
                index === highlight ? "bg-accent/12" : "hover:bg-surface-2",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => addResolved(track)}
                onMouseEnter={() => setHighlight(index)}
              >
                <span className="relative h-9 w-16 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-2">
                  {track.thumbnailUrl ? (
                    <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[12px] leading-tight text-text">
                    {track.title}
                  </span>
                  {track.durationMs ? (
                    <span className="tabular-nums text-[11px] text-text-tertiary">
                      {formatMusicClock(track.durationMs)}
                    </span>
                  ) : null}
                </span>
              </button>
              {canManage && (
                <Tooltip label={t("music.playNext")}>
                  <button
                    type="button"
                    className="rounded-[var(--radius-control)] p-1 text-text-tertiary hover:bg-surface-3 hover:text-text"
                    onClick={() => addResolved(track, true)}
                  >
                    <ListStart className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p role="status" className="text-[11px] text-text-secondary">
          {notice}
        </p>
      )}
    </form>
  );
}
