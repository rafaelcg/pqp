import { z } from "zod";
import { safeTextSchema } from "./api.js";

/**
 * Message search: the wire contract for `GET /api/servers/:serverId/search`.
 *
 * Two characters short of a word match almost everything, and the query is a
 * per-keystroke round trip to Postgres — so the floor is a real guard rather
 * than politeness.
 */
export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 200;

export const SEARCH_PAGE_SIZE = 25;
export const SEARCH_PAGE_MAX = 50;

/**
 * `.pipe` rather than `.refine`: the length bounds have to stay on a plain
 * string schema for the control-character check to compose after them.
 */
export const messageSearchQuerySchema = z
  .string()
  .min(SEARCH_QUERY_MIN_LENGTH)
  .max(SEARCH_QUERY_MAX_LENGTH)
  .pipe(safeTextSchema);

/**
 * Delimiters Postgres wraps matched terms in inside a snippet.
 *
 * Control characters, not `<mark>`: a message body can legitimately contain any
 * markup a user types, so an HTML sentinel would be forgeable and would push the
 * client towards rendering server text as HTML. U+0002 and U+0003 are rejected
 * by `messageBodySchema` before a body is ever stored, so no message can
 * counterfeit a highlight.
 */
export const SEARCH_HIGHLIGHT_OPEN = "\u0002";
export const SEARCH_HIGHLIGHT_CLOSE = "\u0003";

export const searchResultSchema = z.object({
  messageId: z.string().uuid(),
  channelId: z.string().uuid(),
  channelName: z.string(),
  authorId: z.string().uuid(),
  authorName: z.string(),
  authorTag: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  /** Body excerpt around the match, delimited by the markers above. */
  snippet: z.string(),
  createdAt: z.string(),
});

export type MessageSearchResult = z.infer<typeof searchResultSchema>;

export const messageSearchResponseSchema = z.object({
  results: z.array(searchResultSchema),
  hasMore: z.boolean(),
  /**
   * Opaque keyset cursor for the next page. Opaque because the ordering it
   * encodes — relevance, then recency — is the server's business, and a client
   * that reconstructed it would break the moment ranking changed.
   */
  nextCursor: z.string().nullable(),
});

export type MessageSearchResponse = z.infer<typeof messageSearchResponseSchema>;

export interface SearchSnippetSegment {
  text: string;
  /** True when this run of text is one of the terms that matched. */
  match: boolean;
}

// eslint-disable-next-line no-control-regex
const STRAY_MARKERS = /[\u0002\u0003]/g;

/**
 * Split a snippet into plain and matched runs so a client can render the
 * highlight as elements instead of interpreting the string as markup.
 */
export function parseSearchSnippet(snippet: string): SearchSnippetSegment[] {
  const segments: SearchSnippetSegment[] = [];
  let cursor = 0;
  let match = false;

  while (cursor < snippet.length) {
    const marker = match ? SEARCH_HIGHLIGHT_CLOSE : SEARCH_HIGHLIGHT_OPEN;
    const next = snippet.indexOf(marker, cursor);
    const end = next === -1 ? snippet.length : next;

    if (end > cursor) {
      // An unbalanced marker means this run ends at the string rather than at a
      // delimiter — drop any delimiter left inside it instead of emitting an
      // invisible control character into the DOM.
      const text = snippet.slice(cursor, end).replace(STRAY_MARKERS, "");
      if (text) {
        segments.push({ text, match });
      }
    }
    if (next === -1) {
      break;
    }
    cursor = next + 1;
    match = !match;
  }

  return segments;
}
