import { useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  HeadphoneOff,
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
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation, type MessageKey } from "@/lib/i18n";
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

/** Personal off: this machine stops, the room's queue carries on. */
export function MusicStopListeningButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("music.dismiss")}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-music-stop-listening=""
        className={cn("h-8 w-8 shrink-0", className)}
        aria-label={t("music.dismiss")}
        onClick={() => setListening(false)}
      >
        <HeadphoneOff className="h-4 w-4" aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}

/**
 * Local volume, mute, ducking, and stop listening. Click opens the
 * popover; scroll on the icon changes volume.
 */
export function MusicSpeakerControl({
  volume,
  muted,
  ducking,
  onMute,
  onVolume,
  onToggleDucking,
}: {
  volume: number;
  muted: boolean;
  ducking: boolean;
  onMute: () => void;
  onVolume: (value: number) => void;
  onToggleDucking: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const shown = muted || volume === 0 ? 0 : volume;

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <Tooltip label={muted ? t("music.unmute") : t("music.volume")}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-music-speaker=""
          className="h-8 w-8 shrink-0"
          aria-expanded={open}
          aria-label={t("music.volume")}
          onClick={() => setOpen((value) => !value)}
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
      {open ? (
        <div
          data-music-speaker-popover=""
          className="absolute bottom-full right-0 z-[100] mb-2 w-64 overflow-hidden rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)]"
        >
          <div className="flex items-center gap-2 px-2 py-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-pressed={muted}
              aria-label={muted ? t("music.unmute") : t("music.mute")}
              onClick={onMute}
            >
              {shown === 0 ? (
                <VolumeX className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Volume2 className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
            <Slider
              variant="volume"
              value={shown}
              min={0}
              max={100}
              aria-label={t("music.volume")}
              className="min-w-0 flex-1 px-1.5"
              onValueChange={onVolume}
            />
          </div>
          <Switch
            checked={ducking}
            onCheckedChange={onToggleDucking}
            label={t("music.duck")}
            className="hover:bg-ink-3"
          />
          <button
            type="button"
            data-music-stop-listening=""
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-paper outline-none hover:bg-ink-3"
            onClick={() => {
              setListening(false);
              setOpen(false);
            }}
          >
            <HeadphoneOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t("music.dismiss")}
          </button>
        </div>
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
  openControls: boolean;
  autoplay: boolean;
  repeat: MusicRepeat;
  onStopAll?: () => void;
  modes?: "all" | "menu" | "none";
}): ContextMenuItemDef[] {
  if (!input.canManage) {
    return [];
  }
  const modes = input.modes ?? "all";
  const room = musicRoomOverflowItems({
    t: input.t,
    openControls: input.openControls,
    autoplay: input.autoplay,
    onStopAll: input.onStopAll,
  });
  if (modes === "none") {
    return room;
  }
  const modeItems = musicModeOverflowItems({
    t: input.t,
    repeat: input.repeat,
    order: modes,
  });
  if (modes === "menu") {
    return [...modeItems, ...room];
  }
  const stopAt = room.findIndex((item) => item.id === "sep-stop");
  if (stopAt === -1) {
    return [...room, ...modeItems];
  }
  return [...room.slice(0, stopAt), ...modeItems, ...room.slice(stopAt)];
}

/** Confirm-stop lives with the menu that still offers Parar pra todos. */
export function MusicOverflowMenu({
  canManage,
  openControls,
  autoplay,
  repeat,
  modes = "all",
  side,
  triggerClassName,
}: {
  canManage: boolean;
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
        openControls,
        autoplay,
        repeat,
        modes,
        onStopAll: canManage ? () => setConfirmStop(true) : undefined,
      }),
    [t, canManage, openControls, autoplay, repeat, modes],
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
