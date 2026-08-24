import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  EMOJI_PICKER_SIZE,
  placeAnchoredPanel,
} from "@/lib/anchored-panel";
import { cn } from "@/lib/utils";

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
}

export function EmojiPickerPanel({
  onSelect,
  onClose,
  className,
}: EmojiPickerPanelProps) {
  const slotRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ReturnType<
    typeof placeAnchoredPanel
  > | null>(null);

  useLayoutEffect(() => {
    function place() {
      const anchorEl = slotRef.current?.parentElement;
      if (!anchorEl) {
        return;
      }
      setPlacement(
        placeAnchoredPanel(
          anchorEl.getBoundingClientRect(),
          EMOJI_PICKER_SIZE,
          { width: window.innerWidth, height: window.innerHeight },
        ),
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
        "emoji-mart-shell z-[120] overflow-hidden rounded-lg border border-ink-4 shadow-[var(--shadow-popover)] animate-fade-in",
        className,
      )}
    >
      <Suspense fallback={<div className="h-full w-full animate-pulse bg-ink-2" />}>
        <LazyPanel onSelect={onSelect} />
      </Suspense>
    </div>
  );

  return (
    <>
      <span ref={slotRef} aria-hidden />
      {createPortal(panel, document.body)}
    </>
  );
}
