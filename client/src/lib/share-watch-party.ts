/**
 * "Copiar link": the announcement of a watch party, in the hands of the host.
 *
 * WHERE THE ANNOUNCEMENT ACTUALLY GOES. For a Brazilian crew the invite is a
 * WhatsApp message, and the only address a party had until now was the URL
 * bar, which a phone does not even show inside the installed app. This is the
 * same decision tree as `share-handle.ts`: the native sheet first (one tap to
 * WhatsApp on a phone), the clipboard second (a desktop pastes), and never a
 * compose window opened on somebody's behalf.
 *
 * THE LINK IS THIS ORIGIN, NOT THE CANONICAL ONE. A shared profile is a public
 * page and belongs on pqp.gg whatever host built the bundle. A party lives in
 * a channel on THIS instance, so a self-host and staging must hand out their
 * own address, and the only thing that knows it is the page itself.
 *
 * Everything here is pure or takes its capabilities as arguments.
 */

import { channelRoutePath } from "@/lib/app-route";
import type { ShareCapabilities, ShareOutcome } from "@/lib/share-handle";

/** Where the link points: the party's channel, on the origin the page has. */
export function watchPartyShareUrl(
  origin: string,
  serverId: string,
  channelId: string,
): string {
  return `${origin.replace(/\/+$/, "")}${channelRoutePath(serverId, channelId)}`;
}

/**
 * What gets shared. The name the host typed, then the address. Short enough
 * to read in a group chat preview, with nothing in it that reads as
 * marketing.
 */
export function watchPartyShareText(
  name: string,
  url: string,
  locale: string,
): string {
  return locale === "pt-BR"
    ? `watch party: ${name}. entra em ${url}`
    : `watch party: ${name}. join at ${url}`;
}

export async function shareWatchParty(
  input: { name: string; url: string; locale: string },
  capabilities: ShareCapabilities,
): Promise<ShareOutcome> {
  const text = watchPartyShareText(input.name, input.url, input.locale);

  if (capabilities.share) {
    try {
      await capabilities.share({ text, url: input.url });
      return "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return "dismissed";
      }
    }
  }

  if (capabilities.copy) {
    try {
      // The bare URL, not the sentence: on a desktop the person is pasting
      // into a message they are already writing, and a link unfurls while a
      // sentence with a link in it does not always.
      await capabilities.copy(input.url);
      return "copied";
    } catch {
      return "failed";
    }
  }

  return "failed";
}
