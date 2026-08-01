import { isGifMediaUrl, stillGifUrl } from "@pqp/shared";

export interface GifMedia {
  url: string;
  /** Still frame for reduced-motion readers, or null when none is derivable. */
  stillUrl: string | null;
  /** Accessible name — never empty, and never just the URL. */
  alt: string;
}

/** Filenames every GIF on a host shares, which name nothing to a reader. */
const GENERIC_SLUGS = new Set(["giphy", "tenor", "media", "raw", "source"]);

/** Long enough to be a phrase, short enough not to be read as an id. */
const MAX_ALT_WORDS = 6;

/**
 * Best-effort name for a GIF from its URL.
 *
 * The picker's title is not available here: only the body is stored, and the
 * body is the bare URL. Tenor puts a human slug in the filename, so it is worth
 * reading; GIPHY names every file `giphy.gif`, so it is not. Anything that does
 * not clearly read as words falls back to "GIF" rather than announcing a hash
 * to a screen reader.
 */
function altFromUrl(url: string): string {
  let slug: string;
  try {
    slug = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return "GIF";
  }

  const stem = slug.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  if (GENERIC_SLUGS.has(stem)) {
    return "GIF";
  }

  const words = stem
    .split(/[-_]+/)
    .filter((word) => /^[a-z]{2,}$/.test(word))
    // The provider already appends "gif" to most slugs; repeating it would
    // announce "… gif GIF".
    .filter((word) => word !== "gif")
    .slice(0, MAX_ALT_WORDS);

  if (words.length === 0 || !words.some((word) => word.length >= 3)) {
    return "GIF";
  }
  return `${words.join(" ")} GIF`;
}

/**
 * Read a message body as inline media, or null when it is ordinary text.
 *
 * A body qualifies only when it is *nothing but* an allowlisted URL: the URL is
 * then the whole message, so replacing it with the image loses nothing. Any
 * surrounding words mean the author wrote a sentence containing a link, and a
 * link is what they should get.
 */
export function gifMessageMedia(body: string): GifMedia | null {
  const trimmed = body.trim();
  if (!trimmed || /\s/.test(trimmed) || !isGifMediaUrl(trimmed)) {
    return null;
  }
  return {
    url: trimmed,
    stillUrl: stillGifUrl(trimmed),
    alt: altFromUrl(trimmed),
  };
}
