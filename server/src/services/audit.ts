import type { AuditAction, AuditChange, AuditLogEntry } from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";

interface LogAuditInput {
  serverId: string;
  /** Null for a system-initiated action; every route call site has a user. */
  actorId: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  changes?: AuditChange[] | null;
}

/**
 * Written from the route layer rather than deep inside each service
 * function, unlike the original sketch. Every mutation this logs already
 * hands the route both the old and new state for free (a channel row read
 * for its own authorization check, a role fetched to gate the change) or
 * needs neither, so threading a pg client through servers.ts/moderation.ts
 * transactions would buy correctness this app does not need for a v1 audit
 * trail: the tiny window between a mutation committing and this insert
 * running is the same kind of best-effort follow-up write already accepted
 * elsewhere (`notifyChannelActivity` runs after `createMessage` commits, not
 * inside it). Accepts a `PoolClient` anyway so a future caller that genuinely
 * needs the entry to roll back with its transaction still can.
 */
export async function logAudit(
  input: LogAuditInput,
  client?: PoolClient,
): Promise<void> {
  const runner = client ?? getPool();
  await runner.query(
    `INSERT INTO audit_log (server_id, actor_id, action, target_type, target_id, reason, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.serverId,
      input.actorId,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.reason ?? null,
      input.changes ? JSON.stringify(input.changes) : null,
    ],
  );
}

interface AuditLogRow {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  action: AuditAction;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  changes: AuditChange[] | null;
  created_at: Date;
}

function toPublicEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    changes: row.changes,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * A self-hosted instance that never prunes this grows it forever — unlike
 * `messages`, nothing here is ever deleted by the user action that created
 * it. Called on a daily timer from index.ts; see the sweep pattern already
 * used for orphaned attachments.
 */
export async function pruneAuditLog(retentionDays = 90): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM audit_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [retentionDays],
  );
  return result.rowCount ?? 0;
}

export interface ListAuditLogOptions {
  /** Opaque cursor: the `id` of the oldest entry already loaded. */
  before?: string;
  limit: number;
  action?: string;
  actorId?: string;
}

/**
 * Newest first, keyset-paginated on the bare `id` — see the schema comment
 * for why that alone is a safe cursor here in a way it is not for messages.
 */
export async function listAuditLog(
  serverId: string,
  options: ListAuditLogOptions,
): Promise<{ entries: AuditLogEntry[]; hasMore: boolean }> {
  const conditions = ["a.server_id = $1"];
  const params: unknown[] = [serverId];

  if (options.before) {
    params.push(options.before);
    conditions.push(`a.id < $${params.length}`);
  }
  if (options.action) {
    params.push(options.action);
    conditions.push(`a.action = $${params.length}`);
  }
  if (options.actorId) {
    params.push(options.actorId);
    conditions.push(`a.actor_id = $${params.length}`);
  }
  params.push(options.limit + 1);

  const result = await getPool().query<AuditLogRow>(
    `SELECT a.id, a.actor_id, u.display_name AS actor_name, a.action,
            a.target_type, a.target_id, a.reason, a.changes, a.created_at
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.actor_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY a.id DESC
     LIMIT $${params.length}`,
    params,
  );

  const hasMore = result.rows.length > options.limit;
  return {
    entries: result.rows.slice(0, options.limit).map(toPublicEntry),
    hasMore,
  };
}
