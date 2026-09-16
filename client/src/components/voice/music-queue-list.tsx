import { ChevronDown, ChevronUp, ExternalLink, GripVertical, ListStart, X } from "lucide-react";
import { useState, type DragEvent } from "react";
import type { MusicTrack } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import { moveInQueue, moveTrackTo, removeFromQueue } from "@/lib/music-store";
import { cn } from "@/lib/utils";
import { formatMusicClock, lookupAddedBy } from "@/components/voice/music-now-playing";

export function trackSourceHref(track: Pick<MusicTrack, "sourceUrl" | "videoId">): string {
  return track.sourceUrl ?? `https://www.youtube.com/watch?v=${track.videoId}`;
}

export function trackSourceIsSpotify(track: Pick<MusicTrack, "sourceUrl">): boolean {
  return (track.sourceUrl ?? "").includes("spotify");
}

/**
 * The queue: scrolls past six rows, and reorders by drag.
 *
 * Native HTML5 drag, like the sidebar's voice occupants
 * (`lib/voice-occupant-dnd.ts`). While a row is dragged, the pointer's
 * position over each row decides whether it would land before or after it,
 * and a line is drawn there: the "drop preview". The write is one
 * `moveTrackTo` on drop, so the room sees one reorder and not a scrub.
 * The up/down buttons stay for the keyboard.
 */
export function MusicQueueList({
  queue,
  voiceState,
  canManage,
}: {
  queue: MusicTrack[];
  voiceState: VoiceState;
  canManage: boolean;
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
      className="space-y-0.5 pr-0.5"
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
  onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLLIElement>) => void;
}) {
  const { t } = useTranslation();
  const addedBy = lookupAddedBy(voiceState, track.addedByUserId, track.addedByName);
  const href = trackSourceHref(track);
  const openLabel = trackSourceIsSpotify(track) ? t("music.openSource") : t("music.openYoutube");
  const canRemove = canManage || mine;

  return (
    <li
      draggable={canManage}
      data-queue-row={track.id}
      data-drop={dropBefore ? "before" : dropAfter ? "after" : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      className={cn(
        "group/row relative flex items-center gap-1 rounded-[var(--radius-control)] px-1 py-1 hover:bg-surface-2",
        canManage && "cursor-grab active:cursor-grabbing",
        mine && "bg-surface-2/60",
        dragging && "opacity-40",
        dropBefore &&
          "before:absolute before:inset-x-1 before:-top-[2px] before:h-[2px] before:rounded-full before:bg-accent",
        dropAfter &&
          "after:absolute after:inset-x-1 after:-bottom-[2px] after:h-[2px] after:rounded-full after:bg-accent",
      )}
    >
      {canManage && (
        <GripVertical
          className="h-3 w-3 shrink-0 text-text-tertiary/60 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
          aria-hidden="true"
        />
      )}
      <span className="w-4 shrink-0 text-right tabular-nums text-text-tertiary">{index + 1}</span>
      <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-3">
        {track.thumbnailUrl ? (
          <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-text" title={track.title}>
          {track.title}
        </span>
        <span className="flex items-center gap-1 text-[10px] text-text-tertiary">
          <UserAvatar
            name={addedBy.name}
            avatarUrl={addedBy.avatarUrl}
            className="h-3.5 w-3.5"
            fallbackClassName="bg-accent-soft text-[8px] text-on-accent-soft"
            rounded="full"
          />
          <span className="truncate">{addedBy.name}</span>
          {track.durationMs ? (
            <span className="tabular-nums">· {formatMusicClock(track.durationMs)}</span>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
        {canManage && (
          <Tooltip label={t("music.playNext")}>
            <button
              type="button"
              onClick={() => moveTrackTo(track.id, 0)}
              className="rounded-[var(--radius-control)] p-0.5 text-text-tertiary hover:bg-surface-3 hover:text-text"
            >
              <ListStart className="h-3 w-3" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        {canManage && (
          <>
            <Tooltip label={t("music.moveUp")}>
              <button
                type="button"
                disabled={index === 0}
                onClick={() => moveInQueue(track.id, -1)}
                className="rounded-[var(--radius-control)] p-0.5 text-text-tertiary hover:bg-surface-3 hover:text-text focus-visible:opacity-100 disabled:opacity-30"
              >
                <ChevronUp className="h-3 w-3" aria-hidden="true" />
              </button>
            </Tooltip>
            <Tooltip label={t("music.moveDown")}>
              <button
                type="button"
                disabled={last}
                onClick={() => moveInQueue(track.id, 1)}
                className="rounded-[var(--radius-control)] p-0.5 text-text-tertiary hover:bg-surface-3 hover:text-text focus-visible:opacity-100 disabled:opacity-30"
              >
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </button>
            </Tooltip>
          </>
        )}
        {canRemove && (
          <Tooltip label={t("music.remove")}>
            <button
              type="button"
              onClick={() => removeFromQueue(track.id)}
              className="rounded-[var(--radius-control)] p-0.5 text-text-tertiary hover:bg-surface-3 hover:text-text"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        <Tooltip label={openLabel}>
          <Button asChild variant="ghost" size="icon" className="h-6 w-6 text-text-tertiary">
            <a href={href} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </Button>
        </Tooltip>
      </span>
    </li>
  );
}
