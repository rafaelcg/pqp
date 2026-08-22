/**
 * The one place that decides which language the app speaks.
 *
 * Resolution lives here so Clerk, the React provider, and Electron's menu
 * file all ask the same question. `?lang=` outranks `localStorage`, which
 * outranks the OS.
 */

export type Locale = "en" | "pt-BR";

export const DEFAULT_LOCALE: Locale = "en";
export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "pt-BR"];

const STORAGE_KEY = "pqp:locale";
/** `?lang=` accepts the bare language too, since nobody types the region. */
const QUERY_KEY = "lang";

function normalize(value: string | null | undefined): Locale | null {
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  if (lower === "pt-br" || lower === "pt" || lower.startsWith("pt-")) {
    return "pt-BR";
  }
  if (lower === "en" || lower.startsWith("en-")) {
    return "en";
  }
  return null;
}

/**
 * Resolution order, most explicit first:
 *
 * 1. `?lang=` — survives a paste into a chat, which is what makes it the thing
 *    to reach for when somebody reports "it's in the wrong language".
 * 2. A saved preference, once there is UI to set one.
 * 3. What the browser asks for. `languages` rather than `language`, so a
 *    Brazilian user whose OS is English but who lists pt-BR second still gets
 *    Portuguese ahead of the default.
 * 4. English.
 *
 * Every step is wrapped because this runs before first paint: a browser with
 * storage disabled must fall through to the next source, not fail to boot.
 */
export function detectLocale(): Locale {
  try {
    const fromQuery = normalize(
      new URLSearchParams(window.location.search).get(QUERY_KEY),
    );
    if (fromQuery) {
      return fromQuery;
    }
  } catch {
    // Unparseable query string — keep looking.
  }

  try {
    const saved = normalize(window.localStorage.getItem(STORAGE_KEY));
    if (saved) {
      return saved;
    }
  } catch {
    // Storage blocked (private mode, embedded webview) — keep looking.
  }

  try {
    for (const tag of navigator.languages ?? [navigator.language]) {
      const matched = normalize(tag);
      if (matched) {
        return matched;
      }
    }
  } catch {
    // No navigator (SSR, tests) — fall through.
  }

  return DEFAULT_LOCALE;
}

/** Persist a choice, or clear it to go back to following the browser. */
export function setLocalePreference(locale: Locale | null): void {
  try {
    if (locale) {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // A preference we cannot store is not worth failing a click over.
  }
}

/**
 * Keep `<html lang>` truthful. Screen readers pick pronunciation from it and
 * search engines read it, and it ships as `en` in index.html — so a Portuguese
 * page that never updates it is announced with English phonetics.
 */
export function applyDocumentLocale(locale: Locale): void {
  document.documentElement.lang = locale;
}
