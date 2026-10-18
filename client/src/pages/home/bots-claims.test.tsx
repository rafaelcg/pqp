import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadLocale } from "@/lib/i18n";
import type { Locale } from "@/lib/locale";
import { LANDING_BOT_FAQ, LANDING_FAQ, landingFaq, renderMarketingHead } from "@/lib/marketing-meta";
import { BOTS_COPY_UPDATED, botFaqAnswer, type ServerBotClaims } from "@/lib/server-bots-launch";
import en from "@/locales/en/translation.json";
import es from "@/locales/es/translation.json";
import ptBR from "@/locales/pt-BR/translation.json";
import { BotClaimsPreview } from "./breu/claims";
import Home from "./index";

/*
 * The server-bot claims on "/" ship dark: PR#1188 (server bots) is not on main,
 * so both launch switches in `lib/server-bots-launch.ts` are false, and the page
 * keeps Breu, the mascot, while it says nothing about server bots anywhere: not
 * in the copy, not in alt text, aria labels or titles, not in the FAQ, not in
 * the head or the FAQ JSON-LD.
 *
 * Every page reader asks `serverBotClaims()`, so this file drives that one
 * function (a hoisted mock) and renders the whole page, in each language, both
 * ways. Each "absent" case has a "present" twin: with the switches forced on,
 * the same scans must find the bot tile, the bot question and its JSON-LD
 * entry, so a mock that silently failed to apply cannot pass by testing
 * nothing.
 *
 * Helpers are copied from `home-render.test.tsx`, not imported, so the two
 * files can change apart.
 */

const state = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR" | "es",
  claims: null as ServerBotClaims | null,
}));

vi.mock("@/lib/server-bots-launch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-bots-launch")>();
  return { ...actual, serverBotClaims: () => state.claims };
});

// The real `t`, bound to the locale under test.
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useTranslation: () => ({ locale: state.locale, t: actual.translateMessage }),
  };
});

vi.mock("@/hooks/use-communities-enabled", () => ({
  useCommunitiesEnabled: () => false,
}));

// The hosted build: a Google Play listing and a donation page.
vi.mock("@/lib/play-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/play-store")>();
  return { ...actual, playStoreUrl: () => "https://play.google.com/store/apps/details?id=gg.pqp.app" };
});
vi.mock("@/lib/support-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/support-links")>();
  return { ...actual, isSupportPageEnabled: () => true };
});
vi.mock("@/lib/dev-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dev-auth")>();
  return { ...actual, isDevAuthBypassEnabled: () => true };
});
vi.mock("@/components/marketing/marketing-auth-ctas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/marketing/marketing-auth-ctas")>();
  return {
    ...actual,
    MarketingAuthGate: ({
      children,
    }: {
      children: (auth: { signedIn: boolean; bypass: boolean; join: () => void; signIn: () => void }) => ReactNode;
    }) => <>{children({ signedIn: false, bypass: true, join: () => {}, signIn: () => {} })}</>,
  };
});

const LOCALES = ["pt-BR", "en", "es"] as const satisfies readonly Locale[];
const CATALOGUES: Record<Locale, Record<string, string>> = { "pt-BR": ptBR, en, es };

const COMBOS: ServerBotClaims[] = [
  { actions: false, rollout: "aos-poucos" },
  { actions: false, rollout: "todos" },
  { actions: true, rollout: "aos-poucos" },
  { actions: true, rollout: "todos" },
];

/*
 * Every key the bot claims are written in. Two are left out of the token scan:
 * `home.move.stays.discordBots` ("Bots do Discord" under Mudança's "Não vem")
 * is true and shown in both states, and `home.toys.bot.tag.everyone` ("new",
 * "nuevo") is a word the page already uses elsewhere.
 */
const CLAIM_KEYS = [
  "home.toys.caption.bots",
  "home.toys.bot.label",
  "home.toys.bot.tag.gradual",
  "home.toys.bot.title",
  "home.toys.bot.body.actions",
  "home.toys.bot.body.replies",
  "home.toys.bot.note",
  "home.toys.bot.ask.poll",
  "home.toys.bot.work.poll",
  "home.toys.bot.reply.poll",
  "home.toys.bot.card.poll",
  "home.toys.bot.sr.poll",
  "home.toys.bot.ask.time",
  "home.toys.bot.work.thinking",
  "home.toys.bot.reply.time",
  "home.toys.bot.sr.time",
  "home.toys.perm.body.bots",
  "home.limits.bots.body.gradual",
  "home.limits.bots.body.everyone",
  "home.faq.bot.q",
  "home.faq.bot.a.replies",
  "home.faq.bot.a.actions",
  "home.faq.bot.a.gradual",
  "home.faq.bot.a.everyone",
] as const;

/*
 * Values that already say "bot" on the page and claim nothing about server
 * bots: Mudança's "no bot needed", Limites' "bots and integrations are just
 * getting started" and its webhooks line, Discord's bot ecosystem, and the
 * page-only "Bots do Discord" line. The scan removes exactly these strings,
 * then refuses any bot word that is left.
 */
const NO_CLAIM_KEYS = [
  "home.move.lede",
  "home.move.stays.discordBots",
  "home.limits.bots.lead",
  "home.limits.bots.body",
  "home.limits.discord.bots.lead",
  "home.limits.discord.bots.body",
] as const;

/** Words that only a bot claim may use. Case-sensitive where an acronym is meant. */
const CLAIM_WORDS = [
  /\bbots?\b/i,
  /rob[ôo]s?\b/i,
  /\brobots?\b/i,
  /Bardo/,
  /@bardo_bot/i,
  /Anthropic/i,
  /Claude/,
  /\bIA\b/,
  /\bAI\b/,
  /\bBreu\b/,
];

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

/** Text nodes, as a reader gets them: no scripts, no styles, no tags. */
function textOf(html: string): string {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function sectionStart(html: string, id: string): number {
  const open = new RegExp(`<section\\b[^>]*\\sid="${id}"`).exec(html);
  if (!open) throw new Error(`no section #${id}`);
  return open.index;
}

function sectionOf(html: string, id: string): string {
  const open = sectionStart(html, id);
  return html.slice(open, html.indexOf("</section>", open));
}

/** The page without one section: #codigo's release notes are the blog's own titles. */
function withoutSection(html: string, id: string): string {
  const open = sectionStart(html, id);
  return html.slice(0, open) + html.slice(html.indexOf("</section>", open));
}

/** Attribute values a reader or a screen reader gets: alt, aria-label, title, placeholder. */
function accessibleAttributes(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/\s(?:alt|aria-label|title|placeholder)="([^"]*)"/g)) {
    out.push(decode(match[1]!));
  }
  return out;
}

/** Everything a person reads or hears: the text nodes and the accessible attributes. */
const readable = (html: string) => [textOf(html), ...accessibleAttributes(html)].join("\n");

const ids = (html: string) => [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]!);

/** The text of every element that carries `attribute`, in document order. */
function textsMarked(html: string, attribute: string): string[] {
  const pattern = new RegExp(`<(span|p)\\b[^>]*\\s${attribute}=""[^>]*>([\\s\\S]*?)</\\1>`, "g");
  return [...html.matchAll(pattern)].map((match) =>
    decode(match[2]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(),
  );
}

/** The longest run of a value with its `{slot}` parts removed: what must not show. */
function longestLiteral(value: string): string {
  return value
    .split(/\{\w+\}/)
    .map((part) => part.trim())
    .sort((a, b) => b.length - a.length)[0]!;
}

/** The claim words left in `text` once the values that claim nothing are taken out. */
function claimWordsIn(text: string, locale: Locale): string[] {
  let rest = text;
  for (const key of NO_CLAIM_KEYS) rest = rest.split(CATALOGUES[locale][key]!).join(" ");
  return CLAIM_WORDS.flatMap((word) => rest.match(new RegExp(word.source, `${word.flags}g`)) ?? []);
}

/** What the head of "/" says to a reader or a crawler: every meta value and the JSON-LD. */
function headText(head: string): string {
  // `robots` is the meta's own name, not a claim, so that tag is left out.
  const withoutRobots = head.replace(/<meta\s+name="robots"[^>]*\/>/g, " ");
  return decode(withoutRobots.replace(/<[^>]*\scontent="([^"]*)"[^>]*>/g, " $1 ").replace(/<\/?[a-z][^>]*>/g, " "));
}

type FaqNode = { name: string; acceptedAnswer: { text: string } };

/** The FAQPage JSON-LD of "/", as question and answer pairs. */
function jsonLdFaq(locale: Locale): { question: string; answer: string }[] {
  const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(renderMarketingHead("/", locale));
  if (!block) throw new Error("no JSON-LD in the head of /");
  const graph = (JSON.parse(block[1]!) as { "@graph": { "@type": string; mainEntity?: FaqNode[] }[] })["@graph"];
  const faq = graph.find((node) => node["@type"] === "FAQPage");
  if (!faq?.mainEntity) throw new Error("no FAQPage in the JSON-LD of /");
  return faq.mainEntity.map((item) => ({ question: item.name, answer: item.acceptedAnswer.text }));
}

/** The answer the switches pick, built from the catalogue (not the page's `t`). */
const expectedAnswer = (locale: Locale, claims: ServerBotClaims) =>
  botFaqAnswer((key) => CATALOGUES[locale][key]!, claims);

async function renderHome(
  locale: Locale,
  claims: ServerBotClaims | null,
  preview?: ServerBotClaims | null,
): Promise<string> {
  await loadLocale(locale);
  Object.assign(state, { locale, claims });
  const page = (
    <MemoryRouter initialEntries={["/"]}>
      <Home />
    </MemoryRouter>
  );
  return renderToStaticMarkup(
    preview === undefined ? page : <BotClaimsPreview value={preview}>{page}</BotClaimsPreview>,
  );
}

beforeAll(async () => {
  for (const locale of LOCALES) await loadLocale(locale);
});

describe("the bot claims ship dark: switches off", () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      let html = "";
      beforeAll(async () => {
        html = await renderHome(locale, null);
      });

      it("renders a page, and the scans read alt text and labels too", () => {
        expect(html.length).toBeGreaterThan(20_000);
        expect(readable(html)).toContain(CATALOGUES[locale]["home.hero.alt"]);
      });

      it("says no bot claim in any text, alt, aria-label or title", () => {
        const text = readable(withoutSection(html, "codigo"));
        // The present twin: the page does say "bot", in the values that claim
        // nothing, so the scan below runs on real text and the list matters.
        expect(text).toMatch(/\bbots?\b/i);
        expect(claimWordsIn(text, locale)).toEqual([]);
        for (const key of CLAIM_KEYS) {
          expect(text, key).not.toContain(longestLiteral(CATALOGUES[locale][key]!));
        }
      });

      it("draws no bot tile and asks seven questions", () => {
        expect(html).not.toContain("data-breu-tile");
        expect(textsMarked(html, "data-faq-question")).toHaveLength(7);
        expect(readable(sectionOf(html, "brinquedos"))).toContain(CATALOGUES[locale]["home.toys.caption"]);
        // The "e também" list is the bento's last tile, as before the port.
        expect(readable(sectionOf(html, "brinquedos"))).toContain(CATALOGUES[locale]["home.toys.also.title"]);
      });

      it("keeps the dated Limites line as it was", () => {
        const limits = sectionOf(html, "limites");
        expect(limits).toContain('dateTime="2026-10-16"');
        expect(readable(limits)).toContain(CATALOGUES[locale]["home.limits.bots.body"]);
      });

      it("serves no bot claim in the head or the FAQ JSON-LD of /", () => {
        const head = renderMarketingHead("/", locale);
        expect(claimWordsIn(headText(head), locale)).toEqual([]);
        for (const key of CLAIM_KEYS) {
          expect(head, key).not.toContain(longestLiteral(CATALOGUES[locale][key]!));
        }
        // The old landing's "E os bots?" answer (no bot store yet) is gone from "/".
        expect(head).not.toMatch(/Loja de bots|bot store|Tienda de bots|E os bots|What about bots|Y los bots/i);
        expect(jsonLdFaq(locale)).toEqual(LANDING_FAQ[locale]);
      });

      it("still shows the mascot: Breu sleeps in the closer", () => {
        // The present twin of the scans above: the face is drawn, with no words.
        const fim = sectionOf(html, "fim");
        expect(fim.match(/class="bot-face\b/g)).toHaveLength(1);
        expect(fim).toMatch(/aria-hidden="true"/);
      });

      it("shows the page-only Discord bots line under Não vem", () => {
        expect(html).toContain('data-bench-item="discordBots"');
        expect(readable(sectionOf(html, "mudanca"))).toContain(CATALOGUES[locale]["home.move.stays.discordBots"]);
      });

      it("renders no hero Breu in the static markup", () => {
        expect(html).not.toContain("breu-hero");
      });
    });
  }
});

describe("the bot claims with the switches forced on", () => {
  for (const locale of LOCALES) {
    for (const claims of COMBOS) {
      describe(`${locale} ${JSON.stringify(claims)}`, () => {
        const c = CATALOGUES[locale];
        let html = "";
        beforeAll(async () => {
          html = await renderHome(locale, claims);
        });

        it("draws the bot tile, its tag and its body for these switches", () => {
          expect(html).toContain("data-breu-tile");
          const toys = readable(sectionOf(html, "brinquedos"));
          expect(toys).toContain("Bardo");
          expect(toys).toContain("@bardo_bot");
          expect(toys).toContain(c["home.toys.caption.bots"]);
          expect(toys).toContain(c[claims.actions ? "home.toys.bot.body.actions" : "home.toys.bot.body.replies"]);
          expect(toys).not.toContain(c[claims.actions ? "home.toys.bot.body.replies" : "home.toys.bot.body.actions"]);
          expect(toys).toContain(c[claims.rollout === "aos-poucos" ? "home.toys.bot.tag.gradual" : "home.toys.bot.tag.everyone"]);
          if (claims.rollout === "todos") expect(toys).not.toContain(c["home.toys.bot.tag.gradual"]);
          // The card shows only when the bot runs tools.
          const card = c["home.toys.bot.card.poll"]!;
          if (claims.actions) expect(toys).toContain(card);
          else expect(toys).not.toContain(card);
          // The sr-only line names the sample bot.
          expect(toys).toContain(
            c[claims.actions ? "home.toys.bot.sr.poll" : "home.toys.bot.sr.time"]!.replaceAll("{bot}", "Bardo"),
          );
        });

        it("adds the bot's chip in Permissões and moves the rest under the grid", () => {
          const toys = readable(sectionOf(html, "brinquedos"));
          expect(toys).toContain(c["home.toys.perm.body.bots"]);
          expect(toys).toContain(c["home.toys.perm.blind"]!.replace("{role}", "Bardo (bot)"));
          // The list is under the grid, not a tile: no "e também" tile title.
          expect(toys).not.toContain(c["home.toys.also.title"]);
          expect(toys).toContain(c["home.toys.also.label"]);
          expect(toys).toContain(c["home.toys.also.threads"]);
        });

        it("moves the Limites line and its date with the bot", () => {
          const limits = sectionOf(html, "limites");
          expect(limits).toContain(`dateTime="${BOTS_COPY_UPDATED.iso}"`);
          expect(readable(limits)).toContain(
            c[claims.rollout === "aos-poucos" ? "home.limits.bots.body.gradual" : "home.limits.bots.body.everyone"],
          );
        });

        it("asks the bot question after the data one, with the answer the JSON-LD serves", () => {
          const questions = textsMarked(html, "data-faq-question");
          const answers = textsMarked(html, "data-faq-answer");
          expect(questions).toHaveLength(8);
          expect(questions[5]).toBe(c["home.faq.data.q"]);
          expect(questions[6]).toBe(c["home.faq.bot.q"]);
          expect(answers[6]).toBe(expectedAnswer(locale, claims));
          // Page and JSON-LD are the same eight pairs, in the same order.
          const pairs = questions.map((question, i) => ({ question, answer: answers[i] }));
          expect(jsonLdFaq(locale)).toEqual(pairs);
          expect(landingFaq(locale)).toEqual(pairs);
          expect(jsonLdFaq(locale)[6]).toEqual({
            question: LANDING_BOT_FAQ[locale].question,
            answer: expectedAnswer(locale, claims),
          });
        });

        it("says the bot words the off state refuses (the scan's present twin)", () => {
          const text = readable(withoutSection(html, "codigo"));
          const words = claimWordsIn(text, locale);
          expect(words.some((word) => /^bots?$/i.test(word))).toBe(true);
          expect(words).toContain("Bardo");
          expect(words).toContain("Anthropic");
          expect(words).toContain("Claude");
          expect(words).toContain(locale === "en" ? "AI" : "IA");
          const head = renderMarketingHead("/", locale);
          expect(claimWordsIn(headText(head), locale)).toContain("Anthropic");
          // Only the FAQ JSON-LD gains the claim: the title, the description
          // and the card's alt text say the same in both states.
          const meta = head.replace(/<script\b[\s\S]*?<\/script>/g, " ");
          expect(claimWordsIn(headText(meta), locale)).toEqual([]);
        });

        it("stays well formed: no dash, no raw key, no slot, no id twice, no hero Breu", () => {
          expect(html).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
          const text = readable(html);
          expect(text).not.toMatch(/\b(?:home|landing)\.[a-z]/);
          expect(text).not.toMatch(/\{[A-Za-z_]\w*\}/);
          const seen = ids(html);
          expect([...new Set(seen.filter((id, i) => seen.indexOf(id) !== i))]).toEqual([]);
          expect(html).not.toContain("breu-hero");
        });
      });
    }
  }
});

describe("the preview override", () => {
  it("draws the page as if the switches were on, while the JSON-LD follows the real ones", async () => {
    const claims: ServerBotClaims = { actions: true, rollout: "aos-poucos" };
    const html = await renderHome("pt-BR", null, claims);
    expect(html).toContain("data-breu-tile");
    expect(textsMarked(html, "data-faq-question")).toContain(ptBR["home.faq.bot.q"]);
    expect(jsonLdFaq("pt-BR")).toEqual(LANDING_FAQ["pt-BR"]);
    // And off when the override says off, whatever the switches say.
    state.claims = claims;
    const off = await renderHome("pt-BR", claims, null);
    expect(off).not.toContain("data-breu-tile");
  });
});

describe("tripwire", () => {
  it("flips the switches only once PR#1188 is on main, with the bot question in the JSON-LD", async () => {
    const actual = await vi.importActual<typeof import("@/lib/server-bots-launch")>("@/lib/server-bots-launch");
    // PR#1188 adds the shared drawing. The control glob proves the lookup works.
    const shared = import.meta.glob("../../../../packages/shared/src/{bot-face,discord-import}.ts");
    expect(Object.keys(shared).some((path) => path.endsWith("discord-import.ts"))).toBe(true);
    const pr1188 = Object.keys(shared).some((path) => path.endsWith("bot-face.ts"));
    if (actual.SERVER_BOTS_LIVE) {
      expect(pr1188, "flip the bot switches only after PR#1188 is on main").toBe(true);
    }
    // The JSON-LD for "/" carries the bot question exactly when the real switch is on.
    for (const locale of LOCALES) {
      const questions = landingFaq(locale, actual.serverBotClaims()).map((item) => item.question);
      expect(questions.includes(CATALOGUES[locale]["home.faq.bot.q"]!), locale).toBe(actual.SERVER_BOTS_LIVE);
    }
    // Actions and the rollout mean nothing while the main switch is off.
    if (!actual.SERVER_BOTS_LIVE) expect(actual.serverBotClaims()).toBeNull();
  });
});
