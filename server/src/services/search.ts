import {
  formatUserTag,
  SEARCH_HIGHLIGHT_CLOSE,
  SEARCH_HIGHLIGHT_OPEN,
  type MessageSearchResponse,
} from "@pqp/shared";
import { getPool } from "../db.js";
import { isUuid } from "../lib/http.js";

/**
 * Message search over Postgres full-text, with no second engine to operate.
 *
 * The text search configuration has to match the one the generated column in
 * schema.sql is built with, or the query would be stemmed differently from the
 * index and quietly stop matching.
 */
const SEARCH_CONFIG = "english";

/**
 * Snippet shape. Two fragments so a match late in a long message still arrives
 * with context, and short ones because the result row is one line in a sidebar
 * panel rather than a document viewer.
 */
const HEADLINE_OPTIONS = [
  `StartSel="${SEARCH_HIGHLIGHT_OPEN}"`,
  `StopSel="${SEARCH_HIGHLIGHT_CLOSE}"`,
  "MaxFragments=2",
  "MaxWords=18",
  "MinWords=6",
  'FragmentDelimiter=" … "',
].join(", ");

/**
 * The visibility predicate, character for character the one `isChannelMember`
 * and `getChannelAudience` use. Search is the widest read surface in the app —
 * one query touching every message in a server — so it must not carry a second,
 * subtly different idea of who can see what.
 */
const VISIBLE_CHANNEL = `(
        c.is_private = FALSE
        OR sm.role IN ('owner', 'admin')
        OR EXISTS (
          SELECT 1 FROM channel_members cm
          WHERE cm.channel_id = c.id AND cm.user_id = $2
        )
      )`;

interface SearchCursor {
  rank: number;
  createdAt: string;
  id: string;
}

/**
 * Results are ordered by relevance first, so a cursor has to carry the rank as
 * well as the row's position in time — `(created_at, id)` alone would skip
 * every later-but-less-relevant message.
 *
 * Postgres prints `real` with the shortest text that round-trips, so parsing it
 * to a JS number and casting it back to `real` in the next query reproduces the
 * same value exactly.
 */
function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(
    `${cursor.rank}|${cursor.createdAt}|${cursor.id}`,
    "utf8",
  ).toString("base64url");
}

export function decodeSearchCursor(raw: string): SearchCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const [rank, createdAt, id] = decoded.split("|");

  if (!rank || !createdAt || !id || !isUuid(id)) {
    return null;
  }
  const parsedRank = Number(rank);
  if (!Number.isFinite(parsedRank)) {
    return null;
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    return null;
  }
  return { rank: parsedRank, createdAt, id };
}

interface SearchRow {
  id: string;
  channel_id: string;
  channel_name: string;
  author_id: string;
  author_name: string;
  author_username: string | null;
  author_discriminator: string | null;
  author_avatar_url: string | null;
  created_at: Date;
  rank: number;
  snippet: string;
}

export async function searchMessages(
  serverId: string,
  viewerId: string,
  query: string,
  limit: number,
  cursor?: SearchCursor,
): Promise<MessageSearchResponse> {
  const params: unknown[] = [
    serverId,
    viewerId,
    query,
    limit + 1,
    HEADLINE_OPTIONS,
  ];

  let cursorClause = "";
  if (cursor) {
    // Row comparison against the same expression the ordering uses: comparing
    // rank alone would drop every equally-ranked message after the first page.
    cursorClause = `AND (ts_rank_cd(m.search_tsv, q.query), m.created_at, m.id)
        < ($6::real, $7::timestamptz, $8::uuid)`;
    params.push(cursor.rank, cursor.createdAt, cursor.id);
  }

  // `hits` is limited before the outer select runs, so ts_headline — which
  // re-parses the whole body — is only paid for the rows actually returned.
  const result = await getPool().query<SearchRow>(
    `WITH q AS (SELECT websearch_to_tsquery('${SEARCH_CONFIG}', $3) AS query),
     hits AS (
       SELECT m.id, m.channel_id, m.author_id, m.body, m.created_at,
              c.name AS channel_name,
              u.display_name AS author_name,
              u.username AS author_username,
              u.discriminator AS author_discriminator,
              u.avatar_url AS author_avatar_url,
              ts_rank_cd(m.search_tsv, q.query) AS rank
       FROM messages m
       CROSS JOIN q
       JOIN channels c ON c.id = m.channel_id
       JOIN users u ON u.id = m.author_id
       JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $2
       WHERE c.server_id = $1
         AND m.search_tsv @@ q.query
         AND ${VISIBLE_CHANNEL}
         ${cursorClause}
       ORDER BY rank DESC, m.created_at DESC, m.id DESC
       LIMIT $4
     )
     SELECT h.id, h.channel_id, h.channel_name, h.author_id, h.author_name,
            h.author_username, h.author_discriminator, h.author_avatar_url,
            h.created_at, h.rank,
            ts_headline('${SEARCH_CONFIG}', h.body, q.query, $5) AS snippet
     FROM hits h
     CROSS JOIN q
     ORDER BY h.rank DESC, h.created_at DESC, h.id DESC`,
    params,
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];

  return {
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            rank: last.rank,
            createdAt: last.created_at.toISOString(),
            id: last.id,
          })
        : null,
    results: rows.map((row) => ({
      messageId: row.id,
      channelId: row.channel_id,
      channelName: row.channel_name,
      authorId: row.author_id,
      authorName: row.author_name,
      authorTag: formatUserTag(row.author_username, row.author_discriminator),
      authorAvatarUrl: row.author_avatar_url,
      snippet: row.snippet,
      createdAt: row.created_at.toISOString(),
    })),
  };
}
