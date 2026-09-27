import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  rememberLinuxShareAudioHint,
  shouldShowLinuxShareAudioHint,
} from "@/lib/linux-share-audio-hint";
import { cn } from "@/lib/utils";

/**
 * "Does screen share carry sound here?" One line, Linux only, next to the
 * share controls: in a browser, sound rides a Chrome tab and nothing else;
 * in the desktop shell, no share on Linux carries the computer's sound at
 * all (loopback capture is Windows-only in Chromium, and there is no tab to
 * fall back to inside Electron's picker). See `lib/linux-share-audio-hint.ts`.
 *
 * Same shape as `CinemaHint`: dismissed once, remembered in the shared hint
 * store, gone until `visible` goes true again in a session that never
 * dismissed it.
 */
export function LinuxShareAudioHint({
  visible,
  isDesktopShell,
  className,
}: {
  /** The share controls (or the "sharing with no audio" state) are on screen. */
  visible: boolean;
  isDesktopShell: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [eligible] = useState(() => shouldShowLinuxShareAudioHint());
  const [open, setOpen] = useState(true);
  const show = eligible && visible && open;

  useEffect(() => {
    if (show) {
      rememberLinuxShareAudioHint();
    }
  }, [show]);

  if (!show) {
    return null;
  }

  return (
    <div
      role="note"
      data-linux-share-audio-hint=""
      className={cn(
        "pointer-events-auto flex max-w-[min(100%,26rem)] items-center gap-2 rounded-full bg-ink/80 py-1.5 pl-3 pr-1.5 text-xs text-paper shadow-lg ring-1 ring-ink-4/60 backdrop-blur-sm animate-rise",
        className,
      )}
    >
      <span className="min-w-0">
        {t(
          "voice.share.linuxAudioHint",
          // Taken from the prop rather than `desktopContext()`: the shell
          // flag is what makes this branch reachable from a browser test,
          // the same reason `screenCaptureEnvironment` takes its parts as
          // arguments instead of reading `isDesktopApp()` itself.
          isDesktopShell ? { context: "desktop" } : undefined,
        )}
      </span>
      <button
        type="button"
        aria-label={t("voice.share.linuxAudioHint.dismiss")}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-paper-muted hover:bg-ink-3 hover:text-paper"
        onClick={() => setOpen(false)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
