import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { useEffect, useRef } from "react";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

interface EmojiPickerPanelProps {
  onSelect: (emoji: string) => void;
  onClose?: () => void;
  className?: string;
}

interface EmojiMartSelection {
  native: string;
}

export function EmojiPickerPanel({
  onSelect,
  onClose,
  className,
}: EmojiPickerPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();

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

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className={cn(
        "emoji-mart-shell z-50 overflow-hidden rounded-lg border border-ink-4 shadow-[var(--shadow-popover)] animate-rise",
        className,
      )}
    >
      <Picker
        data={data}
        theme={resolved}
        previewPosition="none"
        skinTonePosition="none"
        navPosition="bottom"
        perLine={8}
        maxFrequentRows={1}
        // This panel now opens from the keyboard as often as from a click
        // (the row's context menu, or the toolbar's + once the row is
        // focused) — autoFocus is emoji-mart's own supported hook for
        // landing in its search field on mount, rather than reaching into
        // its shadow DOM from outside.
        autoFocus
        onEmojiSelect={(emoji: EmojiMartSelection) => {
          onSelect(emoji.native);
        }}
      />
    </div>
  );
}
