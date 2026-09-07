import { useCallback, useEffect, useRef, useState } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * One person's sound, in one place: their voice, and their screen share's
 * audio, as two sliders you can reach by CLICKING them.
 *
 * WHY IT EXISTS. Per-peer volume has shipped for months and a moderator
 * running a 510-member community could not find it, which for a control is the
 * same as not having it. Every copy of it was revealed by HOVER: a slider that
 * faded in over a tile, over a listener chip, over the three faces on the
 * collapsed bar. Hover is not a gesture a phone has, the pure-voice call (no
 * camera, no share, which is what a call is most of the time) drew a room of
 * faces that carried no control at all, and the one place a person actually
 * tries first, clicking somebody under the voice channel in the sidebar, did
 * nothing: that row was a `role="button"` with no `onClick`.
 *
 * SO IT IS ONE PANEL, OPENED BY A CLICK, AND THERE IS ONLY ONE OF IT. This
 * replaced `peer-tile-controls.tsx` and the separate slider that used to hang
 * off the corner of a share tile. A person's voice and that same person's
 * share are the two things you turn down about them, so they are two rows of
 * one panel rather than two controls on two different objects, and the panel
 * opens from every surface a person appears on: the sidebar row, the listener
 * chip, the faces on the collapsed bar, the room view, and a camera or share
 * tile's overlay.
 *
 * THE OPEN STATE IS THE CALLER'S (`usePeerAudioMenu`). The trigger is a chip
 * on one surface and a round button on another, and the stage fades its own
 * chrome, so the panel cannot own the element that opens it. What the hook
 * does own is the dismissal contract every menu in this app shares: a press
 * outside, or Escape.
 */

export interface PeerAudioTrack {
  /** 0 to 1. 1 is untouched. */
  volume: number;
  onSetVolume: (volume: number) => void;
}

/**
 * Open state plus the dismissal contract. Put `rootRef` on the element that
 * wraps BOTH the trigger and the panel, so a press on the trigger is the
 * trigger's own toggle rather than an outside-close followed by a re-open.
 */
export function usePeerAudioMenu<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<T>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const close = useCallback(() => setOpen(false), []);
  return { open, setOpen, toggle, close, rootRef };
}

/** The glyph says the level, so a turned-down person reads as one at a glance. */
function VolumeGlyph({ volume }: { volume: number }) {
  if (volume === 0) {
    return <VolumeX className="h-3.5 w-3.5 text-danger" />;
  }
  if (volume < 0.5) {
    return <Volume1 className="h-3.5 w-3.5" />;
  }
  return <Volume2 className="h-3.5 w-3.5" />;
}

function VolumeRow({
  label,
  sliderLabel,
  muteLabel,
  unmuteLabel,
  track,
  testId,
}: {
  label: string;
  sliderLabel: string;
  muteLabel: string;
  unmuteLabel: string;
  track: PeerAudioTrack;
  testId: string;
}) {
  const { t } = useTranslation();
  const silenced = track.volume === 0;
  // Where the slider goes back to when the mute button is pressed again. A
  // person who had somebody at 40% and muted them wants 40% back, not 100%.
  const restoreRef = useRef(1);
  useEffect(() => {
    if (track.volume > 0) {
      restoreRef.current = track.volume;
    }
  }, [track.volume]);

  return (
    <div data-testid={testId} className="px-1 pb-1.5 pt-1">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <span className="truncate text-[11px] uppercase tracking-wide text-paper-muted">
          {label}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-paper-muted">
          {t("voice.audio.percent", {
            percent: Math.round(track.volume * 100),
          })}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-pressed={silenced}
          aria-label={silenced ? unmuteLabel : muteLabel}
          onClick={() =>
            track.onSetVolume(silenced ? restoreRef.current : 0)
          }
        >
          <VolumeGlyph volume={track.volume} />
        </Button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={track.volume}
          aria-label={sliderLabel}
          aria-valuetext={t("voice.tile.volumePercent", {
            percent: Math.round(track.volume * 100),
          })}
          onChange={(event) => track.onSetVolume(Number(event.target.value))}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-signal"
        />
      </div>
    </div>
  );
}

/** Which edge of the anchor the panel hangs off. */
export type PeerAudioMenuSide = "top" | "bottom";
export type PeerAudioMenuAlign = "start" | "end";

const SIDE_CLASS: Record<PeerAudioMenuSide, string> = {
  top: "bottom-full mb-1.5",
  bottom: "top-full mt-1.5",
};

const ALIGN_CLASS: Record<PeerAudioMenuAlign, string> = {
  start: "left-0",
  end: "right-0",
};

export function PeerAudioMenu({
  name,
  open,
  voice,
  share,
  failed = false,
  onRetry,
  side = "top",
  align = "start",
  className,
}: {
  name: string;
  open: boolean;
  /** Absent for ourselves: there is no volume knob on your own voice. */
  voice?: PeerAudioTrack;
  /** Present only while this person is sharing a screen that carries sound. */
  share?: PeerAudioTrack;
  failed?: boolean;
  onRetry?: () => void;
  side?: PeerAudioMenuSide;
  align?: PeerAudioMenuAlign;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!open) {
    return null;
  }
  const hasAnything = voice || share || (failed && onRetry);
  if (!hasAnything) {
    return null;
  }
  return (
    <div
      role="dialog"
      data-testid="peer-audio-menu"
      aria-label={t("voice.audio.title", { name })}
      className={cn(
        "absolute z-50 w-56 max-w-[80vw] cursor-default rounded-lg border border-ink-4 bg-ink-2 p-1 text-left shadow-[var(--shadow-popover)] animate-fade-in",
        SIDE_CLASS[side],
        ALIGN_CLASS[align],
        className,
      )}
      // A drag on the slider must not become a drag of the row underneath it,
      // and a click in here must not also be the chip's own click.
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
    >
      <p className="truncate px-2 pb-0.5 pt-1 text-[13px] font-semibold text-paper">
        {name}
      </p>
      {voice && (
        <VolumeRow
          testId="peer-audio-voice"
          label={t("voice.audio.voice")}
          sliderLabel={t("voice.tile.volumeFor", { name })}
          muteLabel={t("voice.tile.mutePeer", { name })}
          unmuteLabel={t("voice.tile.unmutePeer", { name })}
          track={voice}
        />
      )}
      {share && (
        <VolumeRow
          testId="peer-audio-share"
          label={t("voice.audio.share")}
          sliderLabel={t("voice.audio.shareVolumeFor", { name })}
          muteLabel={t("voice.audio.muteShare", { name })}
          unmuteLabel={t("voice.audio.unmuteShare", { name })}
          track={share}
        />
      )}
      {failed && onRetry && (
        <div className="px-1 pb-1 pt-0.5">
          <Button
            variant="secondary"
            size="sm"
            className="h-7 w-full text-xs"
            onClick={onRetry}
          >
            {t("voice.tile.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The round trigger the picture surfaces use: a camera tile's overlay and a
 * share tile's overlay, beside fullscreen and pin. The chip surfaces have no
 * button, because there the person IS the button.
 */
export function PeerAudioMenuButton({
  name,
  open,
  onToggle,
  muted = false,
  className,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
  /** Drawn lit-danger when this person is silenced, the way the old tile did. */
  muted?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const label: MessageKey = "voice.audio.title";
  return (
    <button
      type="button"
      data-testid="peer-audio-open"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={t(label, { name })}
      title={t(label, { name })}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink/70 text-paper hover:bg-ink-4",
        muted && "text-danger",
        open && "bg-ink-4",
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {muted ? (
        <VolumeX className="h-3.5 w-3.5" />
      ) : (
        <Volume2 className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
