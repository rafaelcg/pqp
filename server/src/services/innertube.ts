/**
 * YouTube's internal JSON API, InnerTube, for search and playlist reads.
 *
 * This is what the YouTube web, TV and mobile apps call, and what every
 * music bot's backend calls too: Lavalink's youtube-source, yt-dlp,
 * Invidious and Piped all speak it, because the official Data API prices a
 * search at 100 of the 10,000 daily units. No key, no quota, one JSON call
 * for twenty results with title, duration and thumbnail.
 *
 * Unofficial, so two rules from those projects. First, MORE THAN ONE CLIENT:
 * each client identity gets a differently shaped answer and is rate limited
 * on its own, so when one fails the next is asked (WEB answers with
 * `videoRenderer`, TVHTML5 with `lockupViewModel`). Second, PARSE BY
 * WALKING, NOT BY PATH: the tree around a result changes with experiments,
 * the result renderers themselves rarely do, so the reader finds them
 * wherever they are. Metadata only: no stream URL is ever requested, which
 * is the half of InnerTube that PO tokens now guard.
 */

const ENDPOINT = "https://www.youtube.com/youtubei/v1";
const TIMEOUT_MS = 8_000;
/** Videos only, the search filter YouTube's own UI sends for "Vídeo". */
const VIDEOS_ONLY = "EgIQAQ%3D%3D";

export interface InnerTubeClient {
  name: string;
  version: string;
  userAgent: string;
}

/** Asked in order. WEB first because its answer is the richest. */
export const INNERTUBE_CLIENTS: readonly InnerTubeClient[] = [
  {
    name: "WEB",
    version: "2.20240814.00.00",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  },
  {
    name: "TVHTML5",
    version: "7.20240814.10.00",
    userAgent: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
  },
];

export interface InnerTubeVideo {
  videoId: string;
  title: string;
  durationMs: number | null;
  thumbnailUrl: string | null;
}

/**
 * Charged before every request to YouTube, one client attempt at a time,
 * so a fallback is a second token and not a free retry. `music.ts` sets it
 * to the shared upstream budget; it throws to refuse.
 */
let gate: () => void = () => {};

export function setInnerTubeGate(next: () => void): void {
  gate = next;
}

export class InnerTubeError extends Error {
  constructor(
    readonly client: string,
    message: string,
  ) {
    super(message);
    this.name = "InnerTubeError";
  }
}

async function call(
  client: InnerTubeClient,
  path: "search" | "browse" | "next",
  body: Record<string, unknown>,
): Promise<unknown> {
  gate();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT}/${path}?prettyPrint=false`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": client.userAgent,
        "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
        "x-youtube-client-name": client.name === "WEB" ? "1" : client.name === "TVHTML5" ? "7" : "1",
        "x-youtube-client-version": client.version,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: client.name,
            clientVersion: client.version,
            hl: "pt-BR",
            gl: "BR",
          },
        },
        ...body,
      }),
    });
    if (!res.ok) {
      throw new InnerTubeError(client.name, `${path} answered ${res.status}`);
    }
    return (await res.json()) as unknown;
  } catch (error) {
    if (error instanceof InnerTubeError) {
      throw error;
    }
    throw new InnerTubeError(
      client.name,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

/** "3:55" or "1:02:03" to milliseconds; null for anything else ("AO VIVO"). */
export function parseDurationLabel(label: string | undefined | null): number | null {
  if (!label) {
    return null;
  }
  const parts = label.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d{1,2}$/.test(p))) {
    return null;
  }
  const numbers = parts.map(Number);
  const seconds =
    numbers.length === 3
      ? (numbers[0] as number) * 3600 + (numbers[1] as number) * 60 + (numbers[2] as number)
      : (numbers[0] as number) * 60 + (numbers[1] as number);
  return seconds * 1000;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runsText(value: unknown): string {
  if (!isObject(value)) {
    return "";
  }
  if (typeof value.simpleText === "string") {
    return value.simpleText;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.runs)) {
    return value.runs
      .map((run) => (isObject(run) && typeof run.text === "string" ? run.text : ""))
      .join("");
  }
  return "";
}

function lastThumbnail(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.thumbnails)) {
    return null;
  }
  const last = value.thumbnails[value.thumbnails.length - 1];
  return isObject(last) && typeof last.url === "string" ? last.url : null;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Reads a `videoRenderer` / `compactVideoRenderer` / `playlistVideoRenderer`. */
function fromRenderer(node: Json): InnerTubeVideo | null {
  const videoId = node.videoId;
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) {
    return null;
  }
  const title = runsText(node.title);
  if (!title) {
    return null;
  }
  return {
    videoId,
    title,
    durationMs: parseDurationLabel(runsText(node.lengthText)),
    thumbnailUrl: lastThumbnail(node.thumbnail) ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

/** Reads a `lockupViewModel`, the newer shape TVHTML5 and playlist pages use. */
function fromLockup(node: Json): InnerTubeVideo | null {
  const videoId = node.contentId;
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) {
    return null;
  }
  const metadata = isObject(node.metadata) ? node.metadata.lockupMetadataViewModel : null;
  const title = isObject(metadata) ? runsText(metadata.title) : "";
  if (!title) {
    return null;
  }
  // The duration is a badge somewhere under the thumbnail. Found by walking:
  // the first badge text that reads as a clock.
  let durationMs: number | null = null;
  walk(node.contentImage, (key, value) => {
    if (durationMs === null && key === "thumbnailBadgeViewModel" && isObject(value)) {
      durationMs = parseDurationLabel(typeof value.text === "string" ? value.text : undefined);
    }
  });
  return {
    videoId,
    title,
    durationMs,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    walk(child, visit);
  }
}

/**
 * Every video in an InnerTube answer, in document order, once each.
 * Exported for the parser tests, which feed it recorded fragments.
 */
export function collectVideos(response: unknown, limit = Infinity): InnerTubeVideo[] {
  const out: InnerTubeVideo[] = [];
  const seen = new Set<string>();
  walk(response, (key, value) => {
    if (out.length >= limit || !isObject(value)) {
      return;
    }
    let video: InnerTubeVideo | null = null;
    if (key === "videoRenderer" || key === "compactVideoRenderer" || key === "playlistVideoRenderer") {
      video = fromRenderer(value);
    } else if (key === "lockupViewModel") {
      video = fromLockup(value);
    }
    if (video && !seen.has(video.videoId)) {
      seen.add(video.videoId);
      out.push(video);
    }
  });
  return out;
}

function playlistTitle(response: unknown): string | null {
  if (!isObject(response)) {
    return null;
  }
  const metadata = isObject(response.metadata) ? response.metadata.playlistMetadataRenderer : null;
  const fromMetadata = isObject(metadata) && typeof metadata.title === "string" ? metadata.title : "";
  if (fromMetadata) {
    return fromMetadata;
  }
  const header = isObject(response.header) ? response.header.pageHeaderRenderer : null;
  return isObject(header) && typeof header.pageTitle === "string" ? header.pageTitle : null;
}

async function withClients<T>(
  run: (client: InnerTubeClient) => Promise<T | null>,
): Promise<T | null> {
  let last: InnerTubeError | null = null;
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const result = await run(client);
      if (result !== null) {
        return result;
      }
    } catch (error) {
      if (!(error instanceof InnerTubeError)) {
        // The gate refusing, or anything else that is not this client's
        // fault: not a reason to try the next client.
        throw error;
      }
      last = error;
      console.warn(`[music] innertube ${client.name} failed:`, last.message);
    }
  }
  if (last) {
    throw last;
  }
  return null;
}

/** Top video results for a query, or null when every client answered with nothing. */
export async function innertubeSearch(query: string, limit = 5): Promise<InnerTubeVideo[] | null> {
  return withClients(async (client) => {
    const response = await call(client, "search", { query, params: VIDEOS_ONLY });
    const videos = collectVideos(response, limit);
    return videos.length > 0 ? videos : null;
  });
}

/** A playlist's first page (up to 100 items) and its name. */
export async function innertubePlaylist(
  listId: string,
  limit: number,
): Promise<{ name: string | null; videos: InnerTubeVideo[] } | null> {
  return withClients(async (client) => {
    const response = await call(client, "browse", { browseId: `VL${listId}` });
    const videos = collectVideos(response, limit);
    return videos.length > 0 ? { name: playlistTitle(response), videos } : null;
  });
}

const RELATED_CACHE_MAX = 500;
const RELATED_CACHE_TTL_MS = 6 * 60 * 60_000;
const relatedCache = new Map<string, { at: number; videos: InnerTubeVideo[] }>();

function rememberRelated(videoId: string, videos: InnerTubeVideo[]) {
  if (relatedCache.size >= RELATED_CACHE_MAX) {
    const oldest = relatedCache.keys().next().value;
    if (oldest !== undefined) {
      relatedCache.delete(oldest);
    }
  }
  relatedCache.set(videoId, { at: Date.now(), videos });
}

/** Test hook. */
export function resetInnerTubeRelatedCache(): void {
  relatedCache.clear();
}

/**
 * "Watch next" videos for a video id. WEB answers `compactVideoRenderer`,
 * TVHTML5 answers `lockupViewModel`; `collectVideos` already reads both.
 * The seed video is dropped. Remembered for six hours, like search.
 */
export async function innertubeRelated(
  videoId: string,
  limit = 5,
): Promise<InnerTubeVideo[] | null> {
  const cached = relatedCache.get(videoId);
  if (cached && Date.now() - cached.at < RELATED_CACHE_TTL_MS) {
    return cached.videos.slice(0, limit);
  }
  return withClients(async (client) => {
    const response = await call(client, "next", { videoId });
    const videos = collectVideos(response)
      .filter((video) => video.videoId !== videoId)
      .slice(0, limit);
    if (videos.length === 0) {
      return null;
    }
    rememberRelated(videoId, videos);
    return videos;
  });
}
