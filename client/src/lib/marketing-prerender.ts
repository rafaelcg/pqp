/**
 * The words of a marketing page for a reader that runs no JavaScript.
 *
 * WHY THIS EXISTS. Every marketing route is the same `index.html` with an
 * empty `<div id="root">`, and only the home page carries a first screen of
 * its own (`prerender-hero.ts`). A crawler or an unfurler that does not run the
 * bundle reads `/streamers` as a head (`marketing-meta.ts`) over an empty body.
 * For a page whose job is to be found and passed around, that is the page
 * missing. So the Pages middleware writes the hero, the three steps and the FAQ
 * into `#root` as plain HTML, in the language it negotiated.
 *
 * NOBODY WITH JAVASCRIPT SEES IT. The head script in `index.html` sets
 * `data-route` on every page, and `index.css` hides `#pre-page` under that
 * attribute; React then replaces whatever is in `#root` on its first render.
 * So a browser never paints this block, and nothing has to match the live page
 * node for node, which is why it is plain semantic HTML with a few token
 * classes rather than a copy of the React tree.
 *
 * DEPENDENCY-FREE, like `marketing-meta.ts`: the middleware is bundled outside
 * the workspace and cannot import the catalogues or `@pqp/shared`. The strings
 * below are duplicates of `streamersPage.*`, and `marketing-prerender.test.ts`
 * pins each one against the JSON, and the button's address against
 * `STREAMERS_WAITLIST_HREF`. The `/tela`, `/vs-discord` and `/download` strings
 * are generated into `marketing-prerender-copy.ts` by
 * `scripts/gen-prerender-copy.mjs`, pinned by the same test.
 */

import {
  escapeHtml,
  STREAMERS_FAQ,
  type MarketingLocale,
  type MarketingPage,
} from "./marketing-meta";
import {
  CHROME_PRERENDER_COPY,
  DOWNLOAD_PRERENDER_COPY,
  TELA_PRERENDER_COPY,
  VS_DISCORD_PRERENDER_COPY,
} from "./marketing-prerender-copy";

/** The catalogue keys this block reads, in the order it reads them. */
export const STREAMERS_PRERENDER_KEYS = [
  "streamersPage.hero.eyebrow",
  "streamersPage.hero.title",
  "streamersPage.hero.body",
  "streamersPage.hero.cta",
  "streamersPage.hero.beta",
  "streamersPage.hero.signup",
  "streamersPage.steps.title",
  "streamersPage.steps.setup.title",
  "streamersPage.steps.setup.body",
  "streamersPage.steps.live.title",
  "streamersPage.steps.live.body",
  "streamersPage.steps.watch.title",
  "streamersPage.steps.watch.body",
  "streamersPage.beta.title",
  "streamersPage.beta.body",
  "streamersPage.faq.title",
  "streamersPage.faq.share.link",
] as const;

type StreamersKey = (typeof STREAMERS_PRERENDER_KEYS)[number];

export const STREAMERS_PRERENDER_COPY: Record<
  MarketingLocale,
  Record<StreamersKey, string>
> = {
  "pt-BR": {
    "streamersPage.hero.eyebrow":
      "Pra streamers",
    "streamersPage.hero.title":
      "Sua comunidade assistindo junto, numa sala que é sua.",
    "streamersPage.hero.body":
      "Você compartilha a tela no pqp e a galera assiste no navegador, sem instalar nada, sem entrar na call e sem o teto de 50 pessoas. A reação continua na sua live, com o chat de sempre.",
    "streamersPage.hero.cta":
      "Pedir acesso",
    "streamersPage.hero.beta":
      "Em beta. Liberamos servidor por servidor, porque cada sessão usa o nosso servidor de vídeo.",
    "streamersPage.hero.signup":
      "Dá pra criar a conta com a Twitch, o Google ou a Apple.",
    "streamersPage.steps.title":
      "Como funciona",
    "streamersPage.steps.setup.title":
      "Monta a sessão",
    "streamersPage.steps.setup.body":
      "Aperta Criar watch party, dá um nome e escolhe a aba ou a janela que vai compartilhar. Só você vê a prévia até ir ao vivo.",
    "streamersPage.steps.live.title":
      "Vai ao vivo",
    "streamersPage.steps.live.body":
      "Aperta Ir ao vivo. A imagem, o som da aba, o seu microfone e a sua câmera vão juntos pra quem está assistindo.",
    "streamersPage.steps.watch.title":
      "A galera assiste",
    "streamersPage.steps.watch.body":
      "Quem você convidar abre o link no navegador, no computador ou no celular, e assiste com o chat do lado. Ninguém precisa de microfone.",
    "streamersPage.beta.title":
      "Em beta, servidor por servidor",
    "streamersPage.beta.body":
      "Cada sessão usa o nosso servidor de vídeo, então liberamos aos poucos. Você pede acesso, diz quanta gente costuma assistir, e avisamos no app quando o seu servidor for liberado.",
    "streamersPage.faq.title":
      "Perguntas de quem faz live",
    "streamersPage.faq.share.link":
      "Ler os termos de uso",
  },
  en: {
    "streamersPage.hero.eyebrow":
      "For streamers",
    "streamersPage.hero.title":
      "Your community watching together, in a room that is yours.",
    "streamersPage.hero.body":
      "You share your screen on pqp and your people watch in the browser, with nothing to install, no call to join and no 50-person cap. Your reaction stays on your stream, with the chat you already have.",
    "streamersPage.hero.cta":
      "Ask for access",
    "streamersPage.hero.beta":
      "In beta. We switch it on one server at a time, because every session runs on our video server.",
    "streamersPage.hero.signup":
      "You can sign up with Twitch, Google or Apple.",
    "streamersPage.steps.title":
      "How it works",
    "streamersPage.steps.setup.title":
      "Set it up",
    "streamersPage.steps.setup.body":
      "Press New watch party, give it a name and pick the tab or window you will share. Only you see the preview until you go live.",
    "streamersPage.steps.live.title":
      "Go live",
    "streamersPage.steps.live.body":
      "Press Go live. The picture, the tab's sound, your microphone and your camera go out together to everyone watching.",
    "streamersPage.steps.watch.title":
      "Your people watch",
    "streamersPage.steps.watch.body":
      "Whoever you invite opens the link in the browser, on a computer or a phone, and watches with the chat beside it. Nobody needs a microphone.",
    "streamersPage.beta.title":
      "In beta, one server at a time",
    "streamersPage.beta.body":
      "Every session runs on our video server, so we open it up gradually. You ask for access, tell us roughly how many people usually watch, and we let you know in the app when your server is on.",
    "streamersPage.faq.title":
      "Questions from people who stream",
    "streamersPage.faq.share.link":
      "Read the terms of service",
  },
  es: {
    "streamersPage.hero.eyebrow":
      "Para streamers",
    "streamersPage.hero.title":
      "Tu comunidad viendo junta, en una sala que es tuya.",
    "streamersPage.hero.body":
      "Tú compartes la pantalla en pqp y la banda la ve en el navegador, sin instalar nada, sin entrar a la llamada y sin el tope de 50 personas. Tu reacción sigue en tu stream, con el chat de siempre.",
    "streamersPage.hero.cta":
      "Pedir acceso",
    "streamersPage.hero.beta":
      "En beta. Lo activamos servidor por servidor, porque cada sesión usa nuestro servidor de video.",
    "streamersPage.hero.signup":
      "Puedes crear tu cuenta con Twitch, Google o Apple.",
    "streamersPage.steps.title":
      "Cómo funciona",
    "streamersPage.steps.setup.title":
      "Arma la sesión",
    "streamersPage.steps.setup.body":
      "Presiona Nueva watch party, ponle nombre y elige la pestaña o la ventana que vas a compartir. Solo tú ves la vista previa hasta salir en vivo.",
    "streamersPage.steps.live.title":
      "Sal en vivo",
    "streamersPage.steps.live.body":
      "Presiona Salir en vivo. La imagen, el sonido de la pestaña, tu micrófono y tu cámara salen juntos para todos los que están viendo.",
    "streamersPage.steps.watch.title":
      "La banda la ve",
    "streamersPage.steps.watch.body":
      "Quien invites abre el link en el navegador, en la computadora o en el celular, y la ve con el chat al lado. Nadie necesita micrófono.",
    "streamersPage.beta.title":
      "En beta, servidor por servidor",
    "streamersPage.beta.body":
      "Cada sesión usa nuestro servidor de video, así que lo abrimos poco a poco. Pides acceso, nos dices cuánta gente suele mirar, y te avisamos en la app cuando tu servidor esté activado.",
    "streamersPage.faq.title":
      "Preguntas de quien hace stream",
    "streamersPage.faq.share.link":
      "Leer los términos de uso",
  },
};

/** The catalogue keys the `/contact` block reads, in the order it reads them. */
export const CONTACT_PRERENDER_KEYS = [
  "contactPage.eyebrow",
  "contactPage.title",
  "contactPage.lead",
  "contactPage.who.title",
  "contactPage.who.body",
  "contactPage.contact.title",
  "contactPage.contact.body",
  "contactPage.independent.title",
  "contactPage.independent.body",
  "contactPage.links.title",
  "footer.privacy",
  "footer.terms",
  "footer.source",
] as const;

type ContactKey = (typeof CONTACT_PRERENDER_KEYS)[number];

export const CONTACT_PRERENDER_COPY: Record<
  MarketingLocale,
  Record<ContactKey, string>
> = {
  "pt-BR": {
    "contactPage.eyebrow":
      "Sobre e contato",
    "contactPage.title":
      "Quem faz o pqp",
    "contactPage.lead":
      "O pqp é um app gratuito e de código aberto para voz, compartilhamento de tela e chat de texto.",
    "contactPage.who.title":
      "Quem está por trás",
    "contactPage.who.body":
      "O pqp é feito por dois irmãos. É um projeto pequeno, e o código é público para qualquer pessoa ler.",
    "contactPage.contact.title":
      "Contato",
    "contactPage.contact.body":
      "Para dúvidas, suporte, pedidos de privacidade ou qualquer outro assunto do serviço, manda um e-mail para o endereço abaixo.",
    "contactPage.independent.title":
      "Projeto independente",
    "contactPage.independent.body":
      "O pqp é um projeto independente e não é afiliado ao Discord nem a nenhuma outra empresa.",
    "contactPage.links.title":
      "Políticas e código-fonte",
    "footer.privacy":
      "Privacidade",
    "footer.terms":
      "Termos",
    "footer.source":
      "Código no GitHub",
  },
  "en": {
    "contactPage.eyebrow":
      "About and contact",
    "contactPage.title":
      "Who makes pqp",
    "contactPage.lead":
      "pqp is a free, open source app for voice, screen sharing and text chat.",
    "contactPage.who.title":
      "Who is behind it",
    "contactPage.who.body":
      "pqp is made by two brothers. It is a small project, and the code is public for anyone to read.",
    "contactPage.contact.title":
      "Contact",
    "contactPage.contact.body":
      "For questions, support, privacy requests or anything else about the service, send an email to the address below.",
    "contactPage.independent.title":
      "Independent project",
    "contactPage.independent.body":
      "pqp is an independent project and is not affiliated with Discord or any other company.",
    "contactPage.links.title":
      "Policies and source code",
    "footer.privacy":
      "Privacy",
    "footer.terms":
      "Terms",
    "footer.source":
      "Source on GitHub",
  },
  "es": {
    "contactPage.eyebrow":
      "Acerca de y contacto",
    "contactPage.title":
      "Quién hace pqp",
    "contactPage.lead":
      "pqp es una app gratuita y de código abierto para voz, pantalla compartida y chat de texto.",
    "contactPage.who.title":
      "Quién está detrás",
    "contactPage.who.body":
      "pqp lo hacen dos hermanos. Es un proyecto pequeño, y el código es público para que cualquiera lo lea.",
    "contactPage.contact.title":
      "Contacto",
    "contactPage.contact.body":
      "Para dudas, soporte, solicitudes de privacidad o cualquier otro tema del servicio, escribe un correo a la dirección de abajo.",
    "contactPage.independent.title":
      "Proyecto independiente",
    "contactPage.independent.body":
      "pqp es un proyecto independiente y no está afiliado a Discord ni a ninguna otra empresa.",
    "contactPage.links.title":
      "Políticas y código fuente",
    "footer.privacy":
      "Privacidad",
    "footer.terms":
      "Términos",
    "footer.source":
      "Código en GitHub",
  },
};

/** The address the page gives, the same constant as `CONTACT_EMAIL` in `help-contact.ts`, pinned by the test. */
export const CONTACT_PRERENDER_EMAIL = "contato@pqp.gg";

/** The repository, the same constant as `SOURCE_REPO_URL` in `downloads.ts`, pinned by the test. */
export const CONTACT_PRERENDER_SOURCE_URL = "https://github.com/rafaelcg/pqp";

/** `STREAMERS_WAITLIST_HREF` in `handle-intent.ts`, pinned by the test. */
export const STREAMERS_PRERENDER_CTA_HREF =
  "/app?intent=watch-party-waitlist&from=streamers";

/**
 * Where the create-room buttons of `/tela` and `/vs-discord` lead without
 * script. The live button opens the sign-up modal with `forceRedirectUrl="/app"`,
 * and is a plain link to `/app` for a signed-in reader.
 */
export const CREATE_ROOM_PRERENDER_HREF = "/app";

/**
 * The iOS beta button on `/vs-discord` when the edge config does not say:
 * `PUBLIC_TESTFLIGHT_URL` in `testflight.ts`, pinned by the test. The live page
 * reads `testflightUrl()`, which the `VITE_TESTFLIGHT_URL` build secret
 * overrides; the build writes that result into `/edge-config.json`, and the
 * middleware passes it in as `MarketingChrome.iosBetaUrl`.
 */
export const IOS_BETA_PRERENDER_HREF = "https://testflight.apple.com/join/envnP5vV";

/** `RELEASES_PAGE_URL` in `downloads.ts`, pinned by the test. Every desktop row links it until the bundle resolves the asset URLs. */
export const DOWNLOAD_PRERENDER_RELEASES_URL =
  "https://github.com/rafaelcg/pqp/releases/latest";

/** `SIGNPATH_CREDIT`, `SIGNPATH_URL` and `SIGNPATH_TERMS_URL` in `downloads.ts`, pinned by the test. The credit is never translated. */
export const DOWNLOAD_PRERENDER_SIGNPATH = {
  credit:
    "Free code signing provided by SignPath.io, certificate by SignPath Foundation",
  url: "https://signpath.org",
  terms: "https://signpath.org/terms",
} as const;

/** The repository's Electron workflow, the same address `code-signing-policy.tsx` links. */
export const DOWNLOAD_PRERENDER_WORKFLOW_URL = `${CONTACT_PRERENDER_SOURCE_URL}/blob/main/.github/workflows/electron.yml`;

/** `CODE_SIGNING_COMMITTERS` and `CODE_SIGNING_APPROVERS` in `code-signing-policy.tsx`, pinned by the test. */
export const DOWNLOAD_PRERENDER_TEAM = {
  committers: [
    { name: "Rafael Cammarano Guglielmi", handle: "rafaelcg" },
    { name: "André", handle: "AndreCamm" },
  ],
  approvers: [{ name: "Rafael Cammarano Guglielmi", handle: "rafaelcg" }],
} as const;

/** The verdicts of the `/vs-discord` table, in the live page's row order. */
const VS_DISCORD_ROWS = [
  ["price", "yes", "yes"],
  ["openSource", "yes", "no"],
  ["selfHost", "yes", "no"],
  ["ageGate", "yes", "yes"],
  ["apps", "partial", "yes"],
  ["ecosystem", "partial", "yes"],
  ["maturity", "partial", "yes"],
  ["region", "yes", "yes"],
] as const;

/** The element the block is written into, exactly as `index.html` has it. */
const ROOT_OPEN = '<div id="root">';

function streamersBlock(locale: MarketingLocale): string {
  const c = STREAMERS_PRERENDER_COPY[locale];
  const e = escapeHtml;
  const steps = (["setup", "live", "watch"] as const)
    .map(
      (id, index) =>
        `<li class="mt-4"><h3 class="font-display text-lg font-bold">${index + 1}. ${e(c[`streamersPage.steps.${id}.title`])}</h3><p class="mt-1 text-text-secondary">${e(c[`streamersPage.steps.${id}.body`])}</p></li>`,
    )
    .join("");
  const faq = STREAMERS_FAQ[locale]
    .map(
      (item, index) =>
        `<div class="mt-4"><dt class="font-display font-bold">${e(item.question)}</dt><dd class="mt-1 text-text-secondary">${e(item.answer)}${index === 0 ? ` <a href="/terms#voice" class="underline">${e(c["streamersPage.faq.share.link"])}</a>` : ""}</dd></div>`,
    )
    .join("");
  return [
    `<main class="mx-auto max-w-3xl">`,
    `<p class="text-xs font-semibold uppercase tracking-[0.18em] text-accent">${e(c["streamersPage.hero.eyebrow"])}</p>`,
    `<h1 class="mt-4 font-display text-4xl font-extrabold tracking-tight">${e(c["streamersPage.hero.title"])}</h1>`,
    `<p class="mt-5 text-lg text-text-secondary">${e(c["streamersPage.hero.body"])}</p>`,
    `<p class="mt-6"><a href="${e(STREAMERS_PRERENDER_CTA_HREF)}" class="inline-flex rounded-[var(--radius-control)] bg-accent px-6 py-3 font-semibold text-on-accent">${e(c["streamersPage.hero.cta"])}</a></p>`,
    `<p class="mt-4 text-sm text-text-tertiary">${e(c["streamersPage.hero.beta"])} ${e(c["streamersPage.hero.signup"])}</p>`,
    `<section class="mt-12"><h2 class="font-display text-2xl font-bold">${e(c["streamersPage.steps.title"])}</h2><ol>${steps}</ol></section>`,
    `<section class="mt-12"><h2 class="font-display text-xl font-bold">${e(c["streamersPage.beta.title"])}</h2><p class="mt-2 text-text-secondary">${e(c["streamersPage.beta.body"])}</p></section>`,
    `<section class="mt-12"><h2 class="font-display text-2xl font-bold">${e(c["streamersPage.faq.title"])}</h2><dl>${faq}</dl></section>`,
    `</main>`,
  ].join("");
}

function contactBlock(locale: MarketingLocale): string {
  const c = CONTACT_PRERENDER_COPY[locale];
  const e = escapeHtml;
  const h2 = (text: string) =>
    `<h2 class="mt-10 font-display text-xl font-bold">${e(text)}</h2>`;
  return [
    `<main class="mx-auto max-w-2xl">`,
    `<p class="text-xs font-semibold uppercase tracking-[0.18em] text-accent">${e(c["contactPage.eyebrow"])}</p>`,
    `<h1 class="mt-3 font-display text-4xl font-extrabold tracking-tight">${e(c["contactPage.title"])}</h1>`,
    `<p class="mt-5 text-lg text-text-secondary">${e(c["contactPage.lead"])}</p>`,
    h2(c["contactPage.who.title"]),
    `<p class="mt-2 text-text-secondary">${e(c["contactPage.who.body"])}</p>`,
    h2(c["contactPage.contact.title"]),
    `<p class="mt-2 text-text-secondary">${e(c["contactPage.contact.body"])}</p>`,
    `<p class="mt-4"><a href="mailto:${e(CONTACT_PRERENDER_EMAIL)}" class="underline">${e(CONTACT_PRERENDER_EMAIL)}</a></p>`,
    h2(c["contactPage.independent.title"]),
    `<p class="mt-2 text-text-secondary">${e(c["contactPage.independent.body"])}</p>`,
    h2(c["contactPage.links.title"]),
    `<ul class="mt-2"><li><a href="/privacy" class="underline">${e(c["footer.privacy"])}</a></li><li><a href="/terms" class="underline">${e(c["footer.terms"])}</a></li><li><a href="${e(CONTACT_PRERENDER_SOURCE_URL)}" class="underline">${e(c["footer.source"])}</a></li></ul>`,
    `</main>`,
  ].join("");
}

const OPEN_PAGE = (width: string) => `<main class="mx-auto ${width}">`;
const CLOSE_PAGE = `</main>`;
const BUTTON =
  "inline-flex rounded-[var(--radius-control)] bg-accent px-6 py-3 font-semibold text-on-accent";

function telaBlock(locale: MarketingLocale): string {
  const c = TELA_PRERENDER_COPY[locale];
  const e = escapeHtml;
  const cta = `<p class="mt-6"><a href="${CREATE_ROOM_PRERENDER_HREF}" class="${BUTTON}">${e(c["tela.cta.create"])}</a></p>`;
  const options = (["pqp", "jitsi", "teamspeak", "meet"] as const)
    .map((id) => {
      const ours =
        id === "pqp"
          ? ` <span class="text-xs font-semibold uppercase tracking-[0.16em] text-accent">${e(c["tela.options.ours"])}</span>`
          : "";
      return `<li class="mt-6"><h3 class="font-display text-xl font-bold">${e(c[`tela.option.${id}.name`])}${ours}</h3><p class="mt-1 text-text-secondary">${e(c[`tela.option.${id}.body`])}</p><dl class="mt-2"><dt class="text-xs font-semibold uppercase tracking-[0.16em]">${e(c["tela.options.goodFor"])}</dt><dd class="mt-1">${e(c[`tela.option.${id}.good`])}</dd><dt class="mt-2 text-xs font-semibold uppercase tracking-[0.16em]">${e(c["tela.options.limit"])}</dt><dd class="mt-1 text-text-secondary">${e(c[`tela.option.${id}.limit`])}</dd></dl></li>`;
    })
    .join("");
  const steps = (["1", "2", "3"] as const)
    .map((n) => `<li class="mt-3">${n}. ${e(c[`tela.how.${n}`])}</li>`)
    .join("");
  const faq = (["download", "vpn", "people", "free", "mobile", "data", "why"] as const)
    .map(
      (id) =>
        `<div class="mt-4"><dt class="font-display font-bold">${e(c[`tela.faq.${id}.q`])}</dt><dd class="mt-1 text-text-secondary">${e(c[`tela.faq.${id}.a`])}${id === "data" ? ` <a href="/privacy" class="underline">${e(c["tela.faq.data.link"])}</a>` : ""}</dd></div>`,
    )
    .join("");
  return [
    OPEN_PAGE("max-w-3xl"),
    `<h1 class="font-display text-4xl font-bold tracking-tight">${e(c["tela.hero.title"])}</h1>`,
    `<p class="mt-5 text-lg text-text-secondary">${e(c["tela.hero.lede"])}</p>`,
    cta,
    `<p class="mt-4 text-sm text-text-tertiary">${e(c["tela.hero.note"])}</p>`,
    `<section class="mt-12"><h2 class="font-display text-2xl font-bold">${e(c["tela.options.title"])}</h2><p class="mt-2 text-sm text-text-secondary">${e(c["tela.hero.disclosure"])}</p><ul>${options}</ul><p class="mt-4 text-xs text-text-tertiary">${e(c["tela.options.asOf"])}</p></section>`,
    `<section class="mt-12"><h2 class="font-display text-2xl font-bold">${e(c["tela.how.title"])}</h2><ol>${steps}</ol></section>`,
    `<section class="mt-12"><h2 class="font-display text-2xl font-bold">${e(c["tela.faq.title"])}</h2><dl>${faq}</dl></section>`,
    `<section class="mt-12"><h2 class="font-display text-2xl font-bold">${e(c["tela.cta.title"])}</h2><p class="mt-2 text-text-secondary">${e(c["tela.cta.body"])}</p>${cta}<p class="mt-4"><a href="/vs-discord" class="underline">${e(c["tela.cta.compare"])}</a></p></section>`,
    CLOSE_PAGE,
  ].join("");
}

function vsDiscordBlock(locale: MarketingLocale, chrome: MarketingChrome): string {
  const c = VS_DISCORD_PRERENDER_COPY[locale];
  const e = escapeHtml;
  const cta = `<a href="${CREATE_ROOM_PRERENDER_HREF}" class="${BUTTON}">${e(c["vsDiscord.cta.create"])}</a>`;
  // The live cell prefixes a visually hidden verdict word when the phrase does
  // not already start with it (`VerdictCell` in `vs-discord-page.tsx`).
  const cell = (verdict: "yes" | "no" | "partial", body: string) => {
    const word = c[`vsDiscord.chip.${verdict}`];
    const prefix = body.toLowerCase().startsWith(word.toLowerCase())
      ? ""
      : `<span class="sr-only">${e(word)}: </span>`;
    return `${prefix}${e(body)}`;
  };
  const rows = VS_DISCORD_ROWS.map(
    ([id, pqp, discord]) =>
      `<tr><th scope="row" class="py-2 pr-4 align-top">${e(c[`vsDiscord.row.${id}.label`])}</th><td class="py-2 pr-4 align-top">${cell(pqp, c[`vsDiscord.row.${id}.pqp`])}</td><td class="py-2 align-top text-text-secondary">${cell(discord, c[`vsDiscord.row.${id}.discord`])}</td></tr>`,
  ).join("");
  const faq = (["why", "when", "how", "catch"] as const)
    .map(
      (id) =>
        `<div class="mt-4"><dt class="font-display font-bold">${e(c[`vsDiscord.faq.${id}.q`])}</dt><dd class="mt-1 text-text-secondary">${e(c[`vsDiscord.faq.${id}.a`])}</dd></div>`,
    )
    .join("");
  // Spanish readers are outside Brazil, and the live page drops the card about
  // the Brazilian suspension for them.
  const featured =
    locale === "es"
      ? `<p class="mt-8">${cta}</p>`
      : `<section class="mt-12"><h2 class="text-xs font-semibold uppercase tracking-[0.22em]">${e(c["vsDiscord.row.screen.label"])}</h2><div class="mt-4"><p class="font-display text-lg font-bold">pqp: ${e(c["vsDiscord.chip.works"])}</p><p class="mt-1 text-text-secondary">${e(c["vsDiscord.featured.pqpDetail"])}</p><p class="mt-4">${cta}</p></div><div class="mt-6"><p class="font-display text-lg font-bold">Discord: ${e(c["vsDiscord.chip.suspended"])}</p><p class="mt-1 text-text-secondary">${e(c["vsDiscord.featured.discordDetail"])}</p></div><p class="mt-4 text-xs text-text-tertiary">${e(c["vsDiscord.hero.disclaimer"])}</p></section>`;
  return [
    OPEN_PAGE("max-w-3xl"),
    `<h1 class="font-display text-4xl font-extrabold tracking-tight">pqp vs Discord <span class="mt-3 block text-xl font-bold">${e(c["vsDiscord.hero.tagline"])}</span></h1>`,
    `<p class="mt-5 text-lg text-text-secondary">${e(c["vsDiscord.hero.body"])}</p>`,
    featured,
    `<section class="mt-12"><h2 class="font-display text-2xl font-bold">${e(c["vsDiscord.table.title"])}</h2><table class="mt-4 w-full text-left text-sm"><caption class="sr-only">${e(c["vsDiscord.table.caption"])}</caption><thead><tr><th scope="col" class="py-2 pr-4">${e(c["vsDiscord.table.col.feature"])}</th><th scope="col" class="py-2 pr-4">${e(c["vsDiscord.table.col.pqp"])}</th><th scope="col" class="py-2">${e(c["vsDiscord.table.col.discord"])}</th></tr></thead><tbody>${rows}</tbody></table></section>`,
    `<section class="mt-12"><h2 class="font-display text-2xl font-bold">${e(c["vsDiscord.faq.title"])}</h2><dl>${faq}</dl></section>`,
    `<section id="ios-beta" class="mt-12"><h2 class="font-display text-2xl font-bold">${e(c["vsDiscord.closing.title"])}</h2><p class="mt-2 text-text-secondary">${e(c["vsDiscord.closing.body"])}</p><p class="mt-6">${cta} <a href="${e(chrome.iosBetaUrl || IOS_BETA_PRERENDER_HREF)}" rel="noopener noreferrer" class="ml-3 underline">${e(c["vsDiscord.cta.beta"])}</a></p><p class="mt-6 text-sm text-text-secondary">${e(c["vsDiscord.closing.tela.lead"])} <a href="/tela" class="underline">${e(c["vsDiscord.closing.tela.link"])}</a></p></section>`,
    CLOSE_PAGE,
  ].join("");
}

function downloadBlock(locale: MarketingLocale): string {
  const c = DOWNLOAD_PRERENDER_COPY[locale];
  const e = escapeHtml;
  const external = (href: string, label: string) =>
    `<a href="${e(href)}" rel="noopener" class="underline">${e(label)}</a>`;
  const releases = (label: string) => external(DOWNLOAD_PRERENDER_RELEASES_URL, label);
  const row = (name: string, links: string) =>
    `<li class="mt-2"><span class="font-semibold">${e(name)}</span>: ${links}</li>`;
  const people = (members: readonly { name: string; handle: string }[]) =>
    members
      .map((m) => `<li>${e(m.name)} ${external(`https://github.com/${m.handle}`, `@${m.handle}`)}</li>`)
      .join("");
  return [
    OPEN_PAGE("max-w-3xl"),
    `<p class="font-display text-lg font-bold text-accent">pqp</p>`,
    `<h1 class="mt-4 font-display text-4xl font-extrabold tracking-tight">${e(c["downloadPage.title"])}</h1>`,
    `<p class="mt-5 text-lg text-text-secondary">${e(c["downloadPage.body"])}</p>`,
    `<p class="mt-6"><a href="/app" class="underline">${e(c["downloadPage.web.cta"])}</a></p>`,
    `<section class="mt-12"><h2 class="text-xs font-semibold uppercase tracking-[0.2em]">${e(c["downloadPage.all"])}</h2><ul class="mt-3">`,
    row(c["downloadPage.windows"], `${releases(c["downloadPage.list.download"])} · ${releases(c["download.windows.portableShort"])}`),
    row(c["downloadPage.mac"], `${releases(c["download.mac.appleSiliconShort"])} · ${releases(c["download.mac.intelShort"])}`),
    row(c["downloadPage.linux"], `${releases(c["download.linux.appImage"])} · ${releases(c["download.linux.deb"])} · ${releases(c["download.linux.flatpak"])}`),
    row(c["downloadPage.ios"], `<a href="/beta" class="underline">${e(c["downloadPage.list.ios"])}</a>`),
    row(c["downloadPage.android"], `<a href="/android" class="underline">${e(c["downloadPage.list.android"])}</a>`),
    `</ul><p class="mt-4 text-xs">${releases(c["download.other"])}</p></section>`,
    `<section id="code-signing" class="mt-16"><h2 class="font-display text-3xl font-extrabold">${e(c["codeSigning.title"])}</h2>`,
    `<p class="mt-4 text-text-secondary">${e(c["codeSigning.status"])}</p>`,
    `<blockquote lang="en" class="mt-4 font-medium">${e(DOWNLOAD_PRERENDER_SIGNPATH.credit)}</blockquote>`,
    `<p class="mt-4 text-sm text-text-secondary">${e(c["codeSigning.creditNote"])}</p>`,
    `<p class="mt-4 text-text-secondary">${e(c["codeSigning.unsigned"])}</p>`,
    `<p class="mt-2 text-sm">${external(DOWNLOAD_PRERENDER_SIGNPATH.url, c["codeSigning.link.signpath"])} · ${external(DOWNLOAD_PRERENDER_SIGNPATH.terms, c["codeSigning.link.terms"])}</p>`,
    `<h3 class="mt-10 text-xl font-semibold">${e(c["codeSigning.team.title"])}</h3><dl class="mt-3">`,
    `<dt class="font-medium">${e(c["codeSigning.team.committers"])}</dt><dd class="mt-1 text-sm text-text-secondary">${e(c["codeSigning.team.committers.desc"])}</dd><dd class="mt-2"><ul>${people(DOWNLOAD_PRERENDER_TEAM.committers)}</ul></dd>`,
    `<dt class="mt-4 font-medium">${e(c["codeSigning.team.approvers"])}</dt><dd class="mt-1 text-sm text-text-secondary">${e(c["codeSigning.team.approvers.desc"])}</dd><dd class="mt-2"><ul>${people(DOWNLOAD_PRERENDER_TEAM.approvers)}</ul></dd></dl>`,
    `<h3 class="mt-10 text-xl font-semibold">${e(c["codeSigning.how.title"])}</h3><ul class="mt-3 list-disc pl-5"><li>${e(c["codeSigning.how.build"])}</li><li>${e(c["codeSigning.how.approve"])}</li><li>${e(c["codeSigning.how.scope"])}</li></ul>`,
    `<p class="mt-3 text-sm">${external(CONTACT_PRERENDER_SOURCE_URL, c["codeSigning.link.repo"])} · ${external(DOWNLOAD_PRERENDER_WORKFLOW_URL, c["codeSigning.link.workflow"])}</p>`,
    `<h3 class="mt-10 text-xl font-semibold">${e(c["codeSigning.privacy.title"])}</h3>`,
    `<p class="mt-3 text-text-secondary">${e(c["codeSigning.privacy.installer"])}</p><p class="mt-3 text-text-secondary">${e(c["codeSigning.privacy.app"])}</p><p class="mt-3 text-text-secondary">${e(c["codeSigning.privacy.signpath"])}</p>`,
    `<p class="mt-3 text-sm"><a href="/privacy" class="underline">${e(c["codeSigning.privacy.link"])}</a></p>`,
    `</section>`,
    CLOSE_PAGE,
  ].join("");
}

/** Which block a page gets. Aliases share their page's block. */
const BLOCKS: Partial<
  Record<MarketingPage, (locale: MarketingLocale, chrome: MarketingChrome) => string>
> = {
  "/streamers": streamersBlock,
  "/criadores": streamersBlock,
  "/contact": contactBlock,
  "/contato": contactBlock,
  "/tela": telaBlock,
  "/vs-discord": vsDiscordBlock,
  "/download": downloadBlock,
};

/** The pages that carry a no-JS body. */
export const PRERENDERED_MARKETING_PAGES = Object.keys(BLOCKS) as MarketingPage[];

/**
 * The three things the live nav and footer decide at run time, as the edge
 * learns them. Every one defaults to off, so a reader that cannot be told
 * never gets a link the live page would not show. It also carries the iOS
 * beta link `/vs-discord` shows, which the build decides.
 */
export interface MarketingChrome {
  /** `useCommunitiesEnabled()`: the API's `COMMUNITIES_ENABLED`. */
  communities: boolean;
  /** `isSupportPageEnabled()`: the build had a sponsor URL or a Pix key. */
  supportPage: boolean;
  /** `playStoreUrl() !== null`: the build did not hide the Play listing. */
  playStore: boolean;
  /** `testflightUrl()` as the build resolved it. Unset falls back to `IOS_BETA_PRERENDER_HREF`. */
  iosBetaUrl?: string;
}

export const NO_MARKETING_CHROME: MarketingChrome = {
  communities: false,
  supportPage: false,
  playStore: false,
};

/** The second address in the footer's last line, as `marketing-footer.tsx` has it. */
export const FOOTER_PRERENDER_SITE_URL = "https://rafael.ltd";

/** `supportPagePath` in `support-links.ts`, pinned by the test. */
function supportPath(locale: MarketingLocale): "/apoie" | "/support" {
  return locale === "pt-BR" ? "/apoie" : "/support";
}

function navBlock(locale: MarketingLocale, chrome: MarketingChrome): string {
  const c = CHROME_PRERENDER_COPY[locale];
  const e = escapeHtml;
  const link = (href: string, label: string, attrs = "") =>
    `<li><a href="${href}"${attrs}>${e(label)}</a></li>`;
  // "Self-host" stays English in every catalogue, and the live link says so.
  const selfHostLang = locale === "en" ? "" : ' lang="en"';
  return [
    `<header class="mx-auto mb-10 max-w-3xl"><nav><ul class="flex flex-wrap gap-x-5 gap-y-2 text-sm">`,
    link("/", "pqp"),
    link("/#features", c["nav.features"]),
    link("/vs-discord", c["footer.vsDiscord"]),
    link("/download", c["nav.download"]),
    chrome.communities ? link("/#communities", c["nav.communities"]) : "",
    link("/#hosting", c["nav.selfHost"], selfHostLang),
    `</ul></nav></header>`,
  ].join("");
}

function footerBlock(locale: MarketingLocale, chrome: MarketingChrome): string {
  const c = CHROME_PRERENDER_COPY[locale];
  const e = escapeHtml;
  const link = (href: string, label: string, attrs = "") =>
    `<li><a href="${e(href)}"${attrs}>${e(label)}</a></li>`;
  const selfHostLang = locale === "en" ? "" : ' lang="en"';
  const product = [
    link("/app", c["nav.openApp"]),
    link("/download", c["footer.desktop"]),
    link("/#features", c["nav.features"]),
    chrome.communities ? link("/#communities", c["nav.communities"]) : "",
    link("/#hosting", c["nav.selfHost"], selfHostLang),
    link("/vs-discord", c["footer.vsDiscord"]),
    link("/vem", c["footer.vem"]),
    link("/tela", c["footer.tela"]),
    link("/streamers", c["footer.streamers"]),
    link("/beta", c["footer.iosBeta"]),
    link("/android", c[chrome.playStore ? "footer.androidBeta.play" : "footer.androidBeta"]),
    link("/blog", c["nav.blog"]),
    link("/status", c["footer.status"]),
    chrome.supportPage ? link(supportPath(locale), c["footer.support"]) : "",
    link(CONTACT_PRERENDER_SOURCE_URL, c["footer.source"], ' rel="noopener"'),
  ].join("");
  const legal = [
    link("/privacy", c["footer.privacy"]),
    link("/terms", c["footer.terms"]),
    link("/cookies", c["footer.cookies"]),
    link("/download#code-signing", c["footer.codeSigning"]),
    link("/contact", c["footer.contact"]),
  ].join("");
  const year = String(new Date().getUTCFullYear());
  return [
    `<footer class="mx-auto mt-16 max-w-3xl text-sm text-text-secondary">`,
    `<p class="font-display text-lg font-bold text-text">pqp</p>`,
    `<p class="mt-1">${e(c["footer.tagline"])}</p>`,
    `<nav class="mt-6 flex flex-wrap gap-x-10 gap-y-6">`,
    `<div><p class="text-xs font-medium uppercase tracking-[0.16em]">${e(c["footer.product"])}</p><ul class="mt-2 space-y-1">${product}</ul></div>`,
    `<div><p class="text-xs font-medium uppercase tracking-[0.16em]">${e(c["footer.legal"])}</p><ul class="mt-2 space-y-1">${legal}</ul></div>`,
    `</nav>`,
    `<p class="mt-8 text-xs">${e(c["footer.copyright"].replace("{year}", year))} · ${e(c["footer.madeBy"])} · <a href="mailto:${e(CONTACT_PRERENDER_EMAIL)}">${e(CONTACT_PRERENDER_EMAIL)}</a> · <a href="${FOOTER_PRERENDER_SITE_URL}" rel="noopener">rafael.ltd</a></p>`,
    `<p class="mt-2 text-xs">${e(c["footer.independent"])}</p>`,
    `</footer>`,
  ].join("");
}

/**
 * `html` with the page's no-JS body written into `#root`, or `html` unchanged
 * for a page that has none, a document with no `#root`, or a `#root` that
 * already has something in it (a second run must not write a second copy).
 * The body sits between the site's nav and footer, so a crawler reaches every
 * page the live chrome links.
 */
export function injectMarketingBody(
  html: string,
  page: MarketingPage,
  locale: MarketingLocale,
  chrome: MarketingChrome = NO_MARKETING_CHROME,
): string {
  const block = BLOCKS[page];
  if (!block) {
    return html;
  }
  const at = html.indexOf(ROOT_OPEN);
  if (at === -1 || html.includes('id="pre-page"')) {
    return html;
  }
  const insertAt = at + ROOT_OPEN.length;
  const body = [
    `<div id="pre-page" lang="${locale}" class="min-h-full bg-surface-0 px-4 py-12 text-text">`,
    navBlock(locale, chrome),
    block(locale, chrome),
    footerBlock(locale, chrome),
    `</div>`,
  ].join("");
  return html.slice(0, insertAt) + body + html.slice(insertAt);
}
