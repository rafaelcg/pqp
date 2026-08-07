import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { applyDocumentLocale, detectLocale, type Locale } from "@/lib/locale";
import {
  loadCatalogue,
  setActiveCatalogue,
  translate,
  type MessageKey,
  type MessageVars,
  type PartialMessages,
} from "./catalogue";

export type { MessageKey } from "./catalogue";
export { translateMessage } from "./catalogue";

/**
 * The app's language, decided once and shared.
 *
 * `lib/locale.ts` stays the only thing that answers "what language is this" —
 * this provider calls `detectLocale()` and then everything downstream reads the
 * answer from context rather than asking again. Clerk's localization is wired to
 * the same value in `main.tsx` for exactly that reason.
 */

export interface Translator {
  locale: Locale;
  t: (key: MessageKey, vars?: MessageVars) => string;
}

const I18nContext = createContext<Translator | null>(null);

/**
 * Non-English catalogues are fetched, not bundled — the same treatment
 * `main.tsx` gives Clerk's pt-BR strings, and for the same reason: an English
 * visitor should not download Portuguese.
 *
 * The cost is a first paint in English for a Portuguese reader. It is a narrow
 * window (the chunk is a few KB from the same origin, requested during mount)
 * and it is the right trade against making every visitor pay for every language.
 * The module-level cache below closes it entirely on the second mount, which is
 * what StrictMode's double-render and any remount actually hit.
 */
const cache = new Map<Locale, PartialMessages | undefined>();
const inflight = new Map<Locale, Promise<void>>();

function ensureCatalogue(locale: Locale): Promise<void> {
  const existing = inflight.get(locale);
  if (existing) {
    return existing;
  }
  const promise = loadCatalogue(locale)
    .then((catalogue) => {
      cache.set(locale, catalogue);
    })
    .catch(() => {
      // A blocked or failed chunk leaves English on screen, which is a working
      // page. Cache the miss so we do not retry on every render; a reload is
      // the recovery, and it is a better one than a request loop.
      cache.set(locale, undefined);
    });
  inflight.set(locale, promise);
  return promise;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // Detect once. Re-detecting per render would let a `?lang=` change mid-session
  // swap the language under a mounted tree, which nothing here is built for.
  const [locale] = useState(detectLocale);
  const [catalogue, setCatalogue] = useState<PartialMessages | undefined>(() => {
    const ready = cache.get(locale);
    setActiveCatalogue(ready);
    return ready;
  });

  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  useEffect(() => {
    if (cache.has(locale)) {
      return;
    }
    let cancelled = false;
    void ensureCatalogue(locale).then(() => {
      if (!cancelled) {
        const loaded = cache.get(locale);
        setActiveCatalogue(loaded);
        setCatalogue(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const value = useMemo<Translator>(
    () => ({
      locale,
      t: (key, vars) => translate(catalogue, key, vars),
    }),
    [locale, catalogue],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Strings for the current language.
 *
 * Usable outside the provider — it falls back to English rather than throwing,
 * because a missing provider should not take a page down over copy. Tests and
 * Storybook-style isolated renders get English for free.
 */
const ENGLISH_FALLBACK: Translator = {
  locale: "en",
  t: (key, vars) => translate(undefined, key, vars),
};

export function useTranslation(): Translator {
  return useContext(I18nContext) ?? ENGLISH_FALLBACK;
}
