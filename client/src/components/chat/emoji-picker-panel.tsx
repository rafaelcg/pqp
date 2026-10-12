import data from "@emoji-mart/data";
import es from "@emoji-mart/data/i18n/es.json";
import pt from "@emoji-mart/data/i18n/pt.json";
import Picker from "@emoji-mart/react";
import { useTheme } from "@/hooks/use-theme";
import { useTranslation } from "@/lib/i18n";
import { emojiPickerLocale } from "@/lib/emoji-picker-locale";

interface EmojiPickerPanelProps {
  onSelect: (emoji: string) => void;
}

interface EmojiMartSelection {
  native: string;
}

export function EmojiPickerPanel({ onSelect }: EmojiPickerPanelProps) {
  const { resolved } = useTheme();
  const { locale } = useTranslation();
  // The picker's own chrome ("Search", "Frequently used", the category
  // names) follows the app's language. emoji-mart ships those strings; they
  // are passed in rather than fetched, because its default for a locale is a
  // request to a CDN this app does not load scripts or data from.
  const picker = emojiPickerLocale(locale, { pt, es });

  return (
    <Picker
      data={data}
      theme={resolved}
      locale={picker.locale}
      i18n={picker.i18n}
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
