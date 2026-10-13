import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";

/**
 * How long a voice notice stays up on its own. Long enough to read twice,
 * short enough that "this call got big, join/leave sounds are off" is not
 * still pinned over the stage an hour later (Rafael, 2026-09-17).
 */
export const VOICE_NOTICE_AUTO_HIDE_MS = 12_000;

/**
 * Whether a notice is still up: it hides on its own after `autoHideMs`, or
 * when closed. A NEW notice text shows again even if the previous one was
 * dismissed; the same text does not come back until it changes.
 *
 * A hook of its own because the stage has to know too: its title overlay
 * steps down a row while the strip is up, and stepping back only when
 * `voiceState.notice` cleared left a dark band where a notice used to be.
 */
export function useVoiceNotice(
  notice: string | null,
  autoHideMs = VOICE_NOTICE_AUTO_HIDE_MS,
): { shown: string | null; hide: () => void } {
  const [hidden, setHidden] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => setHidden(notice), autoHideMs);
    return () => window.clearTimeout(timer);
  }, [notice, autoHideMs]);

  return {
    shown: notice && hidden !== notice ? notice : null,
    hide: () => setHidden(notice),
  };
}

/**
 * The one-line status strip over the call stage (`voiceState.notice`).
 * Every notice is transient by nature (a grant changed, the room was
 * promoted, the join/leave cue went quiet), so it auto-hides and has a close
 * button. Pass `onClose` when the caller tracks visibility with
 * `useVoiceNotice` itself; without it the strip tracks its own.
 */
export function VoiceNoticeBar({
  notice,
  autoHideMs = VOICE_NOTICE_AUTO_HIDE_MS,
  onClose,
  stacked = false,
}: {
  notice: string | null;
  autoHideMs?: number;
  onClose?: () => void;
  /**
   * Drawn as one row of the stage's banner column (`call-stage.tsx`) rather
   * than pinned to the top on its own, so it can never sit on another banner.
   */
  stacked?: boolean;
}) {
  const { t } = useTranslation();
  const own = useVoiceNotice(onClose ? null : notice, autoHideMs);
  const shown = onClose ? notice : own.shown;
  const close = onClose ?? own.hide;

  if (!shown) {
    return null;
  }
  return (
    // Status only. The strip sits over the share tile's own controls, so it
    // stays pointer-events-none and only the close button opts back in --
    // otherwise it captures clicks meant for fullscreen underneath it.
    <p
      role="status"
      data-voice-notice
      className={
        stacked
          ? "pointer-events-none flex items-center justify-center gap-2 bg-ink/70 px-3 py-1.5 text-center text-xs text-paper-muted backdrop-blur-sm"
          : "pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-center gap-2 bg-ink/70 px-3 py-1.5 text-center text-xs text-paper-muted backdrop-blur-sm"
      }
    >
      <span>{shown}</span>
      <button
        type="button"
        aria-label={t("common.close")}
        className="pointer-events-auto rounded p-0.5 text-paper-muted hover:text-paper focus-visible:outline focus-visible:outline-1"
        onClick={close}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </p>
  );
}
