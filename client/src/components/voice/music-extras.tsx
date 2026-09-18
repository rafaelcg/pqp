import { useEffect, useState } from "react";
import {
  HeadphoneOff,
  MonitorPlay,
  Radio,
  Repeat,
  Repeat1,
  Shuffle,
  SkipForward,
  Speech,
  Square,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import type { MusicRepeat, MusicState, MusicTrack } from "@pqp/shared";
import { musicSkipVotesNeeded } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import {
  readdFromHistory,
  setAutoplay,
  setListening,
  setOpenControls,
  setRepeat,
  shuffle,
  voteSkip,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";

const REPEAT_ORDER: MusicRepeat[] = ["off", "one", "all"];

const ghostIcon =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text";

export function effectiveCanManageMusic(
  voiceState: { canManageMusic: boolean; canSpeak: boolean },
  state: Pick<MusicState, "openControls"> | null | undefined,
): boolean {
  return voiceState.canManageMusic || (state?.openControls === true && voiceState.canSpeak);
}

export function MusicRepeatButton({ repeat }: { repeat: MusicRepeat }) {
  const { t } = useTranslation();
  const nextRepeat =
    REPEAT_ORDER[(REPEAT_ORDER.indexOf(repeat) + 1) % REPEAT_ORDER.length] ?? "off";
  const label =
    repeat === "one"
      ? t("music.repeat.one")
      : repeat === "all"
        ? t("music.repeat.all")
        : t("music.repeat.off");

  return (
    <Tooltip label={label}>
      <button
        type="button"
        data-music-repeat={repeat}
        className={ghostIcon}
        aria-label={label}
        onClick={() => setRepeat(nextRepeat)}
      >
        {repeat === "one" ? (
          <Repeat1 className="h-4 w-4 text-accent" aria-hidden="true" />
        ) : (
          <Repeat
            className={repeat === "all" ? "h-4 w-4 text-accent" : "h-4 w-4"}
            aria-hidden="true"
          />
        )}
      </button>
    </Tooltip>
  );
}

export function MusicShuffleButton() {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("music.shuffle")}>
      <button
        type="button"
        data-music-shuffle=""
        className={ghostIcon}
        aria-label={t("music.shuffle")}
        onClick={() => shuffle()}
      >
        <Shuffle className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** Personal off: this machine stops, the room's queue carries on. */
export function MusicStopListeningButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("music.dismiss")}>
      <button
        type="button"
        data-music-stop-listening=""
        className={cn(ghostIcon, className)}
        aria-label={t("music.dismiss")}
        onClick={() => setListening(false)}
      >
        <HeadphoneOff className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** Sheet overflow: duck, video, stage, room options, stop for everyone. */
export function musicOverflowItems(input: {
  t: (key: MessageKey) => string;
  canManage: boolean;
  ducking: boolean;
  showVideo: boolean;
  onStage: boolean;
  openControls: boolean;
  autoplay: boolean;
  onToggleDucking?: (value: boolean) => void;
  onToggleVideo: () => void;
  onWatchOnStage?: () => void;
  onStopAll?: () => void;
}): ContextMenuItemDef[] {
  const items: ContextMenuItemDef[] = [];
  if (input.onToggleDucking) {
    items.push({
      id: "duck",
      label: input.t("music.duck"),
      icon: Speech,
      checked: input.ducking,
      onSelect: () => input.onToggleDucking?.(!input.ducking),
    });
  }
  items.push({
    id: "video",
    label: input.showVideo ? input.t("music.video.hide") : input.t("music.video.show"),
    icon: input.showVideo ? VideoOff : Video,
    checked: input.showVideo,
    onSelect: input.onToggleVideo,
  });
  if (input.onWatchOnStage) {
    items.push({
      id: "stage",
      label: input.onStage ? input.t("music.stage.dock") : input.t("music.stage.watch"),
      icon: MonitorPlay,
      checked: input.onStage,
      onSelect: input.onWatchOnStage,
    });
  }
  if (input.canManage) {
    items.push(
      { id: "sep-room", label: "", separator: true },
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
    );
  }
  if (input.canManage && input.onStopAll) {
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
      <button
        type="button"
        data-music-vote-skip=""
        className={cn(
          "flex h-8 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text",
          voted && "text-accent",
        )}
        disabled={voted || !userId}
        aria-label={label}
        aria-pressed={voted}
        onClick={() => voteSkip(roomSize)}
      >
        <SkipForward className="h-4 w-4" aria-hidden="true" />
        <span className="text-[10px] tabular-nums">
          {t("music.voteSkip.tally", { count, needed })}
        </span>
      </button>
    </Tooltip>
  );
}

export function MusicHistoryList({
  history,
  defaultOpen = false,
}: {
  history: MusicTrack[];
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  if (history.length === 0) {
    return null;
  }

  return (
    <div data-music-history="" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-1 rounded-[var(--radius-control)] px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary hover:bg-surface-2 hover:text-text"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{t("music.history")}</span>
        <span className="tabular-nums">{history.length}</span>
      </button>
      {open ? (
        <ol className="max-h-40 space-y-0.5 overflow-y-auto">
          {history.map((track) => (
            <li key={track.id} className="flex items-center gap-2 rounded-md px-1 py-1">
              <span className="min-w-0 flex-1 truncate text-text" title={track.title}>
                {track.title}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => readdFromHistory(track.id)}
              >
                {t("music.playAgain")}
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
