import type { ServerEmoji } from "@pqp/shared";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ContainedChunkBoundary } from "@/components/error-boundary";
import {
  EMOJI_PICKER_SIZE,
  placeAnchoredPanel,
} from "@/lib/anchored-panel";
import { alignPanelEnd } from "@/lib/composer-picker-place";
import { isRedesignOn } from "@/lib/redesign";
import { cn } from "@/lib/utils";
import { POPOVER_SURFACE } from "@/components/ui/popover";

/**
 * `@emoji-mart/data` is ~80 KB gzipped of pure data. Loading it lazily keeps it
 * out of the initial bundle for the (many) sessions that never open the picker.
 */
const LazyPanel = lazy(() =>
  import("./emoji-picker-panel").then((module) => ({
    default: module.EmojiPickerPanel,
  })),
);

interface EmojiPickerPanelProps {
  onSelect: (emoji: string) => void;
  onClose?: () => void;
  className?: string;
  /**
   * The server's own emoji, shown as their own category. A pick arrives as the
   * `:name:` text the composer expands on send. Omit where only Unicode can be
   * stored (reactions, forum tags, Baú).
   */
  customEmoji?: readonly ServerEmoji[] | null;
  /**
   * Opt-in, for the composer under the redesign at sm and up: open upward
   * from `bounds` (the composer) with the panel's right edge on `anchor`'s
   * right edge (the emoji button), kept inside `bounds`. Read on each
   * placement. Returning null, or leaving it out, keeps the default: the
   * panel's left edge on this component's parent.
   */
  alignEndTo?: () => { anchor: HTMLElement; bounds: HTMLElement } | null;
}

export function EmojiPickerPanel({
  onSelect,
  onClose,
  className,
  customEmoji,
  alignEndTo,
}: EmojiPickerPanelProps) {
  const slotRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ReturnType<
    typeof placeAnchoredPanel
  > | null>(null);

  const alignEndToRef = useRef(alignEndTo);
  alignEndToRef.current = alignEndTo;

  useLayoutEffect(() => {
    function place() {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const endAligned = alignEndToRef.current?.();
      if (endAligned) {
        const bounds = endAligned.bounds.getBoundingClientRect();
        const vertical = placeAnchoredPanel(bounds, EMOJI_PICKER_SIZE, viewport);
        const across = alignPanelEnd(
          endAligned.anchor.getBoundingClientRect().right,
          bounds,
          vertical.maxWidth,
        );
        setPlacement({ ...vertical, left: across.left, maxWidth: across.width });
        return;
      }
      const anchorEl = slotRef.current?.parentElement;
      if (!anchorEl) {
        return;
      }
      setPlacement(
        placeAnchoredPanel(anchorEl.getBoundingClientRect(), EMOJI_PICKER_SIZE, viewport),
      );
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!panelRef.current?.contains(event.target as Node)) {
        onClose?.();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // This Escape is spent: the unread strip and other layers skip it.
        // Only under the redesign, where the strip is; the old look's layers
        // each still hear it.
        if (isRedesignOn()) {
          event.preventDefault();
        }
        onClose?.();
      }
    }
    // Opening from a row at the bottom of a sticky-to-bottom log can shift
    // scrollHeight in the same frame. Ignore that burst so the picker is not
    // dismissed before it paints.
    let scrollArmed = false;
    const armScroll = window.setTimeout(() => {
      scrollArmed = true;
    }, 80);
    function handleScroll(event: Event) {
      if (!scrollArmed) {
        return;
      }
      if (panelRef.current?.contains(event.target as Node)) {
        return;
      }
      onClose?.();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      window.clearTimeout(armScroll);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  const panel = (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        width: placement?.maxWidth,
        height: placement?.maxHeight,
        visibility: placement ? "visible" : "hidden",
      }}
      className={cn(
        // Under the redesign 6px under the category bar, so its active
        // underline does not sit on the panel's edge and corner.
        "emoji-mart-shell z-[120] overflow-hidden animate-fade-in redesign:pb-1.5",
        POPOVER_SURFACE,
        className,
      )}
    >
      {/* A stale chunk costs this panel and nothing else: the root boundary
          would take the whole app, a call's screens included. */}
      <ContainedChunkBoundary nested>
        <Suspense fallback={<div className="h-full w-full animate-pulse bg-ink-2 redesign:bg-[color:var(--popover-surface)]" />}>
          <LazyPanel onSelect={onSelect} customEmoji={customEmoji} />
        </Suspense>
      </ContainedChunkBoundary>
    </div>
  );

  return (
    <>
      <span ref={slotRef} aria-hidden />
      {createPortal(panel, document.body)}
    </>
  );
}
