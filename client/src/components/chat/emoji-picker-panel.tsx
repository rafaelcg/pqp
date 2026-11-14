import data from "@emoji-mart/data";
import es from "@emoji-mart/data/i18n/es.json";
import pt from "@emoji-mart/data/i18n/pt.json";
import Picker from "@emoji-mart/react";
import { useTheme } from "@/hooks/use-theme";
import { useTranslation } from "@/lib/i18n";
import { emojiPickerLocale } from "@/lib/emoji-picker-locale";
import {
  emptySearchStyle,
  ensurePortugueseSearch,
  type SearchableEmoji,
} from "@/lib/emoji-search-pt";
import { serverEmojiImageUrl } from "@/lib/server-emoji";
import type { ServerEmoji } from "@pqp/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRedesign } from "@/lib/redesign";

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
  const redesign = useRedesign();

  // Portuguese words have to be in emoji-mart's data before its first init
  // reads it, so a pt-BR picker waits for them (a local chunk, no network).
  const wantsPt = picker.locale === "pt";
  const [ptReady, setPtReady] = useState(!wantsPt);
  useEffect(() => {
    if (!wantsPt) {
      setPtReady(true);
      return;
    }
    let live = true;
    void ensurePortugueseSearch(
      (data as { emojis: Record<string, SearchableEmoji> }).emojis,
    ).then(() => {
      if (live) {
        setPtReady(true);
      }
    });
    return () => {
      live = false;
    };
  }, [wantsPt]);

  // emoji-mart keeps its "nothing found" text in a preview bar this panel
  // hides, so the empty result list says nothing. Draw it into the picker's
  // shadow root.
  const noResults = t("emojiPicker.noResults");
  const slotRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const wrapper = slotRef.current?.previousElementSibling;
    // A constructed sheet, not a <style>: the picker's first render clears
    // any child it did not make, and a <style> added here went with it.
    if (!wrapper || typeof CSSStyleSheet === "undefined") {
      return;
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(emptySearchStyle(noResults));
    const roots = new Set<ShadowRoot>();
    // emoji-mart's React wrapper replaces its element when it mounts twice
    // (Strict Mode, a remount), so the sheet follows whichever one is there.
    const adopt = () => {
      const root = wrapper.querySelector("em-emoji-picker")?.shadowRoot;
      if (root && !roots.has(root) && "adoptedStyleSheets" in root) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
        roots.add(root);
      }
    };
    adopt();
    const watch = new MutationObserver(adopt);
    watch.observe(wrapper, { childList: true });
    return () => {
      watch.disconnect();
      for (const root of roots) {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter(
          (one) => one !== sheet,
        );
      }
    };
  }, [noResults, ptReady]);

  if (!ptReady) {
    return (
      <div className="h-full w-full animate-pulse bg-ink-2 redesign:bg-[color:var(--popover-surface)]" />
    );
  }

  return (
    <>
    <Picker
      data={data}
      theme={resolved}
      locale={picker.locale}
      i18n={picker.i18n}
      previewPosition="none"
      skinTonePosition="none"
      navPosition="bottom"
      perLine={8}
      // Under the redesign the grid fills the 336px popover edge to edge
      // (8 x 38 plus the picker's padding); the default 36 left a gutter.
      emojiButtonSize={redesign ? 38 : undefined}
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
    <span ref={slotRef} hidden />
    </>
  );
}
