import {
  gifSchema,
  isGifMediaUrl,
  type Gif,
} from "@pqp/shared";
import { z } from "zod";

/**
 * GIF search proxy, backed by Klipy (https://docs.klipy.com).
 *
 * The API key never reaches the browser: anything in a `VITE_` variable is
 * baked into the public bundle, so the key would be readable by every visitor
 * and burnable by anyone who viewed source. On Klipy the key is a *path
 * segment*, which makes the full upstream URL itself a secret; nothing below
 * may echo it into an error message or a log line.
 */
const KLIPY_ENDPOINT = "https://api.klipy.com/api/v1";

/**
 * Upstream is a third party on the request path of a per-keystroke action, so
 * it gets a short leash — a hung connection must not hold a Node socket open
 * until the client's own 12s timeout fires.
 */
const UPSTREAM_TIMEOUT_MS = 5_000;

/**
 * Forced on every call. This is a chat app for small communities, and
 * unfiltered GIF search is not an acceptable default for one. Klipy's scale
 * names the filter's looseness, not the content's: `low` admits G, PG and
 * PG-13, exactly the set GIPHY's forced `rating=pg-13` admitted, while `off`
 * adds R and `medium`/`high` cut down to PG/G.
 */
const CONTENT_FILTER = "low";

/**
 * Klipy refuses `per_page` below 8, so a smaller ask is padded up to this and
 * the page trimmed after normalisation.
 */
const KLIPY_MIN_PER_PAGE = 8;

/** Upstream reachable but unusable — a 502 to the caller, never a 500. */
export class GifBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GifBackendError";
  }
}

function apiKey(): string | null {
  const key = process.env.KLIPY_API_KEY?.trim();
  if (!key || key.startsWith("your-")) {
    return null;
  }
  return key;
}

export function isGifSearchConfigured(): boolean {
  return apiKey() !== null;
}

/**
 * Only the fields worth reading. `.passthrough()` is deliberate — Klipy adds
 * formats and metadata over time, and a strict schema would reject the whole
 * page over a field nobody looks at.
 */
const renditionSchema = z
  .object({
    url: z.string().optional(),
    width: z.union([z.string(), z.number()]).optional(),
    height: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

/**
 * One size tier (`hd` / `md` / `sm` / `xs`), holding one rendition per format
 * (`gif` / `webp` / `jpg` / `mp4` / `webm`).
 */
const tierSchema = z.record(renditionSchema);

const klipyResponseSchema = z.object({
  result: z.boolean().optional(),
  data: z
    .object({
      data: z.array(
        z
          .object({
            id: z.union([z.string(), z.number()]).optional(),
            title: z.string().optional(),
            type: z.string().optional(),
            file: z.record(tierSchema).optional(),
          })
          .passthrough(),
      ),
    })
    .optional(),
});

type Tier = z.infer<typeof tierSchema>;
type KlipyItem = NonNullable<
  z.infer<typeof klipyResponseSchema>["data"]
>["data"][number];

function dimension(value: string | number | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/**
 * The chosen URL becomes a message body that outlives the session that
 * fetched it, so nothing request-scoped may ride along in it. Klipy serves
 * bare static URLs and hangs its ad attribution on request parameters this
 * proxy never sends (GIPHY put `cid`/`rid`/`ct` right on the media URL); the
 * query is stripped anyway so a provider change cannot quietly reintroduce a
 * tracking id into stored messages.
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

function pickTier(
  file: Record<string, Tier> | undefined,
  names: string[],
): Tier | null {
  for (const name of names) {
    const tier = file?.[name];
    if (tier?.gif?.url) {
      return tier;
    }
  }
  return null;
}

/**
 * Collapse one upstream entry to the wire shape, or drop it. A single odd
 * result must not fail the whole search — an incomplete grid is a far better
 * answer than an error page.
 */
function toGif(raw: KlipyItem): Gif | null {
  // Klipy can interleave sponsored entries (`type: "ad"`, an HTML payload in
  // place of a file). None should ever arrive, since ad delivery is keyed on
  // `customer_id`, `ad-*` parameters and a browser-like User-Agent and this
  // proxy sends none of them, but a picker grid is no place for one that
  // slips through unmarked.
  if (raw.type !== undefined && raw.type !== "gif") {
    return null;
  }

  // The animated GIF rendition on purpose, not the lighter webp/mp4: the URL
  // is posted as the message body and every client renders it with an image
  // decoder that is only guaranteed to animate GIF (see docs/ANDROID.md on
  // coil-gif). `md` lands near GIPHY's old `downsized_medium` weight; `hd`
  // regularly crosses 4MB, too heavy for a chat message.
  const fullTier = pickTier(raw.file, ["md", "hd", "sm"]);
  const previewTier = pickTier(raw.file, ["sm", "xs", "md"]);
  const full = fullTier?.gif;
  const preview = previewTier?.gif;
  // Klipy publishes a jpg still in every tier, which is what a reduced-motion
  // grid shows instead of twenty animations at once.
  const still = previewTier?.jpg;

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
    id: raw.id === undefined ? undefined : String(raw.id),
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
  limit: number,
  params: Record<string, string>,
): Promise<Gif[]> {
  const key = apiKey();
  if (!key) {
    throw new GifBackendError("GIF search is not configured");
  }

  // Deliberately no `customer_id`, no `locale`, no `ad-*` parameters: Klipy
  // uses them for per-user recents and ad attribution, and this proxy is
  // anonymous on purpose. Every caller looks like the same nobody.
  const query = new URLSearchParams({
    ...params,
    per_page: String(Math.max(limit, KLIPY_MIN_PER_PAGE)),
    content_filter: CONTENT_FILTER,
  });

  let response: Response;
  try {
    response = await fetch(
      `${KLIPY_ENDPOINT}/${key}/gifs/${path}?${query.toString()}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
  } catch (error) {
    // Node's fetch errors can quote the URL, and the URL contains the key.
    const message =
      error instanceof Error
        ? error.message.replaceAll(key, "***")
        : "GIF provider unreachable";
    throw new GifBackendError(message);
  }

  if (!response.ok) {
    throw new GifBackendError(`GIF provider returned HTTP ${response.status}`);
  }

  const payload = klipyResponseSchema.safeParse(await response.json());
  if (!payload.success) {
    throw new GifBackendError("GIF provider returned an unexpected payload");
  }
  // Klipy reports some failures as `{ "result": false }` under HTTP 200.
  if (payload.data.result === false || !payload.data.data) {
    throw new GifBackendError("GIF provider refused the request");
  }

  return payload.data.data.data
    .map(toGif)
    .filter((gif): gif is Gif => gif !== null)
    .slice(0, limit);
}

export function searchGifs(query: string, limit: number): Promise<Gif[]> {
  return fetchGifs("search", limit, { q: query });
}

export function trendingGifs(limit: number): Promise<Gif[]> {
  return fetchGifs("trending", limit, {});
}
