import { Music, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, resolveMusic } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { addTrack, addTracks, musicSessionChannelId } from "@/lib/music-store";

/**
 * The add box: a YouTube link, a Spotify track link, or a search. Resolved
 * by the API, then written to the room. Shared by the popover on the call
 * bar and the player at the bottom of the sidebar, so both say the same
 * things when a link is bad.
 */
export function MusicAddForm({
  compact = false,
  variant = "queue",
}: {
  compact?: boolean;
  /** `start`: nothing is on yet, so the box says so and wears a note. */
  variant?: "start" | "queue";
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(null), 2_500);
    return () => clearTimeout(timer);
  }, [notice]);

  const submit = useCallback(async () => {
    const text = query.trim();
    if (!text || busy) {
      return;
    }
    setBusy(true);
    setNotice(null);
    // The room this was typed for. A resolve can take twenty seconds, and
    // a person can leave for another call meanwhile; the answer must not
    // land in that one.
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
        }
      } else {
        const outcome = addTrack(track);
        if (outcome === "queued") {
          setNotice(t("music.queued"));
        } else if (outcome === "full") {
          setNotice(t("music.full"));
        }
        if (outcome !== "full") {
          setQuery("");
        }
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
    } finally {
      setBusy(false);
    }
  }, [busy, query, t]);

  return (
    <form
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-1.5">
        {variant === "start" && (
          <Music className="h-4 w-4 shrink-0 text-signal" aria-hidden="true" />
        )}
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            variant === "start"
              ? t("music.placeholder.start")
              : compact
                ? t("music.placeholder.short")
                : t("music.placeholder")
          }
          aria-label={t("music.placeholder")}
          className="h-8 text-xs"
          disabled={busy}
          onKeyDown={(event) => {
            // The window-level shortcut handlers run in the capture phase;
            // submitting here keeps Enter meaning "add" whatever they do.
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {compact ? (
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
        ) : (
          <Button type="submit" size="sm" disabled={busy || !query.trim()}>
            {t("music.add")}
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="text-[11px] text-paper-muted">
          {notice}
        </p>
      )}
    </form>
  );
}
