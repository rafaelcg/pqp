/**
 * "Traz tua galera": the announcement an owner pastes into their old Discord
 * after copying its layout here. Flag `discord_bring_crew`; see
 * `docs/DISCORD_IMPORT.md` §"Bring your people".
 *
 * WHY THIS IS NOT IN translation.json. The language of the announcement is
 * the old server's, not the app's: a Brazilian owner whose app is in English
 * still writes to their server in Portuguese. So the text is picked by a chip
 * on the step, and every language has to be reachable whatever the UI says.
 * Same reason, and same shape, as `shareInviteText` in `share-invite.ts`.
 *
 * Written for Discord: `**bold**` renders there, one emoji, four short lines,
 * the link on its own line so Discord unfurls it. It names what is free on
 * pqp that a Discord server pays Nitro for, because that is the reason anybody
 * clicks. No @everyone: the owner decides whether to ping.
 */

import { shareInviteUrl } from "./share-invite";

export const ANNOUNCEMENT_LANGS = ["pt-BR", "en", "es"] as const;
export type AnnouncementLang = (typeof ANNOUNCEMENT_LANGS)[number];

/** The chip labels, each in its own language. */
export const ANNOUNCEMENT_LANG_LABELS: Record<AnnouncementLang, string> = {
  "pt-BR": "Português",
  en: "English",
  es: "Español",
};

/** The app's language picks the first chip; anything else reads English. */
export function defaultAnnouncementLang(locale: string): AnnouncementLang {
  if (locale === "pt-BR" || locale.startsWith("pt")) {
    return "pt-BR";
  }
  if (locale.startsWith("es")) {
    return "es";
  }
  return "en";
}

/** The import's link: its permanent invite, tagged `?ref=discord`. */
export function announcementUrl(origin: string, code: string): string {
  return shareInviteUrl(origin, code, "discord");
}

/**
 * The server name as it goes into the paste. It came from a Discord template,
 * so it is somebody else's text: no markdown that would break the bold line,
 * no `@everyone` / `@here` or role mention the owner did not choose, and no
 * link or masked link riding along with ours.
 */
export function announcementServerName(server: string): string {
  return (
    server
      .replace(/https?:\/\/\S*/gi, "")
      .replace(/[*_~`|<>@#[\]()]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "pqp"
  );
}

export function discordAnnouncement(
  lang: AnnouncementLang,
  server: string,
  url: string,
): string {
  const name = announcementServerName(server);
  switch (lang) {
    case "pt-BR":
      return [
        `**${name} agora também tá no pqp** 🎉`,
        "Copiei nossos canais pra lá, tá tudo no mesmo lugar. Lá dá pra compartilhar a tela em 1080p60 e fazer watch party de graça, sem Nitro.",
        `Chega mais: ${url}`,
        "Abre no navegador, até no celular.",
      ].join("\n");
    case "es":
      return [
        `**${name} ahora también está en pqp** 🎉`,
        "Copié nuestros canales, todo está en su lugar. Ahí compartir pantalla en 1080p60 y hacer watch party es gratis, sin Nitro.",
        `Vente: ${url}`,
        "Abre en el navegador, hasta en el celular.",
      ].join("\n");
    case "en":
      return [
        `**${name} is on pqp now too** 🎉`,
        "I copied our channels over, everything is where you left it. Screen share in 1080p60 and watch parties are free there, no Nitro.",
        `Come hang out: ${url}`,
        "Opens in the browser, even on your phone.",
      ].join("\n");
  }
}
