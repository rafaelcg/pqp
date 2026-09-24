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
 * `tela.faq.*`, `landing.faq.*`, and
 * `marketing-meta.test.ts` pins each pair against the JSON catalogues — the
 * duplication cannot drift without failing the suite.
 */

/** One address for the index, wherever the bytes were served from. */
const CANONICAL_ORIGIN = "https://pqp.gg";

export type MarketingPage =
  | "/"
  | "/vs-discord"
  | "/tela"
  | "/vem"
  | "/beta"
  | "/android"
  | "/download"
  | "/garanta"
  | "/claim"
  | "/privacy"
  | "/terms"
  | "/cookies"
  | "/status";

export type MarketingLocale = "pt-BR" | "en" | "es";

/**
 * Portuguese and English are required on every page. Spanish is present on
 * every page that has catalogue copy and falls back to English on the ones
 * that do not (the policies and the status page, whose prose is not Spanish).
 */
type LocalizedText = Record<"pt-BR" | "en", string> & { es?: string };

function pick(text: LocalizedText, locale: MarketingLocale): string {
  return text[locale] ?? text.en;
}

const MARKETING_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/vs-discord",
  "/tela",
  "/vem",
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
  title: LocalizedText;
  description: LocalizedText;
  /**
   * Paste-card title. When omitted, `title` is reused for og and twitter.
   * `/tela` is the only page that splits search words from the card.
   */
  ogTitle?: LocalizedText;
  /**
   * Paste-card description. When omitted, `description` is reused.
   */
  ogDescription?: LocalizedText;
  /**
   * Site-relative share-card path per locale. When omitted, the product card.
   * `/vem` is the only page with its own art, one card per language.
   */
  image?: LocalizedText;
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
      "pt-BR": "pqp: voz, tela compartilhada e chat pra sua galera, código aberto",
      en: "pqp: voice, screen share and chat for your crew, open source",
      es: "pqp: voz, pantalla compartida y chat para tu gente, código abierto",
    },
    description: {
      "pt-BR":
        "Canal de voz, tela compartilhada com som e chat completo, direto no navegador. De graça, código aberto, e já rolou watch party com mais de cem pessoas. Cria a comunidade e manda o link.",
      en: "Voice channels, screen share with sound and a full chat, straight from the browser. Free, open source, and a watch party for over a hundred people already ran on it. Make a community, send the link.",
      es: "Canales de voz, pantalla compartida con sonido y un chat completo, directo desde el navegador. Gratis, código abierto, y ya aguantó una watch party de más de cien personas. Crea una comunidad y manda el link.",
    },
  },
  "/vs-discord": {
    canonicalPath: "/vs-discord",
    title: {
      "pt-BR": "Alternativa ao Discord em 2026: comparação honesta | pqp",
      en: "A Discord alternative in 2026: an honest comparison | pqp",
      es: "Una alternativa a Discord en 2026: comparación honesta | pqp",
    },
    description: {
      "pt-BR":
        "Voz, texto e tela compartilhada funcionam no pqp, no navegador. A Discord suspendeu tela e vídeo no Brasil em 17/08/2026. Comparação linha a linha, de graça.",
      en: "Voice, text, and screen sharing work on pqp, in the browser. Discord suspended screen share and video in Brazil on 17 Aug 2026. A line-by-line comparison, free.",
      es: "Voz, texto y pantalla compartida funcionan en pqp, directo en el navegador. Una comparación honesta, punto por punto, y gratis.",
    },
  },
  "/tela": {
    canonicalPath: "/tela",
    title: {
      "pt-BR": "Compartilhar tela no navegador | pqp",
      en: "Share your screen in the browser | pqp",
      es: "Comparte tu pantalla en el navegador | pqp",
    },
    description: {
      "pt-BR":
        "Compartilhe a tela com som, direto do navegador. Sem instalar. Funciona no Brasil. Manda o link e a galera entra.",
      en: "Share your screen with sound, straight from the browser. Nothing to install. Works in Brazil. Send the link and people join.",
      es: "Comparte tu pantalla con sonido, directo desde el navegador. Sin instalar nada. Manda el link y la gente entra.",
    },
    ogTitle: {
      "pt-BR": "Compartilhar tela agora (funciona no BR)",
      en: "Share your screen now (works in Brazil)",
      es: "Comparte tu pantalla ya, en el navegador",
    },
    ogDescription: {
      "pt-BR": "Abre no navegador. Sem instalar. A galera entra pelo link.",
      en: "Opens in the browser. Nothing to install. People join from the link.",
      es: "Se abre en el navegador. Sin instalar nada. La gente entra desde el link.",
    },
  },
  "/vem": {
    canonicalPath: "/vem",
    title: {
      "pt-BR": "Vem pra pqp: traz a galera e a estrutura do seu Discord em dois minutos",
      en: "Come to pqp: bring your crew and your Discord layout in two minutes",
      es: "Ven a pqp: trae a tu banda y la estructura de tu Discord en dos minutos",
    },
    description: {
      "pt-BR":
        "Cola o link do template do seu Discord e a sala nasce igual no pqp: categorias, canais, cargos. Voz, tela com som e chat no navegador. De graça, código aberto, servidores em São Paulo.",
      en: "Paste your Discord template link and your server's layout shows up on pqp: categories, channels, roles. Voice, screen share with sound and chat in the browser. Free, open source, hosted in São Paulo.",
      es: "Pega el link de la plantilla de tu Discord y tu servidor aparece igualito en pqp: categorías, canales, roles. Voz, pantalla compartida con sonido y chat en el navegador. Gratis, de código abierto, con servidores en São Paulo.",
    },
    image: {
      "pt-BR": "/images/og-vem.png",
      en: "/images/og-vem-en.png",
      es: "/images/og-vem-es.png",
    },
  },
  "/beta": {
    canonicalPath: "/beta",
    title: {
      "pt-BR": "Beta do iOS · pqp no iPhone",
      en: "iOS beta · pqp on iPhone",
      es: "Beta de iOS · pqp en iPhone",
    },
    description: {
      "pt-BR":
        "Acesso antecipado ao pqp no iPhone. Voz, texto e as telas que o pessoal compartilha, direto do bolso. Vagas pelo TestFlight, de graça e em beta aberto.",
      en: "Early access to pqp on iPhone. Voice, text, and the screens other people are sharing, from your pocket. Spots via TestFlight, free and in open beta.",
      es: "Acceso anticipado a pqp en iPhone. Voz, texto y las pantallas que comparte la gente, desde tu bolsillo. Lugares por TestFlight, gratis y en beta abierta.",
    },
  },
  "/android": {
    canonicalPath: "/android",
    title: {
      "pt-BR": "Beta do Android · pqp em APK",
      en: "Android beta · pqp APK",
      es: "Beta de Android · pqp en APK",
    },
    description: {
      "pt-BR":
        "Acesso antecipado ao pqp no Android. Versão 0.4.0, beta. A voz funciona em toda sala, das pequenas às watch parties grandes. Baixa o APK, autoriza uma vez, e tá dentro. De graça.",
      en: "Early access to pqp on Android. Version 0.4.0, beta. Voice works in every room, from small ones to big watch parties. Download the APK, allow install once, and you're in. Free.",
      es: "Acceso anticipado a pqp en Android. Versión 0.4.0, beta. La voz funciona en todas las salas, de las chiquitas a las watch parties grandes. Descarga el APK, permite la instalación una vez y ya estás dentro. Gratis.",
    },
  },
  "/download": {
    canonicalPath: "/download",
    title: {
      "pt-BR": "Baixar o pqp",
      en: "Download pqp",
      es: "Descargar pqp",
    },
    description: {
      "pt-BR":
        "App de desktop pra Windows, Mac e Linux, um beta de iPhone pelo TestFlight, e um beta de Android em APK. O navegador continua funcionando sem instalar nada.",
      en: "Desktop app for Windows, Mac, and Linux, an iPhone beta on TestFlight, and an Android beta as an APK. The browser still works with nothing to install.",
      es: "App de escritorio para Windows, Mac y Linux, una beta para iPhone en TestFlight y una beta para Android en APK. El navegador sigue funcionando sin instalar nada.",
    },
  },
  "/garanta": {
    canonicalPath: "/garanta",
    title: {
      "pt-BR": "Garanta seu @ no pqp",
      en: "Claim your @ on pqp",
      es: "Asegura tu @ en pqp",
    },
    description: {
      "pt-BR":
        "pqp.gg/@você, um nome só, quem chegar primeiro leva. De graça, e é seu.",
      en: "pqp.gg/@you, one name, first come, first served. Free, and yours.",
      es: "pqp.gg/@tú, un solo nombre, el primero que llega se lo queda. Gratis, y tuyo.",
    },
  },
  "/claim": {
    canonicalPath: "/garanta",
    title: {
      "pt-BR": "Garanta seu @ no pqp",
      en: "Claim your @ on pqp",
      es: "Asegura tu @ en pqp",
    },
    description: {
      "pt-BR":
        "pqp.gg/@você, um nome só, quem chegar primeiro leva. De graça, e é seu.",
      en: "pqp.gg/@you, one name, first come, first served. Free, and yours.",
      es: "pqp.gg/@tú, un solo nombre, el primero que llega se lo queda. Gratis, y tuyo.",
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
 * The homepage FAQ, duplicated from `landing.faq.*` in the JSON catalogues and
 * served as FAQPage JSON-LD, in the page's own order (`LANDING_FAQ_IDS` in
 * `pages/landing-page.tsx`). Same truth rules as the other two: product claims
 * only, the capacity answer says where the number came from, and the Discord
 * import answer says what does not come along. The suite pins every string
 * here against its JSON twin.
 */
export const LANDING_FAQ: Record<
  MarketingLocale,
  { question: string; answer: string }[]
> = {
  "pt-BR": [
    {
      question: "É seguro criar conta?",
      answer:
        "É um site. Não precisa instalar nada. Os servidores ficam em São Paulo. Você apaga a conta de dentro do app. O código é público se um dia você quiser olhar. Não precisa ler pra usar.",
    },
    {
      question: "O pqp é de graça mesmo?",
      answer:
        "É. Código aberto sob AGPL, sem plano pago e sem limite artificial de sala. Dá pra apoiar o projeto com uma doação, e doar não desbloqueia nada.",
    },
    {
      question: "Preciso instalar alguma coisa?",
      answer:
        "Não. Funciona no navegador, no computador e no celular. Tem app de desktop pra Mac, Windows e Linux, e beta pra iPhone e Android se preferir.",
    },
    {
      question: "Quantas pessoas cabem numa call?",
      answer:
        "Mais de cem numa sala só, com tela compartilhada rodando, já aconteceu no pqp.gg. Uma cópia auto-hospedada sem servidor de mídia fica em torno de oito por canal.",
    },
    {
      question: "Dá pra trazer o meu servidor do Discord?",
      answer:
        "Dá pra trazer o layout: cola um link de template discord.new e o pqp recria as categorias, os canais e as permissões principais. Mensagens e membros não vêm junto.",
    },
    {
      question: "O que acontece com os meus dados?",
      answer:
        "Ficam em servidores em São Paulo. Você exporta a sua conta e a sua comunidade quando quiser, e apaga a conta de dentro do app. Ou roda a sua própria cópia e fica com tudo na sua máquina.",
    },
  ],
  en: [
    {
      question: "Is it safe to create an account?",
      answer:
        "It's a website. You don't have to install anything. The servers are in São Paulo. You can delete the account from inside the app. The code is public if you ever want to look. You don't have to read it to use the site.",
    },
    {
      question: "Is pqp really free?",
      answer:
        "Yes. Open source under AGPL, no paid plan and no artificial room limit. You can support the project with a donation, and donating unlocks nothing.",
    },
    {
      question: "Do I need to install anything?",
      answer:
        "No. It works in the browser, on the computer and on the phone. There is a desktop app for Mac, Windows and Linux, and betas for iPhone and Android if you prefer.",
    },
    {
      question: "How many people fit in one call?",
      answer:
        "Over a hundred in one room, with a screen share running, has already happened on pqp.gg. A self-hosted copy without a media server stays around eight per channel.",
    },
    {
      question: "Can I bring my Discord server?",
      answer:
        "You can bring the layout: paste a discord.new template link and pqp recreates the categories, channels and the main permissions. Messages and members do not come along.",
    },
    {
      question: "What happens to my data?",
      answer:
        "It lives on servers in São Paulo. You can export your account and your community whenever you want, and delete the account from inside the app. Or run your own copy and keep everything on your machine.",
    },
  ],
  es: [
    {
      question: "¿Es seguro crear una cuenta?",
      answer:
        "Es un sitio web. No tienes que instalar nada. Los servidores están en São Paulo. Puedes eliminar la cuenta desde la app. El código es público por si algún día quieres echarle un ojo. No necesitas leerlo para usar el sitio.",
    },
    {
      question: "¿pqp de verdad es gratis?",
      answer:
        "Sí. Código abierto bajo AGPL, sin plan de pago y sin límite artificial de salas. Puedes apoyar el proyecto con una donación, y donar no desbloquea nada.",
    },
    {
      question: "¿Tengo que instalar algo?",
      answer:
        "No. Funciona en el navegador, en la computadora y en el celular. Hay una app de escritorio para Mac, Windows y Linux, y betas para iPhone y Android si lo prefieres.",
    },
    {
      question: "¿Cuántas personas caben en una llamada?",
      answer:
        "Más de cien en una sola sala, con una pantalla compartida corriendo, ya pasó en pqp.gg. Una copia self-host sin servidor de medios se queda en unas ocho por canal.",
    },
    {
      question: "¿Puedo traer mi servidor de Discord?",
      answer:
        "Puedes traer la estructura: pega un link de plantilla de discord.new y pqp recrea las categorías, los canales y los permisos principales. Los mensajes y los miembros no se vienen.",
    },
    {
      question: "¿Qué pasa con mis datos?",
      answer:
        "Viven en servidores en São Paulo. Puedes exportar tu cuenta y tu comunidad cuando quieras, y eliminar la cuenta desde la app. O corre tu propia copia y quédate con todo en tu máquina.",
    },
  ],
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
  es: [
    {
      question: "¿pqp reemplaza a Discord?",
      answer:
        "Para muchos grupos, sí: voz, pantalla con sonido, chat y watch party, directo en el navegador. Si tu servidor vive de bots o necesitas apps pulidas en las tiendas, Discord sigue ganando ahí, y te puedes quedar con los dos.",
    },
    {
      question: "¿Puedo usar pqp y Discord al mismo tiempo?",
      answer:
        "Claro. Muchos grupos se quedan con los dos: Discord para lo de siempre, pqp para la llamada y la pantalla. Nada de lo que haces en pqp toca tu Discord.",
    },
    {
      question: "¿Cómo puede mi grupo compartir pantalla hoy?",
      answer:
        "Crea una comunidad en pqp.gg, manda el enlace de invitación y comparte tu pantalla directo desde el navegador: el juego, el código, las diapositivas. Gratis, sin instalar nada; también hay app de escritorio.",
    },
    {
      question: "¿pqp de verdad es gratis? ¿Cuál es el truco?",
      answer:
        "Gratis y de código abierto. Usa el servicio alojado en pqp.gg, o corre tu propia copia en tus propias máquinas, el código es público. Es una beta abierta: joven, honesta al respecto y construida a la vista de todos.",
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
        "Duas ao mesmo tempo nas salas menores e quatro nas grandes, lado a lado, e cada uma com o seu botão de tela cheia. Na voz cabe a galera toda: já rodou watch party com mais de cem pessoas na mesma sala.",
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
    {
      question:
        "Por que o compartilhamento de tela do Discord está suspenso no Brasil?",
      answer:
        "A Discord comunicou que tela compartilhada, vídeo e Go Live estão suspensos para usuários no Brasil desde 17 de agosto de 2026, cumprindo uma medida preventiva da ANPD, a autoridade brasileira de proteção de dados. É o comunicado da própria Discord. Esta página é sobre o que dá pra usar agora, não conselho jurídico.",
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
        "Two at the same time in smaller rooms and four in big ones, side by side, and each one has its own fullscreen button. Voice holds the whole room: one has already run a watch party with more than a hundred people in it.",
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
    {
      question: "Why is Discord screen share suspended in Brazil?",
      answer:
        "Discord announced that screen share, video, and Go Live are suspended for users in Brazil since 17 August 2026, complying with a preventive order from the ANPD, Brazil's data-protection authority. That is Discord's own announcement. This page is about what you can use right now, not legal advice.",
    },
  ],
  es: [
    {
      question: "¿Tengo que descargar algo?",
      answer:
        "No. pqp corre en el navegador en computadora y en Android. Hay una app de escritorio si la quieres, y una beta de iOS en TestFlight, pero ninguna es obligatoria.",
    },
    {
      question: "¿Se escucha el sonido de lo que comparto?",
      answer:
        "Sí, en Chrome o en Edge: cuando compartes una pestaña, activa la opción de compartir el audio. En la app de escritorio, Windows 11 también lleva el sonido del sistema. Firefox no comparte el audio de una pestaña.",
    },
    {
      question: "¿Cuántas personas pueden compartir pantalla en una sala?",
      answer:
        "Dos al mismo tiempo en las salas más chicas y cuatro en las grandes, lado a lado, y cada una con su propio botón de pantalla completa. En la voz cabe toda la sala: ya hubo una watch party con más de cien personas.",
    },
    {
      question: "¿Es gratis?",
      answer:
        "Sí. pqp es de código abierto bajo la AGPL (github.com/rafaelcg/pqp). Usa gratis el servicio alojado en pqp.gg, o corre tu propia copia.",
    },
    {
      question: "¿Funciona en el celular?",
      answer:
        "En Android hay una beta en APK en pqp.gg/android. En iPhone, TestFlight en pqp.gg/beta. El navegador sigue funcionando en los dos. Ninguna está en las tiendas todavía.",
    },
    {
      question: "¿Qué guardan sobre mí?",
      answer:
        "Menos de lo que te imaginas, y todo está explicado en lenguaje sencillo en la política de privacidad en pqp.gg/privacy. El pqp.gg alojado usa analítica sin cookies (Umami) y una etiqueta de conversión de Google Ads que solo cuenta registros. Sin remarketing, sin listas de audiencia.",
    },
    {
      question: "¿Por qué compartir pantalla desde el navegador?",
      answer:
        "Porque nadie tiene que instalar nada: mandas el link, la gente entra y ve tu pantalla. Si prefieres una app, también hay app de escritorio para Mac, Windows y Linux.",
    },
  ],
};

/**
 * The `/vem` FAQ, duplicated from `vem.faq.*` in the JSON catalogues and served
 * as FAQPage JSON-LD, in the page's own order (`VEM_FAQ_IDS` in
 * `pages/vem-page.tsx`). The suite pins every string here against its twin.
 */
export const VEM_FAQ: Record<
  MarketingLocale,
  { question: string; answer: string }[]
> = {
  "pt-BR": [
    {
      question: "Meus amigos não vão mudar.",
      answer:
        "Não precisam mudar. Precisam clicar num link. A sala deles nasce igual aqui, com os mesmos canais e os mesmos cargos, e o convite abre no navegador. Muita turma mantém os dois: o Discord pra o que já era, o pqp pra call e pra tela. Quando a call é melhor de um lado, a galera vai sozinha.",
    },
    {
      question: "Isso é seguro?",
      answer:
        "É um site: não instala nada. Os servidores ficam em São Paulo. Você apaga a conta de dentro do app e exporta os seus dados quando quiser. Bloqueio, denúncia e automod existem. O código é público se você quiser olhar, e não precisa ler pra usar. O pqp é pra maiores de 18.",
    },
    {
      question: "É de graça mesmo? Qual é a pegadinha?",
      answer:
        "Não tem plano pago hoje e não tem limite artificial de sala. O projeto é código aberto sob AGPL, então o que existe continua existindo pra quem roda a própria cópia. Dá pra doar pra ajudar na hospedagem, e doar não desbloqueia nada. A pegadinha é ser beta: vai ter aresta, e a gente conserta em público.",
    },
    {
      question: "E os bots?",
      answer:
        "Webhook de entrada compatível com o do Discord (o que posta lá, posta aqui), webhook de saída pra quem quer automatizar, e comandos nativos: /roll, /flip, /draw, /poll, fila de música. Loja de bots ainda não tem. Se o seu servidor vive de bot, é a coisa mais honesta que a gente pode te dizer.",
    },
    {
      question: "E as minhas mensagens?",
      answer:
        "Ficam no Discord. O template não carrega mensagem, e o pqp não pede login na sua conta de lá. O que nasce aqui é a estrutura; a conversa começa do zero, com a galera que chegar. As mensagens do pqp são suas: busca, exporta, apaga.",
    },
    {
      question: "Preciso instalar alguma coisa?",
      answer:
        "Não. Funciona no navegador, no computador e no celular. Tem app de desktop pra Mac, Windows e Linux, e beta pra iPhone (TestFlight) e Android (APK), se você preferir.",
    },
    {
      question: "Quantas pessoas cabem numa call?",
      answer:
        "A sala inteira. Centenas de pessoas já assistiram junto numa sala só no pqp.gg. Uma cópia auto-hospedada sem servidor de mídia fica em torno de oito por canal.",
    },
    {
      question: "E se eu quiser voltar?",
      answer:
        "Volta. O Discord não mudou em nada. E a sua comunidade do pqp exporta quando você quiser.",
    },
  ],
  en: [
    {
      question: "My friends won't move.",
      answer:
        "They don't have to move. They have to click a link. Their room is born here with the same channels and the same roles, and the invite opens in the browser. Plenty of groups keep both: Discord for what it already was, pqp for the call and the screen. When the call is better on one side, people drift there on their own.",
    },
    {
      question: "Is it safe?",
      answer:
        "It is a website: nothing to install. Servers are in São Paulo. You delete your account from inside the app and export your data whenever you want. Blocking, reports and automod exist. The code is public if you want to look, and you don't need to read it to use it. pqp is for adults, 18 and over.",
    },
    {
      question: "Is it really free? What's the catch?",
      answer:
        "There is no paid plan today and no artificial room limit. The project is open source under the AGPL, so what exists keeps existing for anyone who runs their own copy. You can donate to help with hosting, and donating unlocks nothing. The catch is that it is a beta: there will be rough edges, and we fix them in public.",
    },
    {
      question: "What about bots?",
      answer:
        "Incoming webhooks compatible with Discord's (what posts there posts here), outgoing webhooks for anyone who wants to automate, and built-in commands: /roll, /flip, /draw, /poll, a music queue. No bot store yet. If your server runs on bots, that is the most honest thing we can tell you.",
    },
    {
      question: "What about my messages?",
      answer:
        "They stay on Discord. A template carries no messages, and pqp never asks to log into your account there. What is born here is the structure; the conversation starts fresh with whoever shows up. Messages on pqp are yours: search them, export them, delete them.",
    },
    {
      question: "Do I have to install anything?",
      answer:
        "No. It works in the browser, on the computer and on the phone. There is a desktop app for Mac, Windows and Linux, and betas for iPhone (TestFlight) and Android (APK), if you prefer.",
    },
    {
      question: "How many people fit in a call?",
      answer:
        "The whole room. Hundreds of people have already watched together in one room on pqp.gg. A self-hosted copy with no media server sits around eight per channel.",
    },
    {
      question: "What if I want to go back?",
      answer:
        "Go back. Discord was never touched. And your pqp community exports whenever you want.",
    },
  ],
  es: [
    {
      question: "Mis amigos no se van a cambiar.",
      answer:
        "No tienen que cambiarse. Tienen que darle clic a un link. Su sala aparece igualita aquí, con los mismos canales y los mismos roles, y la invitación abre en el navegador. Muchos grupos se quedan con los dos: Discord para lo de siempre, pqp para la llamada y la pantalla. Cuando la llamada está mejor de un lado, la gente se va solita.",
    },
    {
      question: "¿Es seguro?",
      answer:
        "Es un sitio web: no instalas nada. Los servidores están en São Paulo. Borras tu cuenta desde la app y exportas tus datos cuando quieras. Hay bloqueo, reportes y automod. El código es público si quieres echarle un ojo, y no necesitas leerlo para usarlo. pqp es para mayores de 18.",
    },
    {
      question: "¿De verdad es gratis? ¿Cuál es el truco?",
      answer:
        "Hoy no hay plan de pago ni límite artificial de sala. El proyecto es de código abierto bajo AGPL, así que lo que existe sigue existiendo para quien corra su propia copia. Puedes donar para ayudar con el hosting, y donar no desbloquea nada. El truco es que es beta: va a haber detalles, y los arreglamos en público.",
    },
    {
      question: "¿Y los bots?",
      answer:
        "Webhooks de entrada compatibles con los de Discord (lo que publica allá, publica aquí), webhooks de salida para quien quiera automatizar, y comandos integrados: /roll, /flip, /draw, /poll, cola de música. Tienda de bots todavía no hay. Si tu servidor vive de bots, esto es lo más honesto que te podemos decir.",
    },
    {
      question: "¿Y mis mensajes?",
      answer:
        "Se quedan en Discord. La plantilla no trae mensajes, y pqp nunca te pide entrar a tu cuenta de allá. Lo que nace aquí es la estructura; la conversación empieza de cero, con la banda que vaya llegando. Tus mensajes en pqp son tuyos: búscalos, expórtalos, bórralos.",
    },
    {
      question: "¿Tengo que instalar algo?",
      answer:
        "No. Funciona en el navegador, en la computadora y en el celular. Hay app de escritorio para Mac, Windows y Linux, y beta para iPhone (TestFlight) y Android (APK), si prefieres.",
    },
    {
      question: "¿Cuántas personas caben en una llamada?",
      answer:
        "La sala entera. Cientos de personas ya vieron algo juntas en una sola sala en pqp.gg. Una copia autoalojada sin servidor de medios anda por las ocho personas por canal.",
    },
    {
      question: "¿Y si me quiero regresar?",
      answer:
        "Te regresas. Tu Discord no cambió en nada. Y tu comunidad de pqp se exporta cuando quieras.",
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
 * Every page carries the WebSite node, and now an Organization node beside
 * it: one stable identity for the publisher, independent of which page a
 * crawler landed on first, with `sameAs` pointing at the two other places the
 * same product answers for itself — the source repository and the Play Store
 * listing. Both are checked-in facts, not guesses: the repo is the one this
 * codebase lives in, and the Play listing is the one `docs/ANDROID_RELEASE.md`
 * records production access as open for. The App Store is deliberately absent
 * — TestFlight is a beta enrollment, not a public listing, and `sameAs` is for
 * pages anyone can already land on.
 *
 * The landing adds SoftwareApplication — the page is the product — mirroring
 * what the shipped `index.html` says (`applicationCategory`, a zero-price
 * Offer) and, since the redesign, its own FAQPage, plus the same Play Store
 * link on `sameAs` for the one app-store URL that is public today. `/vs-discord`
 * adds FAQPage too, whose questions are the FAQ section actually rendered on
 * the page — schema for copy a visitor can read, never schema alone. `/tela`
 * does the same with its own seven.
 */
const ORGANIZATION_SAME_AS = [
  "https://github.com/rafaelcg/pqp",
  "https://play.google.com/store/apps/details?id=gg.pqp.app",
];

function jsonLdFor(page: MarketingPage, locale: MarketingLocale): string {
  const graph: Record<string, unknown>[] = [
    {
      "@type": "WebSite",
      name: "pqp",
      url: `${CANONICAL_ORIGIN}/`,
      inLanguage: ["pt-BR", "en", "es"],
    },
    {
      "@type": "Organization",
      name: "pqp",
      url: `${CANONICAL_ORIGIN}/`,
      logo: `${CANONICAL_ORIGIN}/icons/icon-512.png`,
      sameAs: ORGANIZATION_SAME_AS,
    },
  ];
  if (page === "/") {
    graph.push({
      "@type": "SoftwareApplication",
      name: "pqp",
      applicationCategory: "CommunicationApplication",
      operatingSystem: "Web, Windows, macOS, Linux, Android",
      url: `${CANONICAL_ORIGIN}/`,
      description: pick(PAGE_COPY["/"].description, locale),
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      sameAs: ORGANIZATION_SAME_AS,
    });
  }
  const faq =
    page === "/"
      ? LANDING_FAQ[locale]
      : page === "/vs-discord"
        ? VS_DISCORD_FAQ[locale]
        : page === "/tela"
          ? TELA_FAQ[locale]
          : page === "/vem"
            ? VEM_FAQ[locale]
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
  const title = pick(copy.title, locale);
  const description = pick(copy.description, locale);
  const ogTitle = copy.ogTitle ? pick(copy.ogTitle, locale) : title;
  const ogDescription = copy.ogDescription
    ? pick(copy.ogDescription, locale)
    : description;
  const image = `${CANONICAL_ORIGIN}${copy.image ? pick(copy.image, locale) : "/images/og-image.jpg"}`;
  const e = escapeHtml;
  const langSuffix = url.includes("?") ? "&" : "?";

  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<link rel="canonical" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="x-default" href="${e(url)}" />`,
    `<link rel="alternate" hreflang="pt-BR" href="${e(url)}${langSuffix}lang=pt-BR" />`,
    `<link rel="alternate" hreflang="en" href="${e(url)}${langSuffix}lang=en" />`,
    `<link rel="alternate" hreflang="es" href="${e(url)}${langSuffix}lang=es" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="pqp" />`,
    `<meta property="og:url" content="${e(url)}" />`,
    `<meta property="og:title" content="${e(ogTitle)}" />`,
    `<meta property="og:description" content="${e(ogDescription)}" />`,
    `<meta property="og:image" content="${e(image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${e(ogTitle)}" />`,
    `<meta name="twitter:description" content="${e(ogDescription)}" />`,
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
  if (locale !== "en") {
    stripped = stripped.replace('<html lang="en">', `<html lang="${locale}">`);
  }
  const insertAt = stripped.indexOf("<head>") + "<head>".length;
  return (
    stripped.slice(0, insertAt) +
    "\n    " +
    renderMarketingHead(page, locale) +
    stripped.slice(insertAt)
  );
}
