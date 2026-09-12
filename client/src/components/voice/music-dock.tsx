import { ChevronDown, ChevronUp, ListMusic, Music, X } from "lucide-react";
import type { MusicTrack } from "@pqp/shared";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { MusicAddForm } from "@/components/voice/music-add-form";
import {
  moveInQueue,
  removeFromQueue,
  toggleMusicOpen,
  useMusic,
  type MusicSnapshot,
} from "@/lib/music-store";
import { cn } from "@/lib/utils";
import type { VoiceState } from "@/hooks/use-voice";

/**
 * THE MUSIC QUEUE, ON THE CALL.
 *
 * One line on the strip (what is playing, a button to open the queue) and a
 * panel with the player, the controls and what is up next. The player is a
 * real, visible YouTube embed: the platform's terms want it seen, and a
 * thumbnail-sized one is what Discord's Watch Together shows too.
 *
 * The player itself is not here: it lives at the bottom of the sidebar
 * (`music-mini-player.tsx`), above the call controls, so it is mounted for
 * the whole call whatever the panel is doing. Unmounting it is what stops
 * the sound.
 */

const QUEUE_SHOWN = 8;

export function MusicDock({
  voiceState,
  compact = false,
  className,
}: {
  voiceState: VoiceState;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const music = useMusic();
  const open = music.open;
  const inCall = voiceState.status === "connected" && voiceState.voiceChannelId !== null;
  const current = music.state?.current ?? null;

  if (!inCall) {
    return null;
  }

  const strip = (
    <div
      data-music-dock={compact ? "compact" : "stage"}
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-[11px] text-paper-muted",
        className,
      )}
    >
      <Tooltip label={open ? t("music.close") : t("music.open")}>
        <button
          type="button"
          aria-pressed={open}
          onClick={() => toggleMusicOpen()}
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-ink-3/70",
            current ? "text-signal" : "text-paper-muted",
          )}
        >
          <Music className="h-3 w-3 shrink-0" aria-hidden="true" />
          {current ? (
            <span className="max-w-[12rem] truncate">{current.title}</span>
          ) : (
            <span>{t("music.title")}</span>
          )}
        </button>
      </Tooltip>
      {current && music.state && music.state.queue.length > 0 && (
        <span className="tabular-nums">
          {t("music.more", { count: music.state.queue.length })}
        </span>
      )}
    </div>
  );

  // A popover off the strip rather than a block inside it: the strip is one
  // line and the stage's bar has no room for a panel. Opens downward from
  // the strip and upward from the bar, so it never covers the controls.
  return (
    <div className="relative">
      {strip}
      {(open || current) && (
        <div
          hidden={!open}
          className={cn(
            "pointer-events-auto absolute right-0 z-30 w-80 rounded-lg bg-ink-2/95 p-2.5 text-xs shadow-lg ring-1 ring-ink-4/60 backdrop-blur",
            compact ? "top-full mt-1" : "bottom-full mb-1.5",
          )}
        >
          <MusicPanel
            music={music}
            selfUserId={voiceState.self?.userId ?? null}
          />
        </div>
      )}
    </div>
  );
}

function MusicPanel({
  music,
  selfUserId,
}: {
  music: MusicSnapshot;
  selfUserId: string | null;
}) {
  const { t } = useTranslation();
  const state = music.state;
  const current = state?.current ?? null;

  return (
    <div className="space-y-2">
      <MusicAddForm />

      {current ? (
        <p className="truncate text-[11px] text-paper-muted" title={current.title}>
          {t("music.nowPlaying")}: <span className="text-paper">{current.title}</span>
        </p>
      ) : (
        <p className="text-[11px] text-paper-muted">{t("music.empty")}</p>
      )}

      {state && state.queue.length > 0 && (
        <div>
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-paper-muted">
            <ListMusic className="h-3 w-3" aria-hidden="true" />
            {t("music.queue")}
          </p>
          <ol className="mt-1 space-y-0.5">
            {state.queue.slice(0, QUEUE_SHOWN).map((track, index) => (
              <QueueRow
                key={track.id}
                track={track}
                index={index}
                last={index === state.queue.length - 1}
                mine={track.addedByUserId === selfUserId}
              />
            ))}
          </ol>
          {state.queue.length > QUEUE_SHOWN && (
            <p className="mt-1 text-[11px] text-paper-muted">
              {t("music.more", { count: state.queue.length - QUEUE_SHOWN })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function QueueRow({
  track,
  index,
  last,
  mine,
}: {
  track: MusicTrack;
  index: number;
  last: boolean;
  mine: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={cn(
        "flex items-center gap-1.5 rounded-md px-1 py-0.5",
        mine && "bg-ink-3/40",
      )}
    >
      <span className="w-4 shrink-0 text-right tabular-nums text-paper-muted">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate" title={track.title}>
        {track.title}
        <span className="ml-1 text-paper-muted">{track.addedByName}</span>
      </span>
      <Tooltip label={t("music.moveUp")}>
        <button
          type="button"
          disabled={index === 0}
          onClick={() => moveInQueue(track.id, -1)}
          className="rounded p-0.5 text-paper-muted hover:bg-ink-3/70 hover:text-paper disabled:opacity-30"
        >
          <ChevronUp className="h-3 w-3" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={t("music.moveDown")}>
        <button
          type="button"
          disabled={last}
          onClick={() => moveInQueue(track.id, 1)}
          className="rounded p-0.5 text-paper-muted hover:bg-ink-3/70 hover:text-paper disabled:opacity-30"
        >
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={t("music.remove")}>
        <button
          type="button"
          onClick={() => removeFromQueue(track.id)}
          className="rounded p-0.5 text-paper-muted hover:bg-ink-3/70 hover:text-paper"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </Tooltip>
    </li>
  );
}
