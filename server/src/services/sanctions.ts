import { describeTimeout, formatUserTag, type MemberTimeout } from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * Timeouts — the temporary sanction that sits between "delete one message" and
 * "ban the account".
 *
 * The design argument lives in `packages/shared/src/sanctions.ts` (why
 * server-wide, why it never reaches a conversation, why it takes speaking and
 * not reading) and the storage argument lives in the `member_timeouts` comment
 * in schema.sql (why one row per pair, why expiry is evaluated on read). This
 * file is the part that has to be *fast and impossible to forget*, because it
 * runs on the hot path of every send.
 *
 * TWO CHOKEPOINTS, NOT FIFTY ROUTES.
 *
 * The codebase already made this argument once, for the 18+ gate, and the
 * comment in `handleApi` states it plainly: the router has over a hundred
 * handlers and grows every week, so a per-route check is a check somebody will
 * forget on the route where it matters. A timeout has exactly the same problem
 * and gets exactly the same answer — one guard per surface, placed before
 * dispatch:
 *
 *   * HTTP — `handleApi`, immediately after the age gate, over WRITE methods
 *     only. `findTimeoutForRequest` resolves the pathname to a server without
 *     the router's help, so a route that does not exist yet is covered the day
 *     it is written.
 *
 *   * WebSocket — the top of `handleChatMessage`. Deliberately NOT
 *     `resolveAuthUser`, where the age gate's socket half lives: a socket
 *     authenticates once and lives for hours, so a connection-time check would
 *     mean a timeout issued at 14:00 does not bind anybody who was already
 *     online at 13:59 — which is every person a moderator is actually reacting
 *     to.
 *
 *   * Voice — `join-voice-room` in ws/voice.ts, plus an eviction at issue time.
 *
 * `NOW()` throughout is Postgres's clock, never the process's. Every enforcement
 * read and the write that sets `expires_at` therefore compare against the same
 * clock, which is the only way a two-replica deploy agrees about when a
 * sanction ended.
 */

export interface ActiveTimeout {
  serverId: string;
  userId: string;
  expiresAt: Date;
  reason: string | null;
}

interface ActiveTimeoutRow {
  server_id: string;
  user_id: string;
  expires_at: Date;
  reason: string | null;
}

function toActiveTimeout(row: ActiveTimeoutRow): ActiveTimeout {
  return {
    serverId: row.server_id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    reason: row.reason,
  };
}

/**
 * The columns every enforcement read selects, and the predicate every one of
 * them carries.
 *
 * `t.expires_at > NOW()` is not an optimisation and must never be moved into an
 * application-side comparison: a row whose sentence has run out is simply not
 * returned, so an expired timeout stops binding at the exact instant it says it
 * will, with nothing scheduled and nothing to go wrong.
 */
const ACTIVE_TIMEOUT_SELECT = `
  SELECT t.server_id, t.user_id, t.expires_at, t.reason
  FROM member_timeouts t`;

const ACTIVE = `t.user_id = $1 AND t.expires_at > NOW()`;

/** Is this person timed out in this server right now? */
export async function findTimeoutInServer(
  userId: string,
  serverId: string,
): Promise<ActiveTimeout | null> {
  const result = await getPool().query<ActiveTimeoutRow>(
    `${ACTIVE_TIMEOUT_SELECT} WHERE ${ACTIVE} AND t.server_id = $2`,
    [userId, serverId],
  );
  const row = result.rows[0];
  return row ? toActiveTimeout(row) : null;
}

/**
 * The same question asked about a channel.
 *
 * The join to `channels` is what keeps rule 2 (a server timeout never reaches a
 * conversation) true *structurally* rather than by a caller remembering to
 * check the kind. A DM or group channel has `server_id IS NULL`, the join
 * matches no timeout row, and the answer is null — so the guard at the top of
 * `handleChatMessage` can be unconditional and still be incapable of silencing
 * somebody's direct messages.
 */
export async function findTimeoutForChannel(
  userId: string,
  channelId: string,
): Promise<ActiveTimeout | null> {
  const result = await getPool().query<ActiveTimeoutRow>(
    `${ACTIVE_TIMEOUT_SELECT}
     JOIN channels c ON c.server_id = t.server_id
     WHERE ${ACTIVE} AND c.id = $2`,
    [userId, channelId],
  );
  const row = result.rows[0];
  return row ? toActiveTimeout(row) : null;
}

/** And about a message, for the routes that name one (edit, delete, pin). */
export async function findTimeoutForMessage(
  userId: string,
  messageId: string,
): Promise<ActiveTimeout | null> {
  const result = await getPool().query<ActiveTimeoutRow>(
    `${ACTIVE_TIMEOUT_SELECT}
     JOIN channels c ON c.server_id = t.server_id
     JOIN messages m ON m.channel_id = c.id
     WHERE ${ACTIVE} AND m.id = $2`,
    [userId, messageId],
  );
  const row = result.rows[0];
  return row ? toActiveTimeout(row) : null;
}

// ---------------------------------------------------------------------------
// The HTTP chokepoint's path resolver
// ---------------------------------------------------------------------------

/**
 * Which server, if any, a pathname acts on — derived from the URL alone, before
 * the router has matched anything.
 *
 * This is what makes the HTTP guard a chokepoint rather than a hundred
 * remembered checks. Three prefixes cover every write that lands inside a
 * server, and each one names something the database can resolve to a
 * `server_id`. A path that matches none of them (`/api/me`, `/api/dms`,
 * `/api/blocks`, `/api/reports`) is not a server action and is not gated — see
 * `TIMEOUT_EXEMPT_SUFFIXES` for the two that match a prefix and are exempt
 * anyway.
 *
 * The uuid shape is loose on purpose. A malformed id resolves to no server and
 * so is not gated here; the router's own `:xxxId` uuid rule answers 404 for it
 * a moment later. Being strict here would buy nothing and would risk this
 * regex and the router's disagreeing about what an id is.
 */
const ID = "[0-9a-fA-F-]{36}";

const TIMEOUT_SCOPES: ReadonlyArray<{
  pattern: RegExp;
  kind: "server" | "channel" | "message";
}> = [
  { pattern: new RegExp(`^/api/servers/(${ID})(?:/|$)`), kind: "server" },
  { pattern: new RegExp(`^/api/channels/(${ID})(?:/|$)`), kind: "channel" },
  { pattern: new RegExp(`^/api/messages/(${ID})(?:/|$)`), kind: "message" },
];

/**
 * The writes a timed-out member may still make, matched on the path *after* the
 * id.
 *
 * Kept as one short explicit list for the same reason `AGE_GATE_EXEMPT` is:
 * "which doors stay open to somebody we are sanctioning" should have to be
 * decided deliberately, one route at a time, and be readable in one place.
 *
 * There are exactly two, and each is a thing that is not participation:
 *
 *  1. **Leaving.** A sanction that traps somebody in the server they are being
 *     sanctioned in is a different and much worse product. Discord gets this
 *     wrong; there is no reason to copy it.
 *  2. **Marking a channel read.** Dismissing your own unread badge puts nothing
 *     in front of anybody. A timeout deliberately leaves reading intact, and
 *     blocking this would mean the badge for a channel they are still allowed
 *     to read can never be cleared.
 *
 * Reporting is not on this list because it never needed to be: `POST
 * /api/reports` carries no server in its path, so it matches no scope. That is
 * load-bearing — the person most likely to be timed out in a fight is also
 * sometimes the person with the legitimate complaint, and taking away their
 * ability to escalate would be the single most harmful thing this feature could
 * do.
 */
const TIMEOUT_EXEMPT_SUFFIXES: ReadonlyArray<{
  method: string;
  suffix: string;
}> = [
  { method: "POST", suffix: "/leave" },
  { method: "POST", suffix: "/read" },
];

/**
 * The one call the HTTP chokepoint makes. Null means "not a sanctioned write",
 * which covers both "this path is not about a server" and "this person is not
 * timed out there".
 *
 * At most one query, and only for a write whose path names a server, channel or
 * message — so `GET` traffic, `/api/me`, DMs and the report queue pay nothing.
 */
export async function findTimeoutForRequest(
  userId: string,
  method: string,
  pathname: string,
): Promise<ActiveTimeout | null> {
  for (const scope of TIMEOUT_SCOPES) {
    const match = scope.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    const id = match[1]!;
    const suffix = pathname.slice(match[0].replace(/\/$/, "").length);
    if (
      TIMEOUT_EXEMPT_SUFFIXES.some(
        (exempt) => exempt.method === method && exempt.suffix === suffix,
      )
    ) {
      return null;
    }
    if (scope.kind === "server") {
      return findTimeoutInServer(userId, id);
    }
    if (scope.kind === "channel") {
      return findTimeoutForChannel(userId, id);
    }
    return findTimeoutForMessage(userId, id);
  }
  return null;
}

/** The sentence, wherever it is shown. See `describeTimeout` in shared. */
export function timeoutMessage(timeout: ActiveTimeout): string {
  return describeTimeout(timeout.expiresAt);
}

// ---------------------------------------------------------------------------
// Issuing, lifting, listing
// ---------------------------------------------------------------------------

export interface IssuedTimeout {
  serverId: string;
  userId: string;
  expiresAt: Date;
  reason: string | null;
  /** The expiry the row carried before this call replaced it, when there was a
   * live one. Lets the route log an extension as a change rather than as a
   * fresh sanction. */
  previousExpiresAt: Date | null;
}

/**
 * Issue (or replace) a timeout.
 *
 * `NOW() + interval` rather than a timestamp computed in Node: the expiry has to
 * be anchored to the same clock every enforcement read compares against, or a
 * replica whose clock drifts by a minute releases people a minute early or
 * late. It also means the caller passes a *duration*, which is the only thing a
 * moderator actually decides.
 *
 * `ON CONFLICT DO UPDATE` makes a second timeout a replacement, not a second
 * row — see the schema comment. The old expiry is read first so the audit entry
 * can say "45 minutes became 24 hours" instead of just "timed out", which is
 * the difference between a trail that shows escalation and one that does not.
 * That read is deliberately *not* folded into the upsert's `RETURNING`: a
 * `RETURNING` clause on `ON CONFLICT DO UPDATE` reports the post-update row, so
 * naming `member_timeouts.expires_at` there would silently hand back the new
 * expiry labelled as the old one. It is also allowed to race — losing it costs
 * one audit entry a "previous" field, and costs enforcement nothing.
 */
export async function issueTimeout(input: {
  serverId: string;
  userId: string;
  issuedBy: string;
  minutes: number;
  reason?: string | null;
}): Promise<IssuedTimeout> {
  const previous = await findTimeoutInServer(input.userId, input.serverId);
  const result = await getPool().query<{
    expires_at: Date;
    reason: string | null;
  }>(
    `INSERT INTO member_timeouts (server_id, user_id, issued_by, reason, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)
     ON CONFLICT (server_id, user_id) DO UPDATE
       SET issued_by = EXCLUDED.issued_by,
           reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at,
           created_at = NOW()
     RETURNING expires_at, reason`,
    [
      input.serverId,
      input.userId,
      input.issuedBy,
      input.reason ?? null,
      String(input.minutes),
    ],
  );
  const row = result.rows[0]!;
  return {
    serverId: input.serverId,
    userId: input.userId,
    expiresAt: row.expires_at,
    reason: row.reason,
    previousExpiresAt: previous?.expiresAt ?? null,
  };
}

/**
 * Lift a timeout early. Returns false when there was no *live* one to lift, so
 * the route can answer 404 rather than pretending it undid something.
 *
 * Deletes the row whether or not it had expired — an expired row is dead
 * weight — but only reports success for one that was still binding.
 */
export async function liftTimeout(
  serverId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query<{ was_active: boolean }>(
    `DELETE FROM member_timeouts
     WHERE server_id = $1 AND user_id = $2
     RETURNING (expires_at > NOW()) AS was_active`,
    [serverId, userId],
  );
  return result.rows[0]?.was_active === true;
}

/**
 * Every timeout still running in one server, soonest to expire first.
 *
 * The moderator-facing read, and the reason it carries four columns nothing
 * enforces on: who issued it, when, why, and when it ends. A solo operator
 * coming back after a week needs to see the shape of what they did without
 * reconstructing it from an audit log, and a sanction nobody can see the
 * history of is how that goes wrong.
 */
export async function listActiveTimeouts(
  serverId: string,
): Promise<MemberTimeout[]> {
  const result = await getPool().query<{
    user_id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    issued_by: string | null;
    issued_by_name: string | null;
    reason: string | null;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT t.user_id, u.display_name, u.username, u.discriminator,
            t.issued_by, actor.display_name AS issued_by_name,
            t.reason, t.created_at, t.expires_at
     FROM member_timeouts t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN users actor ON actor.id = t.issued_by
     WHERE t.server_id = $1 AND t.expires_at > NOW()
     ORDER BY t.expires_at ASC`,
    [serverId],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    tag: formatUserTag(row.username, row.discriminator),
    issuedById: row.issued_by,
    issuedByName: row.issued_by_name,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  }));
}

/**
 * Drop rows whose sentence ran out.
 *
 * PURELY DISK HYGIENE. Nothing about who may speak depends on this ever
 * running — every read already filters on `expires_at > NOW()`, which is the
 * whole point of the design. Called from the same daily timer as
 * `pruneAuditLog`; if that timer never fires, the only consequence is a table
 * that keeps one dead row per sanction ever issued.
 */
export async function pruneExpiredTimeouts(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM member_timeouts WHERE expires_at <= NOW()`,
  );
  return result.rowCount ?? 0;
}
