import { Mic, MicOff } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Hold-to-talk as a call control, not a banner above the bar.
 *
 * Lives in the same row as the icon buttons. The bound key is a chip on the
 * pill; when the window is not focused the chip dims, because the key cannot
 * reach this page and the button still can.
 *
 * `inBar`: on the slim bar the pill is the cell between the people and the
 * tiles. It is full width while the bar folds into lines, and from 35rem it
 * grows into whatever the row has spare, up to 22rem. The tiers are the
 * bar's, in `call-stage.tsx`.
 */
export function PttHoldControl({
  blocked,
  listenOnly,
  isTransmitting,
  keyLabel,
  windowFocused,
  inBar = false,
  onPushToTalk,
}: {
  blocked: boolean;
  listenOnly: boolean;
  isTransmitting: boolean;
  keyLabel: string | null;
  windowFocused: boolean;
  inBar?: boolean;
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
        // Cap the used box. Flex items default to min-height: auto, so the
        // label + keycap would otherwise grow past the tiles.
        "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-full px-3 text-sm font-medium leading-none touch-none",
        inBar ? "h-9 max-h-9 min-h-9" : "h-10 max-h-10 min-h-10",
        "transition-[background,color,opacity] duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
        "disabled:pointer-events-none disabled:opacity-40",
        inBar &&
          "w-full @min-[35rem]:w-auto @min-[35rem]:max-w-[22rem] @min-[35rem]:grow",
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
      <span className="leading-none">{label}</span>
      {keyLabel ? (
        <kbd
          className={cn(
            "rounded-md border px-1.5 py-0 text-[11px] font-medium leading-none",
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
