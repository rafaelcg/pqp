import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { useTheme } from "@/hooks/use-theme";

interface EmojiPickerPanelProps {
  onSelect: (emoji: string) => void;
}

interface EmojiMartSelection {
  native: string;
}

export function EmojiPickerPanel({ onSelect }: EmojiPickerPanelProps) {
  const { resolved } = useTheme();

  return (
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
  );
}
