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
 * The locale the edge already picked for THIS document, if it wrote one.
 *
 * `client/functions/_middleware.ts` negotiates a locale per request and stamps
 * it into the head it injects, so this is the server's answer to the same
 * question, for the same page load. It is deliberately consulted before
 * `navigator.languages`, and the reason is a bug that cost real traffic.
 *
 * A crawler's fetch and a crawler's renderer are two different clients. Google
 * fetches the HTML with no `Accept-Language`, so the edge correctly serves the
 * Portuguese head; Google then renders that document in a headless Chrome that
 * reports `navigator.languages === ["en-US"]`. Without this step the app boots
 * in English and `Seo` overwrites the Portuguese title, description and
 * `<html lang>` with the English ones — and the rendered DOM is what gets
 * indexed. Verified live on 2026-08-27: pqp.gg served
 * `<title>pqp: o chat em grupo é seu</title>` and rendered
 * `pqp: group chat you own`. The body is JS-only, so English was the ONLY copy
 * an index could have held for a Portuguese-first site.
 *
 * For a real browser this changes nothing: `Accept-Language` and
 * `navigator.languages` come from the same setting, so the edge and the client
 * already agree. It only bites where they disagree, which is exactly the
 * automated clients this is for.
 */
function fromServedDocument(): Locale | null {
  try {
    const el = document.querySelector('meta[name="pqp:locale"]');
    return normalize(el?.getAttribute("content"));
  } catch {
    return null;
  }
}

/**
 * Resolution order, most explicit first:
 *
 * 1. `?lang=` — survives a paste into a chat, which is what makes it the thing
 *    to reach for when somebody reports "it's in the wrong language".
 * 2. A saved preference, once there is UI to set one.
 * 3. The locale the edge wrote into this document — see `fromServedDocument`.
 * 4. What the browser asks for. `languages` rather than `language`, so a
 *    Brazilian user whose OS is English but who lists pt-BR second still gets
 *    Portuguese ahead of the default.
 * 5. English.
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

  const served = fromServedDocument();
  if (served) {
    return served;
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
