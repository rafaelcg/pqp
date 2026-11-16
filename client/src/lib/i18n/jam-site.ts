/**
 * The public jam site's own i18next instance.
 *
 * WHY NOT `@/lib/i18n`. That module bundles the whole English catalogue of the
 * app (500 kB of JSON) so `t()` works before anything mounts. The jam site is
 * a light public page for somebody who may never open the app, so it keeps its
 * own three small catalogues (`locales/jam-site/{en,pt-BR,es}.json`), checked
 * by `i18n:check` for parity and placeholders like the main ones, and an
 * instance of its own. Same library, same rules: `{name}` slots, `_one` /
 * `_other` plurals, English is the source and the fallback, pt-BR and Spanish
 * load as chunks of their own, and `tu` is the pt-BR voice.
 */

import i18n from "i18next";
import type { Locale } from "@/lib/locale";
import en from "@/locales/jam-site/en.json";

const instance = i18n.createInstance();

void instance.init({
  lng: "en",
  fallbackLng: "en",
  initAsync: false,
  returnNull: false,
  returnEmptyString: false,
  keySeparator: false,
  nsSeparator: false,
  pluralSeparator: "_",
  contextSeparator: "_",
  interpolation: { prefix: "{", suffix: "}", escapeValue: false },
  resources: { en: { translation: en } },
});

type ResourceKey = keyof typeof en;
type StripSuffix<K extends string> = K extends `${infer Base}_${"zero" | "one" | "two" | "few" | "many" | "other"}`
  ? Base
  : K;

/** Keys `t()` accepts: the English keys plus the base of each plural family. */
export type JamKey = ResourceKey | StripSuffix<ResourceKey & string>;

export type JamVars = Record<string, string | number | undefined> & { count?: number };

const LOADERS: Partial<Record<Locale, () => Promise<unknown>>> = {
  "pt-BR": () => import("@/locales/jam-site/pt-BR.json"),
  es: () => import("@/locales/jam-site/es.json"),
};

/** Load a language's catalogue and switch to it. English is already here. */
export async function loadJamLocale(locale: Locale): Promise<void> {
  const loader = LOADERS[locale];
  if (loader) {
    try {
      const module = await loader();
      const bundle = ((module as { default?: unknown }).default ?? module) as Record<string, string>;
      instance.addResourceBundle(locale, "translation", bundle, true, true);
    } catch {
      // A catalogue that will not load leaves English, which reads fine.
      return;
    }
  }
  await instance.changeLanguage(locale);
}

export function jt(key: JamKey, vars?: JamVars): string {
  const result = instance.t(String(key), vars);
  return typeof result === "string" ? result : String(result);
}
