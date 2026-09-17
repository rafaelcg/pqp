import type { BlogLocale } from "./posts";

/**
 * The prose of every guide, one lazy importer per article and locale.
 *
 * Same hard reason `bodies.ts` is split from `posts.ts`: `blog-meta.ts` sits
 * in the Pages middleware's import graph, wrangler bundles that with
 * esbuild, and esbuild has no loader for `.md`. A `?raw` import anywhere in
 * that graph fails the deploy even inside a dynamic `import()` the edge would
 * never run, because the bundler still has to parse it.
 *
 * **Nothing that the edge can reach may import this file.** Today that means
 * `blog-post-page.tsx` and nothing else.
 */
const ARTICLE_BODIES: Record<string, Partial<Record<BlogLocale, () => Promise<string>>>> = {
  "pqp-vs-discord-2026": {
    "pt-BR": () =>
      import("@/content/blog/pqp-vs-discord-2026.pt-BR.md?raw").then(
        (m) => m.default,
      ),
    en: () =>
      import("@/content/blog/pqp-vs-discord-2026.en.md?raw").then(
        (m) => m.default,
      ),
  },
  "watch-party-assistir-filme-com-amigos": {
    "pt-BR": () =>
      import(
        "@/content/blog/watch-party-assistir-filme-com-amigos.pt-BR.md?raw"
      ).then((m) => m.default),
    en: () =>
      import(
        "@/content/blog/watch-party-assistir-filme-com-amigos.en.md?raw"
      ).then((m) => m.default),
  },
  "compartilhar-tela-com-audio": {
    "pt-BR": () =>
      import("@/content/blog/compartilhar-tela-com-audio.pt-BR.md?raw").then(
        (m) => m.default,
      ),
  },
  "migrar-servidor-discord-para-pqp": {
    "pt-BR": () =>
      import(
        "@/content/blog/migrar-servidor-discord-para-pqp.pt-BR.md?raw"
      ).then((m) => m.default),
  },
  "chat-de-voz-para-comunidade-de-streamer": {
    "pt-BR": () =>
      import(
        "@/content/blog/chat-de-voz-para-comunidade-de-streamer.pt-BR.md?raw"
      ).then((m) => m.default),
  },
  "instalar-pqp-android-iphone-pc": {
    "pt-BR": () =>
      import(
        "@/content/blog/instalar-pqp-android-iphone-pc.pt-BR.md?raw"
      ).then((m) => m.default),
  },
};

/**
 * The body of one article in one language, falling back to Portuguese when
 * there is no English body — same contract as `loadPostBody`, and for the
 * same reason: these are written for the people already using the product.
 */
export async function loadArticleBody(
  slug: string,
  locale: BlogLocale,
): Promise<string | null> {
  const bodies = ARTICLE_BODIES[slug];
  if (!bodies) {
    return null;
  }
  const load = bodies[locale] ?? bodies["pt-BR"];
  return load ? load() : null;
}

/** Every slug that has prose, so a test can pin it against `ARTICLES`. */
export const SLUGS_WITH_ARTICLE_BODIES = Object.keys(ARTICLE_BODIES);
