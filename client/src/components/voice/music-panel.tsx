import {
  ChevronDown,
  ListMusic,
  Pause,
  Play,
  SkipForward,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MusicState, MusicTrack } from "@pqp/shared";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MarqueeText } from "@/components/ui/marquee-text";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import type { VoiceState } from "@/hooks/use-voice";
import { useTranslation } from "@/lib/i18n";
import {
  seekTo,
  setListening,
  stopMusic,
  toggleMusicOpen,
  type MusicSnapshot,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";
import {
  formatMusicClock,
  formatMusicClockOrUnknown,
  ghostIconButton,
  lookupActorName,
  lookupAddedBy,
  usePlaybackProgress,
} from "@/components/voice/music-now-playing";
import { MusicQueueList } from "@/components/voice/music-queue-list";
import { MusicSearchPicker } from "@/components/voice/music-search-picker";

export type MusicActivityKind =
  | { kind: "skipped" }
  | { kind: "paused" }
  | { kind: "resumed" }
  | { kind: "added"; count: number }
  | { kind: "stopped" };

/** First snapshot is silent: joining a room that is already playing is not news. */
export function musicActivityFromDiff(
  prev: MusicState | null,
  next: MusicState | null,
): MusicActivityKind | null {
  if (!prev) {
    return null;
  }
  if (!next) {
    return { kind: "stopped" };
  }
  if (prev.current?.id && next.current?.id !== prev.current.id) {
    return { kind: "skipped" };
  }
  if (prev.status === "playing" && next.status === "paused") {
    return { kind: "paused" };
  }
  if (prev.status === "paused" && next.status === "playing" && prev.current?.id === next.current?.id) {
    return { kind: "resumed" };
  }
  const prevIds = new Set(prev.queue.map((track) => track.id));
  if (prev.current) {
    prevIds.add(prev.current.id);
  }
  let added = next.queue.filter((track) => !prevIds.has(track.id)).length;
  if (next.current && !prevIds.has(next.current.id)) {
    added += 1;
  }
  if (added > 0) {
    return { kind: "added", count: added };
  }
  return null;
}

/** Own actions are already visible; only other people's writes get a line. */
export function musicActivityForViewer(
  prev: MusicState | null,
  next: MusicState | null,
  peerId: string | null,
): MusicActivityKind | null {
  const actorId = next?.actorId ?? prev?.actorId ?? null;
  if (actorId && actorId === peerId) {
    return null;
  }
  return musicActivityFromDiff(prev, next);
}

function MusicActivityLine({
  voiceState,
  state,
}: {
  voiceState: VoiceState;
  state: MusicState | null;
}) {
  const { t } = useTranslation();
  const prev = useRef<MusicState | null>(null);
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    const previous = prev.current;
    prev.current = state;
    const diff = musicActivityForViewer(previous, state, voiceState.peerId);
    if (!diff) {
      return;
    }
    const name =
      lookupActorName(voiceState, state?.actorId ?? previous?.actorId ?? null) ??
      t("music.activity.someone");
    const text =
      diff.kind === "added"
        ? t("music.activity.added", { name, count: diff.count })
        : t(`music.activity.${diff.kind}`, { name });
    setLine(text);
    const timer = window.setTimeout(() => setLine(null), 4_000);
    return () => clearTimeout(timer);
  }, [state, t, voiceState]);

  if (!line) {
    return null;
  }

  return (
    <p
      role="status"
      data-music-activity=""
      className="text-[11px] text-text-secondary motion-safe:animate-fade-in"
    >
      {line}
    </p>
  );
}

export function MusicPanel({
  current,
  music,
  voiceState,
  canManage,
  playing,
  needsTap,
  showVideo,
  volume,
  muted,
  onPlayPause,
  onSkip,
  onTapToPlay,
  onMute,
  onVolume,
  onToggleVideo,
}: {
  current: MusicTrack;
  music: MusicSnapshot;
  voiceState: VoiceState;
  canManage: boolean;
  playing: boolean;
  needsTap: boolean;
  showVideo: boolean;
  volume: number;
  muted: boolean;
  onPlayPause: () => void;
  onSkip: () => void;
  onTapToPlay: () => void;
  onMute: () => void;
  onVolume: (value: number) => void;
  onToggleVideo: () => void;
}) {
  const { t } = useTranslation();
  const addedBy = lookupAddedBy(voiceState, current.addedByUserId, current.addedByName);
  const progress = usePlaybackProgress(music, current.durationMs);
  const [scrub, setScrub] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const duration = progress.durationMs ?? 0;
  const position = scrub ?? progress.position;
  const queue = music.state?.queue ?? [];
  const durationKnown = progress.known;

  return (
    <div data-music-panel="" className="flex max-h-[60vh] flex-col overflow-x-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 px-2 pb-2">
          <div className="flex items-center gap-2">
            <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[var(--radius-card)] bg-surface-2">
              {current.thumbnailUrl ? (
                <img src={current.thumbnailUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <ListMusic className="m-auto h-5 w-5 text-accent" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <MarqueeText text={current.title} className="text-[13px] font-medium text-text" />
              <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-text-secondary">
                <UserAvatar
                  name={addedBy.name}
                  avatarUrl={addedBy.avatarUrl}
                  className="h-3.5 w-3.5"
                  fallbackClassName="bg-accent-soft text-[9px] text-on-accent-soft"
                  rounded="full"
                />
                <span className="truncate">{t("music.addedBy", { name: addedBy.name })}</span>
              </span>
            </div>
            <Tooltip label={t("music.collapse")}>
              <button
                type="button"
                className={cn(ghostIconButton, "h-7 w-7")}
                aria-expanded
                onClick={() => toggleMusicOpen()}
              >
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tooltip>
          </div>

          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-left text-[11px] tabular-nums text-text-tertiary">
              {formatMusicClock(position)}
            </span>
            <Slider
              variant="scrub"
              readOnly={!canManage || !durationKnown}
              indeterminate={!durationKnown}
              value={position}
              min={0}
              max={durationKnown ? duration : 1}
              step={250}
              className="min-w-0 flex-1"
              aria-label={canManage && durationKnown ? t("music.seek") : t("music.progress")}
              onValueChange={(value) => {
                if (canManage && durationKnown) {
                  setScrub(value);
                }
              }}
              onValueCommit={(value) => {
                if (canManage && durationKnown) {
                  seekTo(value);
                  setScrub(null);
                }
              }}
            />
            <span className="shrink-0 text-right text-[11px] tabular-nums text-text-tertiary">
              {formatMusicClockOrUnknown(durationKnown ? duration : null)}
            </span>
          </div>

          <div className="flex items-center justify-center gap-2">
            {needsTap ? (
              <button
                type="button"
                className="flex h-9 items-center gap-1 rounded-full bg-accent px-3 text-[11px] font-semibold text-on-accent"
                onClick={onTapToPlay}
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                {t("music.tapToPlay")}
              </button>
            ) : (
              <>
                <span className="inline-flex h-8 w-8 shrink-0" aria-hidden="true" />
                <Tooltip
                  label={playing ? t("music.pause") : t("music.play")}
                  detail={canManage ? undefined : t("music.noManage")}
                >
                  <button
                    type="button"
                    className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent",
                      canManage ? "hover:bg-accent-hover" : "opacity-40",
                    )}
                    aria-pressed={playing}
                    aria-disabled={!canManage || undefined}
                    onClick={() => {
                      if (canManage) {
                        onPlayPause();
                      }
                    }}
                  >
                    {playing ? (
                      <Pause className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <Play className="ml-0.5 h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </Tooltip>
                <Tooltip label={t("music.skip")} detail={canManage ? undefined : t("music.noManage")}>
                  <button
                    type="button"
                    className={cn(ghostIconButton, !canManage && "opacity-40")}
                    aria-disabled={!canManage || undefined}
                    onClick={() => {
                      if (canManage) {
                        onSkip();
                      }
                    }}
                  >
                    <SkipForward className="h-4 w-4" aria-hidden="true" />
                  </button>
                </Tooltip>
              </>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <Tooltip label={muted ? t("music.unmute") : t("music.mute")}>
              <button
                type="button"
                className={cn(ghostIconButton, "h-7 w-7")}
                aria-pressed={muted}
                onClick={onMute}
              >
                {muted || volume === 0 ? (
                  <VolumeX className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Volume2 className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </Tooltip>
            <Slider
              variant="volume"
              value={muted ? 0 : volume}
              min={0}
              max={100}
              aria-label={t("music.volume")}
              className="min-w-0 flex-1"
              onValueChange={onVolume}
            />
            <Tooltip label={showVideo ? t("music.video.hide") : t("music.video.show")}>
              <button
                type="button"
                className={cn(ghostIconButton, "h-7 w-7")}
                aria-pressed={showVideo}
                onClick={onToggleVideo}
              >
                {showVideo ? (
                  <Video className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <VideoOff className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </Tooltip>
          </div>

          <MusicSearchPicker compact canManage={canManage} />

          <MusicActivityLine voiceState={voiceState} state={music.state} />

          {queue.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                <ListMusic className="h-3 w-3" aria-hidden="true" />
                {t("music.queue")}
                <span className="tabular-nums">{queue.length}</span>
              </p>
              <MusicQueueList queue={queue} voiceState={voiceState} canManage={canManage} />
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="flex shrink-0 items-center justify-between gap-1 px-2 py-1.5 text-[11px]">
        <button
          type="button"
          className="shrink-0 whitespace-nowrap rounded-[var(--radius-control)] px-1.5 py-1 text-text-tertiary hover:bg-surface-2 hover:text-text"
          onClick={() => setListening(false)}
        >
          {t("music.dismiss")}
        </button>
        {canManage && (
          <button
            type="button"
            className="shrink-0 whitespace-nowrap rounded-[var(--radius-control)] px-1.5 py-1 text-text-tertiary hover:bg-danger-soft hover:text-on-danger-soft"
            onClick={() => setConfirmStop(true)}
          >
            {t("music.stopAll")}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmStop}
        title={t("music.stopAllConfirm.title")}
        description={t("music.stopAllConfirm.body")}
        confirmLabel={t("music.stopAll")}
        onConfirm={() => stopMusic()}
        onClose={() => setConfirmStop(false)}
      />
    </div>
  );
}
