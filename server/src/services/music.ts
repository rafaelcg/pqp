import { parseMusicInput, type MusicResolved } from "@pqp/shared";

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
    readonly code: "unsupported" | "not_found" | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "MusicResolveError";
  }
}

const FETCH_TIMEOUT_MS = 8_000;

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
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
      throw new MusicResolveError("upstream", `${url} answered ${res.status}`);
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

export async function searchYouTube(query: string): Promise<MusicResolved> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  const hit = key ? await searchWithDataApi(query, key) : await searchByScraping(query);
  if (!hit) {
    throw new MusicResolveError("not_found", `Nothing on YouTube for "${query}"`);
  }
  return {
    provider: "youtube",
    videoId: hit.videoId,
    title: hit.title.trim().slice(0, 200) || hit.videoId,
    sourceUrl: null,
    thumbnailUrl: hit.thumbnailUrl,
    durationMs: null,
  };
}

export async function resolveMusic(raw: string): Promise<MusicResolved> {
  const link = parseMusicInput(raw);
  if (!link) {
    throw new MusicResolveError(
      "unsupported",
      "Only YouTube and Spotify links, or a search, are supported",
    );
  }
  if (link.kind === "youtube") {
    return resolveYouTube(link.videoId, link.url);
  }
  if (link.kind === "spotify") {
    if (link.entity !== "track") {
      throw new MusicResolveError(
        "unsupported",
        "Only Spotify track links are supported (not albums or playlists)",
      );
    }
    const query = await spotifyQuery(link.url);
    const found = await searchYouTube(query);
    return { ...found, sourceUrl: link.url };
  }
  return searchYouTube(link.query);
}
