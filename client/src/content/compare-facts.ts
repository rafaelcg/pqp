/**
 * The facts behind every comparison page: `/vs-discord`, `/tela` and the
 * `/compare` hub. One file, so a cell cannot say one thing on one page and
 * another somewhere else, and so every claim about another product has the
 * same three things next to it: where it came from, the day somebody looked,
 * and a value written for each language.
 *
 * RULES (pinned by `compare-facts.test.ts`):
 *  - Every fact has at least one `https` source and a `checked` date. A row
 *    without either fails the suite, which is the point.
 *  - A cell that nobody verified says so (`status: "unknown"`, "not verified")
 *    instead of guessing. Where we looked is still the source.
 *  - Claims are about FEATURES, never about a company's conduct or troubles.
 *  - pqp's own rows are held to the same standard, and say what pqp lacks.
 *  - No em dashes. pt-BR uses "tu".
 *
 * DEPENDENCY-FREE on purpose: the Pages middleware bundles the no-JS bodies
 * outside the workspace (`marketing-prerender.ts` imports this file), so it
 * imports nothing.
 */

export type FactLocale = "pt-BR" | "en" | "es";
export type Loc = Record<FactLocale, string>;

/** `na` is only used for a cell that cannot apply (see `NOT_APPLICABLE`). */
export type FactStatus = "yes" | "no" | "partial" | "unknown";

export type CompareProduct = "pqp" | "discord" | "stoat" | "teamspeak" | "slack";

export type CompareFeature =
  | "price"
  | "openSource"
  | "selfHost"
  | "screenShare"
  | "screenAudio"
  | "watchParty"
  | "layoutImport"
  | "apps"
  | "ecosystem"
  | "maturity";

/**
 * The rows of the `/compare` matrix, in order. `maturity` is only on the
 * `/vs-discord` table, where it has a Discord line worth saying.
 */
export const MATRIX_FEATURES: readonly CompareFeature[] = [
  "price",
  "openSource",
  "selfHost",
  "screenShare",
  "screenAudio",
  "watchParty",
  "layoutImport",
  "apps",
  "ecosystem",
];

/** The rows of the `/vs-discord` table, in order. */
export const VS_DISCORD_FEATURES: readonly CompareFeature[] = [
  "price",
  "openSource",
  "selfHost",
  "screenShare",
  "screenAudio",
  "watchParty",
  "apps",
  "ecosystem",
  "maturity",
];

/** The day the facts below were last checked against their sources. */
export const FACTS_CHECKED = "2026-10-16";

export interface Fact {
  product: CompareProduct;
  feature: CompareFeature;
  status: FactStatus;
  value: Loc;
  /** Where the claim comes from, or where we looked when the cell is `unknown`. */
  sources: readonly string[];
  /** ISO date (`YYYY-MM-DD`) somebody last read the sources. */
  checked: string;
}

/**
 * Cells that cannot apply to a product, and so have no fact. Anything else
 * missing is a bug the suite catches.
 */
export const NOT_APPLICABLE: Partial<Record<CompareProduct, readonly CompareFeature[]>> = {
  // Discord is where the layout comes from.
  discord: ["layoutImport"],
};

const REPO = "https://github.com/rafaelcg/pqp";
const STOAT_NOTE = "https://stoat.chat/release-notes/93eb1f4ec77444ca9fb13617e0e6c0b1";
const STOAT_WIKI = "https://en.wikipedia.org/wiki/Stoat_(software)";
const STOAT_REPO = "https://github.com/stoatchat/stoatchat";
const TS_SITE = "https://teamspeak.com/en/";
const TS_BETA_POST =
  "https://community.teamspeak.com/t/teamspeak-6-0-0-beta1-screen-camera-sharing-communities-design-overhaul/54925";
const TS_ALTERNATIVETO =
  "https://alternativeto.net/news/2026/8/teamspeak-6-will-finally-introduce-direct-calls-4k-screen-sharing-and-picture-in-picture/";
const DISCORD_NITRO = "https://discord.com/nitro";
const DISCORD_TERMS = "https://discord.com/terms";
const DISCORD_WIKI = "https://en.wikipedia.org/wiki/Discord";

const C = FACTS_CHECKED;

export const FACTS: readonly Fact[] = [
  // ---------------------------------------------------------------- pqp
  {
    product: "pqp",
    feature: "price",
    status: "yes",
    value: {
      "pt-BR": "De graça. Sem plano pago, e doar não libera nada.",
      en: "Free. No paid plan, and donating unlocks nothing.",
      es: "Gratis. Sin plan de pago, y donar no desbloquea nada.",
    },
    sources: [`${REPO}#readme`],
    checked: C,
  },
  {
    product: "pqp",
    feature: "openSource",
    status: "yes",
    value: {
      "pt-BR": "Sim, AGPL-3.0.",
      en: "Yes, AGPL-3.0.",
      es: "Sí, AGPL-3.0.",
    },
    sources: [`${REPO}/blob/main/LICENSE`],
    checked: C,
  },
  {
    product: "pqp",
    feature: "selfHost",
    status: "partial",
    value: {
      "pt-BR":
        "Dá pra rodar a tua cópia, mas hoje precisa de Postgres e de uma conta Clerk própria. Ainda não existe caminho sem Clerk.",
      en: "You can run your own copy, but today it needs Postgres and your own Clerk account. There is no Clerk-free path yet.",
      es: "Puedes correr tu propia copia, pero hoy necesita Postgres y una cuenta de Clerk propia. Todavía no hay camino sin Clerk.",
    },
    sources: [`${REPO}#self-host`],
    checked: C,
  },
  {
    product: "pqp",
    feature: "screenShare",
    status: "yes",
    value: {
      "pt-BR":
        "No navegador e no app de desktop, até 1080p; a taxa de quadros se adapta à conexão. Duas telas ao mesmo tempo em sala pequena, quatro em sala grande.",
      en: "In the browser and the desktop app, up to 1080p; the frame rate adapts to the connection. Two screens at once in a small room, four in a large one.",
      es: "En el navegador y en la app de escritorio, hasta 1080p; la tasa de cuadros se adapta a la conexión. Dos pantallas a la vez en una sala chica, cuatro en una grande.",
    },
    sources: ["https://pqp.gg/blog/qualidade-de-video", "https://pqp.gg/tela"],
    checked: C,
  },
  {
    product: "pqp",
    feature: "screenAudio",
    status: "partial",
    value: {
      "pt-BR":
        "Leva o som da aba no Chrome e no Edge, e da tela inteira no Windows. Tela inteira no Mac, Firefox e Safari não levam som.",
      en: "Carries tab sound in Chrome and Edge, and whole-screen sound on Windows. A whole screen on a Mac, Firefox and Safari do not carry sound.",
      es: "Lleva el sonido de la pestaña en Chrome y Edge, y el de la pantalla completa en Windows. Pantalla completa en Mac, Firefox y Safari no llevan sonido.",
    },
    sources: ["https://pqp.gg/blog/som-na-tela"],
    checked: C,
  },
  {
    product: "pqp",
    feature: "watchParty",
    status: "partial",
    value: {
      "pt-BR":
        "Em acesso antecipado: compartilha uma aba com som e a galera assiste no navegador, no PC ou no celular. Já rodou com mais de cem pessoas. Liberado servidor por servidor.",
      en: "In early access: share a tab with sound and people watch in the browser, on a computer or a phone. It has run with more than a hundred people. Switched on one server at a time.",
      es: "En acceso anticipado: compartes una pestaña con sonido y la gente mira en el navegador, en la computadora o en el celular. Ya corrió con más de cien personas. Se activa servidor por servidor.",
    },
    sources: [`${REPO}/blob/main/docs/WATCH_PARTY.md`, "https://pqp.gg/watch-party"],
    checked: C,
  },
  {
    product: "pqp",
    feature: "layoutImport",
    status: "yes",
    value: {
      "pt-BR":
        "Cola um link de template discord.new e o pqp recria categorias, canais e permissões principais. Mensagens e membros não vêm junto.",
      en: "Paste a discord.new template link and pqp recreates categories, channels and the main permissions. Messages and members do not come along.",
      es: "Pega un link de plantilla de discord.new y pqp recrea categorías, canales y permisos principales. Los mensajes y los miembros no se vienen.",
    },
    sources: [`${REPO}/blob/main/docs/DISCORD_IMPORT.md`],
    checked: C,
  },
  {
    product: "pqp",
    feature: "apps",
    status: "partial",
    value: {
      "pt-BR":
        "Navegador, desktop (Windows, Mac e Linux) e Android na Google Play. O iPhone está em beta pelo TestFlight.",
      en: "Browser, desktop (Windows, Mac and Linux) and Android on Google Play. iPhone is a TestFlight beta.",
      es: "Navegador, escritorio (Windows, Mac y Linux) y Android en Google Play. iPhone está en beta por TestFlight.",
    },
    sources: ["https://pqp.gg/download"],
    checked: C,
  },
  {
    product: "pqp",
    feature: "ecosystem",
    status: "partial",
    value: {
      "pt-BR":
        "Só começando: webhook de entrada compatível com o do Discord, webhook de saída e comandos nativos. Ainda sem loja de bots.",
      en: "Just starting: Discord-compatible incoming webhooks, outgoing webhooks and built-in commands. No bot store yet.",
      es: "Apenas empezando: webhooks de entrada compatibles con los de Discord, webhooks de salida y comandos integrados. Todavía sin tienda de bots.",
    },
    sources: ["https://pqp.gg/vem"],
    checked: C,
  },
  {
    product: "pqp",
    feature: "maturity",
    status: "partial",
    value: {
      "pt-BR": "Beta aberto, feito por dois irmãos.",
      en: "Open beta, made by two brothers.",
      es: "Beta abierta, hecha por dos hermanos.",
    },
    sources: ["https://pqp.gg/contact"],
    checked: C,
  },

  // ------------------------------------------------------------ Discord
  {
    product: "discord",
    feature: "price",
    status: "partial",
    value: {
      "pt-BR": "Grátis pra usar; o streaming em HD faz parte do Nitro, que é pago.",
      en: "Free to use; HD streaming is part of Nitro, which is paid.",
      es: "Gratis para usar; el streaming en HD es parte de Nitro, que es de pago.",
    },
    sources: [DISCORD_NITRO],
    checked: C,
  },
  {
    product: "discord",
    feature: "openSource",
    status: "no",
    value: {
      "pt-BR":
        "Não. Os termos licenciam o software só pra acessar o serviço, e proíbem copiar e modificar.",
      en: "No. The terms license the software only to access the service, and forbid copying and modifying it.",
      es: "No. Los términos licencian el software solo para acceder al servicio, y prohíben copiarlo y modificarlo.",
    },
    sources: [DISCORD_TERMS, DISCORD_WIKI],
    checked: C,
  },
  {
    product: "discord",
    feature: "selfHost",
    status: "no",
    value: {
      "pt-BR":
        "Não encontramos uma versão pra hospedar por conta própria; os termos licenciam o software só pra usar o serviço do Discord.",
      en: "We found no self-hosted edition; the terms license the software only to use Discord's own service.",
      es: "No encontramos una versión para alojar por cuenta propia; los términos licencian el software solo para usar el servicio de Discord.",
    },
    sources: [DISCORD_TERMS],
    checked: C,
  },
  {
    product: "discord",
    feature: "screenShare",
    status: "yes",
    value: {
      "pt-BR":
        "Sim: tela inteira ou um aplicativo. O streaming em HD é do Nitro. Limites exatos do plano grátis: não verificado.",
      en: "Yes: a whole screen or one application. HD streaming is a Nitro feature. Exact limits on the free plan: not verified.",
      es: "Sí: pantalla completa o una aplicación. El streaming en HD es de Nitro. Límites exactos del plan gratis: no verificado.",
    },
    sources: [DISCORD_NITRO, DISCORD_WIKI],
    checked: C,
  },
  {
    product: "discord",
    feature: "screenAudio",
    status: "unknown",
    value: {
      "pt-BR":
        "Não verificado: a central de ajuda do Discord não abriu pra gente em 16 de outubro de 2026.",
      en: "Not verified: Discord's help center would not open for us on 16 October 2026.",
      es: "No verificado: el centro de ayuda de Discord no nos abrió el 16 de octubre de 2026.",
    },
    sources: ["https://support.discord.com/"],
    checked: C,
  },
  {
    product: "discord",
    feature: "watchParty",
    status: "partial",
    value: {
      "pt-BR": "Tem o Watch Together, uma Atividade pra assistir vídeos do YouTube juntos.",
      en: "Has Watch Together, an Activity for watching YouTube videos together.",
      es: "Tiene Watch Together, una Actividad para ver videos de YouTube juntos.",
    },
    sources: [
      "https://support-apps.discord.com/hc/en-us/articles/26502500234519-Watch-Together",
      "https://pocketnow.com/discord-introduces-watch-together-a-youtube-integration-for-watching-videos",
    ],
    checked: C,
  },
  {
    product: "discord",
    feature: "apps",
    status: "yes",
    value: {
      "pt-BR": "Windows, macOS, Linux, iOS, Android e consoles, além do navegador.",
      en: "Windows, macOS, Linux, iOS, Android and consoles, plus the browser.",
      es: "Windows, macOS, Linux, iOS, Android y consolas, además del navegador.",
    },
    sources: ["https://discord.com/download", DISCORD_WIKI],
    checked: C,
  },
  {
    product: "discord",
    feature: "ecosystem",
    status: "yes",
    value: {
      "pt-BR": "Tem um diretório público de apps e bots, o App Directory.",
      en: "Has a public directory of apps and bots, the App Directory.",
      es: "Tiene un directorio público de apps y bots, el App Directory.",
    },
    sources: ["https://discord.com/application-directory"],
    checked: C,
  },
  {
    product: "discord",
    feature: "maturity",
    status: "yes",
    value: {
      "pt-BR": "No ar desde maio de 2015.",
      en: "Public since May 2015.",
      es: "Disponible desde mayo de 2015.",
    },
    sources: [DISCORD_WIKI],
    checked: C,
  },

  // -------------------------------------------------------------- Stoat
  {
    product: "stoat",
    feature: "price",
    status: "unknown",
    value: {
      "pt-BR": "Descrito como software livre; não verificamos se o serviço hospedado cobra algo.",
      en: "Described as free software; we did not verify whether the hosted service charges anything.",
      es: "Descrito como software libre; no verificamos si el servicio alojado cobra algo.",
    },
    sources: [STOAT_WIKI],
    checked: C,
  },
  {
    product: "stoat",
    feature: "openSource",
    status: "yes",
    value: {
      "pt-BR": "Sim, AGPL-3.0 no backend (cada crate pode ter a sua licença).",
      en: "Yes, AGPL-3.0 on the backend (individual crates may carry their own licence).",
      es: "Sí, AGPL-3.0 en el backend (cada crate puede tener su propia licencia).",
    },
    sources: [STOAT_REPO, STOAT_WIKI],
    checked: C,
  },
  {
    product: "stoat",
    feature: "selfHost",
    status: "yes",
    value: {
      "pt-BR": "Sim, o projeto dá suporte a auto-hospedagem.",
      en: "Yes, the project supports self-hosting.",
      es: "Sí, el proyecto soporta el autoalojamiento.",
    },
    sources: [STOAT_WIKI],
    checked: C,
  },
  {
    product: "stoat",
    feature: "screenShare",
    status: "yes",
    value: {
      "pt-BR":
        "Sim, desde julho de 2026: tela inteira ou janela, 720p a 30 fps por enquanto, sem limite de telas ao mesmo tempo.",
      en: "Yes, since July 2026: a whole screen or a window, 720p at 30 fps for now, no limit on simultaneous shares.",
      es: "Sí, desde julio de 2026: pantalla completa o ventana, 720p a 30 fps por ahora, sin límite de pantallas a la vez.",
    },
    sources: [STOAT_NOTE],
    checked: C,
  },
  {
    product: "stoat",
    feature: "screenAudio",
    status: "partial",
    value: {
      "pt-BR": "Sim, ligando a opção Compartilhar áudio. No Wayland o som ainda é instável.",
      en: "Yes, with the Share Audio option on. Sound on Wayland is still unreliable.",
      es: "Sí, activando la opción Compartir audio. En Wayland el sonido todavía es inestable.",
    },
    sources: [STOAT_NOTE],
    checked: C,
  },
  {
    product: "stoat",
    feature: "watchParty",
    status: "unknown",
    value: {
      "pt-BR": "Não encontramos um watch party embutido; não verificado.",
      en: "We found no built-in watch party; not verified.",
      es: "No encontramos una watch party integrada; no verificado.",
    },
    sources: ["https://stoat.chat/updates"],
    checked: C,
  },
  {
    product: "stoat",
    feature: "layoutImport",
    status: "unknown",
    value: {
      "pt-BR":
        "Não encontramos um importador oficial; existe uma ferramenta de terceiros (DiscoReaper). Não verificado.",
      en: "We found no official importer; a third-party tool (DiscoReaper) exists. Not verified.",
      es: "No encontramos un importador oficial; existe una herramienta de terceros (DiscoReaper). No verificado.",
    },
    sources: ["https://deepwiki.com/rambros3d/disco-reaper"],
    checked: C,
  },
  {
    product: "stoat",
    feature: "apps",
    status: "partial",
    value: {
      "pt-BR":
        "Navegador, Windows, macOS, Linux e Android; iPhone pelo TestFlight, segundo a nota de 17 de julho de 2026.",
      en: "Browser, Windows, macOS, Linux and Android; iPhone through TestFlight, per its 17 July 2026 note.",
      es: "Navegador, Windows, macOS, Linux y Android; iPhone por TestFlight, según su nota del 17 de julio de 2026.",
    },
    sources: [STOAT_NOTE],
    checked: C,
  },
  {
    product: "stoat",
    feature: "ecosystem",
    status: "unknown",
    value: {
      "pt-BR": "Não verificado.",
      en: "Not verified.",
      es: "No verificado.",
    },
    sources: [STOAT_REPO],
    checked: C,
  },

  // ---------------------------------------------------------- TeamSpeak
  {
    product: "teamspeak",
    feature: "price",
    status: "unknown",
    value: {
      "pt-BR": "Não verificado: as páginas que lemos não mostram preço do cliente.",
      en: "Not verified: the pages we read show no price for the client.",
      es: "No verificado: las páginas que leímos no muestran precio del cliente.",
    },
    sources: [TS_SITE],
    checked: C,
  },
  {
    product: "teamspeak",
    feature: "openSource",
    status: "unknown",
    value: {
      "pt-BR": "Não verificado: a página de licenciamento não abriu pra gente.",
      en: "Not verified: the licensing page would not open for us.",
      es: "No verificado: la página de licencias no nos abrió.",
    },
    sources: [TS_SITE],
    checked: C,
  },
  {
    product: "teamspeak",
    feature: "selfHost",
    status: "partial",
    value: {
      "pt-BR": "Dá pra hospedar o servidor beta do TeamSpeak 6 com Docker, segundo o AlternativeTo.",
      en: "The TeamSpeak 6 beta server can be self-hosted with Docker, per AlternativeTo.",
      es: "El servidor beta de TeamSpeak 6 se puede autoalojar con Docker, según AlternativeTo.",
    },
    sources: [TS_ALTERNATIVETO],
    checked: C,
  },
  {
    product: "teamspeak",
    feature: "screenShare",
    status: "partial",
    value: {
      "pt-BR":
        "Em beta: o site fala em até 4K e 60 fps, com resolução, bitrate e fps ajustáveis. As chamadas diretas 1 a 1 ainda não saíram.",
      en: "In beta: the site says up to 4K at 60 fps, with adjustable resolution, bitrate and frame rate. Direct 1-to-1 calls are not out yet.",
      es: "En beta: el sitio habla de hasta 4K a 60 fps, con resolución, bitrate y fps ajustables. Las llamadas directas 1 a 1 todavía no salen.",
    },
    sources: [TS_SITE, TS_BETA_POST, TS_ALTERNATIVETO],
    checked: C,
  },
  {
    product: "teamspeak",
    feature: "screenAudio",
    status: "partial",
    value: {
      "pt-BR": "Há ajuste de áudio no compartilhamento; os detalhes não foram verificados.",
      en: "There is an audio setting for sharing; details not verified.",
      es: "Hay un ajuste de audio al compartir; los detalles no se verificaron.",
    },
    sources: [TS_ALTERNATIVETO],
    checked: C,
  },
  {
    product: "teamspeak",
    feature: "watchParty",
    status: "unknown",
    value: {
      "pt-BR": "Não encontramos um watch party embutido; não verificado.",
      en: "We found no built-in watch party; not verified.",
      es: "No encontramos una watch party integrada; no verificado.",
    },
    sources: [TS_SITE],
    checked: C,
  },
  {
    product: "teamspeak",
    feature: "layoutImport",
    status: "unknown",
    value: {
      "pt-BR": "Não verificado.",
      en: "Not verified.",
      es: "No verificado.",
    },
    sources: [TS_SITE],
    checked: C,
  },
  {
    product: "teamspeak",
    feature: "apps",
    status: "partial",
    value: {
      "pt-BR":
        "Apps de Android e iOS (no celular, canais de voz, chat e comandos, segundo o site). Desktop: não verificado.",
      en: "Android and iOS apps (on a phone: voice channels, chat and commands, per the site). Desktop: not verified.",
      es: "Apps de Android e iOS (en el celular: canales de voz, chat y comandos, según el sitio). Escritorio: no verificado.",
    },
    sources: [TS_SITE],
    checked: C,
  },
  {
    product: "teamspeak",
    feature: "ecosystem",
    status: "unknown",
    value: {
      "pt-BR": "Não verificado.",
      en: "Not verified.",
      es: "No verificado.",
    },
    sources: [TS_SITE],
    checked: C,
  },
];

/** The one fact for a product and a feature, or `undefined` when there is none. */
export function factFor(
  product: CompareProduct,
  feature: CompareFeature,
): Fact | undefined {
  return FACTS.find((f) => f.product === product && f.feature === feature);
}

/**
 * Sources for the products `/tela` lists that are not in the matrix, with the
 * day they were read. `jitsi`: jitsi.org (no account, open source, screen
 * share). The others read their rows above.
 */
export const TELA_SOURCES: Record<"pqp" | "jitsi" | "stoat" | "teamspeak", readonly string[]> = {
  pqp: ["https://pqp.gg/blog/som-na-tela", `${REPO}/blob/main/LICENSE`],
  jitsi: ["https://jitsi.org/jitsi-meet/"],
  stoat: [STOAT_NOTE],
  teamspeak: [TS_SITE, TS_ALTERNATIVETO],
};

/** `2026-10-16` as a date a reader recognises, in the page's language. */
export function formatCheckedDate(iso: string, locale: FactLocale): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** The host a source link is labelled with: `support.discord.com`, not a URL. */
export function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
