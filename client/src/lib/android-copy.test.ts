import { describe, expect, it } from "vitest";
import en from "../locales/en/translation.json";
import es from "../locales/es/translation.json";
import ptBR from "../locales/pt-BR/translation.json";
import LLMS from "../../public/llms.txt?raw";
import LLMS_FULL from "../../public/llms-full.txt?raw";
import INDEX_MD from "../../public/index.md?raw";
import { factFor } from "../content/compare-facts";
/**
 * What the site may say about Android. Every page words it its own way, so
 * this file is the one place the facts live, and every surface is checked
 * against them in all three languages. The Organization `sameAs` entry for
 * the listing is pinned in `marketing-meta.test.ts`.
 *
 * When a fact changes (the camera ships, the minimum Android moves), change it
 * here first and let the failures list every string that has to follow.
 */
const ANDROID = {
  store: "Google Play",
  /** `gameAudioSupported()` in android/.../voice/GameAudioCapture.kt. */
  gameAudioMinAndroid: 10,
  camera: false,
} as const;

const catalogues = { "pt-BR": ptBR, en, es } as const;
type Locale = keyof typeof catalogues;
const locales = Object.keys(catalogues) as Locale[];
const get = (locale: Locale, key: string): string => {
  const value = (catalogues[locale] as Record<string, string>)[key];
  if (value === undefined) throw new Error(`${locale} is missing ${key}`);
  return value;
};

/** Every string pqp.gg shows that says where the Android app lives. */
const STORE_SURFACES = [
  "home.phone.lede.play",
  "home.phone.android.play",
  "home.phone.android.cta.play",
  "home.faq.phone.a.play",
  "download.mobile.android.play",
  "downloadPage.seo.description",
  "downloadPage.android.body.play",
  "downloadPage.android.cta.play",
  "downloadDialog.body",
  "footer.androidBeta.play",
  "mobileBetaHint.android.body.play",
  "voice.share.useApp.android",
  "androidPage.seo.description",
  "androidPage.title.play",
  "androidPage.body.play",
  "androidPage.perk.play.body",
  "androidPage.honest.play",
  "tela.option.pqp.limit",
  "tela.faq.download.a",
  "tela.faq.mobile.a",
  "vem.proof.platforms",
  "vem.compare.apps.pqp",
  "vem.faq.install.a",
  "vem.footer.androidLink.play",
];

/**
 * The APK-only fallback. pqp.gg never shows these: `VITE_PLAY_STORE_URL`
 * defaults to the listing, and only a self-host that blanks it gets them.
 */
const APK_ONLY = [
  "home.phone.lede",
  "home.phone.android",
  "home.phone.android.cta",
  "home.faq.phone.a",
  "download.mobile.android",
  "downloadPage.android.body",
  "downloadPage.android.cta",
  "footer.androidBeta",
  "mobileBetaHint.android.body",
  "androidPage.badge",
  "androidPage.title",
  "androidPage.body",
  "androidPage.perk.early.title",
  "androidPage.perk.early.body",
  "androidPage.honest",
  "vem.footer.androidLink",
];

/** Strings that describe what the Android app can do. */
const CAPABILITY_SURFACES = [
  "androidPage.notYet",
  "home.night.share.android",
  "vem.features.share.body",
];

const NOT_IN_STORE_YET =
  /ainda não (abriu|saiu|está na|tá na)|antes da loja|nas lojas ainda|not (open|in the store|on Google Play) yet|before the store|todavía no (abre|está)|antes de la tienda|beta (em|in|en) APK|APK beta/i;

const DATE_PROMISE =
  /em breve|chegando|\bsoon\b|on the way|próximamente|pronto llega|\b20\d\d\b/i;

describe("Android: where the app lives", () => {
  for (const locale of locales) {
    it(`${locale}: every hosted surface names ${ANDROID.store}`, () => {
      for (const key of STORE_SURFACES) {
        expect(get(locale, key), `${locale} ${key}`).toContain(ANDROID.store);
      }
    });

    it(`${locale}: no hosted surface says the store is not open`, () => {
      for (const key of STORE_SURFACES) {
        expect(get(locale, key), `${locale} ${key}`).not.toMatch(NOT_IN_STORE_YET);
      }
    });

    it(`${locale}: the APK fallback keys still exist for a self-host`, () => {
      for (const key of APK_ONLY) expect(get(locale, key)).toBeTruthy();
    });

    it(`${locale}: the home page's APK wording promises no date and names no store`, () => {
      // Only a self-host that blanks VITE_PLAY_STORE_URL ever shows these, so
      // they must not claim a listing, and (like the Play wording) no date.
      for (const key of APK_ONLY.filter((key) => key.startsWith("home."))) {
        const value = get(locale, key);
        expect(value, `${locale} ${key}`).not.toContain(ANDROID.store);
        expect(value, `${locale} ${key}`).not.toMatch(DATE_PROMISE);
      }
    });
  }

  it("the comparison facts name Google Play for pqp's apps, in every language", () => {
    const fact = factFor("pqp", "apps")!;
    for (const locale of locales) {
      expect(fact.value[locale], locale).toMatch(/Google Play/);
      expect(fact.value[locale], locale).not.toMatch(NOT_IN_STORE_YET);
    }
  });

  it("pt-BR says na Google Play, everywhere", () => {
    for (const [key, value] of Object.entries(ptBR)) {
      expect(value, key).not.toMatch(/\bno Google Play\b/);
    }
  });

  it("the machine-readable summaries say Google Play, not an APK beta", () => {
    for (const text of [LLMS, LLMS_FULL, INDEX_MD]) {
      expect(text).toMatch(/Google Play/);
      expect(text).not.toMatch(/APK beta|Android beta/);
    }
  });
});

describe("Android: what the app does", () => {
  for (const locale of locales) {
    it(`${locale}: /android names the game sound's minimum Android and the camera`, () => {
      const notYet = get(locale, "androidPage.notYet");
      expect(notYet).toContain(`Android ${ANDROID.gameAudioMinAndroid}`);
      if (!ANDROID.camera) expect(notYet).toMatch(/câmera|camera|cámara/i);
    });

    it(`${locale}: the home page and /vem say an Android phone can share too`, () => {
      expect(get(locale, "home.night.share.android")).toMatch(/Android/);
      expect(get(locale, "vem.features.share.body")).toMatch(/Android/);
    });

    it(`${locale}: no Android string promises a date`, () => {
      for (const key of [...STORE_SURFACES, ...CAPABILITY_SURFACES]) {
        expect(get(locale, key), `${locale} ${key}`).not.toMatch(DATE_PROMISE);
      }
    });

    it(`${locale}: /android does not point at an old build`, () => {
      expect(get(locale, "androidPage.version")).not.toMatch(/0\.4\.0/);
    });
  }
});
