/**
 * The release-notes index: what has been posted, in what order, under what
 * title.
 *
 * WHY THE METADATA AND THE PROSE ARE SEPARATE FILES. This module is imported by
 * the Cloudflare Pages middleware, which runs in front of every request the
 * site serves. It needs a slug, a date, a title and a summary so a shared
 * `/blog/...` link unfurls with the post's own card instead of the product's
 * generic one. It does not need the post. Keeping the bodies behind the dynamic
 * importers in `BODIES` means the edge bundle carries a few hundred bytes of
 * strings rather than every release note ever written, and the browser
 * downloads exactly the one post on screen, in one language.
 *
 * WHY NOT A CMS, OR FRONTMATTER, OR A BUILD STEP. A release note is written by
 * the person who shipped the thing, in the same commit, and is then never
 * edited again. A markdown file next to a typed index gives that workflow a
 * compile error when the two disagree, which is the only guarantee that
 * actually matters here. `posts.test.ts` pins the rest: unique slugs, real
 * dates, both locales present, newest first.
 *
 * ADDING A POST. Write the two markdown files under `content/blog/`, add the
 * entry at the TOP of `POSTS`, add both importers to `BODIES`, add the URL to
 * `client/public/sitemap.xml`. Dates are the day the work reached people, not
 * the day it was merged.
 */

/**
 * Same two languages as the rest of the marketing surface. Declared here rather
 * than imported from `marketing-meta` so neither module has to be loaded to
 * read the other; see that file's note on the head builders being deliberately
 * separate.
 */
export type BlogLocale = "pt-BR" | "en";

export interface BlogPost {
  /** URL segment. Lowercase, hyphenated, never changed once published. */
  slug: string;
  /** `YYYY-MM-DD`, the day it reached people. */
  date: string;
  title: Record<BlogLocale, string>;
  /**
   * One or two sentences. Does double duty as the card blurb on the index and
   * the `<meta name="description">` the edge injects, so it has to read as a
   * complete thought on its own.
   */
  summary: Record<BlogLocale, string>;
}

/**
 * Newest first. The order here IS the order on the page; nothing sorts it at
 * runtime, because a sort would quietly hide the day somebody typos a year.
 * `posts.test.ts` asserts the descending order instead, so the mistake is a
 * failing test rather than a post that silently moves.
 */
export const POSTS: readonly BlogPost[] = [
  {
    slug: "beta-no-iphone",
    date: "2026-08-21",
    title: {
      "pt-BR": "O pqp no iPhone, em beta aberto",
      en: "pqp on iPhone, in open beta",
    },
    summary: {
      "pt-BR":
        "O app de iPhone entrou em beta publico pelo TestFlight. Voz, texto e ver tela compartilhada no celular. Ainda nao e a App Store, e a gente conta por que.",
      en: "The iPhone app is in public beta through TestFlight. Voice, text, and watching a screen share from your phone. It is not the App Store yet, and we explain why.",
    },
  },
  {
    slug: "codigo-aberto-e-caca-bugs",
    date: "2026-08-20",
    title: {
      "pt-BR": "Licenca aberta de verdade, e um lugar pra reclamar",
      en: "A real open licence, and somewhere to complain",
    },
    summary: {
      "pt-BR":
        "O pqp agora tem licenca AGPL-3.0, entao codigo aberto virou uma afirmacao legal e nao um slogan. Junto veio uma caixa de feedback dentro do app e um badge de caca-bugs.",
      en: "pqp is now licensed under AGPL-3.0, so open source is a legal statement rather than a slogan. Alongside it, a feedback box inside the app and a bug-hunter badge.",
    },
  },
  {
    slug: "comunidades-perfis-e-o-seu-arroba",
    date: "2026-08-08",
    title: {
      "pt-BR": "Comunidades, perfis e um @ que e seu",
      en: "Communities, profiles, and an @ of your own",
    },
    summary: {
      "pt-BR":
        "A maior semana do projeto ate agora: comunidades publicas, paginas de perfil em pqp.gg/@voce, depoimentos, convites que viraram links e uma segunda lingua.",
      en: "The biggest week the project has had: public communities, profile pages at pqp.gg/@you, depoimentos, invites that became links, and a second language.",
    },
  },
] as const;

/**
 * The prose, one importer per post and locale.
 *
 * `?raw` rather than a markdown plugin: the body is handed straight to the
 * `react-markdown` the app already ships for messages, so there is nothing to
 * transform at build time and nothing new in the dependency tree.
 */
const BODIES: Record<string, Record<BlogLocale, () => Promise<string>>> = {
  "beta-no-iphone": {
    "pt-BR": () =>
      import("@/content/blog/beta-no-iphone.pt-BR.md?raw").then(
        (m) => m.default,
      ),
    en: () =>
      import("@/content/blog/beta-no-iphone.en.md?raw").then((m) => m.default),
  },
  "codigo-aberto-e-caca-bugs": {
    "pt-BR": () =>
      import("@/content/blog/codigo-aberto-e-caca-bugs.pt-BR.md?raw").then(
        (m) => m.default,
      ),
    en: () =>
      import("@/content/blog/codigo-aberto-e-caca-bugs.en.md?raw").then(
        (m) => m.default,
      ),
  },
  "comunidades-perfis-e-o-seu-arroba": {
    "pt-BR": () =>
      import(
        "@/content/blog/comunidades-perfis-e-o-seu-arroba.pt-BR.md?raw"
      ).then((m) => m.default),
    en: () =>
      import("@/content/blog/comunidades-perfis-e-o-seu-arroba.en.md?raw").then(
        (m) => m.default,
      ),
  },
};

/** The post at a slug, or null. Null is "there is no such post", not an error. */
export function postBySlug(slug: string): BlogPost | null {
  return POSTS.find((post) => post.slug === slug) ?? null;
}

/**
 * The body of one post in one language.
 *
 * Falls back to Portuguese rather than to English, which is the opposite of the
 * string catalogue and deliberate: the catalogue's source of truth is English
 * because that is where new keys are written, but release notes are written for
 * the people already using the product, and they are in Brazil.
 */
export async function loadPostBody(
  slug: string,
  locale: BlogLocale,
): Promise<string | null> {
  const bodies = BODIES[slug];
  if (!bodies) {
    return null;
  }
  const load = bodies[locale] ?? bodies["pt-BR"];
  return load();
}
