import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { SM_UP_QUERY, useMediaQuery } from "@/components/ui/use-media-query";
import { POPOVER_OWN_EDGE, POPOVER_SURFACE } from "@/components/ui/popover";
import { useTranslation } from "@/lib/i18n";
import {
  MUSIC_VOLUME_STEP,
  nudgedVolume,
  volumeGlyph,
  wheelSteps,
  type MusicVolumeGlyph,
} from "@/lib/music-volume";
import { cn } from "@/lib/utils";

/**
 * THE SPEAKER ON THE MUSIC BAR, AND THE LEVEL BEHIND IT.
 *
 * One component for the sidebar radio and the call's composer, over one
 * store (`music-local-playback.ts`), so the two cannot disagree. The level is
 * personal: this machine's iframe, never the socket.
 *
 * The button is a mute toggle on a mouse and the level lives in a slider
 * that floats above it while the pointer is over the speaker or keyboard
 * focus is on it (a sibling in the DOM, so Tab goes button then slider). With
 * no hover to use, or a window narrower than the rail's own breakpoint, a
 * tap opens the same slider in a small popover with a mute switch instead,
 * because a tap cannot be both "mute" and "show me the level". The wheel
 * over the speaker moves it five percent a notch. In a composer wide enough
 * to have room the slider stays inline, as before.
 */

const GLYPHS: Record<MusicVolumeGlyph, typeof Volume> = {
  muted: VolumeX,
  low: Volume,
  medium: Volume1,
  high: Volume2,
};

/** How long the flyout outlives the pointer, so the gap to it can be crossed. */
const HOVER_CLOSE_MS = 220;
/** And after a wheel notch, long enough to read where it landed. */
const WHEEL_CLOSE_MS = 900;

export function MusicSpeakerControl({
  volume,
  muted,
  slider = false,
  onMute,
  onVolume,
}: {
  volume: number;
  muted: boolean;
  /** The composer has the width for an inline slider on a wide bar. */
  slider?: boolean;
  onMute: () => void;
  onVolume: (value: number) => void;
}) {
  const { t } = useTranslation();
  const shown = muted || volume === 0 ? 0 : volume;
  const finePointer = useMediaQuery("(hover: hover) and (pointer: fine)", true);
  const wide = useMediaQuery(SM_UP_QUERY, true);
  const hoverMode = finePointer && wide;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const closeTimer = useRef<number | null>(null);
  /** Escape hands focus back to the speaker, which must not reopen it. */
  const skipFocusOpen = useRef(false);
  const carry = useRef(0);
  const latest = useRef({ volume, muted, onVolume });
  latest.current = { volume, muted, onVolume };

  const clearTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const closeSoon = useCallback(
    (ms: number) => {
      clearTimer();
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setHovered(false);
      }, ms);
    },
    [clearTimer],
  );
  useEffect(() => clearTimer, [clearTimer]);

  // Leaving hover mode (a window resized, a tablet docked) drops what it held.
  useEffect(() => {
    if (hoverMode) {
      setPinned(false);
    } else {
      setHovered(false);
      setFocused(false);
    }
  }, [hoverMode]);

  const open = hoverMode ? hovered || focused : pinned;

  // The wheel needs `preventDefault`, which React's root listener (passive)
  // cannot do, so this one is native and lives on the speaker alone.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) {
        return;
      }
      event.preventDefault();
      const moved = wheelSteps(carry.current, event.deltaY, event.deltaMode);
      carry.current = moved.carry;
      if (moved.steps === 0) {
        return;
      }
      const now = latest.current;
      const next = nudgedVolume(
        { volume: now.volume, muted: now.muted, restoreVolume: now.volume },
        moved.steps,
      );
      if (next.volume !== now.volume || next.muted !== now.muted) {
        now.onVolume(next.volume);
      }
      setHovered(true);
      closeSoon(WHEEL_CLOSE_MS);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [closeSoon]);

  // A tap outside, or Escape, puts the popover away.
  useEffect(() => {
    if (!pinned) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) {
        setPinned(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pinned]);

  const Glyph = GLYPHS[volumeGlyph(shown)];
  const label = hoverMode
    ? shown === 0
      ? t("music.unmute")
      : t("music.mute")
    : t("music.volume");

  return (
    <div
      ref={rootRef}
      data-music-speaker-root=""
      data-music-speaker-mode={hoverMode ? "hover" : "tap"}
      className="relative flex shrink-0 items-center gap-1"
      onPointerEnter={(event) => {
        if (hoverMode && event.pointerType !== "touch") {
          clearTimer();
          setHovered(true);
        }
      }}
      onPointerLeave={(event) => {
        if (hoverMode && event.pointerType !== "touch") {
          closeSoon(HOVER_CLOSE_MS);
        }
      }}
      onFocus={(event) => {
        if (skipFocusOpen.current) {
          skipFocusOpen.current = false;
          return;
        }
        if (!hoverMode) {
          return;
        }
        let visible = true;
        try {
          visible = (event.target as HTMLElement).matches(":focus-visible");
        } catch {
          // An engine without the selector: treat focus as keyboard focus.
        }
        // A mouse click leaves focus on the button; that must not pin it open.
        if (visible) {
          setFocused(true);
        }
      }}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) {
          return;
        }
        event.stopPropagation();
        clearTimer();
        setHovered(false);
        setFocused(false);
        setPinned(false);
        const button = buttonRef.current;
        if (button && document.activeElement !== button) {
          skipFocusOpen.current = true;
          button.focus();
        }
      }}
    >
      <Tooltip label={label} side="bottom">
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="icon"
          data-music-speaker=""
          className="h-8 w-8 shrink-0 pointer-coarse:h-11 pointer-coarse:w-11"
          aria-pressed={hoverMode ? shown === 0 : undefined}
          aria-haspopup={hoverMode ? undefined : "true"}
          aria-expanded={hoverMode ? undefined : pinned}
          onClick={() => {
            if (hoverMode) {
              onMute();
            } else {
              setPinned((value) => !value);
            }
          }}
        >
          <Glyph className="h-4 w-4" aria-hidden="true" data-music-glyph={volumeGlyph(shown)} />
        </Button>
      </Tooltip>
      {slider ? (
        <Slider
          variant="volume"
          data-music-volume=""
          value={shown}
          min={0}
          max={100}
          step={MUSIC_VOLUME_STEP}
          aria-label={t("music.volume")}
          aria-valuetext={t("music.volume.valueText", { percent: shown })}
          className="hidden w-20 shrink-0 @min-[40rem]:flex pointer-coarse:h-11"
          onValueChange={onVolume}
        />
      ) : null}
      {open ? (
        <div
          role="group"
          aria-label={t("music.volume")}
          data-music-volume-flyout=""
          className={cn(
            "absolute bottom-full right-0 z-50 mb-2 w-52 animate-fade-in",
            POPOVER_SURFACE,
            POPOVER_OWN_EDGE,
            // Its fill only repeats the level-3 default, so under the
            // redesign it follows the popover's.
            "border border-border bg-surface-2 p-2 text-text redesign:bg-[color:var(--popover-surface)]",
            // The composer shows its slider inline once it is wide enough.
            slider && "@min-[40rem]:hidden",
          )}
        >
          <div className="flex items-center gap-2 px-1">
            <Slider
              variant="volume"
              data-music-volume=""
              value={shown}
              min={0}
              max={100}
              step={MUSIC_VOLUME_STEP}
              aria-label={t("music.volume")}
              aria-valuetext={t("music.volume.valueText", { percent: shown })}
              className="min-w-0 flex-1 pointer-coarse:h-11"
              onValueChange={onVolume}
            />
            <span
              aria-hidden="true"
              className="w-9 shrink-0 text-right text-[11px] tabular-nums text-text-secondary"
            >
              {`${shown}%`}
            </span>
          </div>
          {hoverMode ? null : (
            <Switch
              label={t("music.mute")}
              checked={shown === 0}
              onCheckedChange={() => onMute()}
              className="mt-1 pointer-coarse:min-h-11"
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
