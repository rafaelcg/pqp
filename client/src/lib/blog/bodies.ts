import type { BlogLocale } from "./posts";

/**
 * The prose of every release note, one lazy importer per post and locale.
 *
 * SEPARATE FROM `posts.ts` FOR A HARD REASON, not a tidiness one. The Pages
 * middleware imports the metadata so a shared link unfurls properly, and
 * wrangler bundles that middleware with esbuild rather than Vite. esbuild has
 * no loader for `.md`, so a `?raw` import anywhere in the middleware's import
 * graph fails the deploy, even inside a dynamic `import()` that would never run
 * at the edge: the bundler still parses it. CI does not catch this, because CI
 * builds the client and never bundles the functions.
 *
 * **Nothing that the edge can reach may import this file.** Today that means
 * `blog-post-page.tsx` and nothing else.
 *
 * `?raw` rather than a markdown plugin: the body goes straight to the
 * `react-markdown` the app already ships for chat messages, so there is nothing
 * to transform at build time and nothing new in the dependency tree.
 */
const BODIES: Record<string, Record<BlogLocale, () => Promise<string>>> = {
  "qualidade-de-video": {
    "pt-BR": () =>
      import("@/content/blog/qualidade-de-video.pt-BR.md?raw").then(
        (m) => m.default,
      ),
    en: () =>
      import("@/content/blog/qualidade-de-video.en.md?raw").then(
        (m) => m.default,
      ),
  },
  "som-na-tela": {
    "pt-BR": () =>
      import("@/content/blog/som-na-tela.pt-BR.md?raw").then((m) => m.default),
    en: () =>
      import("@/content/blog/som-na-tela.en.md?raw").then((m) => m.default),
  },
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

/** Every slug that has prose, so a test can pin it against `POSTS`. */
export const SLUGS_WITH_BODIES = Object.keys(BODIES);
