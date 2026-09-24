/**
 * "Vem pra pqp": the paste that turns an invite into a link somebody
 * drops in Discord or WhatsApp.
 *
 * The growth loop is a person pasting into a group chat, not a marketing
 * page. The short line is for Discord, whose preview card eats long text.
 * The long line is for WhatsApp, where a sentence actually gets read.
 *
 * WHY THE LINK CARRIES `?ref=convite`. A shared invite is a channel, and a
 * channel we cannot count is a channel we cannot repeat. Same reason
 * `share-handle.ts` tags `?ref=perfil`: a friend reads this URL before they
 * click it, and a UTM triple in a message from a friend reads as marketing.
 *
 * Everything here is pure or takes its capabilities as arguments, so the
 * decision tree is testable without a browser.
 */

import {
  type ShareCapabilities,
  type ShareOutcome,
} from "./share-handle";

export type InvitePasteKind = "short" | "long";

/**
 * The `?ref=` a link carries, by where pqp handed it out. `discord` is the
 * invite a Discord import shows on its last screen, the paste a group leader
 * drops back into their old Discord; `onboarding` is the one the first-run
 * wizard hands an organizer on its last step, so "copied in the wizard, then
 * somebody joined through it" is a count of its own; `convite` is every other
 * shared invite.
 * The server stores the tag on the membership it creates (`join_ref`), which
 * is how "joined through an imported server's invite" gets counted.
 */
export type InviteRef = "convite" | "discord" | "onboarding";

/** Where a shared invite points, tagged so an arrival can be counted. */
export function shareInviteUrl(
  origin: string,
  code: string,
  ref: InviteRef = "convite",
): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/app/invite/${encodeURIComponent(code)}?ref=${ref}`;
}

/**
 * What gets pasted.
 *
 * The joke is the product's own name and it only works in Portuguese.
 * English gets the plain sentence rather than a translated pun, same rule
 * as `shareTextFor`.
 */
export function shareInviteText(
  kind: InvitePasteKind,
  locale: string,
  url: string,
): string {
  if (locale === "pt-BR") {
    return kind === "short"
      ? `Vem pra pqp: ${url} #vemprapqp`
      : `A gente mudou pra pqp. Abre no navegador, entra na call e já era: ${url} #vemprapqp`;
  }
  // Spanish gets its own campaign line and hashtag (`/ven`, #venapqp): the
  // Portuguese pun does not survive the trip, the invitation does.
  if (locale === "es") {
    return kind === "short"
      ? `Ven a pqp: ${url} #venapqp`
      : `Nos mudamos a pqp. Abre en el navegador, entras a la llamada y listo: ${url} #venapqp`;
  }
  return kind === "short"
    ? `Come hang out on pqp: ${url} #vemprapqp`
    : `We moved to pqp. Opens in the browser, join the call and that's it: ${url} #vemprapqp`;
}

/**
 * Share an invite paste the best way this device can.
 *
 * Native sheet first (phones, one tap to WhatsApp). Clipboard second.
 * A cancelled sheet is a decision, not a failure.
 */
export async function shareInvite(
  kind: InvitePasteKind,
  locale: string,
  url: string,
  capabilities: ShareCapabilities,
): Promise<ShareOutcome> {
  const text = shareInviteText(kind, locale, url);

  if (capabilities.share) {
    try {
      await capabilities.share({ text, url });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return "dismissed";
      }
    }
  }

  if (capabilities.copy) {
    try {
      await capabilities.copy(text);
      return "copied";
    } catch {
      return "failed";
    }
  }

  return "failed";
}
