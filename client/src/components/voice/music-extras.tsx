import { useEffect, useState } from "react";
import { ChevronDown, Repeat, Repeat1, Shuffle, SkipForward } from "lucide-react";
import type { MusicRepeat, MusicState, MusicTrack, VoiceParticipant } from "@pqp/shared";
import { musicSkipVotesNeeded } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import {
  readdFromHistory,
  setAutoplay,
  setOpenControls,
  setRepeat,
  shuffle,
  useMusic,
  voteSkip,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";

const REPEAT_ORDER: MusicRepeat[] = ["off", "one", "all"];
const OPTIONS_KEY = "pqp:music-options-open";

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

export function MusicRoomSwitches() {
  const { t } = useTranslation();
  const music = useMusic();
  const openControls = music.state?.openControls === true;
  const autoplay = music.state?.autoplay === true;

  return (
    <div data-music-options-body="" className="space-y-0.5">
      <Switch
        checked={openControls}
        onCheckedChange={setOpenControls}
        label={t("music.openControls")}
        className="min-w-0 px-1 py-1"
      />
      <Switch
        checked={autoplay}
        onCheckedChange={setAutoplay}
        label={t("music.autoplay")}
        description={t("music.autoplay.hint")}
        className="min-w-0 px-1 py-1"
      />
    </div>
  );
}

function readOptionsOpen(): boolean {
  try {
    return localStorage.getItem(OPTIONS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOptionsOpen(open: boolean) {
  try {
    localStorage.setItem(OPTIONS_KEY, open ? "1" : "0");
  } catch {
    // per-browser convenience only
  }
}

/** Collapsed by default, remembered in this browser. Effective managers only. */
export function MusicQueueOptions() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(readOptionsOpen);

  return (
    <div data-music-options="" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-1 rounded-[var(--radius-control)] px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary hover:bg-surface-2 hover:text-text"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => {
            const next = !value;
            writeOptionsOpen(next);
            return next;
          });
        }}
      >
        <span>{t("music.options")}</span>
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")}
          aria-hidden="true"
        />
      </button>
      {open ? <MusicRoomSwitches /> : null}
    </div>
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

export function MusicListeners({
  participants,
}: {
  participants: VoiceParticipant[];
}) {
  const { t } = useTranslation();
  const listening = participants.filter((peer) => peer.listeningMusic !== false);
  if (listening.length === 0) {
    return null;
  }
  const shown = listening.slice(0, 5);
  const extra = listening.length - shown.length;
  return (
    <div
      data-music-listeners=""
      className="flex min-w-0 items-center gap-1 text-[11px] text-text-secondary"
    >
      <div className="flex -space-x-1.5">
        {shown.map((peer) => (
          <UserAvatar
            key={peer.peerId}
            name={peer.displayName}
            avatarUrl={peer.avatarUrl}
            className="h-5 w-5 ring-1 ring-surface-1"
            fallbackClassName="bg-accent-soft text-[9px] text-on-accent-soft"
            rounded="full"
          />
        ))}
      </div>
      {extra > 0 ? (
        <span className="tabular-nums text-text-tertiary">+{extra}</span>
      ) : null}
      <span className="min-w-0 truncate tabular-nums">
        {t("music.listening", { count: listening.length })}
      </span>
    </div>
  );
}
