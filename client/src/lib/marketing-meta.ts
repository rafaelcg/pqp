/**
 * Server-side meta injection for the marketing routes, and the reason
 * `/vs-discord` can rank for anything at all.
 *
 * THE SAME PROBLEM `profile-meta.ts` SOLVES, aimed at the product's own pages.
 * This is a static SPA: `/vs-discord`, `/garanta` and the rest are all served
 * the same `index.html`, whose head describes the landing page — title, og
 * tags, and, worst of all, `<link rel="canonical" href="https://pqp.gg/">`.
 * `Seo` fixes that in the browser, which is worth nothing to any crawler that
 * does not run the script: Bing, most unfurlers, and Google's first pass all
 * read the bytes. To them every marketing URL is a duplicate of the homepage
 * that *says so in its own head* — so the one page built for the queries this
 * product can win was telling search engines to fold it into `/`.
 *
 * UNLIKE THE PROFILE AND COMMUNITY INJECTORS, THIS ONE FETCHES NOTHING. The
 * marketing pages' titles and descriptions are constants, so the middleware
 * branch is a pure string rewrite — no API call, no timeout, no new failure
 * mode beyond "the document has no <head>", which serves the page unchanged
 * exactly as the other two injectors do.
 *
 * THE CANONICAL ORIGIN IS PINNED to https://pqp.gg rather than taken from the
 * request, on purpose: the same build is served at pqp-3yr.pages.dev, and a
 * request-derived canonical would put the twin into the index as a competitor.
 * With the pin, every copy of the site that runs this middleware votes for
 * pqp.gg. (Self-hosts serve the SPA from their own server, not from Pages, so
 * this middleware never runs there.)
 *
 * DELIBERATELY DEPENDENCY-FREE, like its two siblings: wrangler's esbuild
 * bundles this outside the pnpm workspace, so it cannot import the i18n
 * JSON. The strings below are duplicates of `landing.seo.*`,
 * `vsDiscord.seo.*`, `tela.seo.*`, `claim.seo.*`, `betaPage.seo.*`,
 * `androidPage.seo.*`, `downloadPage.seo.*`, `vsDiscord.faq.*` and
 * `tela.faq.*`, and
 * `marketing-meta.test.ts` pins each pair against the JSON catalogues — the
 * duplication cannot drift without failing the suite.
 */

/** One address for the index, wherever the bytes were served from. */
const CANONICAL_ORIGIN = "https://pqp.gg";

export type MarketingPage =
  | "/"
  | "/vs-discord"
  | "/tela"
  | "/beta"
  | "/android"
  | "/download"
  | "/garanta"
  | "/claim"
  | "/privacy"
  | "/terms"
  | "/cookies"
  | "/status";

export type MarketingLocale = "pt-BR" | "en";

const MARKETING_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/vs-discord",
  "/tela",
  "/beta",
  "/android",
  "/download",
  "/garanta",
  "/claim",
  "/privacy",
  "/terms",
  "/cookies",
  "/status",
] satisfies MarketingPage[]);

/**
 * The marketing page behind a path, or null for every other path.
 *
 * Null is the middleware's "not my business" answer and it has to be exactly
 * that: this runs in front of EVERY request to the site — most importantly
 * every hashed asset under `/assets/` — so membership is an exact-match set
 * lookup, never a prefix test.
 */
export function marketingPageFromMetaPath(
  pathname: string,
): MarketingPage | null {
  const normalized =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return MARKETING_PATHS.has(normalized)
    ? (normalized as MarketingPage)
    : null;
}

interface PageCopy {
  /**
   * Where the canonical points. `/claim` canonicalises to `/garanta` because
   * they are one page under two names and the client `Seo` already says so
   * (`claim-page.tsx` passes `path="/garanta"` from both routes).
   */
  canonicalPath: string;
  title: Record<MarketingLocale, string>;
  description: Record<MarketingLocale, string>;
}

/**
 * Titles and descriptions per page. The landing, vs-discord and claim strings
 * are catalogue duplicates (see the file comment); the policy and status pages
 * have no catalogue SEO keys, so their strings live only here.
 */
const PAGE_COPY: Record<MarketingPage, PageCopy> = {
  "/": {
    canonicalPath: "/",
    title: {
      "pt-BR": "pqp: chat em grupo com voz e tela compartilhada",
      en: "pqp: group chat with voice and screen sharing",
    },
    description: {
      "pt-BR":
        "Voz, texto e tela compartilhada pra sua galera, direto no navegador. Crie uma comunidade e mande o link. Código aberto, de graça, e o servidor pode ser seu.",
      en: "Voice, text, and screen sharing for your people, straight from the browser. Make a community, send the link. Open source, free, and the server can be yours.",
    },
  },
  "/vs-discord": {
    canonicalPath: "/vs-discord",
    title: {
      "pt-BR": "Alternativa ao Discord em 2026: comparação honesta | pqp",
      en: "A Discord alternative in 2026: an honest comparison | pqp",
    },
    description: {
      "pt-BR":
        "Voz, texto e tela compartilhada funcionam no pqp, no navegador. A Discord suspendeu tela e vídeo no Brasil em 17/08/2026. Comparação linha a linha, de graça.",
      en: "Voice, text, and screen sharing work on pqp, in the browser. Discord suspended screen share and video in Brazil on 17 Aug 2026. A line-by-line comparison, free.",
    },
  },
  "/tela": {
    canonicalPath: "/tela",
    title: {
      "pt-BR": "Alternativa ao Discord para compartilhar tela | pqp",
      en: "A Discord alternative for sharing your screen | pqp",
    },
    description: {
      "pt-BR":
        "Compartilhe a tela com os amigos sem Discord, direto do navegador e com som. Comparação honesta do que funciona hoje no Brasil. Grátis e de código aberto.",
      en: "Share your screen with friends without Discord, straight from the browser, with audio. An honest comparison of what works today in Brazil. Free and open source.",
    },
  },
  "/beta": {
    canonicalPath: "/beta",
    title: {
      "pt-BR": "Beta do iOS · pqp no iPhone",
      en: "iOS beta · pqp on iPhone",
    },
    description: {
      "pt-BR":
        "Acesso antecipado ao pqp no iPhone. Voz, texto e as telas que o pessoal compartilha, direto do bolso. Vagas pelo TestFlight, de graça e em beta aberto.",
      en: "Early access to pqp on iPhone. Voice, text, and the screens other people are sharing, from your pocket. Spots via TestFlight, free and in open beta.",
    },
  },
  "/android": {
    canonicalPath: "/android",
    title: {
      "pt-BR": "Beta do Android · pqp em APK",
      en: "Android beta · pqp APK",
    },
    description: {
      "pt-BR":
        "Acesso antecipado ao pqp no Android. Baixa o APK, autoriza uma vez, e tá dentro. Ainda não tá na Play Store. De graça.",
      en: "Early access to pqp on Android. Download the APK, allow install once, and you're in. Not on the Play Store yet. Free.",
    },
  },
  "/download": {
    canonicalPath: "/download",
    title: {
      "pt-BR": "Baixar o pqp",
      en: "Download pqp",
    },
    description: {
      "pt-BR":
        "App de desktop pra Windows, Mac e Linux, um beta de iPhone pelo TestFlight, e um beta de Android em APK. O navegador continua funcionando sem instalar nada.",
      en: "Desktop app for Windows, Mac, and Linux, an iPhone beta on TestFlight, and an Android beta as an APK. The browser still works with nothing to install.",
    },
  },
  "/garanta": {
    canonicalPath: "/garanta",
    title: {
      "pt-BR": "Garanta seu @ no pqp",
      en: "Claim your @ on pqp",
    },
    description: {
      "pt-BR":
        "pqp.gg/@você, um nome só, quem chegar primeiro leva. De graça, e é seu.",
      en: "pqp.gg/@you, one name, first come, first served. Free, and yours.",
    },
  },
  "/claim": {
    canonicalPath: "/garanta",
    title: {
      "pt-BR": "Garanta seu @ no pqp",
      en: "Claim your @ on pqp",
    },
    description: {
      "pt-BR":
        "pqp.gg/@você, um nome só, quem chegar primeiro leva. De graça, e é seu.",
      en: "pqp.gg/@you, one name, first come, first served. Free, and yours.",
    },
  },
  "/privacy": {
    canonicalPath: "/privacy",
    title: {
      "pt-BR": "Política de privacidade · pqp",
      en: "Privacy policy · pqp",
    },
    description: {
      "pt-BR":
        "Como o pqp trata os seus dados: o que guardamos, por quê, e os seus direitos.",
      en: "How pqp handles your data: what we store, why, and your rights.",
    },
  },
  "/terms": {
    canonicalPath: "/terms",
    title: {
      "pt-BR": "Termos de uso · pqp",
      en: "Terms of service · pqp",
    },
    description: {
      "pt-BR": "Os termos para usar o serviço hospedado do pqp em pqp.gg.",
      en: "The terms for using the hosted pqp service at pqp.gg.",
    },
  },
  "/cookies": {
    canonicalPath: "/cookies",
    title: {
      "pt-BR": "Cookies · pqp",
      en: "Cookies · pqp",
    },
    description: {
      "pt-BR": "Quais cookies o pqp usa e para que servem.",
      en: "What cookies pqp uses and what they are for.",
    },
  },
  "/status": {
    canonicalPath: "/status",
    title: {
      "pt-BR": "Status · pqp",
      en: "Status · pqp",
    },
    description: {
      "pt-BR": "Status operacional do serviço hospedado do pqp, ao vivo.",
      en: "Live operational status for the hosted pqp service.",
    },
  },
};

/**
 * The `/vs-discord` FAQ, duplicated from `vsDiscord.faq.*` in the JSON
 * catalogues and served as FAQPage JSON-LD. Same truth rules as the page:
 * product claims only, no legal advice, no return-date speculation. The test
 * suite pins every string here against its JSON twin.
 */
export const VS_DISCORD_FAQ: Record<
  MarketingLocale,
  { question: string; answer: string }[]
> = {
  "pt-BR": [
    {
      question:
        "Por que o compartilhamento de tela do Discord está suspenso no Brasil?",
      answer:
        "A Discord comunicou que tela compartilhada, vídeo e Go Live estão suspensos para usuários no Brasil desde 17 de agosto de 2026, cumprindo uma medida preventiva da ANPD, a autoridade brasileira de proteção de dados. É o comunicado da própria Discord, esta página é uma comparação de produto, não conselho jurídico.",
    },
    {
      question:
        "Quando volta o compartilhamento de tela do Discord no Brasil?",
      answer:
        "Não há data anunciada. A carta da Discord para a comunidade brasileira diz que estão trabalhando para restaurar os recursos, sem dizer quando.",
    },
    {
      question: "Como compartilhar tela com o meu grupo hoje?",
      answer:
        "Cria uma comunidade no pqp.gg, manda o link do convite e compartilha a tela direto do navegador, o jogo, o código, os slides. De graça, sem instalar nada; também tem app pra desktop.",
    },
    {
      question: "O pqp é grátis mesmo? Qual é a pegadinha?",
      answer:
        "Grátis e de código aberto. Usa o serviço hospedado no pqp.gg, ou roda a sua própria cópia nas suas máquinas, o código é público. É um beta aberto: novo, honesto sobre isso, e construído às claras.",
    },
  ],
  en: [
    {
      question: "Why is Discord screen share suspended in Brazil?",
      answer:
        "Discord announced that screen share, video, and Go Live are suspended for users in Brazil since 17 August 2026, complying with a preventive order from the ANPD, Brazil's data-protection authority. That is Discord's own announcement, this page is a product comparison, not legal advice.",
    },
    {
      question: "When does Discord screen share come back in Brazil?",
      answer:
        "No date has been announced. Discord's letter to its Brazilian community says they are working to restore the features, without saying when.",
    },
    {
      question: "How can my group share a screen today?",
      answer:
        "Create a community on pqp.gg, send the invite link, and share your screen straight from the browser, the game, the code, the slides. Free, nothing to install; there's a desktop app too.",
    },
    {
      question: "Is pqp really free? What's the catch?",
      answer:
        "Free and open source. Use the hosted service at pqp.gg, or run your own copy on your own machines, the code is public. It's an open beta: young, honest about it, and built in the open.",
    },
  ],
};

/**
 * The `/tela` FAQ, duplicated from `tela.faq.*` in the JSON catalogues and
 * served as FAQPage JSON-LD, in the page's own order. Same truth rules as the
 * page: product claims only, no legal advice, no App Store claim, no
 * return-date speculation. The suite pins every string here against its JSON
 * twin.
 */
export const TELA_FAQ: Record<
  MarketingLocale,
  { question: string; answer: string }[]
> = {
  "pt-BR": [
    {
      question: "Precisa baixar alguma coisa?",
      answer:
        "Não. O pqp roda no navegador, no desktop e no Android. Tem app de desktop se você quiser, e um beta de iOS pelo TestFlight, mas nenhum dos dois é obrigatório.",
    },
    {
      question: "Precisa de VPN?",
      answer:
        "Não. Isso não é um jeito de burlar nada: o pqp é outro app, com servidores próprios no Brasil, e compartilhar tela é um recurso que ele tem. Nada aqui mexe no Discord.",
    },
    {
      question: "Quantas pessoas podem compartilhar tela numa sala?",
      answer:
        "Duas pessoas podem passar a tela ao mesmo tempo, lado a lado, e cada uma tem o seu botão de tela cheia. A sala em si vai bem com 5 ou 6 pessoas na voz, que é P2P. Salas maiores estão em teste e ainda não são o padrão.",
    },
    {
      question: "É de graça?",
      answer:
        "Sim. O pqp é código aberto sob a AGPL (github.com/rafaelcg/pqp). Usa o serviço hospedado no pqp.gg de graça, ou roda a sua própria cópia.",
    },
    {
      question: "Tem no celular?",
      answer:
        "No Android tem um beta em APK em pqp.gg/android. No iPhone, pelo TestFlight em pqp.gg/beta. O navegador continua funcionando nos dois. Ainda não está nas lojas.",
    },
    {
      question: "O que vocês guardam sobre mim?",
      answer:
        "Menos do que você imagina, e tudo está listado em linguagem simples na política de privacidade em pqp.gg/privacy. O pqp.gg hospedado usa analytics sem cookie (Umami) e uma tag de conversão do Google Ads que só conta cadastros. Sem remarketing e sem lista de público.",
    },
  ],
  en: [
    {
      question: "Do I need to download anything?",
      answer:
        "No. pqp runs in the browser on desktop and on Android. There is a desktop app if you want one, and an iOS beta via TestFlight, but neither is required.",
    },
    {
      question: "Do I need a VPN?",
      answer:
        "No. This is not a way around anything: pqp is a different app with its own servers in Brazil, and screen share is a feature it has. Nothing here touches Discord.",
    },
    {
      question: "How many people can share a screen in one room?",
      answer:
        "Two people can share a screen at the same time, side by side, and each one has its own fullscreen button. The room itself works well with 5 or 6 people on voice, which is peer-to-peer. Bigger rooms are being tested and are not the default yet.",
    },
    {
      question: "Is it free?",
      answer:
        "Yes. pqp is open source under the AGPL (github.com/rafaelcg/pqp). Use the hosted service at pqp.gg for free, or run your own copy.",
    },
    {
      question: "Does it work on a phone?",
      answer:
        "On Android there is an APK beta at pqp.gg/android. On iPhone, TestFlight at pqp.gg/beta. The browser still works on both. Neither is on the stores yet.",
    },
    {
      question: "What do you keep about me?",
      answer:
        "Less than you would expect, and all of it is listed in plain language in the privacy policy at pqp.gg/privacy. Hosted pqp.gg uses cookie-less analytics (Umami) and a Google Ads conversion tag that only counts sign-ups. No remarketing, no audience lists.",
    },
  ],
};

/** `&`, `<`, `>` and `"` — everything that can escape an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The structured data a page can honestly claim.
 *
 * Every page carries the WebSite node. The landing adds SoftwareApplication —
 * the page is the product — mirroring what the shipped `index.html` says
 * (`applicationCategory`, a zero-price Offer). `/vs-discord` adds FAQPage,
 * whose questions are the FAQ section actually rendered on the page — schema
 * for copy a visitor can read, never schema alone. `/tela` does the same
 * with its own six.
 */
function jsonLdFor(page: MarketingPage, locale: MarketingLocale): string {
  const graph: Record<string, unknown>[] = [
    {
      "@type": "WebSite",
      name: "pqp",
      url: `${CANONICAL_ORIGIN}/`,
      inLanguage: ["pt-BR", "en"],
    },
  ];
  if (page === "/") {
    graph.push({
      "@type": "SoftwareApplication",
      name: "pqp",
      applicationCategory: "CommunicationApplication",
      operatingSystem: "Web",
      url: `${CANONICAL_ORIGIN}/`,
      description: PAGE_COPY["/"].description[locale],
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    });
  }
  const faq =
    page === "/vs-discord"
      ? VS_DISCORD_FAQ[locale]
      : page === "/tela"
        ? TELA_FAQ[locale]
        : null;
  if (faq) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    });
  }
  // `</script>` inside a JSON string would close the block early. It cannot
  // occur in any field above today; the replace is what keeps that true when
  // somebody adds a field later.
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": graph,
  }).replace(/</g, "\\u003c");
}

/**
 * Every tag the rewrite manages, as one string.
 *
 * The same vocabulary the profile and community injectors emit, minus the
 * image decisions neither of which apply here: the marketing card image is the
 * site's own, so `summary_large_image` is always right.
 */
export function renderMarketingHead(
  page: MarketingPage,
  locale: MarketingLocale,
): string {
  const copy = PAGE_COPY[page];
  const url = `${CANONICAL_ORIGIN}${copy.canonicalPath === "/" ? "/" : copy.canonicalPath}`;
  const title = copy.title[locale];
  const description = copy.description[locale];
  const image = `${CANONICAL_ORIGIN}/images/og-image.jpg`;
  const e = escapeHtml;
  const langSuffix = url.includes("?") ? "&" : "?";

  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<link rel="canonical" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="x-default" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="pt-BR" href="${e(url)}${langSuffix}lang=pt-BR" />`,
    `<link rel="alternate" hreflang="en" href="${e(url)}${langSuffix}lang=en" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="pqp" />`,
    `<meta property="og:url" content="${e(url)}" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    `<meta property="og:image" content="${e(image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${e(title)}" />`,
    `<meta name="twitter:description" content="${e(description)}" />`,
    `<meta name="twitter:image" content="${e(image)}" />`,
    `<meta name="robots" content="index, follow" />`,
    // The locale this document was negotiated in, for the client bundle to
    // read back. `detectLocale()` prefers it over `navigator.languages`,
    // which is what stops a crawler's English renderer overwriting this
    // head with the English one. See `lib/locale.ts`.
    `<meta name="pqp:locale" content="${locale}" />`,
    `<script type="application/ld+json">${jsonLdFor(page, locale)}</script>`,
  ].join("\n    ");
}

/**
 * Tags the shipped `index.html` already carries that describe the PRODUCT.
 *
 * Removed rather than left in place, because a document with two `og:title`
 * tags is one where the crawler picks one and it is usually the first. The
 * pattern is the same narrow one `profile-meta.ts` uses: it names only the
 * social/SEO vocabulary, so the icons, the theme colour, the viewport, the
 * pre-paint theme script and the font preconnects all survive untouched.
 */
const MANAGED_TAGS =
  /[ \t]*(?:<title>[\s\S]*?<\/title>|<meta\s+(?:name|property)="(?:description|robots|pqp:locale|og:[a-zA-Z:]+|twitter:[a-zA-Z:]+|profile:[a-zA-Z:]+)"[\s\S]*?\/>|<link\s+rel="canonical"[^>]*\/>|<link\s+rel="alternate"[^>]*\/>|<script type="application\/ld\+json">[\s\S]*?<\/script>)\n?/g;

/**
 * Rewrite a document's head for one marketing page.
 *
 * Also corrects `<html lang="en">` when the head is being written in
 * Portuguese — a pt-BR title on a document that declares itself English is a
 * mixed signal to exactly the readers this rewrite exists for. The match is
 * the literal attribute the shipped `index.html` carries; if the document does
 * not contain it, nothing changes, which is the right failure.
 *
 * Returns the html unchanged when it has no `<head>` — which cannot happen
 * with our own index.html, and is the correct answer if it ever does: serving
 * the page unmodified is a working page, and that is the bar every failure
 * path in this feature is held to.
 */
export function injectMarketingHead(
  html: string,
  page: MarketingPage,
  locale: MarketingLocale,
): string {
  const headIndex = html.indexOf("<head>");
  if (headIndex === -1) {
    return html;
  }
  let stripped = html.replace(MANAGED_TAGS, "");
  if (locale === "pt-BR") {
    stripped = stripped.replace('<html lang="en">', '<html lang="pt-BR">');
  }
  const insertAt = stripped.indexOf("<head>") + "<head>".length;
  return (
    stripped.slice(0, insertAt) +
    "\n    " +
    renderMarketingHead(page, locale) +
    stripped.slice(insertAt)
  );
}
