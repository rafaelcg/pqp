/**
 * "Eu fui pra pqp" — the share that turns a claimed handle into a link
 * somebody else clicks.
 *
 * WHY THIS IS THE MOST IMPORTANT BUTTON ON THE PRODUCT RIGHT NOW. As of 22 Aug
 * 2026 the acquisition report can see four signups from Reddit and none from
 * anywhere else, and a search of X for "pqp.gg" from anyone other than us
 * returns nothing at all. Every person here arrived because somebody working
 * for the project put a link in front of them by hand. This is the only loop
 * that does not need us in it.
 *
 * WHY THE LINK CARRIES `?ref=perfil`. A shared profile is a channel, and a
 * channel we cannot count is a channel we cannot repeat. It is the site's own
 * short parameter rather than a UTM triple for the same reason the Reddit links
 * are: a person reads this URL before they click it, and
 * `utm_source=x&utm_medium=social` in a message from a friend reads as
 * marketing, which is the one thing this share must not.
 *
 * Everything here is pure or takes its capabilities as arguments, so the
 * decision tree below is testable without a browser.
 */

const ORIGIN = "https://pqp.gg";

/** Where a shared handle points, tagged so the report can see it arrive. */
export function shareUrlFor(handle: string): string {
  return `${ORIGIN}/@${handle}?ref=perfil`;
}

/**
 * What gets shared.
 *
 * The joke is the product's own name and it only works in Portuguese: "vem pra
 * pqp" is the invitation on the landing page, and "fui pra pqp" is what you say
 * after you have gone. English gets the plain version rather than a translated
 * pun, which would be neither funny nor clear.
 */
export function shareTextFor(handle: string, locale: string): string {
  return locale === "pt-BR"
    ? `eu fui pra pqp. me acha em ${shareUrlFor(handle)}`
    : `I'm on pqp. Find me at ${shareUrlFor(handle)}`;
}

export type ShareOutcome = "shared" | "copied" | "dismissed" | "failed";

export interface ShareCapabilities {
  /** `navigator.share`, present on phones and almost nowhere else. */
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  /** `navigator.clipboard.writeText`. */
  copy?: (text: string) => Promise<void>;
}

/**
 * Share a handle the best way this device can, and say which way it went.
 *
 * THE ORDER IS DELIBERATE. The native sheet first, because on a phone it is one
 * tap to WhatsApp, which is where Brazilian group chat actually lives. The
 * clipboard second, because on a desktop a copied line the person pastes
 * themselves beats a popup they have to dismiss. There is no third branch that
 * opens a compose window on somebody's behalf: choosing where a person posts is
 * their business, and a hijacked tab is how a share button becomes the thing
 * people warn each other about.
 *
 * A CANCELLED SHARE IS NOT AN ERROR. `navigator.share` rejects with
 * `AbortError` when somebody backs out of the sheet, which is a decision, not a
 * failure, and telling them "sharing failed" for it would be a lie.
 */
export async function shareHandle(
  handle: string,
  locale: string,
  capabilities: ShareCapabilities,
): Promise<ShareOutcome> {
  const text = shareTextFor(handle, locale);
  const url = shareUrlFor(handle);

  if (capabilities.share) {
    try {
      await capabilities.share({ text, url });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return "dismissed";
      }
      // Anything else and the sheet is not usable here; fall through to the
      // clipboard rather than leaving the person with nothing.
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

/** The real capabilities, read once at the call site so tests can pass fakes. */
export function browserShareCapabilities(): ShareCapabilities {
  if (typeof navigator === "undefined") {
    return {};
  }
  return {
    share: navigator.share ? (data) => navigator.share(data) : undefined,
    copy: navigator.clipboard?.writeText
      ? (text) => navigator.clipboard.writeText(text)
      : undefined,
  };
}
