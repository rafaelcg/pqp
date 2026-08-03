import { z } from "zod";

/**
 * GIFs are not an attachment subsystem. A message whose entire body is a URL on
 * one of the hosts below renders as inline media, which is how Discord and
 * Slack behave for a pasted GIF link — so the picker and a hand-pasted link
 * take exactly the same path and nothing has to be stored beside the message.
 *
 * The allowlist lives in shared because both sides depend on it: the API drops
 * any normalised result that falls outside it, and the client decides from the
 * same predicate whether a body is media or a link. If they ever disagreed the
 * picker would post messages that render as bare URLs.
 */
const GIF_MEDIA_HOSTS: RegExp[] = [
  /^media\d*\.giphy\.com$/,
  /^i\.giphy\.com$/,
  /^media\d*\.tenor\.com$/,
  /^c\.tenor\.com$/,
];

const GIF_MEDIA_EXTENSIONS = [".gif", ".webp", ".png", ".jpg", ".jpeg"];

function parseMediaUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  // http would be a mixed-content block in the browser, and embedded
  // credentials are the classic way to make a hostile host read as a trusted
  // one to a human skimming the text.
  if (url.protocol !== "https:" || url.username || url.password) {
    return null;
  }
  if (!GIF_MEDIA_HOSTS.some((host) => host.test(url.hostname))) {
    return null;
  }

  const path = url.pathname.toLowerCase();
  if (!GIF_MEDIA_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    return null;
  }
  return url;
}

/** True when a URL may be rendered as an `<img>` rather than as a link. */
export function isGifMediaUrl(value: string): boolean {
  return parseMediaUrl(value) !== null;
}

/**
 * The still frame for an animated GIF, when the host names it predictably.
 *
 * Only the message body is stored, so the picker's own still URL is long gone
 * by render time and this is the only thing a reduced-motion reader can be
 * shown without first downloading the animation. GIPHY publishes `giphy_s.gif`
 * alongside every `giphy.gif`; Tenor has no such convention, hence the null,
 * which the client answers with click-to-play instead.
 */
export function stillGifUrl(value: string): string | null {
  const url = parseMediaUrl(value);
  if (!url || !url.hostname.endsWith(".giphy.com")) {
    return null;
  }
  if (!url.pathname.endsWith("/giphy.gif")) {
    return null;
  }
  url.pathname = url.pathname.replace(/\/giphy\.gif$/, "/giphy_s.gif");
  return url.toString();
}

/** Longest search phrase the proxy will forward upstream. */
export const GIF_QUERY_MAX_LENGTH = 100;
/** Results per page, and the ceiling a caller may ask for. */
export const GIF_PAGE_SIZE = 24;
export const GIF_PAGE_MAX = 50;

/**
 * The only shape of a GIF that crosses the wire. The upstream payload is an
 * order of magnitude larger and carries analytics ids, source URLs and a
 * rendition table the client has no use for.
 *
 * `width` / `height` describe `previewUrl`, since the grid is the only place
 * that needs intrinsic dimensions — the inline render constrains itself with
 * CSS.
 */
export const gifSchema = z.object({
  id: z.string().min(1).max(100),
  /** Posted as the message body, so it must satisfy `isGifMediaUrl`. */
  url: z.string().url(),
  /** Small animated rendition for the picker grid. */
  previewUrl: z.string().url(),
  /** Still frame of the preview, or null when the host offers none. */
  previewStillUrl: z.string().url().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  title: z.string(),
});

export type Gif = z.infer<typeof gifSchema>;

/**
 * Staging a picked GIF as an attachment. The server re-checks `url` against the
 * host allowlist rather than trusting this shape — everything here is a client
 * claim, and `url` is the one that would otherwise let a caller render an
 * arbitrary host inside a private channel.
 *
 * `title` becomes the attachment filename, which is what a screen reader
 * announces and what a download is named, so it is bounded like any other
 * display string.
 */
export const createGifAttachmentSchema = z.object({
  url: z.string().url(),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
  title: z.string().max(200).optional(),
});

export type CreateGifAttachmentRequest = z.infer<
  typeof createGifAttachmentSchema
>;

export const gifSearchResponseSchema = z.object({
  gifs: z.array(gifSchema),
});

export type GifSearchResponse = z.infer<typeof gifSearchResponseSchema>;
