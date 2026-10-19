/** Eco's own words. The platform-facing ones (name, presence line) live in the manifest. */
export interface Strings {
  counter: string;
  plus: string;
  pingSection: string;
  ping: string;
  /** `{name}` is the sender's display name. */
  pingFrom: string;
  people: string;
  you: string;
  host: string;
  spectator: string;
  reconnecting: string;
  online: string;
  connecting: string;
  ended: string;
  outside: string;
  connectFailed: string;
  failed: string;
  slowDown: string;
}

export const STRINGS = {
  "pt-BR": {
    counter: "Contador compartilhado",
    plus: "+1",
    pingSection: "Ping",
    ping: "Mandar ping",
    pingFrom: "{name} mandou um ping",
    people: "Quem tá aqui",
    you: "tu",
    host: "host",
    spectator: "assistindo",
    reconnecting: "Reconectando...",
    online: "Conectado",
    connecting: "Conectando...",
    ended: "A sessão acabou.",
    outside: "Abre o Eco dentro do pqp.",
    connectFailed: "Não consegui conectar. Fecha e abre o Eco de novo.",
    failed: "Não deu certo. Tenta de novo.",
    slowDown: "Calma, tá mandando rápido demais.",
  },
  en: {
    counter: "Shared counter",
    plus: "+1",
    pingSection: "Ping",
    ping: "Send ping",
    pingFrom: "{name} sent a ping",
    people: "Who is here",
    you: "you",
    host: "host",
    spectator: "watching",
    reconnecting: "Reconnecting...",
    online: "Connected",
    connecting: "Connecting...",
    ended: "The session ended.",
    outside: "Open Eco inside pqp.",
    connectFailed: "Could not connect. Close and reopen Eco.",
    failed: "That did not work. Try again.",
    slowDown: "Slow down, that was too fast.",
  },
  es: {
    counter: "Contador compartido",
    plus: "+1",
    pingSection: "Ping",
    ping: "Mandar ping",
    pingFrom: "{name} mandó un ping",
    people: "Quién está aquí",
    you: "tú",
    host: "host",
    spectator: "mirando",
    reconnecting: "Reconectando...",
    online: "Conectado",
    connecting: "Conectando...",
    ended: "La sesión terminó.",
    outside: "Abre Eco dentro de pqp.",
    connectFailed: "No pude conectar. Cierra y abre Eco otra vez.",
    failed: "No funcionó. Prueba otra vez.",
    slowDown: "Más despacio, vas muy rápido.",
  },
} as const satisfies Record<string, Strings>;

export type EcoLocale = keyof typeof STRINGS;

/** Exact match first, then the base language, then English. */
export function pickLocale(locale: string): EcoLocale {
  if (Object.hasOwn(STRINGS, locale)) return locale as EcoLocale;
  const base = locale.split("-")[0]?.toLowerCase();
  if (base === "pt") return "pt-BR";
  if (base === "es") return "es";
  return "en";
}

/** A plain splice: the name is untrusted text, so no `$` patterns and no re-expansion. */
export function formatPing(template: string, name: string): string {
  return template.split("{name}").join(name);
}
