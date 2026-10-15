import {
  BAU_FOLLOW_MAX_PER_SERVER,
  Permission,
  hasPermission,
  type BauFollow,
  type BauFollowDestination,
  type BauFollowDestinations,
  type BauFollowState,
  type BauFollowers,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { mapWithConcurrency } from "../lib/admission.js";
import { isEnabled } from "../lib/flags.js";
import { isCommunityHomeEnabled } from "./community-home.js";
import { computeMemberPermissions } from "./permissions.js";
import { listChannels, listServersForUser } from "./servers.js";

/**
 * Seguir: managing follows (who follows which Baú into which channel). The
 * delivery itself is `bau-follow-delivery.ts`.
 *
 * AUTHORITY. Setting a follow up needs MANAGE_WEBHOOKS or MANAGE_CHANNELS in
 * the destination channel, the same pair that lets a person wire a bot into a
 * channel: a follow is a feed posting into it. The person who set it up
 * remains the authority the delivery re-checks (`created_by`), so a follow
 * cannot outlive the right to have made it without pausing itself.
 *
 * The SOURCE decides nothing about who may follow beyond the flag and its
 * block list: a Baú is a public feed by intent. What its staff keep is the
 * list of followers (server names, never people) and the right to remove one,
 * or remove and block the whole destination server.
 */

export class BauFollowError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "forbidden"
      | "disabled"
      | "invalid"
      | "limit"
      | "blocked"
      | "exists",
    message: string,
  ) {
    super(message);
    this.name = "BauFollowError";
  }
}

/** The `bau_follow` flag for a SOURCE server, with the Baú itself as the floor. */
export function isBauFollowOn(sourceServerId: string): boolean {
  return (
    isCommunityHomeEnabled() &&
    isEnabled("bau_follow", { serverId: sourceServerId })
  );
}

export const FOLLOW_MANAGE_BITS = [
  Permission.MANAGE_WEBHOOKS,
  Permission.MANAGE_CHANNELS,
] as const;

/** Whether a permission set may set up a follow (the pair above, plus seeing the channel). */
export function mayManageFollow(permissions: bigint): boolean {
  return (
    hasPermission(permissions, Permission.VIEW_CHANNEL) &&
    FOLLOW_MANAGE_BITS.some((bit) => hasPermission(permissions, bit))
  );
}

interface FollowJoinRow {
  id: string;
  source_server_id: string;
  source_server_name: string;
  source_server_icon_url: string | null;
  target_server_id: string;
  target_server_name: string;
  target_channel_id: string;
  target_channel_name: string;
  role_ping_id: string | null;
  role_ping_name: string | null;
  created_by: string | null;
  paused_at: Date | null;
  paused_reason: "permissions" | null;
  created_at: Date;
}

const FOLLOW_SELECT = `
  SELECT f.id, f.source_server_id, ss.name AS source_server_name,
         ss.icon_url AS source_server_icon_url,
         f.target_server_id, ts.name AS target_server_name,
         f.target_channel_id, tc.name AS target_channel_name,
         f.role_ping_id, r.name AS role_ping_name,
         f.created_by, f.paused_at, f.paused_reason, f.created_at
    FROM bau_follows f
    JOIN servers ss ON ss.id = f.source_server_id
    JOIN servers ts ON ts.id = f.target_server_id
    JOIN channels tc ON tc.id = f.target_channel_id
    LEFT JOIN roles r ON r.id = f.role_ping_id`;

function toFollow(row: FollowJoinRow, viewerId: string): BauFollow {
  return {
    id: row.id,
    sourceServerId: row.source_server_id,
    sourceServerName: row.source_server_name,
    sourceServerIconUrl: row.source_server_icon_url,
    targetServerId: row.target_server_id,
    targetServerName: row.target_server_name,
    targetChannelId: row.target_channel_id,
    targetChannelName: row.target_channel_name,
    rolePingId: row.role_ping_id,
    rolePingName: row.role_ping_name,
    status: row.paused_at ? "paused" : "active",
    pausedReason: row.paused_at ? (row.paused_reason ?? "permissions") : null,
    pausedAt: row.paused_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    mine: row.created_by === viewerId,
  };
}

/** What `GET /api/servers/:id/home/follow` answers: the flag, and the viewer's own follows of this Baú. */
export async function getBauFollowState(
  sourceServerId: string,
  viewerId: string,
): Promise<BauFollowState> {
  // Followable only where the delivery would run: the flag AND this server's
  // own Baú switch (create refuses a server whose Baú is off).
  const home = isBauFollowOn(sourceServerId)
    ? await getPool().query<{ community_home_enabled: boolean | null }>(
        `SELECT community_home_enabled FROM servers WHERE id = $1`,
        [sourceServerId],
      )
    : null;
  if (!home || home.rows[0]?.community_home_enabled !== true) {
    return { enabled: false, maxPerServer: BAU_FOLLOW_MAX_PER_SERVER, mine: [] };
  }
  const result = await getPool().query<FollowJoinRow>(
    `${FOLLOW_SELECT}
      WHERE f.source_server_id = $1 AND f.created_by = $2
      ORDER BY f.created_at DESC`,
    [sourceServerId, viewerId],
  );
  return {
    enabled: true,
    maxPerServer: BAU_FOLLOW_MAX_PER_SERVER,
    mine: result.rows.map((row) => toFollow(row, viewerId)),
  };
}

/**
 * Every server of the viewer where they may set a follow up, with the text
 * channels they may point it at and the roles they may ping. Server-level
 * authority only: a per-channel overwrite that grants MANAGE_WEBHOOKS on one
 * channel is honoured when the follow is created (the check there reads the
 * channel), but is not discovered here, because answering it for every channel
 * of every server a person is in is a query per channel.
 */
export async function listBauFollowDestinations(
  sourceServerId: string,
  viewerId: string,
): Promise<BauFollowDestinations> {
  const pool = getPool();
  const servers = (await listServersForUser(viewerId)).filter(
    (server) => server.id !== sourceServerId,
  );
  const followed = await pool.query<{
    target_channel_id: string;
    target_server_id: string;
  }>(
    `SELECT target_channel_id, target_server_id FROM bau_follows
      WHERE source_server_id = $1
        AND target_server_id = ANY($2::uuid[])`,
    [sourceServerId, servers.map((server) => server.id)],
  );
  const followedChannels = new Set(followed.rows.map((row) => row.target_channel_id));
  const counts = await pool.query<{ target_server_id: string; n: string }>(
    `SELECT target_server_id, COUNT(*)::text AS n FROM bau_follows
      WHERE target_server_id = ANY($1::uuid[])
      GROUP BY target_server_id`,
    [servers.map((server) => server.id)],
  );
  const countByServer = new Map(
    counts.rows.map((row) => [row.target_server_id, Number(row.n)]),
  );
  const blocked = await pool.query<{ blocked_server_id: string }>(
    `SELECT blocked_server_id FROM bau_follow_blocks WHERE source_server_id = $1`,
    [sourceServerId],
  );
  const blockedIds = new Set(blocked.rows.map((row) => row.blocked_server_id));

  const built = await mapWithConcurrency(
    servers.filter((server) => !blockedIds.has(server.id)),
    4,
    async (server): Promise<BauFollowDestination | null> => {
      const permissions = await computeMemberPermissions(server.id, viewerId);
      if (!FOLLOW_MANAGE_BITS.some((bit) => hasPermission(permissions, bit))) {
        return null;
      }
      const [visible, roles] = await Promise.all([
        listChannels(server.id, viewerId),
        pool.query<{ id: string; name: string; color: string | null }>(
          `SELECT id, name, color FROM roles
            WHERE server_id = $1 AND is_everyone = FALSE
              AND ($2::boolean OR mentionable)
            ORDER BY position DESC, name ASC`,
          [server.id, hasPermission(permissions, Permission.MENTION_EVERYONE)],
        ),
      ]);
      const channels = visible.filter((channel) => channel.type === "text");
      if (channels.length === 0) {
        return null;
      }
      return {
        serverId: server.id,
        serverName: server.name,
        serverIconUrl: server.icon_url ?? null,
        channels: channels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          following: followedChannels.has(channel.id),
        })),
        roles: roles.rows.map((role) => ({
          id: role.id,
          name: role.name,
          color: role.color,
        })),
        followCount: countByServer.get(server.id) ?? 0,
      };
    },
  );
  const out = built.filter((one): one is BauFollowDestination => one !== null);
  return { maxPerServer: BAU_FOLLOW_MAX_PER_SERVER, servers: out };
}

interface ChannelRow {
  id: string;
  server_id: string | null;
  kind: string;
  type: string;
  name: string;
}

async function loadTextChannel(channelId: string): Promise<ChannelRow & { server_id: string }> {
  const result = await getPool().query<ChannelRow>(
    `SELECT id, server_id, kind, type, name FROM channels WHERE id = $1`,
    [channelId],
  );
  const channel = result.rows[0];
  if (
    !channel ||
    channel.kind !== "server" ||
    !channel.server_id ||
    channel.type !== "text"
  ) {
    throw new BauFollowError("not_found", "Channel not found");
  }
  return channel as ChannelRow & { server_id: string };
}

/** The role must belong to the destination and be one the actor may ping. */
async function assertPingableRole(
  roleId: string,
  targetServerId: string,
  permissions: bigint,
): Promise<void> {
  const result = await getPool().query<{ mentionable: boolean; is_everyone: boolean }>(
    `SELECT mentionable, is_everyone FROM roles WHERE id = $1 AND server_id = $2`,
    [roleId, targetServerId],
  );
  const role = result.rows[0];
  if (
    !role ||
    role.is_everyone ||
    !(role.mentionable || hasPermission(permissions, Permission.MENTION_EVERYONE))
  ) {
    throw new BauFollowError("invalid", "That role cannot be pinged");
  }
}

export async function createBauFollow(input: {
  sourceServerId: string;
  channelId: string;
  rolePingId: string | null;
  actorId: string;
}): Promise<BauFollow> {
  if (!isBauFollowOn(input.sourceServerId)) {
    throw new BauFollowError("disabled", "Not found");
  }
  const pool = getPool();
  const source = await pool.query<{ community_home_enabled: boolean | null }>(
    `SELECT community_home_enabled FROM servers WHERE id = $1`,
    [input.sourceServerId],
  );
  if (!source.rows[0] || source.rows[0].community_home_enabled !== true) {
    throw new BauFollowError("disabled", "Not found");
  }
  const channel = await loadTextChannel(input.channelId);
  if (channel.server_id === input.sourceServerId) {
    throw new BauFollowError("invalid", "A Baú is not delivered into its own server");
  }
  const permissions = await computeMemberPermissions(
    channel.server_id,
    input.actorId,
    channel.id,
  );
  if (!mayManageFollow(permissions)) {
    throw new BauFollowError(
      "forbidden",
      "You need to manage webhooks or channels in that channel",
    );
  }
  if (input.rolePingId) {
    await assertPingableRole(input.rolePingId, channel.server_id, permissions);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The destination server's row serialises the count below: two follows
    // created at once into one server cannot both see room for one more.
    await client.query(`SELECT 1 FROM servers WHERE id = $1 FOR UPDATE`, [
      channel.server_id,
    ]);
    const blocked = await client.query(
      `SELECT 1 FROM bau_follow_blocks
        WHERE source_server_id = $1 AND blocked_server_id = $2`,
      [input.sourceServerId, channel.server_id],
    );
    if (blocked.rows.length > 0) {
      throw new BauFollowError("blocked", "This Baú does not accept that server");
    }
    const count = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM bau_follows WHERE target_server_id = $1`,
      [channel.server_id],
    );
    if (Number(count.rows[0]?.n ?? "0") >= BAU_FOLLOW_MAX_PER_SERVER) {
      throw new BauFollowError(
        "limit",
        `A server can follow at most ${BAU_FOLLOW_MAX_PER_SERVER} Baús`,
      );
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO bau_follows
         (source_server_id, target_server_id, target_channel_id, created_by, role_ping_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_server_id, target_channel_id) DO NOTHING
       RETURNING id`,
      [
        input.sourceServerId,
        channel.server_id,
        channel.id,
        input.actorId,
        input.rolePingId,
      ],
    );
    if (!inserted.rows[0]) {
      throw new BauFollowError("exists", "That channel already follows this Baú");
    }
    // Read back inside the transaction: a reload that fails after COMMIT would
    // report a follow that exists as an error, and the retry would meet it.
    const follow = await readFollow(inserted.rows[0].id, input.actorId, client);
    await client.query("COMMIT");
    return follow;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function readFollow(
  followId: string,
  viewerId: string,
  db: Pick<PoolClient, "query"> = getPool(),
): Promise<BauFollow> {
  const result = await db.query<FollowJoinRow>(
    `${FOLLOW_SELECT} WHERE f.id = $1`,
    [followId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new BauFollowError("not_found", "Follow not found");
  }
  return toFollow(row, viewerId);
}

export interface FollowRef {
  id: string;
  source_server_id: string;
  target_server_id: string;
  target_channel_id: string;
  created_by: string | null;
  paused_at: Date | null;
}

export async function getFollowRef(followId: string): Promise<FollowRef | null> {
  const result = await getPool().query<FollowRef>(
    `SELECT id, source_server_id, target_server_id, target_channel_id, created_by, paused_at
       FROM bau_follows WHERE id = $1`,
    [followId],
  );
  return result.rows[0] ?? null;
}

/** Destination-side authority over an existing follow. Throws the right refusal. */
export async function requireFollowAuthority(
  follow: FollowRef,
  actorId: string,
): Promise<bigint> {
  const permissions = await computeMemberPermissions(
    follow.target_server_id,
    actorId,
    follow.target_channel_id,
  );
  if (!mayManageFollow(permissions)) {
    // 404, not 403: a person with no standing in the destination learns
    // nothing about which servers follow what.
    throw new BauFollowError("not_found", "Follow not found");
  }
  return permissions;
}

export async function updateBauFollow(input: {
  followId: string;
  actorId: string;
  rolePingId?: string | null;
  resume?: boolean;
}): Promise<BauFollow> {
  const follow = await getFollowRef(input.followId);
  if (!follow) {
    throw new BauFollowError("not_found", "Follow not found");
  }
  const permissions = await requireFollowAuthority(follow, input.actorId);
  if (input.rolePingId) {
    await assertPingableRole(input.rolePingId, follow.target_server_id, permissions);
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (input.rolePingId !== undefined) {
      await client.query(`UPDATE bau_follows SET role_ping_id = $2 WHERE id = $1`, [
        follow.id,
        input.rolePingId,
      ]);
    }
    if (input.resume === true) {
      // The resumer is the authority from here on, and nothing older than this
      // moment is carried: the posts that came and went while it was paused
      // stay where they are, and what was still queued for it is dropped. The
      // transition is conditional on the row STILL being paused, so a second
      // resume that raced the first changes nothing (and never drops what the
      // first one let through).
      const resumed = await client.query(
        `UPDATE bau_follows
            SET paused_at = NULL, paused_reason = NULL, permission_failures = 0,
                created_by = $2, since_at = NOW()
          WHERE id = $1 AND paused_at IS NOT NULL`,
        [follow.id, input.actorId],
      );
      if ((resumed.rowCount ?? 0) > 0) {
        await dropUndelivered(client, follow.id);
      }
    }
    const updated = await readFollow(follow.id, input.actorId, client);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function dropUndelivered(client: PoolClient, followId: string): Promise<void> {
  await client.query(
    `DELETE FROM bau_follow_deliveries
      WHERE follow_id = $1 AND status IN ('pending', 'delivering', 'dead')`,
    [followId],
  );
}

/** Destination staff leaving the follow. Delivered cards stay where they are. */
export async function deleteBauFollow(input: {
  followId: string;
  actorId: string;
}): Promise<FollowRef> {
  const follow = await getFollowRef(input.followId);
  if (!follow) {
    throw new BauFollowError("not_found", "Follow not found");
  }
  await requireFollowAuthority(follow, input.actorId);
  await getPool().query(`DELETE FROM bau_follows WHERE id = $1`, [follow.id]);
  return follow;
}

/** What a destination channel follows. Needs the same authority as setting one up. */
export async function listChannelBauFollows(
  channelId: string,
  actorId: string,
): Promise<BauFollow[]> {
  const channel = await loadTextChannel(channelId);
  const permissions = await computeMemberPermissions(
    channel.server_id,
    actorId,
    channel.id,
  );
  if (!mayManageFollow(permissions)) {
    throw new BauFollowError("forbidden", "You cannot manage this channel");
  }
  const result = await getPool().query<FollowJoinRow>(
    `${FOLLOW_SELECT} WHERE f.target_channel_id = $1 ORDER BY f.created_at ASC`,
    [channelId],
  );
  return result.rows.map((row) => toFollow(row, actorId));
}

// ------------------------------------------------------------ the source's side

export async function listBauFollowers(sourceServerId: string): Promise<BauFollowers> {
  const pool = getPool();
  const followers = await pool.query<{
    id: string;
    target_server_id: string;
    target_server_name: string;
    target_server_icon_url: string | null;
    target_channel_name: string;
    paused_at: Date | null;
    created_at: Date;
  }>(
    `SELECT f.id, f.target_server_id, ts.name AS target_server_name,
            ts.icon_url AS target_server_icon_url,
            tc.name AS target_channel_name, f.paused_at, f.created_at
       FROM bau_follows f
       JOIN servers ts ON ts.id = f.target_server_id
       JOIN channels tc ON tc.id = f.target_channel_id
      WHERE f.source_server_id = $1
      ORDER BY f.created_at DESC
      LIMIT 500`,
    [sourceServerId],
  );
  const total = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM bau_follows WHERE source_server_id = $1`,
    [sourceServerId],
  );
  const blocked = await pool.query<{
    blocked_server_id: string;
    name: string;
    created_at: Date;
  }>(
    `SELECT b.blocked_server_id, s.name, b.created_at
       FROM bau_follow_blocks b
       JOIN servers s ON s.id = b.blocked_server_id
      WHERE b.source_server_id = $1
      ORDER BY b.created_at DESC`,
    [sourceServerId],
  );
  return {
    enabled: isBauFollowOn(sourceServerId),
    count: Number(total.rows[0]?.n ?? "0"),
    followers: followers.rows.map((row) => ({
      id: row.id,
      targetServerId: row.target_server_id,
      targetServerName: row.target_server_name,
      targetServerIconUrl: row.target_server_icon_url,
      targetChannelName: row.target_channel_name,
      status: row.paused_at ? ("paused" as const) : ("active" as const),
      createdAt: row.created_at.toISOString(),
    })),
    blocked: blocked.rows.map((row) => ({
      serverId: row.blocked_server_id,
      serverName: row.name,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

/**
 * Source staff removing one follower, optionally blocking its whole server
 * (which also removes that server's other follows of this Baú). Delivered
 * cards stay in the destination: they are that server's messages now.
 */
export async function removeBauFollower(input: {
  sourceServerId: string;
  followId: string;
  actorId: string;
  block: boolean;
}): Promise<{ targetServerId: string; targetServerName: string; removed: number }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // The destination server's row, the same lock `createBauFollow` takes
    // before it reads the block list: a follow being made and a block being
    // made are serialised, so a follow cannot slip in between the block and the
    // delete. Taken before the follow's own row, in the same order as creation.
    const target = await client.query<{ target_server_id: string }>(
      `SELECT target_server_id FROM bau_follows WHERE id = $1 AND source_server_id = $2`,
      [input.followId, input.sourceServerId],
    );
    if (target.rows[0]) {
      await client.query(`SELECT 1 FROM servers WHERE id = $1 FOR UPDATE`, [
        target.rows[0].target_server_id,
      ]);
    }
    const found = await client.query<{ target_server_id: string; name: string }>(
      `SELECT f.target_server_id, s.name
         FROM bau_follows f JOIN servers s ON s.id = f.target_server_id
        WHERE f.id = $1 AND f.source_server_id = $2
        FOR UPDATE OF f`,
      [input.followId, input.sourceServerId],
    );
    const row = found.rows[0];
    if (!row) {
      throw new BauFollowError("not_found", "Follower not found");
    }
    if (input.block) {
      await client.query(
        `INSERT INTO bau_follow_blocks (source_server_id, blocked_server_id, created_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (source_server_id, blocked_server_id) DO NOTHING`,
        [input.sourceServerId, row.target_server_id, input.actorId],
      );
    }
    const removed = await client.query(
      input.block
        ? `DELETE FROM bau_follows WHERE source_server_id = $1 AND target_server_id = $2`
        : `DELETE FROM bau_follows WHERE source_server_id = $1 AND id = $2`,
      [input.sourceServerId, input.block ? row.target_server_id : input.followId],
    );
    await client.query("COMMIT");
    return {
      targetServerId: row.target_server_id,
      targetServerName: row.name,
      removed: removed.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function unblockBauFollower(
  sourceServerId: string,
  blockedServerId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM bau_follow_blocks
      WHERE source_server_id = $1 AND blocked_server_id = $2`,
    [sourceServerId, blockedServerId],
  );
  return (result.rowCount ?? 0) > 0;
}
