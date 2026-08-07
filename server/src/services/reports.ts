import {
  formatUserTag,
  type Report,
  type ReportContextKind,
  type ReportReason,
  type ReportResolution,
  type ReportStatus,
  type ReportSummary,
} from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getPool } from "../db.js";
import { canAccessChannel } from "./users.js";

/**
 * Reporting — the escalation path for a member who cannot fix the problem
 * themselves.
 *
 * Three rules hold this file together, and every function here exists to keep
 * one of them true:
 *
 * 1. YOU CANNOT REPORT WHAT YOU CANNOT SEE. Every message report goes through
 *    `canAccessChannel`, the one channel-visibility predicate — never a
 *    hand-rolled copy. Without that, POST /api/reports answers "not found" for
 *    a message id that does not exist and "thanks" for one that does, which is
 *    a working oracle for enumerating private channels and DMs by id.
 *
 * 2. WHERE A REPORT GOES IS DECIDED HERE, ONCE, FROM THE REPORTED THING. The
 *    client never names the destination. A report about a server channel gets
 *    that channel's `server_id`; a report about a conversation gets NULL, and
 *    the table's CHECK constraint makes those two states mutually exclusive at
 *    the storage layer rather than in whichever query runs next.
 *
 * 3. A CONVERSATION HAS NO MODERATOR. `channelVisibleSql` deliberately gives
 *    the conversation branch no role escape hatch — a server's owner is not
 *    responsible for, and must never be able to read, their members' direct
 *    messages. A report is a *copy* of that content, so routing DM reports into
 *    a server queue would hand server admins exactly the thing the predicate
 *    spends its whole comment refusing to. They go to the instance queue
 *    instead (see `isInstanceModerator`), which is gated on operator
 *    configuration and not on any server role.
 */

/**
 * How many reports one account may file per hour.
 *
 * This is the durable half of a two-layer limit. The route also spends a
 * token-bucket budget (`reportLimiter` in api/index.ts) the way every other
 * write does, but that bucket is per-process — N replicas grant N buckets, as
 * `lib/rate-limit.ts` says up front. A report queue is one of the few places
 * where that is not good enough: flooding it is not a load problem, it is a
 * denial-of-moderation attack whose whole point is to bury the real report.
 * So the ceiling that matters is counted in the database, where it is exact
 * however many instances are running.
 */
export const REPORTS_PER_HOUR = 10;

/** Reason strings are validated by `reportReasonSchema` before they get here. */
interface CreateReportInput {
  reporterId: string;
  reason: ReportReason;
  details?: string | null;
}

export interface CreateMessageReportInput extends CreateReportInput {
  subjectType: "message";
  messageId: string;
}

export interface CreateUserReportInput extends CreateReportInput {
  subjectType: "user";
  userId: string;
  /** Optional context. Validated against the reporter's own membership. */
  serverId?: string | null;
}

export type CreateReportInputs =
  | CreateMessageReportInput
  | CreateUserReportInput;

/**
 * The reporter cannot see the thing they are reporting, or there is nothing
 * there at all. Deliberately one error for both: the route answers 404, so a
 * message in a channel you were never in is indistinguishable from a message id
 * nobody has ever held.
 */
export class ReportTargetNotVisibleError extends Error {
  constructor() {
    super("Not found");
    this.name = "ReportTargetNotVisibleError";
  }
}

export class ReportFloodError extends Error {
  constructor(readonly limit: number) {
    super("Too many reports filed recently");
    this.name = "ReportFloodError";
  }
}

interface ReportRow {
  id: string;
  subject_type: "message" | "user";
  context_kind: ReportContextKind;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  created_at: Date;
  reporter_id: string | null;
  reporter_name: string | null;
  reported_user_id: string | null;
  subject_label: string | null;
  reported_message_id: string | null;
  content_snapshot: string | null;
  channel_id: string | null;
  channel_label: string | null;
  resolved_at: Date | null;
  resolver_name: string | null;
  resolution_note: string | null;
}

/** Every read of this table selects the same columns, so they cannot drift. */
const REPORT_COLUMNS = `
  r.id::text AS id, r.subject_type, r.context_kind, r.reason, r.details,
  r.status, r.created_at, r.reporter_id, reporter.display_name AS reporter_name,
  r.reported_user_id, r.subject_label, r.reported_message_id::text AS reported_message_id,
  r.content_snapshot, r.channel_id::text AS channel_id, r.channel_label,
  r.resolved_at, resolver.display_name AS resolver_name, r.resolution_note`;

const REPORT_JOINS = `
  LEFT JOIN users reporter ON reporter.id = r.reporter_id
  LEFT JOIN users resolver ON resolver.id = r.resolved_by`;

function toReport(row: ReportRow): Report {
  return {
    id: row.id,
    subjectType: row.subject_type,
    contextKind: row.context_kind,
    reason: row.reason,
    details: row.details,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    reporterId: row.reporter_id,
    reporterName: row.reporter_name,
    reportedUserId: row.reported_user_id,
    reportedUserName: row.subject_label,
    messageId: row.reported_message_id,
    // The evidence outlived the message: this is the state the schema's
    // ON DELETE SET NULL exists to produce, and the queue renders it as
    // "the reported message has since been deleted".
    messageDeleted:
      row.subject_type === "message" && row.reported_message_id === null,
    contentSnapshot: row.content_snapshot,
    channelId: row.channel_id,
    channelName: row.channel_label,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedByName: row.resolver_name,
    resolutionNote: row.resolution_note,
  };
}

/**
 * The reporter's own view. Narrower on purpose — see `reportSummarySchema`:
 * knowing a report was closed is the point, knowing who closed it is not.
 */
function toReportSummary(row: ReportRow): ReportSummary {
  return {
    id: row.id,
    subjectType: row.subject_type,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    reportedUserName: row.subject_label,
  };
}

/** Display name plus tag, so a queue entry still identifies a renamed account. */
function labelFor(row: {
  display_name: string;
  username: string | null;
  discriminator: string | null;
}): string {
  const tag = formatUserTag(row.username, row.discriminator);
  return tag ? `${row.display_name} ${tag}` : row.display_name;
}

/**
 * Refuse the write when this reporter has already filed `REPORTS_PER_HOUR` in
 * the last hour. Counts every report, resolved or not: the cap is on the act of
 * filing, and letting resolved rows drop out of the count would mean a
 * moderator working through a flood reopens the tap by clearing it.
 */
async function assertUnderFloodCap(reporterId: string): Promise<void> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM reports
     WHERE reporter_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [reporterId],
  );
  if (Number(result.rows[0]?.count ?? 0) >= REPORTS_PER_HOUR) {
    throw new ReportFloodError(REPORTS_PER_HOUR);
  }
}

interface ResolvedSubject {
  contextKind: ReportContextKind;
  serverId: string | null;
  channelId: string | null;
  channelLabel: string | null;
  messageId: string | null;
  contentSnapshot: string | null;
  reportedUserId: string;
  subjectLabel: string;
}

/**
 * Read the reported message and prove the reporter can see it.
 *
 * The access check is `canAccessChannel` and nothing else. The reported
 * *channel* determines routing: a server channel names its server, and a
 * conversation deliberately names none.
 */
async function resolveMessageSubject(
  messageId: string,
  reporterId: string,
): Promise<ResolvedSubject> {
  const result = await getPool().query<{
    body: string;
    author_id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    channel_id: string;
    channel_name: string;
    channel_kind: ReportContextKind;
    server_id: string | null;
  }>(
    `SELECT m.body, m.author_id, u.display_name, u.username, u.discriminator,
            c.id AS channel_id, c.name AS channel_name, c.kind AS channel_kind,
            c.server_id
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     JOIN users u ON u.id = m.author_id
     WHERE m.id = $1`,
    [messageId],
  );
  const row = result.rows[0];
  // No row and no access answer identically — see ReportTargetNotVisibleError.
  if (!row || !(await canAccessChannel(row.channel_id, reporterId))) {
    throw new ReportTargetNotVisibleError();
  }

  return {
    contextKind: row.channel_kind,
    // The CHECK constraint pairs these two; deriving both from the same row is
    // what keeps them agreeing.
    serverId: row.channel_kind === "server" ? row.server_id : null,
    channelId: row.channel_id,
    channelLabel: row.channel_name,
    messageId,
    // The evidence. Copied verbatim, and only ever this one message — never the
    // conversation around it.
    contentSnapshot: row.body,
    reportedUserId: row.author_id,
    subjectLabel: labelFor(row),
  };
}

/**
 * Prove the reporter has some relationship with the person they are reporting.
 *
 * Without this the endpoint answers differently for a uuid that belongs to an
 * account and one that does not, which is a membership oracle over every user
 * on the instance. A shared server or a shared conversation is the only
 * relationship this product models, so it is also the whole rule here.
 */
async function sharesContextWith(
  viewerId: string,
  targetId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 WHERE EXISTS (
       SELECT 1 FROM server_members a
       JOIN server_members b ON b.server_id = a.server_id
       WHERE a.user_id = $1 AND b.user_id = $2
     ) OR EXISTS (
       SELECT 1 FROM channel_members a
       JOIN channel_members b ON b.channel_id = a.channel_id
       WHERE a.user_id = $1 AND b.user_id = $2
     )`,
    [viewerId, targetId],
  );
  return result.rows.length > 0;
}

/**
 * A report about a person rather than a post.
 *
 * With a `serverId` it is filed to that server's moderators — which requires
 * both parties to actually be there, or the form becomes a way to drop a note
 * about a stranger into a server they have never been near. With no serverId it
 * carries no server and goes to the instance queue.
 */
async function resolveUserSubject(
  input: CreateUserReportInput,
): Promise<ResolvedSubject> {
  const target = await getPool().query<{
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
  }>(
    `SELECT id, display_name, username, discriminator FROM users
     WHERE id = $1 AND is_webhook = FALSE`,
    [input.userId],
  );
  const user = target.rows[0];
  if (!user || user.id === input.reporterId) {
    throw new ReportTargetNotVisibleError();
  }

  if (input.serverId) {
    const members = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM server_members
       WHERE server_id = $1 AND user_id = ANY($2::uuid[])`,
      [input.serverId, [input.reporterId, input.userId]],
    );
    if (members.rows.length !== 2) {
      throw new ReportTargetNotVisibleError();
    }
    return {
      contextKind: "server",
      serverId: input.serverId,
      channelId: null,
      channelLabel: null,
      messageId: null,
      // A user report carries no message body — not even when it was filed from
      // a conversation. Nothing anyone said is copied anywhere by this path.
      contentSnapshot: null,
      reportedUserId: user.id,
      subjectLabel: labelFor(user),
    };
  }

  if (!(await sharesContextWith(input.reporterId, input.userId))) {
    throw new ReportTargetNotVisibleError();
  }
  return {
    contextKind: "none",
    serverId: null,
    channelId: null,
    channelLabel: null,
    messageId: null,
    contentSnapshot: null,
    reportedUserId: user.id,
    subjectLabel: labelFor(user),
  };
}

export interface CreateReportResult {
  report: Report;
  /**
   * True when an identical open report already existed and this call changed
   * nothing. The route answers 200 rather than 201, the same way blocking
   * somebody you already blocked does.
   */
  duplicate: boolean;
}

/**
 * File a report.
 *
 * Duplicate suppression is the database's job, not a check-then-insert: two
 * taps on a slow button, or two tabs, would both pass a prior SELECT and both
 * insert. The partial unique indexes turn the second one into a 23505, which is
 * caught here and answered with the row that already exists.
 */
export async function createReport(
  input: CreateReportInputs,
): Promise<CreateReportResult> {
  await assertUnderFloodCap(input.reporterId);

  const subject =
    input.subjectType === "message"
      ? await resolveMessageSubject(input.messageId, input.reporterId)
      : await resolveUserSubject(input);

  const params = [
    input.reporterId,
    input.subjectType,
    subject.contextKind,
    subject.messageId,
    subject.reportedUserId,
    subject.serverId,
    subject.channelId,
    subject.contentSnapshot,
    subject.subjectLabel,
    subject.channelLabel,
    input.reason,
    input.details?.trim() || null,
  ];

  try {
    const inserted = await getPool().query<{ id: string }>(
      `INSERT INTO reports (
         reporter_id, subject_type, context_kind, reported_message_id,
         reported_user_id, server_id, channel_id, content_snapshot,
         subject_label, channel_label, reason, details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id::text AS id`,
      params,
    );
    const report = await getReport(inserted.rows[0]!.id);
    if (!report) {
      throw new Error("Report vanished after being filed");
    }
    return { report, duplicate: false };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    ) {
      const existing = await findOpenDuplicate(input, subject);
      if (existing) {
        return { report: existing, duplicate: true };
      }
    }
    throw error;
  }
}

/**
 * The row the unique index refused to duplicate. Mirrors the index predicates
 * exactly — if these two ever disagree the caller sees a 500 instead of a
 * duplicate, which is why they sit next to each other.
 */
async function findOpenDuplicate(
  input: CreateReportInputs,
  subject: ResolvedSubject,
): Promise<Report | null> {
  const result = await getPool().query<ReportRow>(
    input.subjectType === "message"
      ? `SELECT ${REPORT_COLUMNS} FROM reports r ${REPORT_JOINS}
         WHERE r.status = 'open' AND r.reporter_id = $1
           AND r.reported_message_id = $2`
      : `SELECT ${REPORT_COLUMNS} FROM reports r ${REPORT_JOINS}
         WHERE r.status = 'open' AND r.subject_type = 'user'
           AND r.reporter_id = $1 AND r.reported_user_id = $2
           AND COALESCE(r.server_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    input.subjectType === "message"
      ? [input.reporterId, subject.messageId]
      : [input.reporterId, subject.reportedUserId, subject.serverId],
  );
  const row = result.rows[0];
  return row ? toReport(row) : null;
}

export async function getReport(id: string): Promise<Report | null> {
  const result = await getPool().query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM reports r ${REPORT_JOINS} WHERE r.id = $1::bigint`,
    [id],
  );
  const row = result.rows[0];
  return row ? toReport(row) : null;
}

export interface ListReportsOptions {
  /** Opaque cursor: the `id` of the oldest report already loaded. */
  before?: string;
  limit: number;
  status?: ReportStatus;
}

/** Shared tail of every list query: cursor, status filter, keyset order. */
function listConditions(
  options: ListReportsOptions,
  conditions: string[],
  params: unknown[],
): string {
  if (options.before) {
    params.push(options.before);
    conditions.push(`r.id < $${params.length}::bigint`);
  }
  if (options.status) {
    params.push(options.status);
    conditions.push(`r.status = $${params.length}`);
  }
  params.push(options.limit + 1);
  return `WHERE ${conditions.join(" AND ")}
          ORDER BY r.id DESC
          LIMIT $${params.length}`;
}

function page<T>(
  rows: ReportRow[],
  limit: number,
  map: (row: ReportRow) => T,
): { reports: T[]; hasMore: boolean } {
  return {
    reports: rows.slice(0, limit).map(map),
    hasMore: rows.length > limit,
  };
}

/**
 * One server's queue.
 *
 * `server_id = $1` is the entire scope, and it is safe as the entire scope only
 * because the table's CHECK constraint guarantees a conversation report can
 * never carry a server id at all. There is no second predicate to forget.
 */
export async function listServerReports(
  serverId: string,
  options: ListReportsOptions,
): Promise<{ reports: Report[]; hasMore: boolean }> {
  const params: unknown[] = [serverId];
  const tail = listConditions(options, ["r.server_id = $1"], params);
  const result = await getPool().query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM reports r ${REPORT_JOINS} ${tail}`,
    params,
  );
  return page(result.rows, options.limit, toReport);
}

/**
 * The instance queue: every report with no server behind it — conversations,
 * and user reports filed from no particular place.
 *
 * This is the other half of the DM rule. These rows are unreachable from
 * `listServerReports` by construction, and reachable here only by an account
 * the operator named in the environment.
 */
export async function listInstanceReports(
  options: ListReportsOptions,
): Promise<{ reports: Report[]; hasMore: boolean }> {
  const params: unknown[] = [];
  const tail = listConditions(options, ["r.server_id IS NULL"], params);
  const result = await getPool().query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM reports r ${REPORT_JOINS} ${tail}`,
    params,
  );
  return page(result.rows, options.limit, toReport);
}

/** What the reporter filed, in the narrow shape they are allowed to see. */
export async function listReportsByReporter(
  reporterId: string,
  options: ListReportsOptions,
): Promise<{ reports: ReportSummary[]; hasMore: boolean }> {
  const params: unknown[] = [reporterId];
  const tail = listConditions(options, ["r.reporter_id = $1"], params);
  const result = await getPool().query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM reports r ${REPORT_JOINS} ${tail}`,
    params,
  );
  return page(result.rows, options.limit, toReportSummary);
}

/**
 * Just enough of a report for the route to decide who may act on it, without
 * handing the caller anything before they have been authorized.
 *
 * Returned as `serverId | null` because that *is* the authorization question:
 * a server id means "a manager of that server", and null means "an instance
 * moderator". There is no third answer, and no role can turn one into the
 * other.
 */
export async function getReportScope(
  id: string,
): Promise<{ serverId: string | null; status: ReportStatus } | null> {
  const result = await getPool().query<{
    server_id: string | null;
    status: ReportStatus;
  }>(`SELECT server_id, status FROM reports WHERE id = $1::bigint`, [id]);
  const row = result.rows[0];
  return row ? { serverId: row.server_id, status: row.status } : null;
}

/**
 * Close a report.
 *
 * `AND status = 'open'` is what makes this idempotent under two moderators
 * clicking at once: the second update matches nothing and the route answers
 * 409 rather than silently overwriting the first one's note and name. Nothing
 * reopens a report — a recurrence is a new report, which is also what makes
 * "this is the third time" visible in the queue.
 */
export async function resolveReport(
  id: string,
  resolverId: string,
  status: ReportResolution,
  note?: string | null,
): Promise<Report | null> {
  const result = await getPool().query<{ id: string }>(
    `UPDATE reports
     SET status = $2, resolved_by = $3, resolved_at = NOW(), resolution_note = $4
     WHERE id = $1::bigint AND status = 'open'
     RETURNING id::text AS id`,
    [id, status, resolverId, note?.trim() || null],
  );
  const row = result.rows[0];
  return row ? getReport(row.id) : null;
}

/**
 * Whether this account may read and resolve the instance queue.
 *
 * DELIBERATELY NOT A SERVER ROLE, AND DELIBERATELY NOT A DATABASE FLAG ANY
 * IN-APP ACTION CAN GRANT. The instance queue holds reported direct-message
 * content, so the only acceptable way to enter it is a decision the operator of
 * the deployment makes outside the app — the same trust level as holding the
 * `DATABASE_URL`. Clerk ids rather than pqp user ids because a Clerk id is
 * knowable from the dashboard before the account has ever signed in here, while
 * a pqp uuid only exists after it has.
 *
 * With the variable unset there are no instance moderators at all, which is the
 * safe default and the one a self-hosted family instance wants: reports about
 * conversations are still *recorded* (they are evidence, and the reporter is
 * told they were received), they are simply not readable through the API by
 * anybody. `.env.example` is where an operator is told to set this.
 *
 * Read per call rather than at module load so a deployment can change it with a
 * restart and so tests can set it without import-order games.
 */
export function isInstanceModerator(user: Pick<DbUser, "clerk_id">): boolean {
  const configured = (process.env.INSTANCE_MODERATOR_CLERK_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured.includes(user.clerk_id);
}

/**
 * Drop resolved reports past their retention window.
 *
 * Reports hold copied user content — a reported message body that may since
 * have been deleted everywhere else — so unlike the audit log this is not only
 * about disk. A closed report has done its job; keeping the copy indefinitely
 * turns the moderation queue into a permanent archive of the worst things
 * anybody ever said, which is not a thing this product should own. Open reports
 * are never touched however old they are: an unread queue is a moderation
 * failure, not a retention event.
 */
export async function pruneResolvedReports(retentionDays = 90): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM reports
     WHERE status <> 'open'
       AND resolved_at < NOW() - ($1 || ' days')::interval`,
    [retentionDays],
  );
  return result.rowCount ?? 0;
}
