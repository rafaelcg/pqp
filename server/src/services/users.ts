import { formatUserTag } from "@pqp/shared";
import type { DbUser } from "../db.js";
import { getPool } from "../db.js";
import type { AuthUser } from "../auth/clerk.js";

function slugifyUsername(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return slug.length >= 2 ? slug : `user_${Math.random().toString(36).slice(2, 6)}`;
}

async function allocateDiscriminator(username: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const discrim = String(Math.floor(Math.random() * 9999) + 1).padStart(4, "0");
    const existing = await getPool().query(
      `SELECT 1 FROM users WHERE username = $1 AND discriminator = $2`,
      [username, discrim],
    );
    if (existing.rows.length === 0) {
      return discrim;
    }
  }
  throw new Error("Could not allocate username discriminator");
}

export function toPublicUser(user: DbUser) {
  return {
    id: user.id,
    clerkId: user.clerk_id,
    displayName: user.display_name,
    username: user.username,
    discriminator: user.discriminator,
    tag: formatUserTag(user.username, user.discriminator),
    avatarUrl: user.avatar_url,
  };
}

export async function upsertUser(auth: AuthUser): Promise<DbUser> {
  const existing = await getPool().query<DbUser>(
    `SELECT id, clerk_id, display_name, username, discriminator, avatar_url
     FROM users WHERE clerk_id = $1`,
    [auth.clerkId],
  );

  if (existing.rows[0]) {
    // Do not clobber profile edits on every auth; only fill empty avatar from Clerk.
    const result = await getPool().query<DbUser>(
      `UPDATE users SET
         avatar_url = COALESCE(avatar_url, $2)
       WHERE clerk_id = $1
       RETURNING id, clerk_id, display_name, username, discriminator, avatar_url`,
      [auth.clerkId, auth.avatarUrl],
    );
    const user = result.rows[0]!;
    if (!user.username || !user.discriminator) {
      return ensureUsername(user);
    }
    return user;
  }

  const username = slugifyUsername(auth.displayName);
  const discriminator = await allocateDiscriminator(username);

  const result = await getPool().query<DbUser>(
    `INSERT INTO users (clerk_id, display_name, username, discriminator, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, clerk_id, display_name, username, discriminator, avatar_url`,
    [auth.clerkId, auth.displayName, username, discriminator, auth.avatarUrl],
  );
  return result.rows[0]!;
}

async function ensureUsername(user: DbUser): Promise<DbUser> {
  const username = slugifyUsername(user.display_name);
  const discriminator = await allocateDiscriminator(username);
  const result = await getPool().query<DbUser>(
    `UPDATE users SET username = $2, discriminator = $3
     WHERE id = $1
     RETURNING id, clerk_id, display_name, username, discriminator, avatar_url`,
    [user.id, username, discriminator],
  );
  return result.rows[0]!;
}

export async function getUserById(userId: string): Promise<DbUser | null> {
  const result = await getPool().query<DbUser>(
    `SELECT id, clerk_id, display_name, username, discriminator, avatar_url
     FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function updateProfile(
  userId: string,
  updates: {
    displayName?: string;
    username?: string;
    avatarUrl?: string | null;
  },
): Promise<DbUser> {
  const current = await getUserById(userId);
  if (!current) {
    throw new Error("User not found");
  }

  let username = current.username;
  let discriminator = current.discriminator;

  if (updates.username && updates.username !== current.username) {
    username = updates.username;
    discriminator = await allocateDiscriminator(updates.username);
  }

  const avatarUrl =
    updates.avatarUrl !== undefined
      ? updates.avatarUrl === ""
        ? null
        : updates.avatarUrl
      : current.avatar_url;

  const result = await getPool().query<DbUser>(
    `UPDATE users SET
       display_name = COALESCE($2, display_name),
       username = $3,
       discriminator = $4,
       avatar_url = $5
     WHERE id = $1
     RETURNING id, clerk_id, display_name, username, discriminator, avatar_url`,
    [
      userId,
      updates.displayName ?? null,
      username,
      discriminator,
      avatarUrl,
    ],
  );
  return result.rows[0]!;
}

export async function getMemberRole(
  serverId: string,
  userId: string,
): Promise<"owner" | "admin" | "member" | null> {
  const result = await getPool().query<{ role: "owner" | "admin" | "member" }>(
    `SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
  return result.rows[0]?.role ?? null;
}

export async function isServerMember(
  serverId: string,
  userId: string,
): Promise<boolean> {
  return (await getMemberRole(serverId, userId)) !== null;
}

export async function listServerMemberIds(serverId: string): Promise<string[]> {
  const result = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM server_members WHERE server_id = $1`,
    [serverId],
  );
  return result.rows.map((row) => row.user_id);
}

export async function canManageServer(
  serverId: string,
  userId: string,
): Promise<boolean> {
  const role = await getMemberRole(serverId, userId);
  return role === "owner" || role === "admin";
}

export async function isChannelMember(
  channelId: string,
  userId: string,
): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM channels c
     JOIN server_members sm ON sm.server_id = c.server_id
     WHERE c.id = $1 AND sm.user_id = $2
       AND (
         c.is_private = FALSE
         OR sm.role IN ('owner', 'admin')
         OR EXISTS (
           SELECT 1 FROM channel_members cm
           WHERE cm.channel_id = c.id AND cm.user_id = $2
         )
       )`,
    [channelId, userId],
  );
  return result.rows.length > 0;
}

export async function listServerMembers(serverId: string) {
  const result = await getPool().query<{
    id: string;
    display_name: string;
    username: string | null;
    discriminator: string | null;
    avatar_url: string | null;
    role: "owner" | "admin" | "member";
  }>(
    `SELECT u.id, u.display_name, u.username, u.discriminator, u.avatar_url, sm.role
     FROM server_members sm
     JOIN users u ON u.id = sm.user_id
     WHERE sm.server_id = $1
     ORDER BY
       CASE sm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
       u.display_name ASC`,
    [serverId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    discriminator: row.discriminator,
    tag: formatUserTag(row.username, row.discriminator),
    avatarUrl: row.avatar_url,
    role: row.role,
  }));
}

export async function updateMemberRole(
  serverId: string,
  targetUserId: string,
  role: "admin" | "member",
): Promise<void> {
  await getPool().query(
    `UPDATE server_members SET role = $3
     WHERE server_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [serverId, targetUserId, role],
  );
}

export async function leaveServer(
  serverId: string,
  userId: string,
): Promise<void> {
  const role = await getMemberRole(serverId, userId);
  if (!role) {
    throw new Error("Not a member of this server");
  }
  if (role === "owner") {
    throw new Error("Owner cannot leave — transfer ownership or delete the server");
  }
  await getPool().query(
    `DELETE FROM server_members WHERE server_id = $1 AND user_id = $2`,
    [serverId, userId],
  );
  await getPool().query(
    `DELETE FROM channel_members
     WHERE user_id = $1 AND channel_id IN (
       SELECT id FROM channels WHERE server_id = $2
     )`,
    [userId, serverId],
  );
}
