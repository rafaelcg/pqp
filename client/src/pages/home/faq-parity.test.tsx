import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadLocale } from "@/lib/i18n";
import type { Locale } from "@/lib/locale";
import { LANDING_FAQ } from "@/lib/marketing-meta";
import { PLAY_STORE_LISTING_URL, playStoreUrlFrom } from "@/lib/play-store";
import en from "@/locales/en/translation.json";
import es from "@/locales/es/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";
import { Perguntas } from "./perguntas";

/*
 * The FAQ a visitor reads on "/" and the FAQPage JSON-LD the edge writes into
 * the head (`LANDING_FAQ` in `lib/marketing-meta.ts`) are two copies of the
 * same seven pairs. A search result may only quote what the page says, so the
 * two must agree: same questions, same answers, same order, in every language.
 *
 * `marketing-meta.test.ts` pins `LANDING_FAQ` to the catalogues. This file pins
 * it to the page as rendered, which is the claim that matters. It reads the
 * text out of the markup `Perguntas` produces, using the two data attributes
 * the component puts on exactly those texts (`data-faq-question`,
 * `data-faq-answer`). The link line under an answer carries `data-faq-link`
 * and is not part of the answer, so it is never read here.
 *
 * Every "absent" case has a "present" twin. The page and the JSON-LD agree on
 * the hosted build, which links a Google Play listing. A self-host with no
 * listing shows the APK wording on purpose, and its edge middleware never runs,
 * so the JSON-LD does not apply to it. The second describe drives that case so
 * the parity check cannot pass by testing nothing.
 */

const state = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR" | "es",
  play: "https://play.google.com/store/apps/details?id=gg.pqp.app" as string | null,
  support: true,
}));

// The real `t`, bound to the locale under test. Without a provider,
// `useTranslation()` answers English whatever the catalogue says, and every
// locale would be compared with English text.
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useTranslation: () => ({ locale: state.locale, t: actual.translateMessage }),
  };
});

// `playStoreUrl()` has a code default and is never null on its own.
vi.mock("@/lib/play-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/play-store")>();
  return { ...actual, playStoreUrl: () => state.play };
});

// A build without VITE_SPONSOR_URL or VITE_PIX_KEY has no donation page, so
// the "free" answer loses its link line. The answer itself does not change.
vi.mock("@/lib/support-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/support-links")>();
  return { ...actual, isSupportPageEnabled: () => state.support };
});

const LOCALES = ["pt-BR", "en", "es"] as const satisfies readonly Locale[];
const CATALOGUES: Record<Locale, Record<string, string>> = { "pt-BR": ptBR, en, es };
const HOSTED_PLAY = "https://play.google.com/store/apps/details?id=gg.pqp.app";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};
const decode = (value: string) =>
  value.replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity);

/** The text of every element that carries `attribute`, in document order. */
function textsMarked(html: string, attribute: string): string[] {
  const pattern = new RegExp(`<(span|p)\\b[^>]*\\s${attribute}=""[^>]*>([\\s\\S]*?)</\\1>`, "g");
  return [...html.matchAll(pattern)].map((match) =>
    decode(match[2]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(),
  );
}

/** What the page says, as the questions and answers a reader gets, in order. */
async function visibleFaq(
  locale: Locale,
  { play = HOSTED_PLAY, support = true }: { play?: string | null; support?: boolean } = {},
) {
  // `translateMessage` answers in the active locale, so switch it per render.
  await loadLocale(locale);
  Object.assign(state, { locale, play, support });
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <Perguntas />
    </MemoryRouter>,
  );
  const questions = textsMarked(html, "data-faq-question");
  const answers = textsMarked(html, "data-faq-answer");
  return { html, questions, answers, pairs: questions.map((q, i) => ({ question: q, answer: answers[i] })) };
}

beforeAll(async () => {
  // Load every catalogue once; each render then switches with `loadLocale`.
  for (const locale of LOCALES) await loadLocale(locale);
});

describe("the FAQ on '/' and its FAQPage JSON-LD", () => {
  it("is hosted-shaped: a build that sets nothing links the Google Play listing", async () => {
    // The parity below is the right claim only while the hosted build shows
    // the Play wording. `playStoreUrl()` is mocked in this file, so read the
    // real rule: no override means our listing, and a single space opts out.
    expect(playStoreUrlFrom(undefined)).toBe(PLAY_STORE_LISTING_URL);
    expect(PLAY_STORE_LISTING_URL).toBe(HOSTED_PLAY);
    expect(playStoreUrlFrom(" ")).toBeNull();
  });

  for (const locale of LOCALES) {
    it(`says the same seven questions and answers, in the same order, in ${locale}`, async () => {
      const page = await visibleFaq(locale);
      expect(page.questions.length, "questions on the page").toBe(7);
      expect(page.answers.length, "answers on the page").toBe(7);
      expect(page.pairs).toEqual(LANDING_FAQ[locale]);
    });

    it(`reads the page's own text, not a stand-in, in ${locale}`, async () => {
      // A render that fell back to English or to raw keys would still be
      // self-consistent. Pin the first pair to this locale's catalogue.
      const page = await visibleFaq(locale);
      expect(page.pairs[0]).toEqual({
        question: CATALOGUES[locale]["home.faq.friends.q"],
        answer: CATALOGUES[locale]["home.faq.friends.a"],
      });
      for (const text of [...page.questions, ...page.answers]) {
        expect(text, text).not.toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
        expect(text, text).not.toMatch(/[{}]/);
      }
    });
  }

  it("shows the Play wording to the answer on the phone question, in every language", async () => {
    for (const locale of LOCALES) {
      const answer = (await visibleFaq(locale)).answers[3];
      expect(answer, locale).toBe(CATALOGUES[locale]["home.faq.phone.a.play"]);
      expect(answer, locale).toMatch(/Google Play/);
    }
  });

  it("keeps the links out of the answers, in the line under them", async () => {
    for (const locale of LOCALES) {
      const page = await visibleFaq(locale);
      for (const answer of page.answers) {
        expect(answer, locale).not.toMatch(/https?:|\/privacy|\/android|\/beta|\/download/);
      }
      // The link lines exist (the present twin): five of the seven answers
      // have one, and none of them is part of `data-faq-answer`.
      expect(page.html.match(/data-faq-link=""/g)?.length, locale).toBe(5);
    }
  });

  it("does not let the donation gate change an answer", async () => {
    for (const locale of LOCALES) {
      const withSupport = await visibleFaq(locale, { support: true });
      const without = await visibleFaq(locale, { support: false });
      expect(without.answers, locale).toEqual(withSupport.answers);
      expect(without.html.match(/data-faq-link=""/g)?.length, locale).toBe(4);
    }
  });
});

describe("the parity check can fail", () => {
  it("fails on a reordered pair", async () => {
    const page = await visibleFaq("en");
    const swapped = [...LANDING_FAQ.en];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(page.pairs).not.toEqual(swapped);
  });

  it("fails on one changed word in one answer", async () => {
    const page = await visibleFaq("pt-BR");
    const edited = LANDING_FAQ["pt-BR"].map((item, i) =>
      i === 5 ? { ...item, answer: item.answer.replace("Google Ads", "Google") } : item,
    );
    expect(edited[5]!.answer).not.toBe(LANDING_FAQ["pt-BR"][5]!.answer);
    expect(page.pairs).not.toEqual(edited);
  });

  it("fails on a language mix-up", async () => {
    expect((await visibleFaq("es")).pairs).not.toEqual(LANDING_FAQ.en);
    expect((await visibleFaq("pt-BR")).pairs).not.toEqual(LANDING_FAQ.es);
  });

  it("differs in exactly the phone answer on a self-host with no listing", async () => {
    // A self-host shows the APK wording, and its edge never injects this
    // JSON-LD. The page then differs from `LANDING_FAQ` in that one answer
    // and in no other, which shows the gate is read and is the only one.
    for (const locale of LOCALES) {
      const page = await visibleFaq(locale, { play: null });
      const differing = page.pairs
        .map((pair, i) => (pair.answer === LANDING_FAQ[locale][i]!.answer ? null : i))
        .filter((i) => i !== null);
      expect(differing, locale).toEqual([3]);
      expect(page.answers[3], locale).toBe(CATALOGUES[locale]["home.faq.phone.a"]);
      expect(page.answers[3], locale).not.toMatch(/Google Play/);
      expect(page.questions, locale).toEqual(LANDING_FAQ[locale].map((item) => item.question));
    }
  });
});
