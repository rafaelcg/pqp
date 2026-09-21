import { GripVertical, MoreHorizontal } from "lucide-react";
import { useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import type { MusicTrack } from "@pqp/shared";
import { ContextMenu } from "@/components/ui/context-menu";
import { Menu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import { moveInQueue, moveTrackTo, removeFromQueue } from "@/lib/music-store";
import { cn } from "@/lib/utils";
import { queueRowMenuItems } from "@/components/voice/music-extras";
import { formatMusicClock, lookupAddedBy } from "@/components/voice/music-now-playing";

export function trackSourceHref(track: Pick<MusicTrack, "sourceUrl" | "videoId">): string {
  return track.sourceUrl ?? `https://www.youtube.com/watch?v=${track.videoId}`;
}

export function trackSourceIsSpotify(track: Pick<MusicTrack, "sourceUrl">): boolean {
  return (track.sourceUrl ?? "").includes("spotify");
}

/**
 * The queue: scrolls, and reorders by drag. Keyboard is Alt+arrow on a
 * focused row. Hover and right-click share play-next, remove, and the source.
 */
export function MusicQueueList({
  queue,
  voiceState,
  canManage,
  tone = "rail",
}: {
  queue: MusicTrack[];
  voiceState: VoiceState;
  canManage: boolean;
  tone?: "rail" | "composer";
}) {
  const selfUserId = voiceState.self?.userId ?? null;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const finish = () => {
    setDragId(null);
    setDropIndex(null);
  };

  return (
    <ol
      data-music-queue=""
      className="space-y-0.5"
      onDragOver={(event) => {
        if (dragId) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (dragId && dropIndex !== null) {
          moveTrackTo(dragId, dropIndex);
        }
        finish();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropIndex(null);
        }
      }}
    >
      {queue.map((track, index) => (
        <QueueRow
          key={track.id}
          track={track}
          index={index}
          last={index === queue.length - 1}
          mine={track.addedByUserId === selfUserId}
          canManage={canManage}
          voiceState={voiceState}
          dragging={dragId === track.id}
          dropBefore={dropIndex === index}
          dropAfter={dropIndex === index + 1 && index === queue.length - 1}
          tone={tone}
          onDragStart={(event) => {
            if (!canManage) {
              event.preventDefault();
              return;
            }
            setDragId(track.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", track.id);
          }}
          onDragEnd={finish}
          onDragOver={(event) => {
            if (!dragId) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            setDropIndex(after ? index + 1 : index);
          }}
        />
      ))}
    </ol>
  );
}

function QueueRow({
  track,
  index,
  last,
  mine,
  canManage,
  voiceState,
  dragging,
  dropBefore,
  dropAfter,
  tone,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  track: MusicTrack;
  index: number;
  last: boolean;
  mine: boolean;
  canManage: boolean;
  voiceState: VoiceState;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  tone: "rail" | "composer";
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
}) {
  const { t } = useTranslation();
  const addedBy = lookupAddedBy(voiceState, track.addedByUserId, track.addedByName);
  const href = trackSourceHref(track);
  const openLabel = trackSourceIsSpotify(track) ? t("music.openSource") : t("music.openYoutube");
  const canRemove = canManage || mine;
  const composer = tone === "composer";
  const menuItems = useMemo(
    () =>
      queueRowMenuItems({
        t,
        canManage,
        canRemove,
        href,
        openLabel,
        onPlayNext: () => moveTrackTo(track.id, 0),
        onRemove: () => removeFromQueue(track.id),
      }),
    [t, canManage, canRemove, href, openLabel, track.id],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (!canManage || !event.altKey) {
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index > 0) {
        moveInQueue(track.id, -1);
      }
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!last) {
        moveInQueue(track.id, 1);
      }
    }
  };

  return (
    <ContextMenu items={menuItems}>
      <li
        draggable={canManage}
        tabIndex={canManage ? 0 : undefined}
        data-queue-row={track.id}
        data-drop={dropBefore ? "before" : dropAfter ? "after" : undefined}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onKeyDown={onKeyDown}
        className={cn(
          "group/row relative flex items-center gap-2 rounded-md px-1 py-1",
          composer ? "hover:bg-surface-3" : "hover:bg-ink-3",
          dragging && "opacity-40",
          dropBefore &&
            "before:absolute before:inset-x-1 before:-top-[2px] before:h-[2px] before:rounded-full before:bg-accent",
          dropAfter &&
            "after:absolute after:inset-x-1 after:-bottom-[2px] after:h-[2px] after:rounded-full after:bg-accent",
        )}
      >
        <span
          className={cn(
            "relative h-8 w-8 shrink-0 overflow-hidden rounded-md",
            composer ? "bg-surface-3" : "bg-ink-3",
          )}
        >
          {track.thumbnailUrl ? (
            <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : null}
          {canManage ? (
            <span
              className={cn(
                "absolute inset-0 flex cursor-grab items-center justify-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 active:cursor-grabbing",
                composer ? "bg-surface/70 text-text" : "bg-ink/70 text-paper",
              )}
              aria-hidden="true"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </span>
          ) : null}
        </span>
        <span
          className={cn("min-w-0 flex-1 truncate text-sm", composer ? "text-text" : "text-paper")}
          title={track.title}
        >
          {track.title}
        </span>
        <Tooltip label={t("music.addedBy", { name: addedBy.name })}>
          <span className="shrink-0">
            <UserAvatar
              name={addedBy.name}
              avatarUrl={addedBy.avatarUrl}
              className="h-4 w-4"
              fallbackClassName={
                composer
                  ? "bg-surface-3 text-[8px] text-text"
                  : "bg-ink-3 text-[8px] text-paper"
              }
              rounded="full"
            />
          </span>
        </Tooltip>
        {track.durationMs ? (
          <span
            className={cn(
              "shrink-0 text-[11px] tabular-nums",
              composer ? "text-text-secondary" : "text-paper-muted",
            )}
          >
            {formatMusicClock(track.durationMs)}
          </span>
        ) : null}
        <span className="flex w-8 shrink-0 items-center justify-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          <Menu items={menuItems} align="end" side="bottom">
            <button
              type="button"
              data-queue-row-menu=""
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-md",
                composer
                  ? "text-text-tertiary hover:bg-surface-2 hover:text-text"
                  : "text-paper-muted hover:bg-ink-2 hover:text-paper",
              )}
              aria-label={t("music.overflow")}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
          </Menu>
        </span>
      </li>
    </ContextMenu>
  );
}
