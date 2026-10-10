import { formatNoteDuration } from "@pqp/shared";
import { Loader2, Pause, Play, X } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import {
  stopVoiceNote,
  toggleVoiceNote,
  usePlayerState,
} from "@/lib/voice-note-player";

/**
 * The note that is still playing after its card scrolled away or the reader
 * changed channel. Small on purpose: play/pause, whose it is, where it is,
 * and a way to stop it. It disappears the moment the card is back on screen,
 * because then the card is the control.
 */
export function VoiceNoteMiniPlayer() {
  const { t } = useTranslation();
  const player = usePlayerState();
  const current = player.current;
  if (!current || player.currentMounted || player.status === "idle" || player.status === "error") {
    return null;
  }
  // A paused note at the very start is a seek, not something "playing".
  if (player.status === "paused" && player.positionMs === 0) {
    return null;
  }
  const playing = player.status === "playing";
  const loading = player.status === "loading";
  const seconds = Math.floor(player.positionMs / 1000);
  const position = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div
      role="region"
      aria-label={t("voiceNote.mini.label", { name: current.authorName })}
      data-voice-note-mini
      className="elevation-3 fixed bottom-[calc(env(safe-area-inset-bottom)+6rem)] right-3 z-40 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-full border py-1 pl-1 pr-2 sm:right-4"
    >
      <Tooltip label={playing || loading ? t("voiceNote.pausePlayback") : t("voiceNote.play", { name: current.authorName })}>
        <button
          type="button"
          onClick={() => toggleVoiceNote(current)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : playing ? (
            <Pause className="h-4 w-4 fill-current" aria-hidden />
          ) : (
            <Play className="ml-0.5 h-4 w-4 fill-current" aria-hidden />
          )}
        </button>
      </Tooltip>
      <span className="min-w-0 truncate text-xs font-medium text-text">{current.authorName}</span>
      <span className="shrink-0 text-xs tabular-nums text-text-secondary">
        {position} / {formatNoteDuration(current.durationMs)}
      </span>
      <Tooltip label={t("voiceNote.mini.close")}>
        <button
          type="button"
          onClick={stopVoiceNote}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-tertiary hover:bg-surface-3 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}
