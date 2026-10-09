import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useFullscreenPortalHost } from "@/components/ui/tooltip";
import {
  placeAnchoredPanel,
  type AnchoredPanelPlacement,
} from "@/lib/anchored-panel";
import { useTranslation } from "@/lib/i18n";
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
 *
 * A SURFACE THAT CLIPS PASSES `anchorRef`. The panel normally hangs off its
 * trigger with `position: absolute`, which is invisible inside a scrolling
 * row: the listener strip under the stage is `overflow-x-auto` inside an
 * `overflow-hidden` stage, and the panel opened there, in the DOM, where
 * nobody could see it. With an anchor it is portalled out instead, fixed to
 * the viewport beside that anchor.
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
 * A portalled panel is not inside that element, so it takes `panelRef` too.
 */
export function usePeerAudioMenu<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<T>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
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
  return { open, setOpen, toggle, close, rootRef, panelRef };
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
          onClick={() => track.onSetVolume(silenced ? restoreRef.current : 0)}
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
  anchorRef,
  panelRef,
  onClose,
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
  /**
   * The trigger, for a surface whose ancestors clip. Given, the panel is
   * portalled and placed beside it; `align` and `className` positioning then
   * do not apply. Pair it with the hook's `panelRef`.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLDivElement | null>;
  /**
   * Closes the panel. A portalled panel needs it: it is no longer next to its
   * trigger in the DOM, so Tab out of it closes it and hands the focus back to
   * the anchor rather than letting the key wander off to the end of the page.
   */
  onClose?: () => void;
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
  const label = t("voice.audio.title", { name });
  const body = (
    <>
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
    </>
  );
  if (anchorRef) {
    return (
      <AnchoredPanel
        label={label}
        anchorRef={anchorRef}
        panelRef={panelRef}
        onClose={onClose}
        side={side}
        className={className}
      >
        {body}
      </AnchoredPanel>
    );
  }
  return (
    <div
      role="dialog"
      data-testid="peer-audio-menu"
      aria-label={label}
      className={cn(
        PANEL_CLASS,
        "absolute",
        SIDE_CLASS[side],
        ALIGN_CLASS[align],
        className,
      )}
      {...PANEL_GUARDS}
    >
      {body}
    </div>
  );
}

const PANEL_CLASS =
  "z-50 w-56 max-w-[80vw] cursor-default rounded-lg border border-ink-4 bg-ink-2 p-1 text-left shadow-[var(--shadow-popover)] animate-fade-in";

const PANEL_GUARDS = {
  // A drag on the slider must not become a drag of the row underneath it,
  // and a click in here must not also be the chip's own click. React bubbles
  // through a portal by component tree, so the portalled panel needs these
  // exactly as much as the nested one.
  onClick: (event: ReactMouseEvent) => event.stopPropagation(),
  onPointerDown: (event: ReactPointerEvent) => event.stopPropagation(),
  draggable: false,
  onDragStart: (event: DragEvent) => event.preventDefault(),
};

function samePlacement(
  a: AnchoredPanelPlacement | null,
  b: AnchoredPanelPlacement,
): boolean {
  return (
    a !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.maxHeight === b.maxHeight &&
    a.maxWidth === b.maxWidth
  );
}

/**
 * The panel portalled out of a clipping surface, fixed beside its anchor.
 *
 * Into the fullscreen element when there is one, for the reason `Menu` gives:
 * a body portal behind a fullscreen stage is the same invisible panel again.
 * Placed after it has been measured (the height depends on which rows it
 * carries), and placed again on every render, resize and scroll, because the
 * strip scrolls sideways and reflows as people come and go.
 *
 * It takes focus when it appears and gives it back to the anchor when it goes,
 * so the keyboard still reaches a panel that now sits at the end of the page.
 */
function AnchoredPanel({
  label,
  anchorRef,
  panelRef,
  onClose,
  side,
  className,
  children,
}: {
  label: string;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef?: RefObject<HTMLDivElement | null>;
  onClose?: () => void;
  side: PeerAudioMenuSide;
  className?: string;
  children: ReactNode;
}) {
  const host = useFullscreenPortalHost();
  const ownRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<AnchoredPanelPlacement | null>(
    null,
  );

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = ownRef.current;
    if (!anchor || !panel) {
      return;
    }
    const next = placeAnchoredPanel(
      anchor.getBoundingClientRect(),
      { width: panel.offsetWidth, height: panel.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
      side === "top" ? "above" : "below",
    );
    setPlacement((current) => (samePlacement(current, next) ? current : next));
  }, [anchorRef, side]);

  // No dependency list on purpose: a row appearing, or the chip moving
  // because somebody joined, re-renders this and must re-place it.
  useLayoutEffect(place);

  useEffect(() => {
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [place]);

  // Layout, not passive: the cleanup has to run while the panel is still in
  // the document, or the focus has already fallen to the body.
  const placed = placement !== null;
  useLayoutEffect(() => {
    if (!placed) {
      return;
    }
    const panel = ownRef.current;
    panel?.focus({ preventScroll: true });
    const anchor = anchorRef.current;
    return () => {
      // Only when the focus is still ours: a press elsewhere closes the panel
      // and must keep whatever it pressed.
      if (panel?.contains(document.activeElement)) {
        anchor?.focus({ preventScroll: true });
      }
    };
  }, [placed, anchorRef]);

  // The panel sits at the end of the document, so the browser's own Tab order
  // would drop the keyboard there. Leaving either end of it closes it and puts
  // the focus back where it opened from: Tab from the last control carries on
  // from the anchor to whatever follows it, Shift+Tab from the first control
  // lands on the anchor itself, which is where it was before the panel moved.
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const panel = ownRef.current;
      if (event.key !== "Tab" || !panel || !onClose) {
        return;
      }
      const stops = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      const leavingBackwards =
        event.shiftKey && (active === panel || active === first || !first);
      const leavingForwards = !event.shiftKey && (active === last || !last);
      if (!leavingBackwards && !leavingForwards) {
        return;
      }
      if (leavingBackwards) {
        event.preventDefault();
      }
      anchorRef.current?.focus({ preventScroll: true });
      onClose();
    },
    [anchorRef, onClose],
  );

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      ownRef.current = node;
      if (panelRef) {
        panelRef.current = node;
      }
    },
    [panelRef],
  );

  return createPortal(
    <div
      ref={setRefs}
      role="dialog"
      data-testid="peer-audio-menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        maxHeight: placement?.maxHeight,
        visibility: placed ? "visible" : "hidden",
      }}
      className={cn(
        PANEL_CLASS,
        "z-[100] overflow-y-auto overscroll-contain focus:outline-none",
        className,
      )}
      {...PANEL_GUARDS}
    >
      {children}
    </div>,
    host ?? document.body,
  );
}

/**
 * A picture's own sound, on the picture: the mute button and the slider side
 * by side, always drawn, the way a video player's bar draws them. The watch
 * party's player has the same pair (`hls-watch-player.tsx`).
 *
 * ONE SOUND PER PICTURE. A share sets the share's audio, which is what the
 * person watching it is listening to; a share that carries none, and a
 * camera, set the person's voice. The panel with both rows stays where a
 * person is a chip rather than a picture: the sidebar row, the people strip,
 * the faces in the composer. A slider behind a click on the picture was one
 * more step for the one control people reach for mid-share.
 */
export function PictureVolume({
  name,
  track,
  kind,
  className,
  ignoreChange,
}: {
  name: string;
  track: PeerAudioTrack;
  kind: "voice" | "share";
  className?: string;
  /**
   * True while the press in progress only wakes faded controls. A range
   * input moves on the press itself, so that first touch must not change
   * anybody's volume.
   */
  ignoreChange?: () => boolean;
}) {
  const { t } = useTranslation();
  const silenced = track.volume === 0;
  // Unmute goes back to where it was, not to 100%.
  const restoreRef = useRef(1);
  useEffect(() => {
    if (track.volume > 0) {
      restoreRef.current = track.volume;
    }
  }, [track.volume]);
  const muteLabel =
    kind === "share"
      ? t("voice.audio.muteShare", { name })
      : t("voice.tile.mutePeer", { name });
  const unmuteLabel =
    kind === "share"
      ? t("voice.audio.unmuteShare", { name })
      : t("voice.tile.unmutePeer", { name });
  return (
    <div
      data-testid="picture-volume"
      data-picture-volume={kind}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink/70 pl-0.5 pr-0.5 text-paper @min-[20rem]/picture:pr-2.5",
        className,
      )}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        // The label says the action, mute or unmute. A pressed state on top
        // of it was announced as a second, contradicting one.
        aria-label={silenced ? unmuteLabel : muteLabel}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-full hover:bg-ink-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal",
          silenced && "text-danger",
        )}
        onClick={() => track.onSetVolume(silenced ? restoreRef.current : 0)}
      >
        {silenced ? (
          <VolumeX className="h-3.5 w-3.5" />
        ) : track.volume < 0.5 ? (
          <Volume1 className="h-3.5 w-3.5" />
        ) : (
          <Volume2 className="h-3.5 w-3.5" />
        )}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={track.volume}
        aria-label={
          kind === "share"
            ? t("voice.audio.shareVolumeFor", { name })
            : t("voice.tile.volumeFor", { name })
        }
        aria-valuetext={t("voice.tile.volumePercent", {
          percent: Math.round(track.volume * 100),
        })}
        onChange={(event) => {
          if (ignoreChange?.()) {
            return;
          }
          track.onSetVolume(Number(event.target.value));
        }}
        // Hidden on a narrow picture (its row under 20rem), where it squeezed
        // the name to three letters. The mute button stays, and the sidebar
        // still has the full panel.
        className="hidden h-1 w-20 cursor-pointer accent-signal @min-[20rem]/picture:block"
      />
    </div>
  );
}
