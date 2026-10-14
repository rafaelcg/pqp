import {
  formatUserTag,
  MISSED_CALL_BODY,
  type ReportContext,
  type ReportContextMessage,
  type ReportContextServerMessage,
  type ReportReason,
  type ReportStatus,
  type ReportSubjectType,
} from "@pqp/shared";
import { getPool } from "../db.js";
import {
  canActOnMember,
  getMemberHierarchy,
  memberHasPermission,
  Permission,
} from "./permissions.js";
import { canAccessChannel, channelVisibleSql } from "./users.js";

/**
 * The read behind a report card's "Contexto" panel.
 *
 * A report about an ACCOUNT carries no message and no details, so a moderator
 * looking at the queue row has nothing to judge: a six minute old account that
 * cold-called five strangers in twenty minutes looks identical to a grudge.
 * This gathers, for one report, what the instance already knows about the
 * reported account.
 *
 * TWO LENSES, CHOSEN BY THE CALLER FROM WHO IS ASKING (the route decides; this
 * file never looks at an environment variable):
 *
 *   * `instance`: an instance moderator. The whole instance.
 *   * `server`: a manager of the report's server. Everything is narrowed to
 *     that server. Cross-instance facts (how many people blocked the account,
 *     its DM behaviour, its last country, its other servers, its other
 *     reports) are null or empty rather than filtered, because a server's staff
 *     were never entitled to the unfiltered version.
 *
 * NOTHING HERE READS A CONVERSATION BETWEEN THE REPORTED USER AND A THIRD
 * PARTY. DM behaviour is counted and timestamped, never named and never
 * quoted. The one conversation that IS read is the one between the reporter
 * and the reported user, only for an instance moderator, only when a human
 * filed the report (the reporter is a party and chose to bring it here), and
 * only in a 1:1 thread. A group conversation has third parties in it, so the
 * surrounding messages of a group report are withheld.
 */

const SERVER_MESSAGE_LIMIT = 20;
/** How far back the server-message read looks. Bounds the index walk. */
const SERVER_MESSAGE_WINDOW_DAYS = 90;
const CONVERSATION_LIMIT = 20;
const SURROUNDING = 5;
const OTHER_REPORTS_LIMIT = 20;
const CONTACT_TIMES_LIMIT = 100;

export interface ContextViewer {
  id: string;
  /** `isInstanceModerator(user)`, decided by the route. */
  instance: boolean;
}

interface ReportRow {
  id: string;
  subject_type: ReportSubjectType;
  reporter_id: string | null;
  reported_user_id: string | null;
  server_id: string | null;
  channel_id: string | null;
  reported_message_id: string | null;
}

function iso(value: Date): string {
  return value.toISOString();
}

/** Same friendship test everywhere in this file: an ACCEPTED pair. */
const NOT_FRIENDS_SQL = (me: string, other: string) => `NOT EXISTS (
  SELECT 1 FROM friendships fr
  WHERE fr.low_user_id = LEAST(${me}::uuid, ${other}::uuid)
    AND fr.high_user_id = GREATEST(${me}::uuid, ${other}::uuid)
    AND fr.status = 'accepted'
)`;

async function loadAccount(userId: string, instance: boolean) {
  const result = await getPool().query<{
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    avatar_url: string | null;
    created_at: Date;
    deletion_started_at: Date | null;
    last_country: string | null;
  }>(
    `SELECT id, display_name, username, discriminator, avatar_url, created_at,
            deletion_started_at, last_country
     FROM users WHERE id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    createdAtDate: row.created_at,
    account: {
      id: row.id,
      displayName: row.display_name,
      tag: formatUserTag(row.username, row.discriminator),
      avatarUrl: row.avatar_url,
      createdAt: iso(row.created_at),
      deletionStartedAt: row.deletion_started_at
        ? iso(row.deletion_started_at)
        : null,
      lastCountry: instance ? row.last_country : null,
    },
  };
}

interface ContactRow {
  created_at: Date;
  total: string;
  first_hour: string;
}

/**
 * Totals come from window counts over the WHOLE match, computed before the
 * LIMIT, so only the returned timestamp samples are capped, never the totals.
 */
function contactCount(rows: ContactRow[]) {
  return {
    total: Number(rows[0]?.total ?? 0),
    firstHour: Number(rows[0]?.first_hour ?? 0),
    times: rows.map((row) => iso(row.created_at)),
  };
}

/**
 * Conversations the account BEGAN with somebody who is not an accepted friend:
 * the first message of a 1:1 thread is theirs. Both signals below are scoped
 * to these, so a call record in a thread somebody else started is not counted
 * as outreach.
 */
const STARTED_CONVERSATIONS_SQL = `started AS (
  SELECT dp.channel_id, f.created_at AS first_at
  FROM dm_pairs dp
  CROSS JOIN LATERAL (
    SELECT m.author_id, m.created_at FROM messages m
    WHERE m.channel_id = dp.channel_id
    ORDER BY m.created_at, m.id LIMIT 1
  ) f
  WHERE (dp.low_user_id = $1 OR dp.high_user_id = $1)
    AND f.author_id = $1
    AND ${NOT_FRIENDS_SQL(
      "$1",
      "CASE WHEN dp.low_user_id = $1 THEN dp.high_user_id ELSE dp.low_user_id END",
    )}
)`;

/** The end of the account's first hour, in SQL so no precision is lost. */
const FIRST_HOUR_END_SQL = `(SELECT created_at + interval '1 hour' FROM users WHERE id = $1)`;

/** Instance lens only. Counts and times, never a name and never a body. */
async function loadSignals(userId: string, reporterId: string | null) {
  const pool = getPool();
  const [contacts, blocks, reporterBlock] = await Promise.all([
    // ONE statement for both signals, so the started-conversation set (a
    // first-message lookup per DM pair) is built once. Missed-call records
    // are those the account left in the conversations it began; an answered
    // call leaves nothing. The read is bounded by the account's OWN started
    // conversations (each walked by the channel index), not by its history.
    pool.query<ContactRow & { kind: "dm" | "call" }>(
      // MATERIALIZED so the started set is built once and read twice. Each
      // kind keeps its own bounded top-N (ORDER BY ... LIMIT), with the
      // totals as window counts over the whole set, so nothing is ranked or
      // sorted beyond the 100 rows that are returned.
      `WITH ${STARTED_CONVERSATIONS_SQL.replace("started AS (", "started AS MATERIALIZED (")},
       dm AS (
         SELECT first_at AS at,
                COUNT(*) OVER () AS total,
                COUNT(*) FILTER (WHERE first_at <= ${FIRST_HOUR_END_SQL}) OVER () AS first_hour
         FROM started
         ORDER BY first_at DESC
         LIMIT ${CONTACT_TIMES_LIMIT}
       ),
       calls AS (
         SELECT m.created_at AS at,
                COUNT(*) OVER () AS total,
                COUNT(*) FILTER (WHERE m.created_at <= ${FIRST_HOUR_END_SQL}) OVER () AS first_hour
         FROM started s
         JOIN messages m ON m.channel_id = s.channel_id
          AND m.author_id = $1 AND m.body = $2
         ORDER BY m.created_at DESC
         LIMIT ${CONTACT_TIMES_LIMIT}
       )
       SELECT at AS created_at, 'dm'::text AS kind, total::text AS total,
              first_hour::text AS first_hour FROM dm
       UNION ALL
       SELECT at, 'call'::text, total::text, first_hour::text FROM calls
       ORDER BY created_at DESC`,
      [userId, MISSED_CALL_BODY],
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM user_blocks WHERE blocked_user_id = $1`,
      [userId],
    ),
    reporterId
      ? pool.query<{ created_at: Date }>(
          `SELECT created_at FROM user_blocks
           WHERE user_id = $1 AND blocked_user_id = $2`,
          [reporterId, userId],
        )
      : Promise.resolve({ rows: [] as { created_at: Date }[] }),
  ]);
  return {
    dmsStarted: contactCount(contacts.rows.filter((r) => r.kind === "dm")),
    callsPlaced: contactCount(contacts.rows.filter((r) => r.kind === "call")),
    blockedByCount: Number(blocks.rows[0]?.n ?? 0),
    reporterBlockedAt: reporterBlock.rows[0]
      ? iso(reporterBlock.rows[0].created_at)
      : null,
  };
}

async function loadOtherReports(
  reportId: string,
  userId: string,
  serverId: string | null,
) {
  const params: unknown[] = [userId, reportId, OTHER_REPORTS_LIMIT];
  let scope = "";
  if (serverId) {
    params.push(serverId);
    scope = `AND r.server_id = $4`;
  }
  const result = await getPool().query<{
    id: string;
    status: ReportStatus;
    reason: ReportReason;
    subject_type: ReportSubjectType;
    created_at: Date;
    server_name: string | null;
  }>(
    `SELECT r.id::text AS id, r.status, r.reason, r.subject_type, r.created_at,
            srv.name AS server_name
     FROM reports r
     LEFT JOIN servers srv ON srv.id = r.server_id
     WHERE r.reported_user_id = $1 AND r.id <> $2::bigint ${scope}
     ORDER BY r.id DESC
     LIMIT $3`,
    params,
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    reason: row.reason,
    subjectType: row.subject_type,
    createdAt: iso(row.created_at),
    serverName: row.server_name,
  }));
}

async function loadSanctions(userId: string, serverId: string | null) {
  const pool = getPool();
  const params: unknown[] = [userId];
  let scope = "";
  if (serverId) {
    params.push(serverId);
    scope = `AND x.server_id = $2`;
  }
  const [bans, timeouts] = await Promise.all([
    pool.query<{
      server_id: string;
      server_name: string;
      reason: string | null;
      created_at: Date;
    }>(
      `SELECT x.server_id, s.name AS server_name, x.reason, x.created_at
       FROM server_bans x JOIN servers s ON s.id = x.server_id
       WHERE x.user_id = $1 ${scope}
       ORDER BY x.created_at DESC LIMIT 20`,
      params,
    ),
    pool.query<{
      server_id: string;
      server_name: string;
      reason: string | null;
      expires_at: Date;
      created_at: Date;
    }>(
      `SELECT x.server_id, s.name AS server_name, x.reason, x.expires_at,
              x.created_at
       FROM member_timeouts x JOIN servers s ON s.id = x.server_id
       WHERE x.user_id = $1 AND x.expires_at > NOW() ${scope}
       ORDER BY x.created_at DESC LIMIT 20`,
      params,
    ),
  ]);
  return {
    bans: bans.rows.map((r) => ({
      serverId: r.server_id,
      serverName: r.server_name,
      reason: r.reason,
      createdAt: iso(r.created_at),
    })),
    timeouts: timeouts.rows.map((r) => ({
      serverId: r.server_id,
      serverName: r.server_name,
      reason: r.reason,
      expiresAt: iso(r.expires_at),
      createdAt: iso(r.created_at),
    })),
  };
}

interface MessageRow {
  id: string;
  author_id: string;
  author_name: string;
  author_username: string | null;
  author_discriminator: string | null;
  body: string;
  created_at: Date;
}

function toContextMessage(
  row: MessageRow,
  reporterId: string | null,
  reportedId: string | null,
): ReportContextMessage {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    authorTag: formatUserTag(row.author_username, row.author_discriminator),
    party:
      row.author_id === reportedId
        ? "reported"
        : row.author_id === reporterId
          ? "reporter"
          : "other",
    body: row.body,
    createdAt: iso(row.created_at),
    isCall: row.body === MISSED_CALL_BODY,
  };
}

/**
 * The one 1:1 thread between reporter and reported: the last messages, oldest
 * first, and whole-thread counts of TYPED messages per side. The counts are
 * what says "11 from the reporter, none back" when only 20 rows are shown.
 */
async function loadConversation(
  reporterId: string,
  reportedId: string,
): Promise<{
  messages: ReportContextMessage[];
  counts: { fromReporter: number; fromReported: number };
} | null> {
  const [low, high] =
    reporterId < reportedId ? [reporterId, reportedId] : [reportedId, reporterId];
  const pool = getPool();
  const [result, counts] = await Promise.all([
    pool.query<MessageRow>(
      `SELECT m.id, m.author_id, u.display_name AS author_name,
              u.username AS author_username,
              u.discriminator AS author_discriminator, m.body, m.created_at
       FROM dm_pairs dp
       JOIN messages m ON m.channel_id = dp.channel_id
       JOIN users u ON u.id = m.author_id
       WHERE dp.low_user_id = $1 AND dp.high_user_id = $2
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $3`,
      [low, high, CONVERSATION_LIMIT],
    ),
    pool.query<{ from_reporter: string; from_reported: string }>(
      `SELECT COUNT(*) FILTER (WHERE m.author_id = $3 AND m.body <> $5)::text AS from_reporter,
              COUNT(*) FILTER (WHERE m.author_id = $4 AND m.body <> $5)::text AS from_reported
       FROM dm_pairs dp
       JOIN messages m ON m.channel_id = dp.channel_id
       WHERE dp.low_user_id = $1 AND dp.high_user_id = $2`,
      [low, high, reporterId, reportedId, MISSED_CALL_BODY],
    ),
  ]);
  if (result.rows.length === 0) {
    return null;
  }
  return {
    messages: result.rows
      .reverse()
      .map((row) => toContextMessage(row, reporterId, reportedId)),
    counts: {
      fromReporter: Number(counts.rows[0]?.from_reporter ?? 0),
      fromReported: Number(counts.rows[0]?.from_reported ?? 0),
    },
  };
}

/** The reporter, for spotting a serial one. Instance lens only. */
async function loadReporter(
  reporterId: string,
): Promise<ReportContext["reporter"]> {
  const result = await getPool().query<{
    display_name: string;
    username: string | null;
    discriminator: string | null;
    created_at: Date;
    filed: string;
    actioned: string;
    dismissed: string;
  }>(
    `SELECT u.display_name, u.username, u.discriminator, u.created_at,
            COUNT(r.id)::text AS filed,
            COUNT(r.id) FILTER (WHERE r.status = 'actioned')::text AS actioned,
            COUNT(r.id) FILTER (WHERE r.status = 'dismissed')::text AS dismissed
     FROM users u
     LEFT JOIN reports r ON r.reporter_id = u.id
     WHERE u.id = $1
     GROUP BY u.id`,
    [reporterId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    displayName: row.display_name,
    tag: formatUserTag(row.username, row.discriminator),
    createdAt: iso(row.created_at),
    filed: Number(row.filed),
    actioned: Number(row.actioned),
    dismissed: Number(row.dismissed),
  };
}

/**
 * Where a reported message lives, whatever queue the report went to: a
 * `minor_sexual` report is filed to the instance queue by design (no server on
 * the row), but the message still belongs to a server and its staff can still
 * be acted on.
 */
async function loadMessageServer(
  report: ReportRow,
  viewer: ContextViewer,
): Promise<ReportContext["messageServer"]> {
  if (report.subject_type !== "message" || !report.reported_message_id) {
    return null;
  }
  const result = await getPool().query<{
    server_id: string;
    server_name: string;
    channel_name: string;
  }>(
    `SELECT s.id AS server_id, s.name AS server_name, c.name AS channel_name
     FROM messages m
     JOIN channels c ON c.id = m.channel_id AND c.kind = 'server'
     JOIN servers s ON s.id = c.server_id
     WHERE m.id = $1`,
    [report.reported_message_id],
  );
  const row = result.rows[0];
  // A server's staff only ever learn about their own server.
  if (!row || (!viewer.instance && row.server_id !== report.server_id)) {
    return null;
  }
  return { id: row.server_id, name: row.server_name, channelName: row.channel_name };
}

async function loadServerMessages(
  userId: string,
  viewerId: string,
  serverId: string | null,
): Promise<ReportContextServerMessage[]> {
  // The server-channel filter and the server scope apply BEFORE the limit, so
  // DM or other-server activity can never crowd out what the lens is for. The
  // read is bounded by TIME instead of by a pre-filter sample: the
  // (author_id, created_at, id) index walks only the last
  // SERVER_MESSAGE_WINDOW_DAYS days of this one account's messages.
  //
  // The scoped (server lens) form reads the server through the SAME visibility
  // predicate as everybody else: a channel the viewer cannot see is not theirs
  // to read just because they hold a report permission. The instance lens
  // reads every server channel; `isPrivate` says which were private.
  const base = `SELECT m.id, m.body, m.created_at, c.name AS channel_name,
              c.is_private, s.id AS server_id, s.name AS server_name,
              (SELECT COUNT(*) FROM message_attachments a
               WHERE a.message_id = m.id)::int AS attachment_count
       FROM messages m
       JOIN channels c ON c.id = m.channel_id AND c.kind = 'server'
       JOIN servers s ON s.id = c.server_id`;
  const windowSql = `m.author_id = $1
         AND m.created_at > NOW() - make_interval(days => ${SERVER_MESSAGE_WINDOW_DAYS})`;
  const result = serverId
    ? await getPool().query<ServerMessageRow>(
        `${base}
         LEFT JOIN server_members sm
           ON sm.server_id = c.server_id AND sm.user_id = $3
         WHERE ${windowSql}
           AND c.server_id = $2 AND ${channelVisibleSql("$3")}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ${SERVER_MESSAGE_LIMIT}`,
        [userId, serverId, viewerId],
      )
    : await getPool().query<ServerMessageRow>(
        `${base}
         WHERE ${windowSql}
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ${SERVER_MESSAGE_LIMIT}`,
        [userId],
      );
  return result.rows.map((row) => ({
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    channelName: row.channel_name,
    isPrivate: row.is_private,
    body: row.body,
    attachmentCount: row.attachment_count,
    createdAt: iso(row.created_at),
  }));
}

interface ServerMessageRow {
  id: string;
  body: string;
  created_at: Date;
  channel_name: string;
  is_private: boolean;
  server_id: string;
  server_name: string;
  attachment_count: number;
}

async function loadOwnedServers(userId: string, serverId: string | null) {
  const params: unknown[] = [userId];
  let scope = "";
  if (serverId) {
    params.push(serverId);
    scope = `AND s.id = $2`;
  }
  const result = await getPool().query<{
    id: string;
    name: string;
    created_at: Date;
    member_count: number;
  }>(
    `SELECT s.id, s.name, s.created_at,
            (SELECT COUNT(*) FROM server_members sm
             WHERE sm.server_id = s.id)::int AS member_count
     FROM servers s
     WHERE s.owner_id = $1 ${scope}
     ORDER BY s.created_at DESC LIMIT 20`,
    params,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    memberCount: row.member_count,
    createdAt: iso(row.created_at),
  }));
}

/** Five before and five after the reported message, in its own channel. */
async function loadSurrounding(
  report: ReportRow,
  viewer: ContextViewer,
): Promise<ReportContext["surrounding"]> {
  if (report.subject_type !== "message" || !report.reported_message_id) {
    return null;
  }
  const pool = getPool();
  // The neighbours below are found by comparing to the anchor INSIDE SQL: a JS
  // Date carries milliseconds and a timestamptz carries microseconds, so a
  // round trip through `Date` would let the anchor itself match `>`.
  const anchor = await pool.query<
    MessageRow & {
      channel_id: string;
      kind: "server" | "dm" | "group";
      server_id: string | null;
    }
  >(
    `SELECT m.id, m.channel_id, c.kind, c.server_id, m.author_id, m.body,
            m.created_at, u.display_name AS author_name,
            u.username AS author_username,
            u.discriminator AS author_discriminator
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     JOIN users u ON u.id = m.author_id
     WHERE m.id = $1`,
    [report.reported_message_id],
  );
  const row = anchor.rows[0];
  if (!row) {
    return null;
  }
  if (row.kind === "group") {
    return { reported: null, before: [], after: [], withheld: "group" };
  }
  if (row.kind === "dm") {
    // A 1:1 thread: the reporter is one of its two people, and only an
    // instance moderator can hold a report about one (no server queue can).
    if (!viewer.instance || !report.reporter_id) {
      return { reported: null, before: [], after: [], withheld: "no_access" };
    }
  } else {
    // A server channel must belong to the report's own server, and a server's
    // staff must be able to see that channel themselves.
    if (!viewer.instance) {
      if (
        row.server_id !== report.server_id ||
        !(await canAccessChannel(row.channel_id, viewer.id))
      ) {
        return { reported: null, before: [], after: [], withheld: "no_access" };
      }
    }
  }
  const select = `SELECT m.id, m.author_id, u.display_name AS author_name,
                         u.username AS author_username,
                         u.discriminator AS author_discriminator,
                         m.body, m.created_at
                  FROM messages m JOIN users u ON u.id = m.author_id`;
  const [before, after] = await Promise.all([
    pool.query<MessageRow>(
      `${select}
       WHERE m.channel_id = $1
         AND (m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $2)
       ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
      [row.channel_id, row.id, SURROUNDING],
    ),
    pool.query<MessageRow>(
      `${select}
       WHERE m.channel_id = $1
         AND (m.created_at, m.id) > (SELECT created_at, id FROM messages WHERE id = $2)
       ORDER BY m.created_at ASC, m.id ASC LIMIT $3`,
      [row.channel_id, row.id, SURROUNDING],
    ),
  ]);
  const map = (r: MessageRow) =>
    toContextMessage(r, report.reporter_id, report.reported_user_id);
  return {
    reported: map(row),
    before: before.rows.reverse().map(map),
    after: after.rows.map(map),
    withheld: null,
  };
}

/** What the viewer may do from the card, by the same rules the routes apply. */
async function loadActions(
  report: ReportRow,
  viewer: ContextViewer,
  accountExists: boolean,
  /** The row's own server, or the one the reported message lives in. */
  serverId: string | null,
): Promise<ReportContext["actions"]> {
  const targetId = report.reported_user_id;
  const notSelf = Boolean(targetId) && targetId !== viewer.id;
  const canTerminate = viewer.instance && accountExists && notSelf;
  if (!serverId || !targetId || !notSelf || !accountExists) {
    return { canTerminate, server: null };
  }
  const [server, canBanBit, canTimeoutBit, banned, targetHier, viewerHier] =
    await Promise.all([
      getPool().query<{ name: string }>(
        `SELECT name FROM servers WHERE id = $1`,
        [serverId],
      ),
      memberHasPermission(serverId, viewer.id, Permission.BAN_MEMBERS),
      memberHasPermission(serverId, viewer.id, Permission.MODERATE_MEMBERS),
      getPool().query(
        `SELECT 1 FROM server_bans WHERE server_id = $1 AND user_id = $2`,
        [serverId, targetId],
      ),
      getMemberHierarchy(serverId, targetId),
      getMemberHierarchy(serverId, viewer.id),
    ]);
  const name = server.rows[0]?.name;
  if (!name) {
    return { canTerminate, server: null };
  }
  // Same rank rule as the ban and timeout routes: nobody acts on the owner,
  // and an admin cannot act on a peer.
  const outranks =
    viewerHier !== null &&
    (targetHier === null || canActOnMember(viewerHier, targetHier));
  const targetIsOwner = targetHier?.isOwner ?? false;
  return {
    canTerminate,
    server: {
      id: serverId,
      name,
      canBan: canBanBit && outranks && !targetIsOwner,
      // A timeout silences somebody INSIDE a server: a non-member has nobody
      // to silence.
      canTimeout:
        canTimeoutBit && outranks && !targetIsOwner && targetHier !== null,
      alreadyBanned: banned.rows.length > 0,
    },
  };
}

/**
 * Null when there is no such report. The ROUTE has already refused anyone who
 * may not see it; this trusts `viewer.instance` and the report's server scope
 * and does not re-derive them.
 */
export async function getReportContext(
  reportId: string,
  viewer: ContextViewer,
): Promise<ReportContext | null> {
  const found = await getPool().query<ReportRow>(
    `SELECT id::text AS id, subject_type, reporter_id, reported_user_id,
            server_id, channel_id::text AS channel_id,
            reported_message_id::text AS reported_message_id
     FROM reports WHERE id = $1::bigint`,
    [reportId],
  );
  const report = found.rows[0];
  if (!report) {
    return null;
  }

  const lens = viewer.instance ? "instance" : "server";
  // The server lens is scoped to the report's server. (The route guarantees a
  // non-instance viewer only gets here for a server-scoped report.)
  const scopeServer = viewer.instance ? null : report.server_id;
  const userId = report.reported_user_id;

  const loaded = userId ? await loadAccount(userId, viewer.instance) : null;

  if (!userId || !loaded) {
    return {
      reportId: report.id,
      lens,
      account: null,
      signals: null,
      otherReports: [],
      sanctions: { bans: [], timeouts: [] },
      conversation: null,
      conversationCounts: null,
      reporter: null,
      messageServer: await loadMessageServer(report, viewer),
      serverMessages: [],
      ownedServers: [],
      surrounding: await loadSurrounding(report, viewer),
      actions: { canTerminate: false, server: null },
    };
  }

  const [
    signals,
    otherReports,
    sanctions,
    conversation,
    serverMessages,
    ownedServers,
    surrounding,
    messageServer,
    reporter,
  ] = await Promise.all([
    viewer.instance
      ? loadSignals(userId, report.reporter_id)
      : Promise.resolve(null),
    loadOtherReports(report.id, userId, scopeServer),
    loadSanctions(userId, scopeServer),
    viewer.instance && report.reporter_id
      ? loadConversation(report.reporter_id, userId)
      : Promise.resolve(null),
    loadServerMessages(userId, viewer.id, scopeServer),
    loadOwnedServers(userId, scopeServer),
    loadSurrounding(report, viewer),
    loadMessageServer(report, viewer),
    viewer.instance && report.reporter_id
      ? loadReporter(report.reporter_id)
      : Promise.resolve(null),
  ]);
  const actions = await loadActions(
    report,
    viewer,
    true,
    report.server_id ?? messageServer?.id ?? null,
  );

  return {
    reportId: report.id,
    lens,
    account: loaded.account,
    signals,
    otherReports,
    sanctions,
    conversation: conversation?.messages ?? null,
    conversationCounts: conversation?.counts ?? null,
    reporter,
    messageServer,
    serverMessages,
    ownedServers,
    surrounding,
    actions,
  };
}
