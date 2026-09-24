/**
 * React-free i18next instance.
 *
 * Transports (`realtime.ts`, voice hooks) look up copy without a React
 * context. English is bundled and initialised synchronously so `t()` works
 * before the provider mounts. Portuguese is a separate chunk, loaded on
 * demand, and so is Spanish. Neither is imported statically from this file, or
 * every visitor would download both.
 */

import i18n from "i18next";
import type { Locale } from "@/lib/locale";
import en from "@/locales/en/translation.json";

const isTest = Boolean(
  (globalThis as { process?: { env?: { VITEST?: string } } }).process?.env
    ?.VITEST,
);

const PLURAL_OR_CONTEXT_SUFFIX =
  /_(?:zero|one|two|few|many|other|desktop)$/;

type ResourceKey = keyof typeof en;
type StripSuffix<K extends string> = K extends `${infer Base}_${
  | "zero"
  | "one"
  | "two"
  | "few"
  | "many"
  | "other"
  | "desktop"}`
  ? Base
  : K;

/** Keys `t()` accepts: English resource keys plus plural/context bases. */
export type MessageKey = ResourceKey | StripSuffix<ResourceKey & string>;

export type MessageVars = Record<string, string | number | undefined> & {
  count?: number;
  context?: string;
};

export const enMessages: Record<string, string> = en;

function throwOnMissingKey(key: string): string {
  throw new Error(`missing i18n key: ${key}`);
}

void i18n.init({
  lng: "en",
  fallbackLng: "en",
  initAsync: false,
  returnNull: false,
  returnEmptyString: false,
  keySeparator: false,
  nsSeparator: false,
  pluralSeparator: "_",
  contextSeparator: "_",
  interpolation: {
    prefix: "{",
    suffix: "}",
    escapeValue: false,
  },
  resources: {
    en: { translation: en },
  },
  parseMissingKeyHandler: isTest ? throwOnMissingKey : undefined,
});

/**
 * One dynamic import per language, each path written out literally so Vite
 * splits one chunk per catalogue. A templated path would glob English in too.
 */
const LOADERS: Partial<Record<Locale, () => Promise<unknown>>> = {
  "pt-BR": () => import("@/locales/pt-BR/translation.json"),
  es: () => import("@/locales/es/translation.json"),
};

const loaded = new Set<Locale>(["en"]);

export async function loadLocale(locale: Locale): Promise<void> {
  const loader = LOADERS[locale];
  if (loader && !loaded.has(locale)) {
    const module = await loader();
    const bundle = ((module as { default?: unknown }).default ?? module) as Record<
      string,
      string
    >;
    i18n.addResourceBundle(locale, "translation", bundle, true, true);
    loaded.add(locale);
  }
  await i18n.changeLanguage(locale);
}

export function translateMessage(key: MessageKey, vars?: MessageVars): string {
  const result = i18n.t(String(key), vars);
  return typeof result === "string" ? result : String(result);
}

const TEST_LNG = "test";

/**
 * Test-only overlay, same job as the old `setActiveCatalogue`. Missing keys
 * still fall through to English. Pass `undefined` to restore English.
 *
 * In-memory bundles apply before the returned promise settles, so tests can
 * call this and read `t()` on the next line.
 */
export function setActiveCatalogue(
  messages: Partial<Record<string, string>> | undefined,
): void {
  if (!messages) {
    if (i18n.hasResourceBundle(TEST_LNG, "translation")) {
      i18n.removeResourceBundle(TEST_LNG, "translation");
    }
    void i18n.changeLanguage("en");
    return;
  }
  i18n.addResourceBundle(TEST_LNG, "translation", messages, true, true);
  void i18n.changeLanguage(TEST_LNG);
}

export { i18n };

export function isPluralOrContextKey(key: string): boolean {
  return PLURAL_OR_CONTEXT_SUFFIX.test(key);
}
