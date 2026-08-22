/**
 * React-free i18next instance.
 *
 * Transports (`realtime.ts`, voice hooks) look up copy without a React
 * context. English is bundled and initialised synchronously so `t()` works
 * before the provider mounts. Portuguese is a separate chunk, loaded on
 * demand — never imported from this file, or every visitor would download it.
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

let ptLoaded = false;

export async function loadLocale(locale: Locale): Promise<void> {
  if (locale === "pt-BR" && !ptLoaded) {
    const loaded = await import("@/locales/pt-BR/translation.json");
    const bundle = ((loaded as { default?: unknown }).default ?? loaded) as Record<
      string,
      string
    >;
    i18n.addResourceBundle("pt-BR", "translation", bundle, true, true);
    ptLoaded = true;
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
