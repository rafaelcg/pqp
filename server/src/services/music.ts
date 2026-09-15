import { parseMusicInput, type MusicResolved } from "@pqp/shared";
import { createRateLimiter } from "../lib/rate-limit.js";
import { innertubePlaylist, innertubeSearch, setInnerTubeGate } from "./innertube.js";

/**
 * Turn what a person pasted into a YouTube video the room can play.
 *
 * Three inputs. A YouTube link is answered from YouTube's oEmbed endpoint
 * (title and thumbnail, no key, no quota). A Spotify link is read for its
 * Open Graph title and description (the artist), which becomes a search. A
 * bare string is a search. Search uses the YouTube Data API when
 * `YOUTUBE_API_KEY` is set (100 quota units per search on a 10,000/day free
 * key) and otherwise reads the first result off the public results page,
 * which is metadata only: no media ever touches this process.
 */

export class MusicResolveError extends Error {
  constructor(
    readonly code: "unsupported" | "not_found" | "upstream" | "busy",
    message: string,
  ) {
    super(message);
    this.name = "MusicResolveError";
  }
}

const FETCH_TIMEOUT_MS = 8_000;

/**
 * THE UPSTREAM BUDGET, across everybody on this process. Charged per call
 * to YouTube or Spotify, not per request: a cache hit costs nothing, a
 * pasted link costs one, a 25-track Spotify list costs twenty-six. Sized
 * from the load run of 2026-09-12 (`docs/MUSIC.md`), where InnerTube
 * answered ten concurrent searches at p95 446 ms with no refusals; the
 * ceiling here is ours, kept under whatever YouTube's is.
 */
const upstreamBudget = createRateLimiter({ capacity: 300, refillPerSecond: 10 });

export function takeUpstreamBudget(): void {
  if (!upstreamBudget.take("all")) {
    throw new MusicResolveError("busy", "upstream budget spent");
  }
}
// Every InnerTube client attempt is one token, charged inside the attempt.
setInnerTubeGate(takeUpstreamBudget);

/** Test hook. */
export function resetUpstreamBudget(): void {
  upstreamBudget.reset();
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  takeUpstreamBudget();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
        ...headers,
      },
    });
    if (!res.ok) {
      // Never the query string: the Data API key travels in it.
      throw new MusicResolveError("upstream", `${url.split("?")[0]} answered ${res.status}`);
    }
    return await res.text();
  } catch (error) {
    if (error instanceof MusicResolveError) {
      throw error;
    }
    throw new MusicResolveError(
      "upstream",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function resolveYouTube(
  videoId: string,
  sourceUrl: string | null,
): Promise<MusicResolved> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const body = await fetchText(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
  );
  let parsed: { title?: string; thumbnail_url?: string } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new MusicResolveError("upstream", "YouTube oEmbed was not JSON");
  }
  return {
    provider: "youtube",
    videoId,
    title: (parsed.title ?? "").trim().slice(0, 200) || videoId,
    sourceUrl,
    thumbnailUrl:
      parsed.thumbnail_url ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationMs: null,
  };
}

/**
 * Title and artist for a Spotify track, as one search string.
 *
 * The public track page answers a plain fetch with a JavaScript shell and no
 * Open Graph tags, so two other doors: Spotify's oEmbed endpoint for the
 * title (no key, no quota), and the server-rendered embed page for the
 * artist, which the oEmbed answer does not carry.
 */
export async function spotifyQuery(url: string): Promise<string> {
  const oembed = await fetchText(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
  );
  let title = "";
  try {
    title = ((JSON.parse(oembed) as { title?: string }).title ?? "").trim();
  } catch {
    throw new MusicResolveError("upstream", "Spotify oEmbed was not JSON");
  }
  if (!title) {
    throw new MusicResolveError("not_found", "Spotify track had no title");
  }
  let artist = "";
  try {
    const match = url.match(/\/track\/([A-Za-z0-9]+)/);
    if (match) {
      const embed = await fetchText(`https://open.spotify.com/embed/track/${match[1]}`);
      artist = decodeHtml(embed.match(/"artists":\[\{"name":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "");
    }
  } catch {
    // The title alone is still a usable search.
  }
  const query = artist && !title.includes(artist) ? `${artist} ${title}` : title;
  return query.slice(0, 200);
}

interface SearchHit {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  durationMs?: number | null;
}

async function searchWithDataApi(query: string, key: string): Promise<SearchHit | null> {
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoCategoryId: "10",
    maxResults: "1",
    q: query,
    key,
  });
  const body = await fetchText(
    `https://www.googleapis.com/youtube/v3/search?${params.toString()}`,
  );
  const parsed = JSON.parse(body) as {
    items?: Array<{
      id?: { videoId?: string };
      snippet?: { title?: string; thumbnails?: { high?: { url?: string } } };
    }>;
  };
  const first = parsed.items?.[0];
  if (!first?.id?.videoId) {
    return null;
  }
  return {
    videoId: first.id.videoId,
    title: decodeHtml(first.snippet?.title ?? first.id.videoId),
    thumbnailUrl: first.snippet?.thumbnails?.high?.url ?? null,
  };
}

/** First result off the public results page. Exported for the parser test. */
export function firstResultFromHtml(html: string): SearchHit | null {
  // Each result is a `videoRenderer` object carrying its id and title runs.
  const re =
    /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/s;
  const match = html.match(re);
  if (!match) {
    return null;
  }
  let title = match[2] ?? "";
  try {
    title = JSON.parse(`"${title}"`) as string;
  } catch {
    // keep the raw text
  }
  return {
    videoId: match[1] as string,
    title: title || (match[1] as string),
    thumbnailUrl: `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`,
  };
}

async function searchByScraping(query: string): Promise<SearchHit | null> {
  const html = await fetchText(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D`,
    { cookie: "CONSENT=YES+1; SOCS=CAI" },
  );
  return firstResultFromHtml(html);
}

/**
 * Search results, remembered for a while. A Spotify playlist is twenty-five
 * searches, and the same playlist gets pasted into the same room more than
 * once; the answer for "artist title" does not change between the two.
 */
const SEARCH_CACHE_MAX = 500;
const SEARCH_CACHE_TTL_MS = 6 * 60 * 60_000;
const searchCache = new Map<string, { at: number; hit: SearchHit }>();

function rememberSearch(query: string, hit: SearchHit) {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) {
      searchCache.delete(oldest);
    }
  }
  searchCache.set(query, { at: Date.now(), hit });
}

export async function searchYouTube(query: string): Promise<MusicResolved> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  let hit: SearchHit | null;
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    hit = cached.hit;
  } else {
    hit = key ? await searchWithDataApi(query, key) : await searchUnofficial(query);
    if (hit) {
      rememberSearch(cacheKey, hit);
    }
  }
  if (!hit) {
    throw new MusicResolveError("not_found", `Nothing on YouTube for "${query}"`);
  }
  return {
    provider: "youtube",
    videoId: hit.videoId,
    title: hit.title.trim().slice(0, 200) || hit.videoId,
    sourceUrl: null,
    thumbnailUrl: hit.thumbnailUrl,
    durationMs: hit.durationMs ?? null,
  };
}

/**
 * InnerTube first (`innertube.ts`, the JSON API every music bot uses, with
 * a client fallback), the results page as the last resort when every
 * client fails. Both are unofficial; the page is the more fragile of the two.
 */
async function searchUnofficial(query: string): Promise<SearchHit | null> {
  try {
    const videos = await innertubeSearch(query, 5);
    if (videos && videos.length > 0) {
      const first = videos[0]!;
      return {
        videoId: first.videoId,
        title: first.title,
        thumbnailUrl: first.thumbnailUrl,
        durationMs: first.durationMs,
      };
    }
    return null;
  } catch (error) {
    if (error instanceof MusicResolveError) {
      throw error;
    }
    console.warn(
      "[music] innertube search failed, falling back to the results page:",
      error instanceof Error ? error.message : String(error),
    );
    return searchByScraping(query);
  }
}

/** How many of a list we take. The room's queue holds 50. */
export const PLAYLIST_MAX = 50;
/**
 * Each Spotify track is one InnerTube search, three at a time, well under a
 * second each: twenty-five is a few seconds. A YouTube playlist is one call
 * and takes all fifty.
 */
export const SPOTIFY_LIST_MAX = 25;

/** What a resolve answers: one track for a link or a search, many for a list. */
export interface MusicResolution {
  tracks: MusicResolved[];
  /** The list's own name, when there was a list. */
  listName: string | null;
}

/** Items off the public playlist page. Exported for the parser test. */
export function playlistFromHtml(html: string): Array<{ videoId: string; title: string }> {
  const re =
    /\{"lockupViewModel":\{"contentImage".*?"contentId":"([A-Za-z0-9_-]{11})".*?"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/gs;
  const items: Array<{ videoId: string; title: string }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(re)) {
    const videoId = match[1] as string;
    if (seen.has(videoId)) {
      continue;
    }
    seen.add(videoId);
    let title = match[2] ?? "";
    try {
      title = JSON.parse(`"${title}"`) as string;
    } catch {
      // keep the raw text
    }
    items.push({ videoId, title: title || videoId });
    if (items.length >= PLAYLIST_MAX) {
      break;
    }
  }
  return items;
}

function playlistNameFromHtml(html: string): string | null {
  const title = decodeHtml(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "");
  const name = title.replace(/\s*-\s*YouTube\s*$/, "").trim();
  return name || null;
}

async function youtubePlaylistWithDataApi(
  listId: string,
  key: string,
): Promise<{ items: Array<{ videoId: string; title: string; thumbnailUrl: string | null }>; name: string | null }> {
  const params = new URLSearchParams({
    part: "snippet",
    playlistId: listId,
    maxResults: String(PLAYLIST_MAX),
    key,
  });
  const body = await fetchText(
    `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`,
  );
  const parsed = JSON.parse(body) as {
    items?: Array<{
      snippet?: {
        title?: string;
        resourceId?: { videoId?: string };
        thumbnails?: { high?: { url?: string } };
      };
    }>;
  };
  const items = (parsed.items ?? [])
    .map((item) => ({
      videoId: item.snippet?.resourceId?.videoId ?? "",
      title: decodeHtml(item.snippet?.title ?? ""),
      thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? null,
    }))
    // "Deleted video" and "Private video" come back as items with no
    // playable id in practice; drop anything without one.
    .filter((item) => item.videoId && item.title !== "Deleted video" && item.title !== "Private video");
  return { items, name: null };
}

export async function resolveYouTubePlaylist(
  listId: string,
  startVideoId: string | null,
): Promise<MusicResolution> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  let items: Array<{
    videoId: string;
    title: string;
    thumbnailUrl: string | null;
    durationMs?: number | null;
  }> = [];
  let name: string | null = null;
  if (key) {
    ({ items, name } = await youtubePlaylistWithDataApi(listId, key));
  } else {
    // InnerTube `browse` first; the playlist page only when every client failed.
    try {
      const list = await innertubePlaylist(listId, PLAYLIST_MAX);
      if (list) {
        items = list.videos;
        name = list.name;
      }
    } catch (error) {
      if (error instanceof MusicResolveError) {
        throw error;
      }
      console.warn(
        "[music] innertube playlist failed, falling back to the page:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (items.length === 0) {
      const html = await fetchText(`https://www.youtube.com/playlist?list=${listId}`, {
        cookie: "CONSENT=YES+1; SOCS=CAI",
      });
      items = playlistFromHtml(html).map((item) => ({
        ...item,
        thumbnailUrl: `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
      }));
      name = playlistNameFromHtml(html);
    }
  }
  if (items.length === 0) {
    throw new MusicResolveError("not_found", "That playlist is empty, private, or could not be read");
  }
  // A `watch?v=X&list=Y` link starts the list at X, like YouTube does.
  const start = startVideoId ? items.findIndex((item) => item.videoId === startVideoId) : -1;
  let ordered = start > 0 ? [...items.slice(start), ...items.slice(0, start)] : items;
  if (startVideoId && start < 0) {
    // The linked video is past what one page holds (a list longer than
    // PLAYLIST_MAX). It still goes first: that is what the person clicked.
    try {
      const first = await resolveYouTube(startVideoId, null);
      ordered = [
        { videoId: first.videoId, title: first.title, thumbnailUrl: first.thumbnailUrl },
        ...items.filter((item) => item.videoId !== startVideoId),
      ];
    } catch {
      // Unresolvable start video: the list from the top is still a list.
    }
  }
  return {
    listName: name,
    tracks: ordered.slice(0, PLAYLIST_MAX).map((item) => ({
      provider: "youtube",
      videoId: item.videoId,
      title: item.title.trim().slice(0, 200) || item.videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${item.videoId}&list=${listId}`,
      thumbnailUrl: item.thumbnailUrl,
      durationMs: item.durationMs ?? null,
    })),
  };
}

/** The track list off Spotify's embed page. Exported for the parser test. */
export function spotifyTrackListFromHtml(
  html: string,
): { name: string | null; tracks: Array<{ title: string; artist: string }> } {
  const start = html.indexOf('"trackList":[');
  if (start < 0) {
    return { name: null, tracks: [] };
  }
  // The array ends at the first `]` that closes it: track objects nest no
  // arrays of their own except `labels`, which is why the scan below counts
  // depth rather than trusting the first bracket.
  let depth = 0;
  let end = -1;
  for (let i = start + '"trackList":'.length; i < html.length; i++) {
    const ch = html[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const slice = end > 0 ? html.slice(start + '"trackList":'.length, end) : "";
  const tracks: Array<{ title: string; artist: string }> = [];
  for (const match of slice.matchAll(
    /"title":"((?:[^"\\]|\\.)*)","subtitle":"((?:[^"\\]|\\.)*)"/g,
  )) {
    let title = match[1] ?? "";
    let artist = match[2] ?? "";
    try {
      title = JSON.parse(`"${title}"`) as string;
      artist = JSON.parse(`"${artist}"`) as string;
    } catch {
      // keep raw
    }
    if (title) {
      tracks.push({ title, artist });
      if (tracks.length >= SPOTIFY_LIST_MAX) {
        break;
      }
    }
  }
  // The page's own header is the first title/subtitle pair before the list.
  const head = html.slice(0, start).match(/"title":"((?:[^"\\]|\\.)*)","subtitle":"((?:[^"\\]|\\.)*)"/);
  let name: string | null = null;
  if (head?.[1]) {
    try {
      name = JSON.parse(`"${head[1]}"`) as string;
    } catch {
      name = head[1];
    }
  }
  return { name, tracks };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R | null>): Promise<R[]> {
  const out: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        out[index] = await fn(items[index] as T);
      } catch (error) {
        // A spent budget is the room's problem, not this track's: it goes up
        // as the 429 the route documents, never as a shorter list.
        if (error instanceof MusicResolveError && error.code === "busy") {
          throw error;
        }
        out[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out.filter((item): item is R => item !== null);
}

export async function resolveSpotifyList(
  entity: "album" | "playlist",
  id: string,
  url: string,
): Promise<MusicResolution> {
  const html = await fetchText(`https://open.spotify.com/embed/${entity}/${id}`);
  const { name, tracks } = spotifyTrackListFromHtml(html);
  if (tracks.length === 0) {
    throw new MusicResolveError("not_found", "That Spotify list is empty, private, or could not be read");
  }
  // Three at a time, one retry: a burst from one address is what makes
  // YouTube rate-limit a client, and the fallback list absorbs the rest.
  const resolved = await mapLimit(tracks.slice(0, SPOTIFY_LIST_MAX), 3, async (track) => {
    const query = `${track.artist} ${track.title}`.trim().slice(0, 200);
    let found: MusicResolved;
    try {
      found = await searchYouTube(query);
    } catch (error) {
      if (error instanceof MusicResolveError && error.code === "busy") {
        throw error;
      }
      if (error instanceof MusicResolveError && error.code === "not_found") {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      found = await searchYouTube(query);
    }
    return { ...found, sourceUrl: url };
  });
  if (resolved.length === 0) {
    throw new MusicResolveError("not_found", "Nothing on YouTube for that list");
  }
  return { listName: name, tracks: resolved };
}

async function followShortLink(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    return res.url;
  } catch (error) {
    throw new MusicResolveError("upstream", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveMusic(raw: string): Promise<MusicResolution> {
  const link = parseMusicInput(raw);
  if (!link) {
    throw new MusicResolveError(
      "unsupported",
      "Only YouTube and Spotify links, or a search, are supported",
    );
  }
  if (link.kind === "youtube") {
    return { listName: null, tracks: [await resolveYouTube(link.videoId, link.url)] };
  }
  if (link.kind === "youtube-playlist") {
    return resolveYouTubePlaylist(link.listId, link.videoId);
  }
  if (link.kind === "spotify-short") {
    const target = await followShortLink(link.url);
    const inner = parseMusicInput(target);
    if (!inner || inner.kind === "spotify-short") {
      throw new MusicResolveError("not_found", "That short link did not lead to a Spotify track or list");
    }
    return resolveMusic(target);
  }
  if (link.kind === "spotify") {
    if (link.entity === "track") {
      const query = await spotifyQuery(link.url);
      const found = await searchYouTube(query);
      return { listName: null, tracks: [{ ...found, sourceUrl: link.url }] };
    }
    if ((link.entity === "album" || link.entity === "playlist") && link.id) {
      return resolveSpotifyList(link.entity, link.id, link.url);
    }
    throw new MusicResolveError(
      "unsupported",
      "Only Spotify track, album and playlist links are supported",
    );
  }
  return { listName: null, tracks: [await searchYouTube(link.query)] };
}

/**
 * Top search hits for the add box. InnerTube first (title, duration,
 * thumbnail). When it answers nothing, fall through to `resolveMusic` so a
 * pasted query still yields the same single track resolve already knew.
 */
export async function searchMusicCandidates(query: string): Promise<MusicResolved[]> {
  try {
    const videos = await innertubeSearch(query, 5);
    if (videos && videos.length > 0) {
      return videos.slice(0, 5).map((video) => ({
        provider: "youtube" as const,
        videoId: video.videoId,
        title: video.title.trim().slice(0, 200) || video.videoId,
        sourceUrl: null,
        thumbnailUrl: video.thumbnailUrl,
        durationMs: video.durationMs,
      }));
    }
  } catch (error) {
    if (error instanceof MusicResolveError) {
      throw error;
    }
    console.warn(
      "[music] innertube search failed, falling back to resolve:",
      error instanceof Error ? error.message : String(error),
    );
  }
  const { tracks } = await resolveMusic(query);
  return tracks;
}
