import { Mic, MicOff } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Hold-to-talk as a call control, not a banner above the bar.
 *
 * Lives in the same row as the icon buttons. The bound key is a chip on the
 * pill; when the window is not focused the chip dims, because the key cannot
 * reach this page and the button still can.
 */
export function PttHoldControl({
  blocked,
  listenOnly,
  isTransmitting,
  keyLabel,
  windowFocused,
  fullWidth = false,
  onPushToTalk,
}: {
  blocked: boolean;
  listenOnly: boolean;
  isTransmitting: boolean;
  keyLabel: string | null;
  windowFocused: boolean;
  fullWidth?: boolean;
  onPushToTalk?: (held: boolean) => void;
}) {
  const { t } = useTranslation();
  const locked = blocked || listenOnly;
  const label = locked
    ? t("voice.ptt.blocked")
    : isTransmitting
      ? t("voice.ptt.transmitting")
      : t("voice.ptt.hold");

  return (
    <button
      type="button"
      aria-pressed={isTransmitting}
      disabled={locked}
      className={cn(
        "inline-flex h-9 select-none items-center justify-center gap-2 whitespace-nowrap rounded-full px-3 text-sm font-medium touch-none",
        "transition-[background,color,opacity] duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
        "disabled:pointer-events-none disabled:opacity-40",
        fullWidth && "w-full lg:w-auto lg:min-w-[11rem]",
        isTransmitting
          ? "bg-accent text-on-accent"
          : "border border-border bg-surface-3 text-text hover:bg-surface-2",
      )}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onPushToTalk?.(true);
      }}
      onPointerUp={() => onPushToTalk?.(false)}
      onPointerCancel={() => onPushToTalk?.(false)}
      onLostPointerCapture={() => onPushToTalk?.(false)}
      onKeyDown={(event) => {
        if (event.key === " " && !event.repeat) {
          event.preventDefault();
          onPushToTalk?.(true);
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " ") {
          event.preventDefault();
          onPushToTalk?.(false);
        }
      }}
      onBlur={() => onPushToTalk?.(false)}
    >
      {isTransmitting ? (
        <Mic className="h-4 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <MicOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span>{label}</span>
      {keyLabel ? (
        <kbd
          className={cn(
            "rounded-md border px-1.5 py-px text-[11px] font-medium leading-4",
            isTransmitting
              ? "border-on-accent/40 text-on-accent"
              : windowFocused
                ? "border-border text-text-secondary"
                : "border-transparent text-text-tertiary opacity-50",
          )}
        >
          {keyLabel}
        </kbd>
      ) : null}
    </button>
  );
}

export function PttFocusHint({
  show,
  className,
}: {
  show: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!show) {
    return null;
  }
  return (
    <p role="status" className={cn("text-xs text-text-tertiary", className)}>
      {t("voice.ptt.unfocused")}
    </p>
  );
}
