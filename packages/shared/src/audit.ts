import { z } from "zod";

/**
 * Every mutation the audit log records. Deliberately not `server.delete` —
 * that row would cascade away with the server it describes the instant it
 * was written (`audit_log.server_id` is `ON DELETE CASCADE`), and nobody can
 * open `GET /api/servers/:serverId/audit-log` for a server that no longer
 * exists to read it back anyway.
 */
export const AUDIT_ACTIONS = [
  "member.kick",
  "member.ban",
  "member.unban",
  "member.role_update",
  "channel.create",
  "channel.update",
  "channel.delete",
  "channel.move",
  "message.delete",
  "server.update",
  "server.retention_update",
  "server.ownership_transfer",
  "invite.create",
  "invite.delete",
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
