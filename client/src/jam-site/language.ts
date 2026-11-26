import { jamLanguage } from "@/lib/i18n/jam-site";
import { setLocalePreference, type Locale } from "@/lib/locale";

/**
 * The public site's language choice, the browser half. The rules of WHICH
 * language is shown are `lib/locale.ts`'s (`?lang=`, a saved choice, the
 * document the edge wrote, the browser) and are not touched here: this file only
 * lets a visitor make the first two, and hands the choice on.
 *
 * The switch is the app's own `language-picker.tsx` shape: write the saved
 * choice (`pqp:locale`, the key the app reads too, so on the `/jam` mount the
 * app agrees) and reload, with `?lang=` dropped when the choice was stored
 * (it would outrank the very choice being applied) and set when storage is
 * blocked (the only way THIS load can honour the click).
 */

/** The three languages, each in its own, as every language menu writes them. */
export const JAM_LANGUAGES: ReadonlyArray<{ locale: Locale; label: string }> = [
  { locale: "pt-BR", label: "Português" },
  { locale: "en", label: "English" },
  { locale: "es", label: "Español" },
];

/**
 * Did the visitor ask for a language, as opposed to the browser implying one?
 * Only an asked-for language rides into the app (`withLanguage`): the app
 * already infers the same one from the same browser, so repeating it on every
 * link would be noise on every address, and only a click or a link that said
 * `?lang=` can make the app disagree with the browser.
 */
let explicit = false;

/** Once, at boot, before the site moves with `pushState` and the address stops saying it. */
export function rememberLanguageArrival(): void {
  const query = new URLSearchParams(window.location.search).has("lang");
  try {
    explicit = query || window.localStorage.getItem("pqp:locale") !== null;
  } catch {
    explicit = query;
  }
}

/**
 * The address to reload to for a choice: the same path, query (`ref`, `utm_*`,
 * a clip's own parameters) and hash, with `?lang=` removed once the choice is
 * stored, or set to it when it could not be.
 */
export function languageSwitchHref(current: string, next: Locale, persisted: boolean): string {
  const url = new URL(current);
  if (persisted) {
    url.searchParams.delete("lang");
  } else {
    url.searchParams.set("lang", next);
  }
  return url.toString();
}

/** Save the choice and reload into it. */
export function chooseLanguage(next: Locale): void {
  const persisted = setLocalePreference(next);
  explicit = true;
  try {
    window.location.assign(languageSwitchHref(window.location.href, next, persisted));
  } catch {
    window.location.reload();
  }
}

/** `lang=<locale>` when the visitor chose one, else null. */
export function languageParam(): string | null {
  return explicit ? jamLanguage() : null;
}

/**
 * A link to the app with the visitor's chosen language on it. The app reads
 * `?lang=` first (`detectLocale`), so its first screen, the sign-up included,
 * speaks it. The app does not keep it across the sign-up redirect (that is its
 * own business), and nothing is invented for that here.
 */
export function withLanguage(href: string): string {
  const lang = languageParam();
  return lang === null ? href : `${href}${href.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang)}`;
}
