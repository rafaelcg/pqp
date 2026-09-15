import { Repeat, Repeat1, Shuffle } from "lucide-react";
import type { MusicRepeat, MusicTrack, VoiceParticipant } from "@pqp/shared";
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

const REPEAT_ORDER: MusicRepeat[] = ["off", "one", "all"];

export function effectiveCanManageMusic(
  canManageMusic: boolean,
  openControls: boolean,
  canSpeak: boolean,
): boolean {
  return canManageMusic || (openControls && canSpeak);
}

export function MusicRoomSwitches({
  openControls,
  repeat,
}: {
  openControls: boolean;
  repeat: MusicRepeat;
}) {
  const { t } = useTranslation();
  const autoplay = useMusic().state?.autoplay === true;
  const nextRepeat =
    REPEAT_ORDER[(REPEAT_ORDER.indexOf(repeat) + 1) % REPEAT_ORDER.length] ??
    "off";
  const repeatLabel =
    repeat === "one"
      ? t("music.repeat.one")
      : repeat === "all"
        ? t("music.repeat.all")
        : t("music.repeat.off");

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <Switch
          checked={openControls}
          onCheckedChange={setOpenControls}
          label={t("music.openControls")}
          className="min-w-0 flex-1 px-1 py-1"
        />
        <Tooltip label={repeatLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={repeatLabel}
            onClick={() => setRepeat(nextRepeat)}
          >
            {repeat === "one" ? (
              <Repeat1 className="h-4 w-4 text-accent" aria-hidden="true" />
            ) : (
              <Repeat
                className={
                  repeat === "all" ? "h-4 w-4 text-accent" : "h-4 w-4 text-text-tertiary"
                }
                aria-hidden="true"
              />
            )}
          </Button>
        </Tooltip>
        <Tooltip label={t("music.shuffle")}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={t("music.shuffle")}
            onClick={() => shuffle()}
          >
            <Shuffle className="h-4 w-4" aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
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
    <Tooltip
      label={t("music.voteSkip")}
      detail={t("music.voteSkip.hint", { needed })}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="shrink-0"
        disabled={voted || !userId}
        aria-label={label}
        onClick={() => voteSkip(roomSize)}
      >
        {t("music.voteSkip")}
        <span className="tabular-nums text-text-secondary">
          {t("music.voteSkip.count", { count, needed })}
        </span>
      </Button>
    </Tooltip>
  );
}

export function MusicHistoryList({ history }: { history: MusicTrack[] }) {
  const { t } = useTranslation();
  if (history.length === 0) {
    return null;
  }
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
        {t("music.history")}
      </p>
      <ol className="max-h-40 space-y-0.5 overflow-y-auto">
        {history.map((track) => (
          <li
            key={track.id}
            className="flex items-center gap-2 rounded-md px-1 py-1"
          >
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
    </div>
  );
}

export function MusicListeners({
  participants,
}: {
  participants: VoiceParticipant[];
}) {
  const { t } = useTranslation();
  const listening = participants.filter(
    (peer) => peer.listeningMusic !== false,
  );
  const shown = listening.slice(0, 5);
  const extra = listening.length - shown.length;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
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
      <span className="tabular-nums">
        {t("music.listening", { count: listening.length })}
      </span>
    </div>
  );
}
