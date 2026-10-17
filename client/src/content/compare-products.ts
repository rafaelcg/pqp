/**
 * The short write-up behind each `/compare/<product>` page, one entry per
 * product that is not pqp. Same rules as `compare-facts.ts`, which these
 * sentences lean on: features only, never a company's conduct or troubles; a
 * limit is as welcome as a strength; nothing is stated here that its `sources`
 * do not say; and where pqp is behind, it says so first.
 *
 * Discord is not in `COMPARE_PAGES`: its detail page already exists at
 * `/vs-discord` and the hub links there, so there is one page per product and
 * no duplicate to compete with it.
 *
 * Dependency-free like `compare-facts.ts` (the Pages middleware imports it).
 */
import type { CompareProduct, Loc } from "./compare-facts";

export type DetailProduct = Exclude<CompareProduct, "pqp" | "discord">;

/** Products with a `/compare/<slug>` page, in hub order. */
export const COMPARE_PAGES: readonly DetailProduct[] = ["stoat", "teamspeak", "slack"];

/** The columns of the hub's matrix, in order. */
export const MATRIX_PRODUCTS: readonly CompareProduct[] = [
  "pqp",
  "discord",
  "stoat",
  "teamspeak",
  "slack",
];

/** In page order; the edge serves the same pairs as FAQPage JSON-LD (`COMPARE_FAQ`). */
export const COMPARE_FAQ_IDS = ["best", "sound", "import", "self"] as const;

/** The path a product's detail page lives at. */
export function comparePath(product: CompareProduct): string {
  if (product === "pqp") return "/compare";
  return product === "discord" ? "/vs-discord" : `/compare/${product}`;
}

export const PRODUCT_NAMES: Record<CompareProduct, string> = {
  pqp: "pqp",
  discord: "Discord",
  stoat: "Stoat",
  teamspeak: "TeamSpeak 6",
  slack: "Slack huddles",
};

/** One line for Discord's card on the hub (its detail page is `/vs-discord`). Source: discord.com/download. */
export const DISCORD_WHAT: Loc = {
  "pt-BR":
    "Chat de voz e texto com apps em Windows, macOS, Linux, iOS, Android, consoles e navegador.",
  en: "Voice and text chat with apps on Windows, macOS, Linux, iOS, Android, consoles and the browser.",
  es: "Chat de voz y texto con apps en Windows, macOS, Linux, iOS, Android, consolas y navegador.",
};

export interface ProductWriteUp {
  /** What it is, in one sentence. */
  what: Loc;
  /** Where it is ahead of pqp, or simply stronger on a documented point. */
  ahead: Loc;
  /** Where pqp does it differently. */
  different: Loc;
  /** "Pick it if...". */
  pickThem: Loc;
  /** "Pick pqp if...". */
  pickPqp: Loc;
  /** The pages the sentences above came from. */
  sources: readonly string[];
}

/**
 * Where the sentences about pqp itself come from (the 1080p share, the watch
 * party in early access, the more-than-a-hundred room, the layout import):
 * our own docs and pages. Every write-up lists them beside the other
 * product's pages, so no claim stands without a source a reader can open.
 */
const PQP_SOURCES: readonly string[] = [
  "https://github.com/rafaelcg/pqp/blob/main/docs/WATCH_PARTY.md",
  "https://github.com/rafaelcg/pqp/blob/main/docs/DISCORD_IMPORT.md",
  "https://pqp.gg/blog/qualidade-de-video",
  "https://pqp.gg/",
];

export const WRITE_UPS: Record<DetailProduct, ProductWriteUp> = {
  stoat: {
    what: {
      "pt-BR":
        "Chat de código aberto (antes chamado Revolt), com voz, vídeo e compartilhamento de tela desde julho de 2026.",
      en: "Open source chat (formerly called Revolt), with voice, video and screen share since July 2026.",
      es: "Chat de código abierto (antes llamado Revolt), con voz, video y pantalla compartida desde julio de 2026.",
    },
    ahead: {
      "pt-BR":
        "A auto-hospedagem é um ponto central do projeto, e o compartilhamento de tela não tem limite de telas ao mesmo tempo.",
      en: "Self-hosting is a central point of the project, and screen share has no limit on simultaneous shares.",
      es: "El autoalojamiento es un punto central del proyecto, y la pantalla compartida no tiene límite de pantallas a la vez.",
    },
    different: {
      "pt-BR":
        "O pqp compartilha a tela em até 1080p (o Stoat está em 720p a 30 fps por enquanto), tem watch party em acesso antecipado e importa o layout de um servidor do Discord pelo link de template. Para o Stoat só achamos uma ferramenta de terceiros.",
      en: "pqp shares a screen at up to 1080p (Stoat is at 720p and 30 fps for now), has a watch party in early access and imports a Discord server's layout from a template link. For Stoat we only found a third-party tool.",
      es: "pqp comparte pantalla hasta en 1080p (Stoat está en 720p y 30 fps por ahora), tiene watch party en acceso anticipado e importa el layout de un servidor de Discord desde un link de plantilla. Para Stoat solo encontramos una herramienta de terceros.",
    },
    pickThem: {
      "pt-BR": "Se tu quer um projeto aberto cujo foco declarado é a auto-hospedagem.",
      en: "If you want an open project whose stated focus is self-hosting.",
      es: "Si quieres un proyecto abierto cuyo foco declarado es el autoalojamiento.",
    },
    pickPqp: {
      "pt-BR": "Se tu quer tela em qualidade maior, watch party e trazer o layout do Discord.",
      en: "If you want higher screen quality, a watch party and to bring your Discord layout.",
      es: "Si quieres pantalla en mayor calidad, watch party y traer el layout de Discord.",
    },
    sources: [
      "https://stoat.chat/release-notes/93eb1f4ec77444ca9fb13617e0e6c0b1",
      "https://en.wikipedia.org/wiki/Stoat_(software)",
      ...PQP_SOURCES,
    ],
  },
  teamspeak: {
    what: {
      "pt-BR":
        "Servidores de voz para grupos. O TeamSpeak 6 está em beta e inclui compartilhamento de tela.",
      en: "Voice servers for groups. TeamSpeak 6 is in beta and includes screen share.",
      es: "Servidores de voz para grupos. TeamSpeak 6 está en beta e incluye pantalla compartida.",
    },
    ahead: {
      "pt-BR":
        "O site fala em compartilhamento de tela até 4K a 60 fps, com resolução, bitrate e fps ajustáveis, e dá pra hospedar o servidor beta com Docker.",
      en: "The site talks about screen share up to 4K at 60 fps, with adjustable resolution, bitrate and frame rate, and the beta server can be self-hosted with Docker.",
      es: "El sitio habla de pantalla compartida hasta 4K a 60 fps, con resolución, bitrate y fps ajustables, y el servidor beta se puede autoalojar con Docker.",
    },
    different: {
      "pt-BR":
        "O pqp abre no navegador sem instalar nada, tem watch party em acesso antecipado e importa o layout de um servidor do Discord. As chamadas diretas 1 a 1 do TeamSpeak 6 ainda não saíram, segundo o AlternativeTo.",
      en: "pqp opens in the browser with nothing to install, has a watch party in early access and imports a Discord server's layout. TeamSpeak 6's direct 1-to-1 calls are not out yet, per AlternativeTo.",
      es: "pqp abre en el navegador sin instalar nada, tiene watch party en acceso anticipado e importa el layout de un servidor de Discord. Las llamadas directas 1 a 1 de TeamSpeak 6 todavía no salen, según AlternativeTo.",
    },
    pickThem: {
      "pt-BR": "Se o teu grupo já usa TeamSpeak e quer tela nele.",
      en: "If your group already uses TeamSpeak and wants a screen in it.",
      es: "Si tu grupo ya usa TeamSpeak y quiere pantalla en él.",
    },
    pickPqp: {
      "pt-BR": "Se tu quer entrar pelo navegador, com chat de comunidade e watch party.",
      en: "If you want to join from the browser, with community chat and a watch party.",
      es: "Si quieres entrar desde el navegador, con chat de comunidad y watch party.",
    },
    sources: [
      "https://teamspeak.com/en/",
      "https://alternativeto.net/news/2026/8/teamspeak-6-will-finally-introduce-direct-calls-4k-screen-sharing-and-picture-in-picture/",
      ...PQP_SOURCES,
    ],
  },
  slack: {
    what: {
      "pt-BR": "Os huddles são as chamadas de voz do Slack, com compartilhamento de tela.",
      en: "Huddles are Slack's voice calls, with screen sharing.",
      es: "Los huddles son las llamadas de voz de Slack, con pantalla compartida.",
    },
    ahead: {
      "pt-BR":
        "Nos planos pagos um huddle chega a 50 pessoas, e no app de desktop para Mac e Windows dá pra desenhar na tela compartilhada.",
      en: "On paid plans a huddle holds up to 50 people, and in the Mac and Windows desktop app you can draw on a shared screen.",
      es: "En los planes de pago un huddle llega a 50 personas, y en la app de escritorio para Mac y Windows puedes dibujar sobre la pantalla compartida.",
    },
    different: {
      "pt-BR":
        "No plano grátis do Slack um huddle tem no máximo duas pessoas. O pqp não tem plano pago nem esse limite: já rodou uma sala com mais de cem pessoas, e ele é feito pra comunidade que fica, com servidores e canais.",
      en: "On Slack's free plan a huddle holds at most two people. pqp has no paid plan and no such limit: a room with more than a hundred people has already run, and it is built for a community that stays, with servers and channels.",
      es: "En el plan gratis de Slack un huddle admite como máximo dos personas. pqp no tiene plan de pago ni ese límite: ya corrió una sala con más de cien personas, y está hecho para una comunidad que se queda, con servidores y canales.",
    },
    pickThem: {
      "pt-BR": "Se o teu grupo já trabalha no Slack e só precisa de uma chamada rápida com tela.",
      en: "If your group already works in Slack and only needs a quick call with a screen.",
      es: "Si tu grupo ya trabaja en Slack y solo necesita una llamada rápida con pantalla.",
    },
    pickPqp: {
      "pt-BR": "Se tu quer uma comunidade de voz e tela, de graça, com mais de duas pessoas.",
      en: "If you want a voice and screen community, free, with more than two people.",
      es: "Si quieres una comunidad de voz y pantalla, gratis, con más de dos personas.",
    },
    sources: ["https://slack.com/help/articles/216771908", ...PQP_SOURCES],
  },
};
