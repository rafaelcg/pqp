import { Archive, Download, MessageCircle, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Story, StoryViewerRow } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { fetchStoryViewers } from "@/lib/stories/api";
import { onStoriesSignal } from "@/lib/stories/events";
import {
  STORY_REACTION_GLYPH,
  formatStoryDuration,
  formatStoryLeft,
} from "@/lib/stories/format";
import { cn } from "@/lib/utils";

/**
 * Who saw the author's own story, with each viewer's reaction and whether
 * they replied. The author only; nobody else ever sees this list (design
 * decision 15). A panel inside the card, risen over the shrunken story.
 *
 * Refreshes on the `own` frame the server sends after a new batch of views
 * (throttled to one per 10 s), so an open sheet keeps up without a poll.
 */

interface StoryViewersSheetProps {
  story: Story;
  open: boolean;
  now: number;
  bauServers: { serverId: string; serverName: string }[];
  onSaveToBau: (serverId: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function StoryViewersSheet({
  story,
  open,
  now,
  bauServers,
  onSaveToBau,
  onDelete,
  onClose,
}: StoryViewersSheetProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<StoryViewerRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState({
    views: story.own?.viewCount ?? 0,
    reactions: story.own?.reactionCount ?? 0,
  });
  const [loading, setLoading] = useState(false);
  // Every request gets a ticket. A refresh (the first page again) takes a new
  // generation, so a "Ver mais" page or an older refresh still in flight can
  // never append to, or overwrite, the list that replaced it.
  const generation = useRef(0);
  const latest = useRef(0);

  const load = useCallback(
    async (next: string | null) => {
      if (!next) {
        generation.current += 1;
      }
      const ticket = ++latest.current;
      const forGeneration = generation.current;
      setLoading(true);
      try {
        const page = await fetchStoryViewers(story.id, next);
        if (forGeneration !== generation.current || (!next && ticket !== latest.current)) {
          return;
        }
        setRows((current) => (next ? [...current, ...page.viewers] : page.viewers));
        setCursor(page.nextCursor);
        setCounts({ views: page.viewCount, reactions: page.reactionCount });
      } catch {
        // Keep what is on screen; the next frame or reopening asks again.
      } finally {
        if (ticket === latest.current) {
          setLoading(false);
        }
      }
    },
    [story.id],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    void load(null);
    return onStoriesSignal((signal) => {
      if (signal.kind === "refresh" || signal.frame.scope === "own") {
        void load(null);
      }
    });
  }, [open, load]);

  const left = formatStoryLeft(story.expiresAt, now);
  const canDownload = Boolean(story.media?.url);

  return (
    <div
      className="story-sheet absolute inset-x-0 bottom-0 z-20 flex max-h-[62%] flex-col rounded-t-[14px] border-t border-border bg-surface-1 text-text"
      aria-hidden={!open}
      inert={!open || undefined}
      data-story-viewers=""
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t("stories.viewers.back")}
        className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      />
      <div className="px-4 pt-2">
        <p className="font-display text-lg font-extrabold leading-tight">
          {t("stories.viewers.title", { count: counts.views })}
          <span className="ml-2 align-middle text-xs font-medium text-text-tertiary">
            {t("stories.viewers.meta", { reactions: counts.reactions, left })}
          </span>
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {bauServers.map((server) => (
            <Button
              key={server.serverId}
              size="sm"
              variant="secondary"
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={() => onSaveToBau(server.serverId)}
              title={server.serverName}
            >
              <Archive className="h-3.5 w-3.5" aria-hidden />
              {bauServers.length > 1
                ? `${t("stories.own.saveToBau")} · ${server.serverName}`
                : t("stories.own.saveToBau")}
            </Button>
          ))}
          {canDownload && (
            <Button
              asChild
              size="sm"
              variant="secondary"
              className="h-7 rounded-full px-2.5 text-xs"
            >
              <a href={story.media!.url} target="_blank" rel="noreferrer" download>
                <Download className="h-3.5 w-3.5" aria-hidden />
                {t("stories.own.download")}
              </a>
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            className="h-7 rounded-full px-2.5 text-xs"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            {t("stories.own.delete")}
          </Button>
        </div>
        <p className="pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-text-tertiary">
          {t("stories.viewers.heading")}
        </p>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {rows.length === 0 && !loading && (
          <li className="px-2 py-4 text-sm text-text-tertiary">{t("stories.viewers.none")}</li>
        )}
        {rows.map((row) => (
          <li
            key={row.user.id}
            data-story-viewer-row={row.user.displayName}
            className="flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5"
          >
            <UserAvatar
              name={row.user.displayName}
              avatarUrl={row.user.avatarUrl}
              rounded="full"
              className="h-8 w-8"
              fallbackClassName="bg-surface-3 text-xs text-text"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{row.user.displayName}</span>
              <span className="block text-xs text-text-tertiary">
                {formatStoryDuration(now - Date.parse(row.viewedAt))}
                {row.replied ? ` · ${t("stories.viewers.replied")}` : ""}
              </span>
            </span>
            {row.replied && !row.reaction && (
              <MessageCircle className="h-4 w-4 text-accent" aria-hidden />
            )}
            {row.reaction && (
              <span
                className={cn(
                  row.reaction === "gg"
                    ? "rounded-md bg-accent px-1.5 py-1 font-display text-[11px] font-black leading-none text-on-accent"
                    : "text-xl leading-none",
                )}
              >
                {STORY_REACTION_GLYPH[row.reaction]}
              </span>
            )}
          </li>
        ))}
        {cursor && (
          <li className="px-2 pt-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => void load(cursor)}
            >
              {t("stories.viewers.loadMore")}
            </Button>
          </li>
        )}
      </ul>
    </div>
  );
}
