import { Permission } from "@pqp/shared";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";
import { testCatalogEntry, testManifest, type TestManifestOptions } from "./testing.js";

/**
 * A small world for the session tests: one server, the people who matter to
 * the rules (owner, plain member, member who may not start here, moderator,
 * manager, an insider of a private channel, a stranger, an instance
 * moderator), its channels, and an app released on it. Built against whichever
 * module graph the caller hands in, because the two-process tests load the
 * server twice. Test support only: `tsconfig.build.json` excludes it.
 */

export interface WorldModules {
  db: typeof import("../db.js");
  users: typeof import("../services/users.js");
  servers: typeof import("../services/servers.js");
  roles: typeof import("../services/roles.js");
  flags: typeof import("../lib/flags.js");
  catalog: typeof import("./catalog.js");
  sockets: typeof import("../ws/sockets.js");
}

export interface World {
  serverId: string;
  owner: DbUser;
  member: DbUser;
  /** Holds USE_APPS everywhere but is denied it in `restricted`. */
  noApps: DbUser;
  moderator: DbUser;
  manager: DbUser;
  insider: DbUser;
  stranger: DbUser;
  operator: DbUser;
  channels: {
    general: string;
    lobby: string;
    restricted: string;
    secret: string;
    forum: string;
  };
}

let seq = 0;

export async function makeUser(m: WorldModules, name: string): Promise<DbUser> {
  seq += 1;
  return m.users.upsertUser({
    clerkId: `clerk_${name}_${Date.now()}_${seq}_${Math.random().toString(36).slice(2, 8)}`,
    displayName: name,
    avatarUrl: null,
  });
}

async function join(m: WorldModules, serverId: string, user: DbUser): Promise<void> {
  await m.db
    .getPool()
    .query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT DO NOTHING`,
      [serverId, user.id],
    );
}

export async function buildWorld(m: WorldModules): Promise<World> {
  const owner = await makeUser(m, "Owner");
  const member = await makeUser(m, "Member");
  const noApps = await makeUser(m, "NoApps");
  const moderator = await makeUser(m, "Moderator");
  const manager = await makeUser(m, "Manager");
  const insider = await makeUser(m, "Insider");
  const stranger = await makeUser(m, "Stranger");
  const operator = await makeUser(m, "Operator");

  const { server, channels } = await m.servers.createServer("Hall", owner.id);
  const serverId = server.id;
  for (const user of [member, noApps, moderator, manager, insider]) {
    await join(m, serverId, user);
  }
  const roles = await m.roles.listRoles(serverId);
  const byKey = new Map(roles.map((role) => [role.system_key, role.id]));
  await m.roles.assignRole(serverId, moderator.id, byKey.get("moderator")!);
  await m.roles.assignRole(serverId, manager.id, byKey.get("manager")!);

  const general = channels.find((channel) => channel.name === "general")!.id;
  const lobby = channels.find((channel) => channel.name === "Lobby")!.id;
  const restricted = (await m.servers.createChannel(serverId, "restricted", "text")).id;
  const secret = (await m.servers.createChannel(serverId, "secret", "text")).id;
  const forum = (await m.servers.createChannel(serverId, "forum", "forum")).id;

  await m.roles.upsertChannelOverwrite(
    restricted,
    serverId,
    "member",
    noApps.id,
    0n,
    Permission.USE_APPS,
  );
  const everyone = byKey.get("everyone")!;
  await m.roles.upsertChannelOverwrite(secret, serverId, "role", everyone, 0n, Permission.VIEW_CHANNEL);
  await m.roles.upsertChannelOverwrite(
    secret,
    serverId,
    "member",
    insider.id,
    Permission.VIEW_CHANNEL,
    0n,
  );
  return {
    serverId,
    owner,
    member,
    noApps,
    moderator,
    manager,
    insider,
    stranger,
    operator,
    channels: { general, lobby, restricted, secret, forum },
  };
}

/**
 * Put an app into the database the way the loader and the operator leave it
 * (live, global on, released on `serverId`) and return its id.
 */
export async function publishTestApp(
  m: WorldModules,
  serverId: string,
  options: TestManifestOptions = {},
  switches: { operator?: boolean | null; global?: boolean; status?: string } = {},
): Promise<string> {
  const manifest = testManifest(options);
  await m.catalog.loadAppCatalog({ entries: [testCatalogEntry(manifest)], dev: false });
  await m.db
    .getPool()
    .query(`UPDATE apps SET status = $2, global_enabled = $3 WHERE id = $1`, [
      manifest.id,
      switches.status ?? "live",
      switches.global ?? true,
    ]);
  await m.db
    .getPool()
    .query(
      `INSERT INTO server_apps (server_id, app_id, operator_enabled) VALUES ($1, $2, $3)
       ON CONFLICT (server_id, app_id) DO UPDATE SET operator_enabled = EXCLUDED.operator_enabled`,
      [serverId, manifest.id, switches.operator === undefined ? true : switches.operator],
    );
  return manifest.id;
}

export interface RecordedFrame {
  type: string;
  [key: string]: unknown;
}

/** A socket that records every frame it is sent, registered as `user`'s. */
export function recordingSocket(m: Pick<WorldModules, "sockets">, user: DbUser) {
  const frames: RecordedFrame[] = [];
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (payload: string | Buffer) => frames.push(JSON.parse(payload.toString()) as RecordedFrame),
    on: () => {},
  } as unknown as WebSocket;
  m.sockets.setAuthenticatedSocket(socket, user);
  return {
    socket,
    frames,
    ofType: (type: string) => frames.filter((frame) => frame.type === type),
  };
}
