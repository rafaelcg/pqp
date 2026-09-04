/**
 * The release-notes index: what has been posted, in what order, under what
 * title.
 *
 * WHY THE PROSE LIVES IN `bodies.ts` AND NOT HERE. This module is imported by
 * the Cloudflare Pages middleware, which needs a slug, a date, a title and a
 * summary so a shared `/blog/...` link unfurls with the post's own card instead
 * of the product's generic one. It does not need the post.
 *
 * That used to be a size argument. It is a hard requirement. Wrangler bundles
 * `functions/_middleware.ts` with esbuild, not with Vite, and esbuild has no
 * loader for `.md`. A `?raw` import anywhere in this module's graph fails the
 * Pages deploy outright, even inside a dynamic `import()` the edge would never
 * execute, because the bundler still has to parse it. That failure does not
 * appear in CI, which builds the client but never bundles the functions. It
 * appeared in production on 22 Aug 2026, after CI went green.
 *
 * So: metadata here, prose in `bodies.ts`, and nothing that reaches the edge
 * may import `bodies.ts`.
 *
 * WHY NOT A CMS, OR FRONTMATTER, OR A BUILD STEP. A release note is a weekly
 * catch-up, not a per-PR file. Write it with the whats-new skill, then never
 * edit it once it is on `main`. A markdown file next to a typed index gives
 * that workflow a compile error when the two disagree, which is the only
 * guarantee that actually matters here. `blog-meta.test.ts` pins the rest:
 * unique slugs, real dates, both locales present, newest first.
 *
 * ADDING A POST. Write the two markdown files under `content/blog/`, add the
 * entry at the TOP of `POSTS`, add both importers to `BODIES` in `bodies.ts`,
 * add the URL to `client/public/sitemap.xml`. Screenshots are optional: if you
 * have them, they live in `client/public/blog/<slug>/` and are referenced as
 * `/blog/<slug>/file.png` (the markdown is raw text, so a relative import next
 * to the `.md` would 404). Dates are the day the work reached people, not the
 * day it was merged.
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
    slug: "favoritos-camera-e-o-dm-te-acha",
    date: "2026-09-03",
    title: {
      "pt-BR": "O Baú, e o DM na barra",
      en: "The Baú, and DMs on the rail",
    },
    summary: {
      "pt-BR":
        "Baú na comunidade, DM na barra, APK no Android, e o que saiu em agosto.",
      en: "The community Baú, pin a DM to the rail, an Android APK, and what shipped in August.",
    },
  },
  {
    slug: "dados-discord-e-cargos",
    date: "2026-08-30",
    title: {
      "pt-BR": "Dados, Discord, e cargos de verdade",
      en: "Dice, Discord layouts, and real cargos",
    },
    summary: {
      "pt-BR":
        "Saiu um monte: /roll e enquete no chat, copiar a barra do Discord, cargos e visual novo. Daqui pra frente o que muda no pqp a gente conta aqui.",
      en: "A lot shipped: /roll and polls in chat, copy a Discord sidebar, cargos, and new looks. From now on, what changes in pqp gets written here.",
    },
  },

  {
    slug: "fim-do-eco",
    date: "2026-08-27",
    title: {
      "pt-BR": "O eco na tela compartilhada acabou",
      en: "The screen share echo is gone",
    },
    summary: {
      "pt-BR":
        "A tela inteira mandava o som do PC todo, com a call junto, e todo mundo se ouvia de volta. Agora vem desligado. E todo botão de ícone diz o que faz.",
      en: "A whole-screen share sent the machine's entire audio, call included, so everyone heard themselves back. It is now off by default. And every icon button says what it does.",
    },
  },

  {
    slug: "qualidade-de-video",
    date: "2026-08-24",
    title: {
      "pt-BR": "Vídeo em 720p, e você escolhe a qualidade",
      en: "720p video, and you pick the quality",
    },
    summary: {
      "pt-BR":
        "A câmera agora manda 720p, com seletor de automático a 360p, troca no meio da call sem desligar nada e um número mostrando o que está saindo de verdade.",
      en: "The camera now sends 720p, with a selector from auto down to 360p, a mid-call switch that turns nothing off, and a number showing what is actually going out.",
    },
  },

  {
    slug: "som-na-tela",
    date: "2026-08-22",
    title: {
      "pt-BR": "A tela compartilhada agora vai com som",
      en: "Screen sharing now carries sound",
    },
    summary: {
      "pt-BR":
        "Compartilhar tela passou a mandar o áudio junto, o vídeo ficou fluido em vez de travado, e a call ganhou uma pergunta rápida de 1 a 5 quando acaba.",
      en: "Screen sharing now sends the audio too, the picture is smooth instead of stuttering, and a call ends with a quick 1-to-5 question.",
    },
  },
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

/** The post at a slug, or null. Null is "there is no such post", not an error. */
export function postBySlug(slug: string): BlogPost | null {
  return POSTS.find((post) => post.slug === slug) ?? null;
}
