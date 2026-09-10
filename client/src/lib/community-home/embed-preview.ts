import { parseCommunityHomeEmbed, type CommunityHomeMedia } from "@pqp/shared";

/**
 * How long the composer waits after the last keystroke before swapping the
 * 16:9 skeleton for the real player. Short enough to feel like Discord
 * unfurl; long enough that a paste is one paint, not one per character.
 */
export const COMPOSE_EMBED_DEBOUNCE_MS = 300;

const EMBED_NAME: Record<
  NonNullable<ReturnType<typeof parseCommunityHomeEmbed>>,
  string
> = {
  youtube: "YouTube",
  twitch: "Twitch",
  tiktok: "TikTok",
  instagram: "Instagram",
};

/**
 * A body that is nothing but one supported embed URL. Anything with a
 * space, a second line, or an unsupported host stays ordinary text.
 */
export function loneSupportedEmbedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }
  return parseCommunityHomeEmbed(trimmed) ? trimmed : null;
}

/**
 * Link field wins. If it is empty, a body that is only a supported URL
 * is the embed — paste-in-the-post-and-it-unfurls, Discord-style.
 */
export function resolveComposeEmbedUrl(
  linkField: string,
  body: string,
): string {
  const field = linkField.trim();
  if (field) {
    return field;
  }
  return loneSupportedEmbedUrl(body) ?? "";
}

/**
 * Embed URL to send on create/update. A selected file (upload or existing)
 * wins: the preview already treats that file as authoritative, so submit
 * must not fall back to a body that happens to be a watch URL.
 */
export function composeSubmitEmbedUrl(input: {
  linkField: string;
  body: string;
  hasFileMedia: boolean;
}): string | null {
  if (input.hasFileMedia) {
    return null;
  }
  const field = input.linkField.trim();
  if (field) {
    return field;
  }
  return loneSupportedEmbedUrl(input.body);
}

/** Media the feed player already knows how to render, from a classified URL. */
export function communityHomeEmbedMedia(
  raw: string,
): CommunityHomeMedia | null {
  const kind = parseCommunityHomeEmbed(raw);
  if (!kind) {
    return null;
  }
  const trimmed = raw.trim();
  return {
    kind,
    name: EMBED_NAME[kind],
    contentType: null,
    byteSize: null,
    url: null,
    youtubeUrl: kind === "twitch" ? null : trimmed,
    twitchUrl: kind === "twitch" ? trimmed : null,
  };
}
