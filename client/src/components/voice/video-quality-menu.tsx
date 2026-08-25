import { Check, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { InboundVideoReadout } from "@/components/voice/inbound-video-readout";
import { OutboundVideoReadout } from "@/components/voice/outbound-video-readout";
import { VIDEO_QUALITIES, type VideoQuality } from "@/lib/video-quality";
import { cn } from "@/lib/utils";

/**
 * The camera's quality setting, on the call, next to the camera button.
 *
 * WHY IT IS HERE AND NOT ONLY IN SETTINGS. Bad video is noticed during a call
 * and nowhere else, and the readout that tells you what you are actually
 * sending is only alive during a call. Putting the one control that answers
 * "is my video OK" behind a dialog, under a tab named after audio, meant that
 * the person who most needed it had already left the surface where the
 * question occurred to them.
 *
 * IT DOES NOT WIDEN THE BAR BY FIVE BUTTONS. One round button in the bar's
 * own idiom, which opens a menu upward over the stage. The button carries the
 * bar's "active" tint whenever a size is pinned, so `auto` (everybody, by
 * default) looks like every other resting control and a deliberate 480p is
 * visible without opening anything.
 *
 * OPEN STATE IS THE PARENT'S. The stage fades its control bar after a few idle
 * seconds, and a bar that fades while this is open takes the menu with it, so
 * the stage has to know. See `video-quality-control.ts`.
 *
 * TWO HALVES, NAMED FOR THEIR DIRECTIONS, AND THAT IS THE WHOLE FIX. The menu
 * used to be one list of sizes under the heading "Camera and screen quality",
 * shown with identical wording to a presenter and to a watcher. Those are
 * opposite situations: the presenter's choice decides what everyone sees, and
 * the watcher's decides nothing at all, because in a mesh the sender encodes
 * the stream and `RTCRtpReceiver` has no size or rate parameter to answer with.
 * Somebody watching a soft share therefore reached for the only control the
 * product offered, moved it two rungs, and got nothing — twice, across a
 * rejoin. So the sizes now sit under "Video you send" and appear only while
 * this machine is actually sending; underneath them, "Video you receive" says
 * what is arriving and whose choice it was. Nothing here promises a viewer a
 * knob that WebRTC does not have.
 */
const LABELS: Record<VideoQuality, MessageKey> = {
  auto: "settings.voice.videoQuality.auto",
  "1080p": "settings.voice.videoQuality.1080p",
  "720p": "settings.voice.videoQuality.720p",
  "480p": "settings.voice.videoQuality.480p",
  "360p": "settings.voice.videoQuality.360p",
};

export function VideoQualityMenu({
  value,
  open,
  onOpenChange,
  onChange,
  isSendingVideo,
  buttonClassName,
  iconClassName,
}: {
  value: VideoQuality;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (quality: VideoQuality) => void;
  /**
   * Whether this machine has a camera or a share on the wire.
   *
   * False hides the size list entirely rather than disabling it. A disabled
   * rung is still an offer, and the offer would be a lie: picking one while
   * you are only watching changes a stored number and nothing a person can
   * see. The button remains, because the receiving half below it is exactly
   * what a watcher opened this for.
   */
  isSendingVideo: boolean;
  buttonClassName?: string;
  iconClassName?: string;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);

  // Same dismissal contract as the user-panel popover: a press anywhere else,
  // or Escape. Anchored on the wrapper rather than the panel so a press on the
  // button itself is the button's toggle rather than an outside-close followed
  // by a re-open.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  // The button's own name changes with the role, because it is the first
  // thing read and the last thing a screen-reader user hears before opening
  // something that, for a viewer, contains no control at all.
  const label = isSendingVideo
    ? t("call.quality.open", { quality: t(LABELS[value]) })
    : t("call.quality.openReceiving");

  return (
    <div ref={rootRef} className="relative">
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute bottom-full left-1/2 z-50 mb-2 w-64 max-w-[80vw] -translate-x-1/2 rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)] animate-fade-in"
        >
          {isSendingVideo && (
            <p className="px-2.5 pb-1 pt-1.5 text-xs uppercase tracking-wide text-paper-muted">
              {t("settings.voice.videoQuality")}
            </p>
          )}
          {isSendingVideo &&
            VIDEO_QUALITIES.map((quality) => {
              const selected = quality === value;
              return (
                <button
                  key={quality}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-paper outline-none hover:bg-ink-3 focus-visible:bg-ink-3"
                  onClick={() => {
                    onChange(quality);
                    onOpenChange(false);
                  }}
                >
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-signal",
                      !selected && "invisible",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {t(LABELS[quality])}
                  </span>
                </button>
              );
            })}
          {/* The reason the control is on the call rather than only in a
              dialog: the size actually leaving this machine, updating while
              you look at it. Changing the choice above re-shapes the track
              that is already on the wire, so this number moves within a
              couple of seconds without the camera blinking. */}
          {isSendingVideo && (
            <div className="mt-1 border-t border-ink-4/60 px-2.5 pb-1.5 pt-1">
              <OutboundVideoReadout idleKey="call.quality.unmeasured" />
            </div>
          )}
          {/* The other direction, and for a viewer the only thing in here.
              Always present, including for a presenter who is also watching
              somebody else: "mine is fine and theirs is 360p" is a diagnosis,
              and it is unavailable from any other surface in the product. */}
          <div className="mt-1 border-t border-ink-4/60 px-2.5 pb-1.5 pt-1">
            <p className="pb-0.5 text-xs uppercase tracking-wide text-paper-muted">
              {t("call.quality.receiving")}
            </p>
            <InboundVideoReadout />
          </div>
        </div>
      )}
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex items-center justify-center rounded-full",
          buttonClassName,
          // Pinned reads as "on", exactly like the camera and share buttons.
          // Auto is the default everybody has, so it stays a resting control.
          // A viewer's button is never tinted: the stored size is not governing
          // anything they can see, and tinting it would be the same claim the
          // old label made.
          isSendingVideo && value !== "auto"
            ? "bg-signal/20 text-signal"
            : "bg-ink-3 text-paper hover:bg-ink-4",
        )}
        onClick={() => onOpenChange(!open)}
      >
        <SlidersHorizontal className={iconClassName} />
      </button>
    </div>
  );
}
