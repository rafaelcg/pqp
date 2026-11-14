/**
 * The emoji picker's chrome in the app's language (forum QA P2: "Search" and
 * "Frequently used" in English on a pt-BR screen).
 *
 * emoji-mart ships its strings per language, and fetches them from a CDN when
 * it is only told the locale. The app never loads data from there, so the
 * strings are handed in. English is emoji-mart's built-in default and needs
 * nothing. Search still matches the emoji's English keywords: those come from
 * the data set, which has no Portuguese; `emoji-search-pt.ts` adds those.
 */

type PickerStrings = Record<string, unknown> & {
  search?: string;
  categories?: Record<string, string>;
};

export interface EmojiPickerLocale {
  /** emoji-mart's locale id. */
  locale: "en" | "pt" | "es";
  /** Its strings, or undefined for the built-in English. */
  i18n: PickerStrings | undefined;
}

export function emojiPickerLocale(
  appLocale: string,
  bundles: { pt: PickerStrings; es: PickerStrings },
): EmojiPickerLocale {
  if (appLocale.startsWith("pt")) {
    // "Buscar", the word every other search box in the app uses, not
    // emoji-mart's "Procurar".
    // "Resultados", not emoji-mart's "Resultados encontrados": that heading
    // also sits over an empty list when nothing matched.
    return {
      locale: "pt",
      i18n: {
        ...bundles.pt,
        search: "Buscar",
        categories: { ...bundles.pt.categories, search: "Resultados" },
      },
    };
  }
  if (appLocale.startsWith("es")) {
    return { locale: "es", i18n: bundles.es };
  }
  return { locale: "en", i18n: undefined };
}
