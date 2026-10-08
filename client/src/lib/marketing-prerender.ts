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
 * `STREAMERS_WAITLIST_HREF`.
 */

import {
  escapeHtml,
  STREAMERS_FAQ,
  type MarketingLocale,
  type MarketingPage,
} from "./marketing-meta";

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
    `<div id="pre-page" lang="${locale}" class="min-h-full bg-surface-0 px-4 py-12 text-text">`,
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
    `</div>`,
  ].join("");
}

function contactBlock(locale: MarketingLocale): string {
  const c = CONTACT_PRERENDER_COPY[locale];
  const e = escapeHtml;
  const h2 = (text: string) =>
    `<h2 class="mt-10 font-display text-xl font-bold">${e(text)}</h2>`;
  return [
    `<div id="pre-page" lang="${locale}" class="min-h-full bg-surface-0 px-4 py-12 text-text">`,
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
    `</div>`,
  ].join("");
}

/**
 * `html` with the page's no-JS body written into `#root`, or `html` unchanged
 * for a page that has none, a document with no `#root`, or a `#root` that
 * already has something in it (a second run must not write a second copy).
 */
export function injectMarketingBody(
  html: string,
  page: MarketingPage,
  locale: MarketingLocale,
): string {
  const isStreamers = page === "/streamers" || page === "/criadores";
  const isContact = page === "/contact" || page === "/contato";
  if (!isStreamers && !isContact) {
    return html;
  }
  const at = html.indexOf(ROOT_OPEN);
  if (at === -1 || html.includes('id="pre-page"')) {
    return html;
  }
  const insertAt = at + ROOT_OPEN.length;
  const body = isContact ? contactBlock(locale) : streamersBlock(locale);
  return html.slice(0, insertAt) + body + html.slice(insertAt);
}
