import { useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  HeadphoneOff,
  Headphones,
  ListStart,
  MoreHorizontal,
  Plus,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  SkipForward,
  Square,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { MusicRepeat, MusicState, MusicTrack } from "@pqp/shared";
import { musicSkipVotesNeeded } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Menu } from "@/components/ui/menu";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { setMusicDucking } from "@/lib/music-prefs";
import {
  readdFromHistory,
  setAutoplay,
  setListening,
  setOpenControls,
  setRepeat,
  shuffle,
  stopMusic,
  voteSkip,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";

const REPEAT_ORDER: MusicRepeat[] = ["off", "one", "all"];

export function effectiveCanManageMusic(
  voiceState: { canManageMusic: boolean; canSpeak: boolean },
  state: Pick<MusicState, "openControls"> | null | undefined,
): boolean {
  return voiceState.canManageMusic || (state?.openControls === true && voiceState.canSpeak);
}

export function nextMusicRepeat(repeat: MusicRepeat): MusicRepeat {
  return REPEAT_ORDER[(REPEAT_ORDER.indexOf(repeat) + 1) % REPEAT_ORDER.length] ?? "off";
}

function repeatLabel(t: (key: MessageKey) => string, repeat: MusicRepeat): string {
  if (repeat === "one") {
    return t("music.repeat.one");
  }
  if (repeat === "all") {
    return t("music.repeat.all");
  }
  return t("music.repeat.off");
}

const ghostIcon =
  "h-8 w-8 shrink-0 text-text-tertiary hover:bg-surface-2 hover:text-text";

export function MusicRepeatButton({
  repeat,
  className,
  disabled = false,
}: {
  repeat: MusicRepeat;
  className?: string;
  /** A member sees the control dimmed in place, never missing. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const label = repeatLabel(t, repeat);
  const on = repeat !== "off";

  return (
    <Tooltip label={label} detail={disabled ? t("music.noManage") : undefined}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-music-repeat={repeat}
        className={cn(ghostIcon, className)}
        aria-label={label}
        aria-pressed={on}
        disabled={disabled}
        onClick={() => setRepeat(nextMusicRepeat(repeat))}
      >
        {repeat === "one" ? (
          <Repeat1 className={cn("h-4 w-4", on && "text-signal")} aria-hidden="true" />
        ) : (
          <Repeat className={cn("h-4 w-4", on && "text-signal")} aria-hidden="true" />
        )}
      </Button>
    </Tooltip>
  );
}

export function MusicShuffleButton({
  className,
  disabled = false,
}: {
  className?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip
      label={t("music.shuffle")}
      detail={disabled ? t("music.noManage") : undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-music-shuffle=""
        className={cn(ghostIcon, className)}
        aria-label={t("music.shuffle")}
        disabled={disabled}
        onClick={() => shuffle()}
      >
        <Shuffle className="h-4 w-4" aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}

/**
 * Local volume: the icon mutes, the slider sets the level.
 *
 * It was a popover holding a slider, a ducking switch and Parar de ouvir,
 * which made the level a two-click job and hid two personal settings behind
 * a speaker. The level is inline now, the way every player draws it, and
 * the two settings live in the one overflow under "Só pra você". The
 * slider hides on a narrow bar, where its width belongs to the title.
 */
export function MusicSpeakerControl({
  volume,
  muted,
  slider = false,
  onMute,
  onVolume,
}: {
  volume: number;
  muted: boolean;
  /** The composer bar has the width for it; the sidebar radio does not. */
  slider?: boolean;
  onMute: () => void;
  onVolume: (value: number) => void;
}) {
  const { t } = useTranslation();
  const shown = muted || volume === 0 ? 0 : volume;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip label={muted ? t("music.unmute") : t("music.mute")}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-music-speaker=""
          className="h-8 w-8 shrink-0"
          aria-pressed={shown === 0}
          aria-label={muted ? t("music.unmute") : t("music.mute")}
          onClick={onMute}
          onWheel={(event) => {
            event.preventDefault();
            const delta = event.deltaY > 0 ? -5 : 5;
            onVolume(Math.min(100, Math.max(0, shown + delta)));
          }}
        >
          {shown === 0 ? (
            <VolumeX className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Volume2 className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </Tooltip>
      {slider ? (
        <Slider
          variant="volume"
          data-music-volume=""
          value={shown}
          min={0}
          max={100}
          aria-label={t("music.volume")}
          className="hidden w-20 shrink-0 @min-[40rem]:flex"
          onValueChange={onVolume}
        />
      ) : null}
    </div>
  );
}

function musicModeOverflowItems(input: {
  t: (key: MessageKey) => string;
  repeat: MusicRepeat;
  order: "menu" | "all";
}): ContextMenuItemDef[] {
  const shuffleItem: ContextMenuItemDef = {
    id: "shuffle",
    label: input.t("music.shuffle"),
    icon: Shuffle,
    onSelect: () => shuffle(),
  };
  const repeatItem: ContextMenuItemDef = {
    id: "repeat",
    label: repeatLabel(input.t, input.repeat),
    icon: input.repeat === "one" ? Repeat1 : Repeat,
    checked: input.repeat !== "off",
    onSelect: () => setRepeat(nextMusicRepeat(input.repeat)),
  };
  return input.order === "menu" ? [shuffleItem, repeatItem] : [repeatItem, shuffleItem];
}

/**
 * The one row that belongs to the person rather than the room, which is why
 * it leads the menu under its own heading: everything below it changes what
 * the whole call hears.
 */
function musicPersonalItems(input: {
  t: (key: MessageKey) => string;
  listening: boolean;
  ducking: boolean;
}): ContextMenuItemDef[] {
  return [
    {
      id: "scope-you",
      label: input.t("music.scope.you"),
      heading: true,
    },
    {
      id: "duck",
      label: input.t("music.duck"),
      icon: Volume2,
      checked: input.ducking,
      onSelect: () => setMusicDucking(!input.ducking),
    },
    input.listening
      ? {
          id: "stop-listening",
          label: input.t("music.dismiss"),
          icon: HeadphoneOff,
          onSelect: () => setListening(false),
        }
      : {
          id: "listen",
          label: input.t("music.listen"),
          icon: Headphones,
          onSelect: () => setListening(true),
        },
  ];
}

/** Room policy: Todo mundo controla, Continuar com parecidas, Parar pra todos. */
export function musicRoomOverflowItems(input: {
  t: (key: MessageKey) => string;
  openControls: boolean;
  autoplay: boolean;
  onStopAll?: () => void;
}): ContextMenuItemDef[] {
  const items: ContextMenuItemDef[] = [
    {
      id: "open-controls",
      label: input.t("music.openControls"),
      icon: Users,
      checked: input.openControls,
      onSelect: () => setOpenControls(!input.openControls),
    },
    {
      id: "autoplay",
      label: input.t("music.autoplay"),
      icon: Radio,
      checked: input.autoplay,
      onSelect: () => setAutoplay(!input.autoplay),
    },
  ];
  if (input.onStopAll) {
    items.push(
      { id: "sep-stop", label: "", separator: true },
      {
        id: "stop-all",
        label: input.t("music.stopAll"),
        icon: Square,
        danger: true,
        onSelect: input.onStopAll,
      },
    );
  }
  return items;
}

/**
 * Overflow rows for the bar `…` and the drawer `…`.
 * `all` is the drawer: room policy, then shuffle/repeat.
 * `menu` is the bar when the icons hide: shuffle/repeat first, then room.
 * `none` is room policy only.
 */
export function musicOverflowItems(input: {
  t: (key: MessageKey) => string;
  canManage: boolean;
  listening: boolean;
  ducking: boolean;
  openControls: boolean;
  autoplay: boolean;
  repeat: MusicRepeat;
  onStopAll?: () => void;
  modes?: "all" | "menu" | "none";
}): ContextMenuItemDef[] {
  const personal = musicPersonalItems({
    t: input.t,
    listening: input.listening,
    ducking: input.ducking,
  });
  if (!input.canManage) {
    /* A member's menu is the personal rows alone, and a heading over the
       only group there is is noise. */
    return personal.filter((item) => !item.heading);
  }
  const modes = input.modes ?? "all";
  const room = musicRoomOverflowItems({
    t: input.t,
    openControls: input.openControls,
    autoplay: input.autoplay,
    onStopAll: input.onStopAll,
  });
  const scopedRoom: ContextMenuItemDef[] = [
    { id: "sep-scope", label: "", separator: true },
    { id: "scope-room", label: input.t("music.scope.room"), heading: true },
  ];
  if (modes === "none") {
    return [...personal, ...scopedRoom, ...room];
  }
  const modeItems = musicModeOverflowItems({
    t: input.t,
    repeat: input.repeat,
    order: modes,
  });
  if (modes === "menu") {
    return [...personal, ...scopedRoom, ...modeItems, ...room];
  }
  const stopAt = room.findIndex((item) => item.id === "sep-stop");
  const ordered =
    stopAt === -1
      ? [...room, ...modeItems]
      : [...room.slice(0, stopAt), ...modeItems, ...room.slice(stopAt)];
  return [...personal, ...scopedRoom, ...ordered];
}

/** Confirm-stop lives with the menu that still offers Parar pra todos. */
export function MusicOverflowMenu({
  canManage,
  listening,
  ducking,
  openControls,
  autoplay,
  repeat,
  modes = "all",
  side,
  triggerClassName,
}: {
  canManage: boolean;
  /** This machine's own state, which is the menu's first group either way. */
  listening: boolean;
  ducking: boolean;
  openControls: boolean;
  autoplay: boolean;
  repeat: MusicRepeat;
  modes?: "all" | "menu" | "none";
  side: "top" | "bottom";
  triggerClassName: string;
}) {
  const { t } = useTranslation();
  const [confirmStop, setConfirmStop] = useState(false);
  const items = useMemo(
    () =>
      musicOverflowItems({
        t,
        canManage,
        listening,
        ducking,
        openControls,
        autoplay,
        repeat,
        modes,
        onStopAll: canManage ? () => setConfirmStop(true) : undefined,
      }),
    [t, canManage, listening, ducking, openControls, autoplay, repeat, modes],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <Menu items={items} align="end" side={side}>
        <button
          type="button"
          data-music-overflow=""
          className={triggerClassName}
          aria-label={t("music.overflow")}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </Menu>
      <ConfirmDialog
        open={confirmStop}
        title={t("music.stopAllConfirm.title")}
        description={t("music.stopAllConfirm.body")}
        confirmLabel={t("music.stopAll")}
        onConfirm={() => stopMusic()}
        onClose={() => setConfirmStop(false)}
      />
    </>
  );
}

export function MusicVoteSkipButton({
  skipVotes,
  userId,
  roomSize,
}: {
  skipVotes: string[];
  userId: string | null;
  roomSize: number;
}) {
  const { t } = useTranslation();
  const needed = musicSkipVotesNeeded(roomSize);
  const count = skipVotes.length;
  const voted = userId !== null && skipVotes.includes(userId);
  const label = `${t("music.voteSkip")} ${t("music.voteSkip.count", { count, needed })}`;

  return (
    <Tooltip label={t("music.voteSkip")} detail={t("music.voteSkip.hint", { needed })}>
      <span className="relative inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-music-vote-skip=""
          className={cn("h-8 w-8 shrink-0", voted && "text-accent")}
          disabled={voted || !userId}
          aria-label={label}
          aria-pressed={voted}
          onClick={() => voteSkip(roomSize)}
        >
          <SkipForward className="h-4 w-4" aria-hidden="true" />
        </Button>
        {/* The count belongs on the button. In a tooltip it is a fact nobody
            reads until they have already pressed the thing. */}
        <span
          data-music-vote-count=""
          className="pointer-events-none absolute -right-1 -top-0.5 rounded-full bg-accent-soft px-1 text-[9px] font-semibold tabular-nums text-on-accent-soft"
        >
          {t("music.voteSkip.badge", { count, needed })}
        </span>
      </span>
    </Tooltip>
  );
}

export function MusicHistoryList({
  history,
  defaultOpen = false,
  tone = "rail",
}: {
  history: MusicTrack[];
  defaultOpen?: boolean;
  tone?: "rail" | "composer";
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const composer = tone === "composer";

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  if (history.length === 0) {
    return null;
  }

  return (
    <div data-music-history="" data-open={open ? "true" : "false"} className="mt-2">
      <button
        type="button"
        className={cn(
          "flex w-full items-center justify-between gap-1 rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wider",
          composer
            ? "text-text-secondary hover:text-text"
            : "text-paper-muted hover:text-paper",
        )}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{t("music.history")}</span>
        <span className="tabular-nums">{history.length}</span>
      </button>
      {open ? (
        <ol className="max-h-40 space-y-0.5 overflow-y-auto">
          {history.map((track) => (
            <li
              key={track.id}
              className={cn(
                "group/row flex items-center gap-2 rounded-md px-1 py-1",
                composer ? "hover:bg-surface-3" : "hover:bg-ink-3",
              )}
            >
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  composer ? "text-text" : "text-paper",
                )}
                title={track.title}
              >
                {track.title}
              </span>
              <Tooltip label={t("music.playAgain")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-music-play-again=""
                  className="h-8 w-8 shrink-0"
                  aria-label={t("music.playAgain")}
                  onClick={() => readdFromHistory(track.id)}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </Button>
              </Tooltip>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function queueRowMenuItems(input: {
  t: (key: MessageKey) => string;
  canManage: boolean;
  canRemove: boolean;
  href: string;
  openLabel: string;
  onPlayNext: () => void;
  onRemove: () => void;
}): ContextMenuItemDef[] {
  const items: ContextMenuItemDef[] = [];
  if (input.canManage) {
    items.push({
      id: "play-next",
      label: input.t("music.playNext"),
      icon: ListStart,
      onSelect: input.onPlayNext,
    });
  }
  if (input.canRemove) {
    items.push({
      id: "remove",
      label: input.t("music.remove"),
      icon: X,
      danger: true,
      onSelect: input.onRemove,
    });
  }
  items.push({
    id: "open-source",
    label: input.openLabel,
    icon: ExternalLink,
    onSelect: () => {
      window.open(input.href, "_blank", "noopener,noreferrer");
    },
  });
  return items;
}
