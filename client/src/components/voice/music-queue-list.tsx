import { DotsSixVertical, DotsThree } from "@phosphor-icons/react";
import { ChevronDown, ChevronUp, GripVertical, Infinity as InfinityIcon, MoreHorizontal } from "lucide-react";
import { IconSwap } from "@/components/ui/icon";
import {
  MUSIC_COVER_REDESIGN,
  MUSIC_ICON_REDESIGN,
  MUSIC_MUTED_REDESIGN,
  MUSIC_ROW_REDESIGN,
  MUSIC_TEXT_REDESIGN,
} from "@/components/voice/music-classes";
import { useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import type { MusicTrack } from "@pqp/shared";
import { ContextMenu } from "@/components/ui/context-menu";
import { Menu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import { useRedesign } from "@/lib/redesign";
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
  columns = 1,
}: {
  queue: MusicTrack[];
  voiceState: VoiceState;
  canManage: boolean;
  /** `stage` is the call stage's queue: taller rows with who asked and the length. */
  tone?: "rail" | "composer" | "stage";
  /**
   * The stage's queue under a wide sideways card: two columns, filled down
   * the first before the second, so the order still reads top to bottom.
   */
  columns?: 1 | 2;
}) {
  const selfUserId = voiceState.self?.userId ?? null;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const finish = () => {
    setDragId(null);
    setDropIndex(null);
  };

  const grid = tone === "stage" && columns === 2 && queue.length > 1;
  const Row = tone === "stage" ? StageQueueRow : QueueRow;
  return (
    <ol
      data-music-queue=""
      data-music-queue-columns={grid ? 2 : undefined}
      className={cn(
        grid ? "grid grid-flow-col grid-cols-2 gap-x-2 gap-y-0.5" : "space-y-0.5",
      )}
      style={grid ? { gridTemplateRows: `repeat(${Math.ceil(queue.length / 2)}, auto)` } : undefined}
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
        <Row
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
          tone={tone === "stage" ? "composer" : tone}
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
  const redesign = useRedesign();
  const menuItems = useMemo(
    () =>
      queueRowMenuItems({
        t,
        canManage,
        canRemove,
        href,
        openLabel,
        // Under the redesign no item repeats another: the first song already
        // plays next, and for the second "Subir" would be "Tocar a seguir".
        onPlayNext: !redesign || index > 0 ? () => moveTrackTo(track.id, 0) : undefined,
        onRemove: () => removeFromQueue(track.id),
        onMoveUp: redesign && index > 1 ? () => moveInQueue(track.id, -1) : undefined,
        onMoveDown: redesign && !last ? () => moveInQueue(track.id, 1) : undefined,
      }),
    [t, canManage, canRemove, href, openLabel, track.id, redesign, index, last],
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
          MUSIC_ROW_REDESIGN,
          "redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-inset redesign:focus-visible:ring-focus-ring",
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
            MUSIC_COVER_REDESIGN,
          )}
        >
          {track.thumbnailUrl ? (
            <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : null}
          {canManage ? (
            <span
              className={cn(
                "absolute inset-0 flex cursor-grab items-center justify-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 active:cursor-grabbing redesign:[@media(hover:none)]:hidden",
                composer ? "bg-surface/70 text-text" : "bg-ink/70 text-paper",
                "redesign:bg-black/45 redesign:text-white",
              )}
              aria-hidden="true"
            >
              <IconSwap off={GripVertical} on={DotsSixVertical} kind="symbol" size="sm" offClassName="h-3.5 w-3.5" />
            </span>
          ) : null}
        </span>
        <span
          className={cn("min-w-0 flex-1 truncate text-sm", composer ? "text-text" : "text-paper", MUSIC_TEXT_REDESIGN)}
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
                  ? "bg-surface-3 text-[8px] text-text redesign:text-[9px] redesign:bg-[color:var(--card-bg)] redesign:ring-1 redesign:ring-[color:var(--card-border)]"
                  : "bg-ink-3 text-[8px] text-paper redesign:text-[9px] redesign:bg-[color:var(--card-bg)] redesign:text-text redesign:ring-1 redesign:ring-[color:var(--card-border)]"
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
              MUSIC_MUTED_REDESIGN,
            )}
          >
            {formatMusicClock(track.durationMs)}
          </span>
        ) : null}
        <span className="flex w-8 shrink-0 items-center justify-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 redesign:[@media(hover:none)]:opacity-100">
          <Menu items={menuItems} align="end" side="bottom">
            <button
              type="button"
              data-queue-row-menu=""
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-md",
                composer
                  ? "text-text-tertiary hover:bg-surface-2 hover:text-text"
                  : "text-paper-muted hover:bg-ink-2 hover:text-paper",
                MUSIC_ICON_REDESIGN,
              )}
              aria-label={t("music.overflow")}
            >
              <IconSwap off={MoreHorizontal} on={DotsThree} kind="symbol" size="sm" offClassName="h-4 w-4" />
            </button>
          </Menu>
        </span>
      </li>
    </ContextMenu>
  );
}

/**
 * A ROW OF THE STAGE'S QUEUE.
 *
 * 48px, the cover nested in the row's corner (8px row, 4px inset, 4px cover),
 * the title over who asked for it, and the length on the right. Hover or
 * focus swaps the length for the row's actions: up, down and the menu for
 * whoever manages the music, the menu alone for everybody else, whose menu
 * only has what they may do (open it, and take out their own songs). A phone
 * has no hover, so the menu is always there.
 */
function StageQueueRow({
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
  const menuItems = useMemo(
    () =>
      queueRowMenuItems({
        t,
        canManage,
        canRemove,
        href,
        openLabel,
        onPlayNext: index > 0 ? () => moveTrackTo(track.id, 0) : undefined,
        onRemove: () => removeFromQueue(track.id),
        onMoveUp: index > 1 ? () => moveInQueue(track.id, -1) : undefined,
        onMoveDown: !last ? () => moveInQueue(track.id, 1) : undefined,
      }),
    [t, canManage, canRemove, href, openLabel, track.id, index, last],
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

  const action =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-[color:var(--button-ghost-hover)] hover:text-text disabled:pointer-events-none disabled:opacity-40";

  return (
    <ContextMenu items={menuItems}>
      <li
        draggable={canManage}
        // A stop for everybody, not only whoever manages the music: the
        // actions are drawn on hover or focus inside the row, so without it
        // a keyboard never reaches the row's menu.
        tabIndex={0}
        data-queue-row={track.id}
        data-drop={dropBefore ? "before" : dropAfter ? "after" : undefined}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onKeyDown={onKeyDown}
        className={cn(
          "group/row relative flex h-12 min-w-0 items-center gap-2.5 rounded-lg p-1 pr-1.5",
          "hover:bg-[color:var(--menu-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring",
          dragging && "opacity-40",
          dropBefore &&
            "before:absolute before:inset-x-1 before:-top-[2px] before:h-[2px] before:rounded-full before:bg-accent",
          dropAfter &&
            "after:absolute after:inset-x-1 after:-bottom-[2px] after:h-[2px] after:rounded-full after:bg-accent",
        )}
      >
        <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded bg-[color:var(--button-ghost-hover)]">
          {track.thumbnailUrl ? (
            <img src={track.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : null}
          {canManage ? (
            <span
              className="absolute inset-0 flex cursor-grab items-center justify-center bg-black/45 text-white opacity-0 group-hover/row:opacity-100 active:cursor-grabbing [@media(hover:none)]:hidden"
              aria-hidden="true"
            >
              <IconSwap off={GripVertical} on={DotsSixVertical} kind="symbol" size="sm" offClassName="h-3.5 w-3.5" />
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium leading-tight text-text" title={track.title}>
            {track.title}
          </span>
          {track.autoplayed ? (
            <span
              data-music-autoplayed=""
              className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-surface-2 px-1.5 text-[11px] leading-4 text-text-secondary"
            >
              <InfinityIcon className="h-3 w-3" aria-hidden="true" />
              {t("music.queue.similar")}
            </span>
          ) : (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-tight text-text-secondary">
              <UserAvatar
                name={addedBy.name}
                avatarUrl={addedBy.avatarUrl}
                className="h-3.5 w-3.5"
                fallbackClassName="bg-surface-3 text-[8px] text-text"
                rounded="full"
              />
              <span className="truncate">{addedBy.name}</span>
            </span>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 text-[11px] tabular-nums text-text-secondary",
            "group-hover/row:hidden group-focus-within/row:hidden",
            canManage ? "" : "[@media(hover:none)]:hidden",
          )}
        >
          {track.durationMs ? formatMusicClock(track.durationMs) : ""}
        </span>
        <span
          className={cn(
            "hidden shrink-0 items-center group-hover/row:flex group-focus-within/row:flex",
            "[@media(hover:none)]:flex",
          )}
        >
          {canManage ? (
            <>
              <Tooltip label={t("music.moveUp")}>
                <button
                  type="button"
                  data-queue-row-up=""
                  className={cn(action, "[@media(hover:none)]:hidden")}
                  aria-label={t("music.moveUp")}
                  disabled={index === 0}
                  onClick={() => moveInQueue(track.id, -1)}
                >
                  <ChevronUp className="h-4 w-4" aria-hidden="true" />
                </button>
              </Tooltip>
              <Tooltip label={t("music.moveDown")}>
                <button
                  type="button"
                  data-queue-row-down=""
                  className={cn(action, "[@media(hover:none)]:hidden")}
                  aria-label={t("music.moveDown")}
                  disabled={last}
                  onClick={() => moveInQueue(track.id, 1)}
                >
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                </button>
              </Tooltip>
            </>
          ) : null}
          <Menu items={menuItems} align="end" side="bottom">
            <button
              type="button"
              data-queue-row-menu=""
              className={action}
              aria-label={t("music.overflow")}
            >
              <IconSwap off={MoreHorizontal} on={DotsThree} kind="symbol" size="sm" offClassName="h-4 w-4" />
            </button>
          </Menu>
        </span>
      </li>
    </ContextMenu>
  );
}
