import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { useEffect, useRef } from "react";
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
        "emoji-mart-shell z-50 overflow-hidden rounded-lg border border-ink-4 shadow-[0_12px_40px_oklch(0.1_0.02_250/0.55)] animate-rise",
        className,
      )}
    >
      <Picker
        data={data}
        theme="dark"
        previewPosition="none"
        skinTonePosition="none"
        navPosition="bottom"
        perLine={8}
        maxFrequentRows={1}
        onEmojiSelect={(emoji: EmojiMartSelection) => {
          onSelect(emoji.native);
        }}
      />
    </div>
  );
}
