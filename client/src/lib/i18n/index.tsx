import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { applyDocumentLocale, detectLocale, type Locale } from "@/lib/locale";
import { getDesktop } from "@/lib/desktop";
import {
  loadLocale,
  translateMessage,
  type MessageKey,
  type MessageVars,
} from "./instance";

export type { MessageKey, MessageVars } from "./instance";
export {
  enMessages as en,
  i18n,
  loadLocale,
  setActiveCatalogue,
  translateMessage,
} from "./instance";

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
 * `main.tsx` already uses for Clerk's pt-BR strings, and for the same reason: an
 * English visitor should not download Portuguese.
 *
 * The cost is a first paint in English for a Portuguese reader. It is a narrow
 * window (the chunk is a few KB from the same origin, requested during mount)
 * and it is the right trade against making every visitor pay for every language.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale] = useState(detectLocale);
  const [readyLocale, setReadyLocale] = useState<Locale>("en");

  useEffect(() => {
    applyDocumentLocale(locale);
    void getDesktop()?.setLocale?.(locale);
  }, [locale]);

  useEffect(() => {
    if (locale === "en") {
      setReadyLocale("en");
      return;
    }
    let cancelled = false;
    void loadLocale(locale)
      .then(() => {
        if (!cancelled) {
          setReadyLocale(locale);
        }
      })
      .catch(() => {
        // A blocked or failed chunk leaves English on screen, which is a working
        // page. A reload is the recovery, not a request loop.
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const value = useMemo<Translator>(
    () => ({
      locale: readyLocale === locale ? locale : "en",
      t: (key, vars) => translateMessage(key, vars),
    }),
    [locale, readyLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

const ENGLISH_FALLBACK: Translator = {
  locale: "en",
  t: (key, vars) => translateMessage(key, vars),
};

export function useTranslation(): Translator {
  return useContext(I18nContext) ?? ENGLISH_FALLBACK;
}
