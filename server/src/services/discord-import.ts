import { randomUUID } from "node:crypto";
import {
  DiscordImportParseError,
  discordTemplateUrl,
  mapGuildTemplate,
  parseDiscordTemplateCode,
  PERMISSION_DEFAULT_EVERYONE,
  serializePermissions,
  type DiscordImportPlan,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool, type DbServer } from "../db.js";
import {
  FetchTooLargeError,
  safeFetch,
  UnsafeUrlError,
} from "../lib/safe-fetch.js";
import { logAudit } from "./audit.js";
import { createInviteWith, mapInvite } from "./invites.js";
import { applyPrivateChannelOverwrites, seedDefaultRoles } from "./permissions.js";
import { listRoles, mapRole } from "./roles.js";
import {
  mapChannel,
  mapServer,
  SERVER_COLUMNS,
  type ChannelRow,
} from "./servers.js";

const CHANNEL_COLUMNS = `id, server_id, name, type, position, is_private, kind, topic, image_url, parent_id`;

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
): Promise<ChannelRow[]> {
  if (plan.channels.length === 0) {
    return [];
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
  return inserted;
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
  try {
    await client.query("BEGIN");

    const serverResult = await client.query<DbServer>(
      `INSERT INTO servers (name, owner_id) VALUES ($1, $2)
       RETURNING ${SERVER_COLUMNS}`,
      [plan.serverName, ownerId],
    );
    const server = serverResult.rows[0]!;

    await client.query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [server.id, ownerId],
    );

    await seedDefaultRoles(client, server.id);

    if (plan.roles.length > 0) {
      // Staff ladder is everyone=0, then Moderator/Manager/Admin/Owner at
      // 1..4. Slide those four up so cosmetics sit under them, same as a
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
          serializePermissions(PERMISSION_DEFAULT_EVERYONE),
          index + 1,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      await client.query(
        `INSERT INTO roles (server_id, name, color, hoist, mentionable, permissions, position)
         VALUES ${rolePlaceholders.join(", ")}`,
        roleParams,
      );
    }

    const channelRows = await insertChannels(client, server.id, plan);
    for (const channel of channelRows) {
      if (channel.is_private) {
        await applyPrivateChannelOverwrites(client, channel.id, server.id, true);
      }
    }

    const invite = await createInviteWith(client, server.id, ownerId);

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

    const roles = await listRoles(server.id);
    return {
      server: { ...mapServer(server), role: "owner" as const },
      channels: channelRows.map(mapChannel),
      roles: roles.map(mapRole),
      invite: mapInvite({ ...invite, server_name: server.name }),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

