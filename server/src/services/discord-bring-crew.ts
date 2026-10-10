import { bringCrewPhase, type DiscordImportArrivals } from "@pqp/shared";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import type { Queryable } from "./invites.js";

/**
 * "12 pessoas da tua galera já chegaram": who came over after a Discord
 * import, for the owner's strip. Rules and the data behind them:
 * `@pqp/shared` `discord-bring-crew.ts` and `docs/DISCORD_IMPORT.md`.
 *
 * WHAT COUNTS AS ARRIVED. A membership created after the import, by any door
 * (the import's link, a later invite, a community link), that is not the
 * importer, the owner, a webhook or a character. People who arrived and left
 * again are not counted, because `server_members` forgets them: the strip
 * says who is here, which is what the owner wants to know.
 *
 * Three small reads, all on indexes the server already has:
 * `idx_audit_log_server_id`, the `server_members` primary key and
 * `server_invites (server_id)`. Nothing is written.
 */

const OFF: DiscordImportArrivals = {
  enabled: false,
  importedAt: null,
  phase: null,
  arrived: 0,
  viaLink: 0,
  inviteCode: null,
};

export async function getDiscordImportArrivals(
  serverId: string,
  now: number = Date.now(),
  db: Queryable = getPool(),
): Promise<DiscordImportArrivals> {
  if (!isEnabled("discord_bring_crew", { serverId })) {
    return OFF;
  }
  // The first import row: a server is made by one import, and a later one
  // would be a new server.
  const imported = await db.query<{ actor_id: string | null; created_at: Date }>(
    `SELECT actor_id, created_at
       FROM audit_log
      WHERE server_id = $1 AND action = 'server.discord_import'
      ORDER BY id ASC
      LIMIT 1`,
    [serverId],
  );
  const row = imported.rows[0];
  if (!row) {
    return { ...OFF, enabled: true };
  }
  const importedAt = row.created_at;

  const counts = await db.query<{ arrived: string; via_link: string }>(
    `SELECT COUNT(*)::text AS arrived,
            COUNT(*) FILTER (WHERE sm.join_ref = 'discord')::text AS via_link
       FROM server_members sm
       JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = $1
        AND sm.role <> 'owner'
        AND sm.user_id IS DISTINCT FROM $2
        AND sm.joined_at >= $3
        AND NOT u.is_webhook
        AND NOT u.is_character`,
    [serverId, row.actor_id, importedAt],
  );
  const arrived = Number(counts.rows[0]?.arrived ?? 0);
  const viaLink = Number(counts.rows[0]?.via_link ?? 0);
  const phase = bringCrewPhase(importedAt.getTime(), now, arrived);

  let inviteCode: string | null = null;
  if (phase !== "over") {
    // The import's own invite has no expiry and no cap, so it is the one to
    // paste into a channel where it may sit pinned for months. If the owner
    // revoked it, the oldest other permanent invite does the same job; with
    // none the client mints a fresh one.
    const invite = await db.query<{ code: string }>(
      `SELECT code
         FROM server_invites
        WHERE server_id = $1
          AND expires_at IS NULL
          AND max_uses IS NULL
        ORDER BY created_at ASC
        LIMIT 1`,
      [serverId],
    );
    inviteCode = invite.rows[0]?.code ?? null;
  }

  return {
    enabled: true,
    importedAt: importedAt.toISOString(),
    phase,
    arrived,
    viaLink,
    inviteCode,
  };
}

/** What the import's apply says about the step after it. */
export function bringCrewEnabledFor(serverId: string): boolean {
  return isEnabled("discord_bring_crew", { serverId });
}
