import {
  gifSchema,
  isGifMediaUrl,
  type Gif,
} from "@pqp/shared";
import { z } from "zod";

/**
 * GIF search proxy.
 *
 * The API key never reaches the browser: anything in a `VITE_` variable is
 * baked into the public bundle, so the key would be readable by every visitor
 * and burnable by anyone who viewed source.
 */
const GIPHY_ENDPOINT = "https://api.giphy.com/v1/gifs";

/**
 * Upstream is a third party on the request path of a per-keystroke action, so
 * it gets a short leash — a hung connection must not hold a Node socket open
 * until the client's own 12s timeout fires.
 */
const UPSTREAM_TIMEOUT_MS = 5_000;

/**
 * Forced on every call. This is a chat app for small communities, and
 * unfiltered GIF search is not an acceptable default for one.
 */
const RATING = "pg-13";

/** Upstream reachable but unusable — a 502 to the caller, never a 500. */
export class GifBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GifBackendError";
  }
}

function apiKey(): string | null {
  const key = process.env.GIPHY_API_KEY?.trim();
  if (!key || key.startsWith("your-")) {
    return null;
  }
  return key;
}

export function isGifSearchConfigured(): boolean {
  return apiKey() !== null;
}

/**
 * Only the fields worth reading. `.passthrough()` is deliberate — GIPHY adds
 * renditions over time, and a strict schema would reject the whole page over a
 * field nobody looks at.
 */
const renditionSchema = z
  .object({
    url: z.string().optional(),
    width: z.union([z.string(), z.number()]).optional(),
    height: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const giphyResponseSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().optional(),
        title: z.string().optional(),
        images: z.record(renditionSchema).optional(),
      })
      .passthrough(),
  ),
});

type Rendition = z.infer<typeof renditionSchema>;

function dimension(value: string | number | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/**
 * GIPHY appends per-request analytics parameters (`cid`, `rid`, `ct`) to every
 * media URL. The chosen one becomes a message body that outlives the session
 * that fetched it, so strip them: the bare URL serves the same bytes, stays
 * readable in the raw text, and carries no tracking id forward.
 */
function cleanUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function pick(
  images: Record<string, Rendition> | undefined,
  names: string[],
): Rendition | null {
  for (const name of names) {
    const rendition = images?.[name];
    if (rendition?.url) {
      return rendition;
    }
  }
  return null;
}

/**
 * Collapse one upstream entry to the wire shape, or drop it. A single odd
 * result must not fail the whole search — an incomplete grid is a far better
 * answer than an error page.
 */
function toGif(raw: z.infer<typeof giphyResponseSchema>["data"][number]): Gif | null {
  const images = raw.images;
  const full = pick(images, ["downsized_medium", "original", "downsized"]);
  const preview = pick(images, ["fixed_width", "fixed_height", "preview_gif"]);
  const still = pick(images, ["fixed_width_still", "fixed_height_still"]);

  const url = cleanUrl(full?.url);
  const previewUrl = cleanUrl(preview?.url) ?? url;
  if (!url || !previewUrl) {
    return null;
  }

  // The client renders this URL as an image on sight, so the proxy is where a
  // host outside the allowlist has to be refused — after that point nothing
  // re-checks it.
  if (!isGifMediaUrl(url) || !isGifMediaUrl(previewUrl)) {
    return null;
  }

  const parsed = gifSchema.safeParse({
    id: raw.id,
    url,
    previewUrl,
    previewStillUrl: cleanUrl(still?.url),
    width: dimension(preview?.width) ?? dimension(full?.width),
    height: dimension(preview?.height) ?? dimension(full?.height),
    title: raw.title?.trim() ?? "",
  });
  return parsed.success ? parsed.data : null;
}

async function fetchGifs(
  path: "search" | "trending",
  params: Record<string, string>,
): Promise<Gif[]> {
  const key = apiKey();
  if (!key) {
    throw new GifBackendError("GIF search is not configured");
  }

  const query = new URLSearchParams({
    ...params,
    api_key: key,
    rating: RATING,
  });

  let response: Response;
  try {
    response = await fetch(`${GIPHY_ENDPOINT}/${path}?${query.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GifBackendError(
      error instanceof Error ? error.message : "GIF provider unreachable",
    );
  }

  if (!response.ok) {
    throw new GifBackendError(`GIF provider returned HTTP ${response.status}`);
  }

  const payload = giphyResponseSchema.safeParse(await response.json());
  if (!payload.success) {
    throw new GifBackendError("GIF provider returned an unexpected payload");
  }

  return payload.data.data
    .map(toGif)
    .filter((gif): gif is Gif => gif !== null);
}

export function searchGifs(query: string, limit: number): Promise<Gif[]> {
  return fetchGifs("search", { q: query, limit: String(limit) });
}

export function trendingGifs(limit: number): Promise<Gif[]> {
  return fetchGifs("trending", { limit: String(limit) });
}
