import data from "@emoji-mart/data";
import es from "@emoji-mart/data/i18n/es.json";
import pt from "@emoji-mart/data/i18n/pt.json";
import Picker from "@emoji-mart/react";
import { useTheme } from "@/hooks/use-theme";
import { useTranslation } from "@/lib/i18n";
import { emojiPickerLocale } from "@/lib/emoji-picker-locale";
import { serverEmojiImageUrl } from "@/lib/server-emoji";
import type { ServerEmoji } from "@pqp/shared";
import { useMemo } from "react";

interface EmojiPickerPanelProps {
  onSelect: (emoji: string) => void;
  customEmoji?: readonly ServerEmoji[] | null;
}

interface EmojiMartSelection {
  id: string;
  native?: string;
}

/**
 * The server's row comes last, where emoji-mart puts a custom category. Its
 * `categories` prop cannot move it: emoji-mart keeps one module-wide copy of
 * the category list from the first picker a tab opened, and sorts from that
 * copy. A reaction picker opened first meant no server row at all, and the
 * first server's row followed the reader into every other server.
 */
const CUSTOM_CATEGORY_ID = "server";
/** Prefixed so a custom `fire` can never collide with emoji-mart's own `fire`. */
const CUSTOM_ID_PREFIX = "pqp-custom-";

export function EmojiPickerPanel({ onSelect, customEmoji }: EmojiPickerPanelProps) {
  const { resolved } = useTheme();
  const { locale, t } = useTranslation();
  const custom = useMemo(() => {
    const emojis = (customEmoji ?? []).flatMap((emoji) => {
      const src = serverEmojiImageUrl(emoji);
      return src
        ? [{ id: `${CUSTOM_ID_PREFIX}${emoji.id}`, name: `:${emoji.name}:`, keywords: [emoji.name], skins: [{ src }] }]
        : [];
    });
    return emojis.length > 0
      ? [{ id: CUSTOM_CATEGORY_ID, name: t("emojiPicker.serverCategory"), emojis }]
      : [];
  }, [customEmoji, t]);
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
      custom={custom}
      onEmojiSelect={(emoji: EmojiMartSelection) => {
        if (emoji.native) {
          onSelect(emoji.native);
          return;
        }
        const picked = customEmoji?.find(
          (entry) => `${CUSTOM_ID_PREFIX}${entry.id}` === emoji.id,
        );
        if (picked) {
          onSelect(`:${picked.name}:`);
        }
      }}
    />
  );
}
