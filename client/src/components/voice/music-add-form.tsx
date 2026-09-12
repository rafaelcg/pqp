import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { ApiError, resolveMusic } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { addTrack } from "@/lib/music-store";

/**
 * The add box: a YouTube link, a Spotify track link, or a search. Resolved
 * by the API, then written to the room. Shared by the popover on the call
 * bar and the player at the bottom of the sidebar, so both say the same
 * things when a link is bad.
 */
export function MusicAddForm({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const text = query.trim();
    if (!text || busy) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const { track } = await resolveMusic(text);
      const outcome = addTrack(track);
      if (outcome === "queued") {
        setNotice(t("music.queued"));
      } else if (outcome === "full") {
        setNotice(t("music.full"));
      }
      if (outcome !== "full") {
        setQuery("");
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
      <div className="flex gap-1.5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={compact ? t("music.placeholder.short") : t("music.placeholder")}
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
