import { z } from "zod";

/**
 * Every mutation the audit log records, plus one deliberate exception:
 * `server.data_export` logs a *read* — a full data export is sensitive
 * enough (every private channel, every member) that "who pulled this and
 * when" belongs in the same trail as "who deleted that," even though
 * nothing changed. Deliberately not `server.delete` — that row would
 * cascade away with the server it describes the instant it was written
 * (`audit_log.server_id` is `ON DELETE CASCADE`), and nobody can open
 * `GET /api/servers/:serverId/audit-log` for a server that no longer exists
 * to read it back anyway.
 */
export const AUDIT_ACTIONS = [
  "member.kick",
  "member.ban",
  "member.unban",
  "member.role_update",
  /**
   * A timeout issued, and a timeout lifted early. Both are logged, and the
   * *expiry* is not: a timeout that simply ran out is not a moderator action
   * and writing a row for it would need a sweeper to notice, which is the one
   * thing `member_timeouts` is designed not to require. `member.timeout`
   * carries the expiry it was issued with in `changes`, so the trail says how
   * long the sanction was for even after the row itself is gone.
   */
  "member.timeout",
  "member.timeout_lift",
  "channel.create",
  "channel.update",
  "channel.delete",
  "channel.move",
  "message.delete",
  "server.update",
  "server.retention_update",
  "server.sso_domain_update",
  "member.sso_join",
  /**
   * The public-listing opt-in, and the tagline/category edits that go with it.
   * A separate action from `server.update` because it is categorically bigger
   * than a rename: it is the moment a private room becomes findable by, and
   * joinable by, people the owner has never met. An owner reading their own log
   * should be able to answer "when did this become public, and who did it"
   * without inferring it from a generic update entry.
   */
  "server.community_update",
  /**
   * Somebody walked in off the directory, with no invite and nobody's approval.
   * Logged for the same reason `member.sso_join` is: these are the only two
   * ways to become a member without a member's involvement, and a server owner
   * who cannot see them cannot explain their own member list.
   */
  "member.community_join",
  "server.ownership_transfer",
  "server.data_export",
  "invite.create",
  "invite.delete",
  "webhook.create",
  "webhook.delete",
  /**
   * A report closed by a moderator, actioned or dismissed alike. Only ever
   * written for a report whose context is a *server* channel: `audit_log` is
   * server-scoped by its own schema (`server_id` is NOT NULL), and a report
   * about a conversation has no server to file it under. Those resolutions are
   * recorded on the report row itself — `resolved_by` / `resolved_at` /
   * `resolution_note` — which is deliberately the only trail they leave, since
   * publishing them into a server's audit log is exactly the leak the whole
   * DM-report split exists to prevent.
   */
  "report.resolve",
  // --- voice moderation ---
  //
  // Voice-specific sanctions. `voice_disconnect` and `voice_move` record the
  // channel in `changes` (old → new; null on a plain disconnect) because the
  // roster is ephemeral — this row is the only durable record of where the
  // person was ejected from. `voice_mute` / `voice_unmute` are SFU-only (a
  // mesh call's audio never touches the server, so there is nothing honest to
  // log there — the route refuses instead).
  "member.voice_disconnect",
  "member.voice_move",
  "member.voice_mute",
  "member.voice_unmute",
] as const;

export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditChangeSchema = z.object({
  key: z.string(),
  old: z.unknown().nullable(),
  new: z.unknown().nullable(),
});
export type AuditChange = z.infer<typeof auditChangeSchema>;

export const AUDIT_LOG_PAGE_SIZE = 50;
export const AUDIT_LOG_PAGE_MAX = 100;

export const auditLogEntrySchema = z.object({
  id: z.string(),
  actorId: z.string().uuid().nullable(),
  /** Null once the actor's account is gone — see the `ON DELETE SET NULL` note above. */
  actorName: z.string().nullable(),
  action: auditActionSchema,
  targetType: z.string().nullable(),
  targetId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
  changes: z.array(auditChangeSchema).nullable(),
  createdAt: z.string(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogPageSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  hasMore: z.boolean(),
});
export type AuditLogPage = z.infer<typeof auditLogPageSchema>;
