/**
 * The two LGPD art. 18 rights a data subject exercises on their *own* account:
 * access/portability (art. 18, II and V) and erasure (art. 18, IV and VI).
 *
 * Not to be confused with `services/export.ts`, which is the server-owner tool:
 * that one is scoped to a *server* and hands its owner every member's messages.
 * This one is scoped to a *person* and is the only export a user can run about
 * themselves. The two must never be collapsed into one — a data-subject export
 * that contained other people's content would be a disclosure, not a right.
 */

import { formatUserTag, type UserPreferences } from "@pqp/shared";
import { getPool } from "../db.js";
import type { PublicUser } from "@pqp/shared";
import { deleteClerkUser, forgetAuthUser } from "../auth/clerk.js";
import { listBlocks } from "./blocks.js";
import { exportAttachments, type ExportAttachment } from "./export.js";
import { getPreferences } from "./preferences.js";
import { toPublicUserSummary } from "./users.js";

/** Same ceiling and batch size as the server export, and for the same reason:
 * one HTTP response must not hold an unbounded number of rows in memory. */
const MAX_EXPORT_MESSAGES = 50_000;
const EXPORT_BATCH_SIZE = 1000;

/** Audit entries are pruned at 90 days, so this cap is a backstop against a
 * pathologically busy moderator rather than a real limit. */
const MAX_EXPORT_AUDIT_ENTRIES = 10_000;
const MAX_EXPORT_REPORTS = 5_000;

// ---------------------------------------------------------------------------
// Part 1 — personal data export
// ---------------------------------------------------------------------------

/**
 * WHY THE OTHER SIDE OF A DM IS NOT IN THIS FILE.
 *
 * A conversation has two authors, and exporting it would hand one of them a
 * durable, forwardable copy of the other's words. That is the single hardest
 * call in this feature, so the reasoning is written down rather than assumed:
 *
 * 1. **What art. 18 actually grants.** Art. 18, II gives access to "dados a seu
 *    respeito" — data *concerning the subject*. A message somebody else wrote
 *    is that person's own expression, attributable to them, and is about the
 *    requester only incidentally. Art. 18, V (portability) is narrower still,
 *    and both are bounded by the same limit GDPR art. 20(4) states outright and
 *    the LGPD carries through art. 18 §7 and the art. 7, IX balancing test:
 *    exercising your right must not trample the rights of others.
 *
 * 2. **What withholding it costs the requester.** Almost nothing. They can
 *    already read every one of those messages in the app right now — they were
 *    a lawful recipient of all of them. Nothing is being hidden from them; only
 *    the *packaging* of somebody else's words into a file changes.
 *
 * 3. **What including it would cost the other person.** Everything the block
 *    feature exists to prevent. A DM is the one channel in this product nobody
 *    moderates (see docs/TRUST_AND_SAFETY.md §3.3), and an export turns a
 *    scrollback that lives behind someone's login into an artefact that can be
 *    published, pasted, or handed to a third party in one action. Somebody
 *    building a case against an ex-partner would be the first user of it.
 *
 * 4. **The least-bad answer, and it is a trade, not a clean win.** Export the
 *    requester's own messages in full, plus the *metadata* of every
 *    conversation they were part of — who was in it, when they joined, how many
 *    of the messages were theirs, when it last saw traffic. That is
 *    unambiguously their data: participation in a conversation is a fact about
 *    them. What it does not give them is a readable transcript, because half a
 *    transcript is what they are entitled to and half a transcript is what they
 *    get.
 *
 * 5. **Say so in the file.** `notes` below states the exclusion in plain
 *    language inside the export itself. Art. 18 §1 requires the response to be
 *    clear about its own scope, and a silent omission would read as a bug. A
 *    subject who genuinely needs the other side — a court case, a harassment
 *    complaint — has a documented route to ask the encarregado, where a human
 *    can do the balancing test this code cannot.
 */
const EXPORT_NOTES = [
  "This file contains the personal data pqp.gg holds about you, the account named under `account`.",
  "Messages you wrote are included in full, wherever you wrote them.",
  "Messages written by OTHER people are not included, including in your direct messages and group conversations. Those are their personal data, not yours, and exporting them would hand you a copy of somebody else's words. You can still read them in the app. `conversations` lists every conversation you took part in, who was in it, and how much of it was yours.",
  "For the same reason, a report you filed lists what you said and who you reported, but not a copy of the content you reported.",
  "Records that must survive your account being deleted — audit entries, bans, and reports filed about you — are described in the privacy policy and in docs/TRUST_AND_SAFETY.md.",
  "Connected Steam, Battle.net and Twitch accounts are listed under `connections` with the provider id stored for each. Disconnecting one in settings deletes that row; this file is a snapshot of what was linked when you exported.",
  "If you need something this file does not contain, contact the encarregado (DPO) named in the privacy policy.",
];

export interface PersonalExportAccount {
  id: string;
  /** The account's identifier at Clerk, the identity provider. Only ever sent
   * to the account's own owner — the same rule `toPublicUser` carries. */
  clerkId: string;
  displayName: string;
  username: string | null;
  discriminator: string | null;
  tag: string | null;
  avatarUrl: string | null;
  dmPrivacy: string;
  /** Domains only, never addresses — see the `email_domains` schema comment. */
  verifiedEmailDomains: string[];
  createdAt: string;
  /**
   * The 18+ declaration, if one has been made. Included because art. 18, II is
   * about everything the controller holds, and a stored answer about the
   * subject's age is squarely that. `dateOfBirth` is only ever populated for a
   * declaration that failed — a passing one is reduced to the boolean on the
   * spot and the date is never written. See the `age_check_*` schema comment.
   */
  ageCheck: {
    checkedAt: string | null;
    passed: boolean | null;
    dateOfBirth: string | null;
  };
}

export interface PersonalExportServer {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

export interface PersonalExportConversation {
  channelId: string;
  kind: "dm" | "group";
  joinedAt: string;
  /** Everyone else who was in it. Names and handles only — never their messages. */
  otherParticipants: PublicUser[];
  yourMessageCount: number;
  lastMessageAt: string | null;
}

export interface PersonalExportMessage {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  replyToId: string | null;
  pinnedAt: string | null;
  channelId: string;
  channelName: string | null;
  channelKind: "server" | "dm" | "group";
  serverId: string | null;
  serverName: string | null;
  attachments: ExportAttachment[];
}

export interface PersonalExportReport {
  id: string;
  createdAt: string;
  subjectType: "message" | "user";
  contextKind: "server" | "dm" | "group" | "none";
  /** Who or what you reported, as it was labelled at the time. */
  subjectLabel: string | null;
  channelLabel: string | null;
  serverId: string | null;
  /** Your own words on the form. */
  reason: string;
  details: string | null;
  status: "open" | "actioned" | "dismissed";
  resolvedAt: string | null;
}

export interface PersonalExportAuditEntry {
  id: string;
  createdAt: string;
  serverId: string;
  serverName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  changes: unknown;
}

export interface PersonalExportConnection {
  provider: string;
  providerUserId: string;
  displayName: string;
  profileUrl: string | null;
  visibility: string;
  connectedAt: string;
}

export interface PersonalDataExport {
  format: "pqp.personal-data-export.v1";
  exportedAt: string;
  notes: string[];
  account: PersonalExportAccount;
  preferences: UserPreferences;
  connections: PersonalExportConnection[];
  servers: PersonalExportServer[];
  conversations: PersonalExportConversation[];
  messages: PersonalExportMessage[];
  blockedUsers: Awaited<ReturnType<typeof listBlocks>>;
  reportsYouFiled: PersonalExportReport[];
  auditEntries: PersonalExportAuditEntry[];
  /** True when any section hit its cap — the file is a prefix, not the whole
   * account. Stated rather than silently truncated, same as `ServerExport`. */
  truncated: boolean;
}

interface AccountRow {
  id: string;
  clerk_id: string;
  display_name: string;
  username: string | null;
  discriminator: string | null;
  avatar_url: string | null;
  dm_privacy: string;
  email_domains: string[] | null;
  created_at: Date;
  age_checked_at: Date | null;
  age_check_passed: boolean | null;
  /** `DATE` — node-postgres hands it back as a `YYYY-MM-DD` string, which is
   * exactly what a date of birth is and what the export should carry. */
  age_check_dob: string | null;
}

async function exportAccount(userId: string): Promise<AccountRow | null> {
  const result = await getPool().query<AccountRow>(
    `SELECT id, clerk_id, display_name, username, discriminator, avatar_url,
            dm_privacy, email_domains, created_at,
            age_checked_at, age_check_passed, age_check_dob
     FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

async function exportConnections(
  userId: string,
): Promise<PersonalExportConnection[]> {
  const result = await getPool().query<{
    provider: string;
    provider_user_id: string;
    display_name: string;
    profile_url: string | null;
    visibility: string;
    connected_at: Date;
  }>(
    `SELECT provider, provider_user_id, display_name, profile_url, visibility,
            connected_at
       FROM user_connections
      WHERE user_id = $1
      ORDER BY connected_at ASC`,
    [userId],
  );
  return result.rows.map((row) => ({
    provider: row.provider,
    providerUserId: row.provider_user_id,
    displayName: row.display_name,
    profileUrl: row.profile_url,
    visibility: row.visibility,
    connectedAt: row.connected_at.toISOString(),
  }));
}

async function exportMemberships(
  userId: string,
): Promise<PersonalExportServer[]> {
  const result = await getPool().query<{
    id: string;
    name: string;
    role: "owner" | "admin" | "member";
    joined_at: Date;
  }>(
    `SELECT s.id, s.name, sm.role, sm.joined_at
     FROM server_members sm
     JOIN servers s ON s.id = sm.server_id
     WHERE sm.user_id = $1
     ORDER BY sm.joined_at ASC`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
  }));
}

/**
 * Conversation *participation*, never conversation *content* — see the long
 * comment on `EXPORT_NOTES`. `yourMessageCount` is the one number that lets the
 * subject check the `messages` section is complete for a given thread.
 */
async function exportConversations(
  userId: string,
): Promise<PersonalExportConversation[]> {
  const result = await getPool().query<{
    channel_id: string;
    kind: "dm" | "group";
    added_at: Date;
    own_message_count: string;
    last_message_at: Date | null;
  }>(
    `SELECT c.id AS channel_id, c.kind, cm.added_at,
            (SELECT COUNT(*) FROM messages m
              WHERE m.channel_id = c.id AND m.author_id = $1)::text
              AS own_message_count,
            (SELECT MAX(m.created_at) FROM messages m
              WHERE m.channel_id = c.id) AS last_message_at
     FROM channel_members cm
     JOIN channels c ON c.id = cm.channel_id AND c.kind <> 'server'
     WHERE cm.user_id = $1
     ORDER BY cm.added_at ASC`,
    [userId],
  );

  const channelIds = result.rows.map((row) => row.channel_id);
  const participants = await exportParticipants(channelIds, userId);

  return result.rows.map((row) => ({
    channelId: row.channel_id,
    kind: row.kind,
    joinedAt: row.added_at.toISOString(),
    otherParticipants: participants.get(row.channel_id) ?? [],
    yourMessageCount: Number(row.own_message_count),
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
  }));
}

/**
 * `publicUserSchema` and nothing wider, exactly as `listParticipants` in
 * dms.ts: these describe other people, and the fact that the file is going to
 * the requester does not make somebody else's `clerkId` theirs to receive.
 */
async function exportParticipants(
  channelIds: string[],
  viewerId: string,
): Promise<Map<string, PublicUser[]>> {
  const byChannel = new Map<string, PublicUser[]>();
  if (channelIds.length === 0) {
    return byChannel;
  }
  const result = await getPool().query<{
    channel_id: string;
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    avatar_url: string | null;
  }>(
    `SELECT cm.channel_id, u.id, u.display_name, u.username, u.discriminator,
            u.avatar_url
     FROM channel_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.channel_id = ANY($1::uuid[]) AND cm.user_id <> $2
     ORDER BY cm.added_at ASC`,
    [channelIds, viewerId],
  );
  for (const row of result.rows) {
    const list = byChannel.get(row.channel_id) ?? [];
    list.push(toPublicUserSummary(row));
    byChannel.set(row.channel_id, list);
  }
  return byChannel;
}

interface PersonalMessageRow {
  id: string;
  channel_id: string;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  reply_to_id: string | null;
  pinned_at: Date | null;
  channel_name: string;
  channel_kind: "server" | "dm" | "group";
  server_id: string | null;
  server_name: string | null;
}

/**
 * Every message this user wrote, anywhere, oldest first — keyset paginated on
 * `(created_at, id)` and capped, the same shape `exportMessages` in export.ts
 * uses. A `LIMIT/OFFSET` walk would re-scan from the top on every page, and
 * loading them all at once is the memory blow-up the cap exists to prevent.
 *
 * `idx_messages_author_created` is what makes this an index scan rather than a
 * sort of the whole table; see the schema comment that introduces it.
 */
async function exportOwnMessages(
  userId: string,
): Promise<{ messages: PersonalExportMessage[]; truncated: boolean }> {
  const rows: PersonalMessageRow[] = [];
  let cursor: { createdAt: Date; id: string } | null = null;

  while (rows.length < MAX_EXPORT_MESSAGES) {
    const remaining = MAX_EXPORT_MESSAGES - rows.length;
    const limit = Math.min(EXPORT_BATCH_SIZE, remaining);
    const params: unknown[] = [userId];
    let cursorClause = "";
    if (cursor) {
      params.push(cursor.createdAt, cursor.id);
      cursorClause = `AND (m.created_at, m.id) > ($2, $3)`;
    }
    params.push(limit);

    const result = await getPool().query<PersonalMessageRow>(
      `SELECT m.id, m.channel_id, m.body, m.created_at, m.edited_at,
              m.reply_to_id, m.pinned_at,
              c.name AS channel_name, c.kind AS channel_kind, c.server_id,
              s.name AS server_name
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN servers s ON s.id = c.server_id
       WHERE m.author_id = $1 ${cursorClause}
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT $${params.length}`,
      params,
    );
    rows.push(...result.rows);
    if (result.rows.length < limit) {
      break;
    }
    const last = result.rows[result.rows.length - 1]!;
    cursor = { createdAt: last.created_at, id: last.id };
  }

  const truncated = rows.length >= MAX_EXPORT_MESSAGES;
  const attachmentsByMessage = await exportAttachments(rows.map((r) => r.id));

  return {
    truncated,
    messages: rows.map((row) => ({
      id: row.id,
      body: row.body,
      createdAt: row.created_at.toISOString(),
      editedAt: row.edited_at?.toISOString() ?? null,
      replyToId: row.reply_to_id,
      pinnedAt: row.pinned_at?.toISOString() ?? null,
      channelId: row.channel_id,
      // A conversation's `name` is an internal placeholder rather than
      // something anybody typed, so it is only meaningful for a server channel.
      channelName: row.channel_kind === "server" ? row.channel_name : null,
      channelKind: row.channel_kind,
      serverId: row.server_id,
      serverName: row.server_name,
      attachments: attachmentsByMessage.get(row.id) ?? [],
    })),
  };
}

/**
 * Reports this user filed.
 *
 * `content_snapshot` is deliberately absent. It is a verbatim copy of somebody
 * else's message, kept as evidence — the same category of data as the other
 * half of a DM, and excluded for the same reason. `subject_label` stays,
 * because without it the entry says nothing at all and the requester
 * demonstrably already knows who they reported.
 */
async function exportReportsFiled(
  userId: string,
): Promise<{ reports: PersonalExportReport[]; truncated: boolean }> {
  const result = await getPool().query<{
    id: string;
    created_at: Date;
    subject_type: "message" | "user";
    context_kind: "server" | "dm" | "group" | "none";
    subject_label: string | null;
    channel_label: string | null;
    server_id: string | null;
    reason: string;
    details: string | null;
    status: "open" | "actioned" | "dismissed";
    resolved_at: Date | null;
  }>(
    `SELECT id::text, created_at, subject_type, context_kind, subject_label,
            channel_label, server_id, reason, details, status, resolved_at
     FROM reports
     WHERE reporter_id = $1
     ORDER BY id ASC
     LIMIT $2`,
    [userId, MAX_EXPORT_REPORTS + 1],
  );

  const truncated = result.rows.length > MAX_EXPORT_REPORTS;
  return {
    truncated,
    reports: result.rows.slice(0, MAX_EXPORT_REPORTS).map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      subjectType: row.subject_type,
      contextKind: row.context_kind,
      subjectLabel: row.subject_label,
      channelLabel: row.channel_label,
      serverId: row.server_id,
      reason: row.reason,
      details: row.details,
      status: row.status,
      resolvedAt: row.resolved_at?.toISOString() ?? null,
    })),
  };
}

/** Audit entries where this user was the actor — moderation actions they took,
 * which is their own conduct and squarely within art. 18, II. */
async function exportAuditEntries(
  userId: string,
): Promise<{ entries: PersonalExportAuditEntry[]; truncated: boolean }> {
  const result = await getPool().query<{
    id: string;
    created_at: Date;
    server_id: string;
    server_name: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    reason: string | null;
    changes: unknown;
  }>(
    `SELECT a.id::text, a.created_at, a.server_id, s.name AS server_name,
            a.action, a.target_type, a.target_id, a.reason, a.changes
     FROM audit_log a
     LEFT JOIN servers s ON s.id = a.server_id
     WHERE a.actor_id = $1
     ORDER BY a.id ASC
     LIMIT $2`,
    [userId, MAX_EXPORT_AUDIT_ENTRIES + 1],
  );

  const truncated = result.rows.length > MAX_EXPORT_AUDIT_ENTRIES;
  return {
    truncated,
    entries: result.rows.slice(0, MAX_EXPORT_AUDIT_ENTRIES).map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      serverId: row.server_id,
      serverName: row.server_name,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      reason: row.reason,
      changes: row.changes,
    })),
  };
}

export async function buildPersonalExport(
  userId: string,
): Promise<PersonalDataExport | null> {
  const account = await exportAccount(userId);
  if (!account) {
    return null;
  }

  const [
    preferences,
    servers,
    conversations,
    messages,
    blockedUsers,
    reports,
    audit,
    connections,
  ] = await Promise.all([
    getPreferences(userId),
    exportMemberships(userId),
    exportConversations(userId),
    exportOwnMessages(userId),
    listBlocks(userId),
    exportReportsFiled(userId),
    exportAuditEntries(userId),
    exportConnections(userId),
  ]);

  return {
    format: "pqp.personal-data-export.v1",
    exportedAt: new Date().toISOString(),
    notes: EXPORT_NOTES,
    account: {
      id: account.id,
      clerkId: account.clerk_id,
      displayName: account.display_name,
      username: account.username,
      discriminator: account.discriminator,
      tag: formatUserTag(account.username, account.discriminator),
      avatarUrl: account.avatar_url,
      dmPrivacy: account.dm_privacy,
      verifiedEmailDomains: account.email_domains ?? [],
      createdAt: account.created_at.toISOString(),
      ageCheck: {
        checkedAt: account.age_checked_at?.toISOString() ?? null,
        passed: account.age_check_passed,
        dateOfBirth: account.age_check_dob,
      },
    },
    preferences,
    connections,
    servers,
    conversations,
    messages: messages.messages,
    blockedUsers,
    reportsYouFiled: reports.reports,
    auditEntries: audit.entries,
    truncated: messages.truncated || reports.truncated || audit.truncated,
  };
}

// ---------------------------------------------------------------------------
// Part 2 — account deletion
// ---------------------------------------------------------------------------

export interface BlockingOwnedServer {
  id: string;
  name: string;
  /** Members other than the departing owner. Always at least 1 here. */
  otherMemberCount: number;
}

/**
 * Servers this user owns that somebody else is still in.
 *
 * WHY DELETION REFUSES RATHER THAN RESOLVING THIS ITSELF.
 *
 * `servers.owner_id` is `ON DELETE CASCADE`, so the naive `DELETE FROM users`
 * silently destroys every server the account owns — every channel, and every
 * message every *other* member ever wrote in it. That is the default, it is the
 * worst of the three options, and it is what this function exists to prevent.
 *
 * The three ways out, and why this one:
 *
 * - **Cascade the server.** Rejected. It destroys other people's data to serve
 *   one person's erasure right. Art. 18, IV entitles the subject to deletion of
 *   *their* data, not of a community; the messages of everyone else in that
 *   server are those people's personal data and their own art. 18 rights attach
 *   to them.
 *
 * - **Auto-transfer to the longest-tenured admin.** Rejected. Ownership is not
 *   a trophy, it is a set of obligations: moderating the place, holding its
 *   retention setting, holding its SSO domain, and being the person a legal
 *   notice about it reaches. Conferring that silently on somebody who is not
 *   present, has not agreed, and may not have opened the app in a year is a
 *   decision the platform has no standing to make for them. It also has no
 *   sensible answer when there is no admin at all.
 *
 * - **Refuse, and say exactly what to do.** Chosen. Both remedies already exist
 *   as first-class actions the user can take in the same session — transfer
 *   ownership (`PATCH /api/servers/:id` with `ownerId`) or delete the server
 *   (`DELETE /api/servers/:id`) — so this is a step, not a dead end. The API
 *   answers 409 with the servers named, and the client renders them as a list
 *   with the two choices, rather than a bare "cannot delete account".
 *
 * A server the user owns *alone* is not blocking: nobody else's data is in it,
 * and making someone delete an empty server before exercising a statutory right
 * would be friction for its own sake. Those cascade away with the account.
 *
 * The 15-day clock in art. 19 still runs. If a user refuses to do either thing
 * and complains, that is the encarregado's call to make by hand — noted in
 * docs/TRUST_AND_SAFETY.md §5 rather than papered over here.
 */
export async function listBlockingOwnedServers(
  userId: string,
): Promise<BlockingOwnedServer[]> {
  const result = await getPool().query<{
    id: string;
    name: string;
    other_member_count: string;
  }>(
    `SELECT s.id, s.name,
            (SELECT COUNT(*) FROM server_members sm
              WHERE sm.server_id = s.id AND sm.user_id <> $1)::text
              AS other_member_count
     FROM servers s
     WHERE s.owner_id = $1
       AND EXISTS (SELECT 1 FROM server_members sm
                    WHERE sm.server_id = s.id AND sm.user_id <> $1)
     ORDER BY s.created_at ASC`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    otherMemberCount: Number(row.other_member_count),
  }));
}

export class OwnedServersBlockDeletionError extends Error {
  constructor(readonly servers: BlockingOwnedServer[]) {
    super("Transfer or delete the servers you own before deleting your account");
    this.name = "OwnedServersBlockDeletionError";
  }
}

/** Thrown when Clerk refuses to delete the identity. Nothing local has been
 * touched at that point beyond the deletion stamp, which is rolled back. */
export class IdentityDeletionFailedError extends Error {
  constructor(readonly cause: unknown) {
    super("Could not delete the sign-in identity");
    this.name = "IdentityDeletionFailedError";
  }
}

export interface DeleteAccountResult {
  /** Storage keys of the objects this account's attachments named, for the
   * caller to sweep. Read before the DELETE, because the rows that name them
   * cascade away with it. */
  attachmentKeys: string[];
}

/**
 * Delete the account for real: the local rows, and the identity at Clerk.
 *
 * WHAT ACTUALLY GETS DELETED, and why the schema's existing cascades are right:
 *
 * - **Messages they wrote — deleted, bodies and all** (`messages.author_id` is
 *   `ON DELETE CASCADE`). The alternative, repointing `author_id` at a shared
 *   "Deleted User" tombstone the way `users.is_webhook` already does for
 *   webhooks, is expressible — and it is the wrong answer. Message bodies are
 *   free text: people put their address, their phone number, their health and
 *   their politics in them. Art. 5, III defines anonymised data as data that
 *   cannot be reverted to a subject "considerando a utilização de meios
 *   técnicos razoáveis", and a message saying "my flight lands at 6, I'm at Rua
 *   X 40" is still personal data with the name stripped off it — everyone in
 *   that channel who read it live knows exactly who wrote it. Calling that
 *   anonymisation would be self-deception, and shipping it while telling users
 *   we deleted their account would be worse. The honest cost is that other
 *   people's threads get holes in them; the schema already softens that, since
 *   `messages.reply_to_id` is `ON DELETE SET NULL`, so an answer outlives the
 *   question it answered.
 *
 * - **Reactions, mentions, read cursors, preferences, blocks, memberships,
 *   conversation participation, invites they created, attachments they
 *   uploaded** — all cascade. All are only about them.
 *
 * WHAT SURVIVES, each on an art. 16 basis rather than on convenience:
 *
 * - **Audit entries** (`audit_log.actor_id` → NULL). Art. 16, I and II:
 *   retention for compliance with a legal obligation and for the exercise of
 *   rights in judicial or administrative proceedings. Concretely, an audit row
 *   is the only record that a moderator deleted a message or banned a member in
 *   somebody else's community; if deleting your account erased it, every
 *   moderator who abused a server would have a one-click way to launder it.
 *   What is retained is the *act*, not the person — the actor id nulls, so the
 *   surviving row is already pseudonymised — and the whole log is pruned at 90
 *   days regardless.
 *
 * - **Bans they issued against other people** (rows survive, `banned_by` →
 *   NULL). Art. 16, II, and more simply: the row is a fact about the *banned*
 *   person and about the server, not about the departing owner. Cascading it
 *   would silently readmit everybody that user ever banned, harming the members
 *   of servers they moderated to serve nobody.
 *
 * - **Reports filed about them** (`reported_user_id` → NULL, the evidence
 *   snapshot survives). Art. 16, II. The schema comment on `reports` already
 *   argues the point: the report must outlive what it points at, or filing one
 *   is trivially defeated by the subject destroying the evidence — and account
 *   deletion would be exactly that lever. Reports they *filed* survive too
 *   (`reporter_id` → NULL): a report is a record of somebody else's conduct,
 *   and an open queue must not empty itself when a reporter leaves. Resolved
 *   reports, snapshot included, are pruned at 90 days.
 *
 * KNOWN GAP, stated rather than hidden: bans *against* this user cascade away
 * with them (`server_bans.user_id` is `ON DELETE CASCADE`), so deleting an
 * account is a ban-evasion route. Keeping the row would protect nothing — it is
 * keyed on `users.id`, and a re-registration gets a fresh uuid — and the only
 * durable defence, retaining a hash of the Clerk id after erasure, is a new
 * retention decision that needs counsel, not a code change. See
 * docs/TRUST_AND_SAFETY.md §6.
 *
 * ORDERING, and what happens when the second call fails:
 *
 *   1. Stamp `users.deletion_started_at`. Nothing is destroyed yet.
 *   2. Delete the Clerk user.
 *   3. Delete the local row.
 *
 * **Clerk first is the direction that fails safe.** If step 2 throws, step 1 is
 * rolled back and the account is untouched and consistent — the caller answers
 * 502 and the user retries. The reverse order has no such state: with the local
 * row already gone and Clerk still holding the identity, the user signs back in
 * and `upsertUser` mints them a *brand new empty account*, so the product
 * reports success while the identity it promised to delete is alive and nothing
 * anywhere records that it should not be.
 *
 * If step 3 fails (or the process dies between 2 and 3), the identity is gone —
 * the account can never sign in and can never be recreated by `upsertUser`,
 * because that only ever runs behind a verified Clerk token — and the local row
 * is left carrying its `deletion_started_at` stamp. That stamp is the whole
 * recovery mechanism: `sweepPendingAccountDeletions` below finds it on a timer
 * and finishes the job, re-running the Clerk delete first (a 404 there counts
 * as success, so a repeat is harmless) and then the local one. Every way this
 * sequence can be interrupted converges on the same end state without anybody
 * being paged.
 */
export async function deleteAccount(
  userId: string,
  clerkId: string,
): Promise<DeleteAccountResult> {
  const blocking = await listBlockingOwnedServers(userId);
  if (blocking.length > 0) {
    throw new OwnedServersBlockDeletionError(blocking);
  }

  // Read before the delete: these rows cascade, and once they are gone nothing
  // names the objects in the bucket any more.
  const attachmentKeys = await accountAttachmentKeys(userId);

  const stamped = await getPool().query(
    `UPDATE users SET deletion_started_at = NOW()
     WHERE id = $1 AND clerk_id = $2`,
    [userId, clerkId],
  );
  if ((stamped.rowCount ?? 0) === 0) {
    // Already gone — a double-submit, or the sweeper won the race.
    return { attachmentKeys: [] };
  }

  try {
    await deleteClerkUser(clerkId);
  } catch (error) {
    await getPool()
      .query(`UPDATE users SET deletion_started_at = NULL WHERE id = $1`, [
        userId,
      ])
      .catch(() => {
        // Leaving the stamp on is safe: the sweeper retries the Clerk delete,
        // which is the same call that just failed, and gives up again if it
        // still fails. It never deletes local data on its own.
      });
    throw new IdentityDeletionFailedError(error);
  }

  await getPool().query(`DELETE FROM users WHERE id = $1`, [userId]);
  forgetAuthUser(clerkId);

  return { attachmentKeys };
}

/**
 * Storage keys of every object this account uploaded — including the ones on
 * messages it no longer owns, since `message_attachments.uploader_id` is
 * `ON DELETE CASCADE` and takes those rows too.
 *
 * Remote (GIF) attachments have no key and are skipped: nothing of ours holds
 * those bytes.
 */
async function accountAttachmentKeys(userId: string): Promise<string[]> {
  const result = await getPool().query<{ storage_key: string }>(
    `SELECT storage_key FROM message_attachments
     WHERE uploader_id = $1 AND storage_key IS NOT NULL`,
    [userId],
  );
  return result.rows.map((row) => row.storage_key);
}

/**
 * How long a stamped-but-unfinished deletion is left alone before the sweeper
 * takes it over. Long enough that it can never race the request that stamped it
 * (which finishes in under a second), short enough that a crash costs minutes,
 * not days.
 */
const PENDING_DELETION_GRACE_MS = 5 * 60_000;

/**
 * Finish deletions that were interrupted — see the ordering note on
 * `deleteAccount`. Runs on a timer from the entrypoint.
 *
 * Re-runs the Clerk delete before the local one every time, because the sweeper
 * cannot tell which of the two steps was reached: a 404 from Clerk means it was
 * already done and counts as success, and any other failure leaves the row
 * stamped for the next tick rather than deleting local data for an identity
 * that can still sign in.
 *
 * Returns how many accounts it finished, for logging and for tests.
 */
export async function sweepPendingAccountDeletions(): Promise<number> {
  const pending = await getPool().query<{ id: string; clerk_id: string }>(
    `SELECT id, clerk_id FROM users
     WHERE deletion_started_at IS NOT NULL
       AND deletion_started_at < NOW() - ($1 || ' milliseconds')::interval
     ORDER BY deletion_started_at ASC
     LIMIT 50`,
    [PENDING_DELETION_GRACE_MS],
  );

  let finished = 0;
  for (const row of pending.rows) {
    try {
      await deleteClerkUser(row.clerk_id);
    } catch (error) {
      console.error(
        `[account] pending deletion ${row.id}: Clerk delete still failing`,
        error,
      );
      continue;
    }
    const keys = await accountAttachmentKeys(row.id);
    await getPool().query(`DELETE FROM users WHERE id = $1`, [row.id]);
    forgetAuthUser(row.clerk_id);
    finished += 1;
    if (keys.length > 0) {
      console.warn(
        `[account] pending deletion ${row.id}: ${keys.length} attachment object(s) left for the hourly sweeper`,
      );
    }
  }
  return finished;
}
