import { randomUUID } from "node:crypto";
import {
  DiscordImportParseError,
  discordTemplateUrl,
  mapGuildTemplate,
  MAX_SERVER_ICON_BYTES,
  parseDiscordTemplateCode,
  type DiscordImportPlan,
  type ServerImageContentType,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool, type DbServer } from "../db.js";
import {
  FetchTooLargeError,
  safeFetch,
  UnsafeUrlError,
} from "../lib/safe-fetch.js";
import {
  isStorageConfigured,
  presignGet,
  putObject,
} from "../lib/s3.js";
import { logAudit } from "./audit.js";
import { scanAllowsAttachment, scanImage } from "./content-scan.js";
import { createInviteWith, mapInvite } from "./invites.js";
import { applyPrivateChannelOverwrites, seedDefaultRoles } from "./permissions.js";
import { listRoles, mapRole } from "./roles.js";
import {
  serverImageObjectKey,
  serverImageUrlForKey,
  setServerImage,
  verifyServerImageObject,
  discardServerImageObject,
} from "./server-images.js";
import {
  CHANNEL_COLUMNS,
  mapChannel,
  mapServer,
  SERVER_COLUMNS,
  type ChannelRow,
} from "./servers.js";

export class DiscordTemplateNotFoundError extends Error {
  constructor() {
    super("No Discord template was found for that code.");
    this.name = "DiscordTemplateNotFoundError";
  }
}

export class DiscordTemplateRateLimitedError extends Error {
  retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super("Discord asked us to slow down. Try again in a moment.");
    this.name = "DiscordTemplateRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class DiscordTemplateUnavailableError extends Error {
  constructor(message = "Could not read that Discord template.") {
    super(message);
    this.name = "DiscordTemplateUnavailableError";
  }
}

export class DiscordTemplateTooLargeError extends Error {
  constructor() {
    super("That Discord template is too large to copy.");
    this.name = "DiscordTemplateTooLargeError";
  }
}

function parseRetryAfter(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

export async function fetchMappedDiscordTemplate(
  source: string,
): Promise<{ code: string; plan: DiscordImportPlan }> {
  const code = parseDiscordTemplateCode(source);
  if (!code) {
    throw new DiscordImportParseError(
      "Paste a discord.new link or a Discord template code.",
    );
  }

  let response;
  try {
    response = await safeFetch(discordTemplateUrl(code), {
      accept: "application/json",
    });
  } catch (error) {
    if (error instanceof FetchTooLargeError) {
      throw new DiscordTemplateTooLargeError();
    }
    if (error instanceof UnsafeUrlError) {
      throw new DiscordTemplateUnavailableError();
    }
    throw new DiscordTemplateUnavailableError();
  }

  if (response.statusCode === 404) {
    throw new DiscordTemplateNotFoundError();
  }
  if (response.statusCode === 429) {
    throw new DiscordTemplateRateLimitedError(
      parseRetryAfter(response.headers["retry-after"]),
    );
  }
  if (response.statusCode !== 200) {
    throw new DiscordTemplateUnavailableError();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new DiscordImportParseError();
  }

  return { code, plan: mapGuildTemplate(payload) };
}

async function insertChannels(
  client: PoolClient,
  serverId: string,
  plan: DiscordImportPlan,
): Promise<{ rows: ChannelRow[]; idByTemplate: Map<number, string> }> {
  if (plan.channels.length === 0) {
    return { rows: [], idByTemplate: new Map() };
  }

  const idByTemplate = new Map<number, string>();
  for (const channel of plan.channels) {
    idByTemplate.set(channel.templateId, randomUUID());
  }

  const categories = plan.channels.filter((channel) => channel.type === "category");
  const rest = plan.channels.filter((channel) => channel.type !== "category");

  const inserted: ChannelRow[] = [];
  if (categories.length > 0) {
    inserted.push(
      ...(await insertChannelRows(client, serverId, categories, idByTemplate)),
    );
  }
  if (rest.length > 0) {
    inserted.push(
      ...(await insertChannelRows(client, serverId, rest, idByTemplate)),
    );
  }
  return { rows: inserted, idByTemplate };
}

async function insertChannelRows(
  client: PoolClient,
  serverId: string,
  rows: DiscordImportPlan["channels"],
  idByTemplate: Map<number, string>,
): Promise<ChannelRow[]> {
  const params: unknown[] = [];
  const placeholders = rows.map((channel, index) => {
    const base = index * 8;
    const id = idByTemplate.get(channel.templateId)!;
    const parentId =
      channel.parentTemplateId != null
        ? (idByTemplate.get(channel.parentTemplateId) ?? null)
        : null;
    params.push(
      id,
      serverId,
      channel.name,
      channel.type,
      channel.position,
      channel.isPrivate,
      channel.topic,
      parentId,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  });
  const result = await client.query<ChannelRow>(
    `INSERT INTO channels (id, server_id, name, type, position, is_private, topic, parent_id)
     VALUES ${placeholders.join(", ")}
     RETURNING ${CHANNEL_COLUMNS}`,
    params,
  );
  return result.rows;
}

export async function createServerFromImport(
  ownerId: string,
  code: string,
  plan: DiscordImportPlan,
): Promise<{
  server: ReturnType<typeof mapServer> & { role: "owner" };
  channels: ReturnType<typeof mapChannel>[];
  roles: ReturnType<typeof mapRole>[];
  invite: ReturnType<typeof mapInvite>;
}> {
  const client = await getPool().connect();
  let server: DbServer;
  let channelRows: ChannelRow[];
  let invite: Awaited<ReturnType<typeof createInviteWith>>;
  try {
    await client.query("BEGIN");

    const serverResult = await client.query<DbServer>(
      `INSERT INTO servers (name, owner_id) VALUES ($1, $2)
       RETURNING ${SERVER_COLUMNS}`,
      [plan.serverName, ownerId],
    );
    server = serverResult.rows[0]!;

    await client.query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [server.id, ownerId],
    );

    await seedDefaultRoles(client, server.id);

    if (plan.everyonePermissions) {
      await client.query(
        `UPDATE roles SET permissions = $2
          WHERE server_id = $1 AND system_key = 'everyone'`,
        [server.id, plan.everyonePermissions],
      );
    }

    const roleIdByTemplate = new Map<number, string>();
    const everyone = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE server_id = $1 AND system_key = 'everyone'`,
      [server.id],
    );
    if (everyone.rows[0]) {
      roleIdByTemplate.set(0, everyone.rows[0].id);
    }

    if (plan.roles.length > 0) {
      // Staff ladder is everyone=0, then VIP / Moderator / Manager / Admin /
      // Owner. Slide those rungs up so cosmetics sit under them, same as a
      // homemade cargo created in Cargos.
      await client.query(
        `UPDATE roles SET position = position + $2
          WHERE server_id = $1
            AND system_key IS NOT NULL
            AND system_key <> 'everyone'`,
        [server.id, plan.roles.length],
      );

      const roleParams: unknown[] = [];
      const rolePlaceholders = plan.roles.map((role, index) => {
        const base = index * 7;
        roleParams.push(
          server.id,
          role.name,
          role.color,
          role.hoist,
          role.mentionable,
          role.permissions,
          index + 1,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      const insertedRoles = await client.query<{ id: string; name: string }>(
        `INSERT INTO roles (server_id, name, color, hoist, mentionable, permissions, position)
         VALUES ${rolePlaceholders.join(", ")}
         RETURNING id, name`,
        roleParams,
      );
      const idByName = new Map(
        insertedRoles.rows.map((row) => [row.name, row.id]),
      );
      for (const role of plan.roles) {
        const id = idByName.get(role.name);
        if (id) {
          roleIdByTemplate.set(role.templateId, id);
        }
      }
    }

    const inserted = await insertChannels(
      client,
      server.id,
      plan,
    );
    channelRows = inserted.rows;
    const { idByTemplate } = inserted;
    for (const overwrite of plan.overwrites) {
      const channelId = idByTemplate.get(overwrite.channelTemplateId);
      const roleId = roleIdByTemplate.get(overwrite.roleTemplateId);
      if (!channelId || !roleId) {
        continue;
      }
      await client.query(
        `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
         VALUES ($1, 'role', $2, $3, $4)
         ON CONFLICT (channel_id, target_type, target_id)
         DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
        [channelId, roleId, overwrite.allow, overwrite.deny],
      );
    }
    for (const channel of channelRows) {
      if (channel.is_private) {
        await applyPrivateChannelOverwrites(client, channel.id, server.id, true);
      }
    }

    invite = await createInviteWith(client, server.id, ownerId);

    await logAudit(
      {
        serverId: server.id,
        actorId: ownerId,
        action: "server.discord_import",
        targetType: "server",
        targetId: server.id,
        changes: [
          { key: "templateCode", old: null, new: code },
          { key: "channelCount", old: null, new: plan.channels.length },
          { key: "roleCount", old: null, new: plan.roles.length },
        ],
      },
      client,
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let mappedServer = mapServer(server);
  if (plan.iconUrl) {
    const withIcon = await copyImportedServerIcon(server.id, plan.iconUrl);
    if (withIcon) {
      mappedServer = mapServer(withIcon);
    }
  }

  const roles = await listRoles(server.id);
  return {
    server: { ...mappedServer, role: "owner" as const },
    channels: channelRows.map(mapChannel),
    roles: roles.map(mapRole),
    invite: mapInvite({ ...invite, server_name: server.name }),
  };
}

function sniffImageContentType(
  bytes: Buffer,
  header: string | undefined,
): ServerImageContentType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  const type = (header ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "image/jpeg" || type === "image/png" || type === "image/webp") {
    return type;
  }
  return null;
}

/**
 * Fetch a constructed Discord CDN icon and store it on the server row.
 *
 * Runs after the create transaction commits: it talks to Discord and to the
 * bucket, and nothing between BEGIN and COMMIT may do that. A failure leaves
 * the community up with the monogram. Preview already showed the CDN picture.
 */
async function copyImportedServerIcon(
  serverId: string,
  iconUrl: string,
): Promise<DbServer | null> {
  if (!isStorageConfigured()) {
    return null;
  }
  let response;
  try {
    response = await safeFetch(iconUrl, { accept: "image/*" });
  } catch {
    return null;
  }
  if (response.statusCode !== 200) {
    return null;
  }
  if (response.body.length === 0 || response.body.length > MAX_SERVER_ICON_BYTES) {
    return null;
  }
  const headerType = Array.isArray(response.headers["content-type"])
    ? response.headers["content-type"][0]
    : response.headers["content-type"];
  const contentType = sniffImageContentType(response.body, headerType);
  if (!contentType) {
    return null;
  }

  const key = serverImageObjectKey("icon", serverId, contentType);
  try {
    await putObject(key, response.body, contentType);
  } catch (error) {
    console.error(
      "[discord-import] icon PUT failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  const verified = await verifyServerImageObject("icon", serverId, key);
  if (verified == null) {
    await discardServerImageObject(key);
    return null;
  }

  const scanUrl = presignGet(key, { ttlSeconds: 60 * 60 });
  const scan = await scanImage({ imageUrl: scanUrl, contentType });
  if (!scanAllowsAttachment(scan)) {
    await discardServerImageObject(key);
    return null;
  }

  const written = await setServerImage(
    "icon",
    serverId,
    { url: serverImageUrlForKey("icon", serverId, key), key },
    SERVER_COLUMNS,
  );
  return written?.server ?? null;
}

