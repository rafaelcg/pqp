import { DEV_AUTH_TOKEN } from "@pqp/shared";
import WebSocket from "ws";
import { isDevAuthBypassEnabled } from "../auth/clerk.js";
import { getPool, type DbUser } from "../db.js";
import { logEvent } from "../lib/log.js";
import { parseCalendarDate, recordAgeDeclaration } from "./age-gate.js";
import { updateCommunitySettings } from "./communities.js";
import { createMessage } from "./messages.js";
import { mergePreferences } from "./preferences.js";
import { assignRole, listRoles } from "./roles.js";
import { createChannel, createServer } from "./servers.js";
import { updateProfile, upsertUser } from "./users.js";

/** Stable name. Re-running the seed finds this hall instead of making a second. */
export const DEV_HALL_NAME = "Sandbox";
export const DEV_HALL_SLUG = "sandbox";

const ADULT_DOB = parseCalendarDate("1990-01-01")!;

export type DevSeedStaff =
  | "admin"
  | "manager"
  | "moderator"
  | "vip"
  | "member"
  | "bot";

export type DevSeedPresence = "online" | "idle" | "dnd" | "offline";

export type DevSeedPerson = {
  suffix: string;
  name: string;
  staff: DevSeedStaff;
  presence: DevSeedPresence;
};

/**
 * Dummy roster for the local hall. Suffixes become `dev-local-token:<suffix>`.
 * Online / idle / dnd hold a WebSocket for the life of this process.
 */
export const DEV_HALL_ROSTER: readonly DevSeedPerson[] = [
  { suffix: "rafa", name: "Rafa", staff: "admin", presence: "online" },
  { suffix: "bia", name: "Bia", staff: "admin", presence: "offline" },
  { suffix: "caio", name: "Caio", staff: "manager", presence: "online" },
  { suffix: "duda", name: "Duda", staff: "manager", presence: "idle" },
  { suffix: "eli", name: "Eli", staff: "moderator", presence: "online" },
  { suffix: "fabi", name: "Fabi", staff: "moderator", presence: "offline" },
  { suffix: "gabi", name: "Gabi", staff: "member", presence: "online" },
  { suffix: "hugo", name: "Hugo", staff: "member", presence: "dnd" },
  { suffix: "isa", name: "Isa", staff: "member", presence: "offline" },
  { suffix: "joao", name: "João", staff: "member", presence: "offline" },
  { suffix: "kata", name: "Kata", staff: "member", presence: "online" },
  { suffix: "lara", name: "Lara", staff: "member", presence: "idle" },
  { suffix: "nico", name: "Nico", staff: "vip", presence: "online" },
  { suffix: "omar", name: "Omar", staff: "vip", presence: "offline" },
  { suffix: "lito", name: "Lito", staff: "bot", presence: "online" },
];

const SAMPLE_MESSAGES: ReadonlyArray<{ suffix: string; body: string }> = [
  { suffix: "rafa", body: "e aí. isso aqui é o Sandbox local, gente fictícia." },
  { suffix: "caio", body: "Lobby embaixo se quiser testar voz. a gente não entra sozinha." },
  { suffix: "eli", body: "admin e mod offline ficam na seção deles, apagados." },
  { suffix: "nico", body: "VIP agora é cargo padrão. o estrela é esse." },
];

let heldSockets: WebSocket[] = [];

/**
 * Local demo hall only. Never production, never Vitest, never a test database
 * that opted out. `DEV_SEED=false` skips it on a bypass box that wants empty.
 */
export function shouldSeedDevHall(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.DEV_AUTH_BYPASS !== "true") {
    return false;
  }
  if (env.NODE_ENV === "production" || env.NODE_ENV === "test") {
    return false;
  }
  if (env.VITEST === "true") {
    return false;
  }
  if (env.DEV_SEED === "false") {
    return false;
  }
  return true;
}

export async function seedDevHall(options: { port: number }): Promise<void> {
  if (!shouldSeedDevHall() || !isDevAuthBypassEnabled()) {
    return;
  }

  const owner = await ensureAccount("dev_local_user", "Dev User", false);
  const serverId = await ensureHall(owner.id);
  await ensureExtraChannel(serverId, "off-topic", "text");
  const roles = await listRoles(serverId);
  const byKey = Object.fromEntries(
    roles
      .filter((role) => role.system_key)
      .map((role) => [role.system_key, role.id]),
  );
  const general = await textChannelNamed(serverId, "general");
  const people: Array<DevSeedPerson & { user: DbUser }> = [];
  for (const person of DEV_HALL_ROSTER) {
    const user = await ensureAccount(
      `dev_local_user_${person.suffix}`,
      person.name,
      person.staff === "bot",
    );
    await joinHall(serverId, user.id);
    const roleId =
      person.staff === "bot" || person.staff === "member"
        ? null
        : (byKey[person.staff] ?? null);
    if (roleId) {
      await assignRole(serverId, user.id, roleId);
    }
    if (person.presence === "dnd") {
      await mergePreferences(user.id, { status: "dnd" });
    }
    people.push({ ...person, user });
  }

  await listAsCommunity(serverId);

  if (general) {
    await ensureSampleMessages(general, people);
  }

  await holdPresence(options.port, people);
  logEvent("dev-seed.ready", {
    server: DEV_HALL_NAME,
    members: DEV_HALL_ROSTER.length + 1,
    sockets: heldSockets.length,
  });
}

async function ensureAccount(
  clerkId: string,
  displayName: string,
  isBot: boolean,
): Promise<DbUser> {
  const user = await upsertUser({
    clerkId,
    displayName,
    avatarUrl: null,
    emailDomains: [],
  });
  await recordAgeDeclaration(user.id, ADULT_DOB);
  await mergePreferences(user.id, {
    onboardedAt: new Date().toISOString(),
    firstRunDismissedAt: new Date().toISOString(),
  });
  if (user.display_name !== displayName) {
    await updateProfile(user.id, { displayName });
  }
  if (isBot) {
    await getPool().query(
      `UPDATE users SET is_character = TRUE WHERE id = $1 AND is_character IS DISTINCT FROM TRUE`,
      [user.id],
    );
    user.is_character = true;
  }
  return user;
}

async function ensureHall(ownerId: string): Promise<string> {
  const existing = await getPool().query<{ id: string }>(
    `SELECT id FROM servers WHERE name = $1 AND owner_id = $2`,
    [DEV_HALL_NAME, ownerId],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }
  const created = await createServer(DEV_HALL_NAME, ownerId);
  return created.server.id;
}

async function ensureExtraChannel(
  serverId: string,
  name: string,
  type: "text" | "voice",
): Promise<void> {
  const found = await getPool().query(
    `SELECT 1 FROM channels WHERE server_id = $1 AND name = $2 AND type = $3`,
    [serverId, name, type],
  );
  if (found.rowCount) {
    return;
  }
  await createChannel(serverId, name, type);
}

async function listAsCommunity(serverId: string): Promise<void> {
  try {
    await updateCommunitySettings(serverId, {
      isCommunity: true,
      slug: DEV_HALL_SLUG,
      tagline: "Sala local de demo. Gente fictícia, não é gente de verdade.",
      category: "geral",
      language: "pt",
    });
  } catch (error) {
    logEvent("dev-seed.community-skipped", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function joinHall(serverId: string, userId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO server_members (server_id, user_id, role)
     VALUES ($1, $2, 'member')
     ON CONFLICT DO NOTHING`,
    [serverId, userId],
  );
}

async function textChannelNamed(
  serverId: string,
  name: string,
): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM channels
      WHERE server_id = $1 AND name = $2 AND type = 'text'
      LIMIT 1`,
    [serverId, name],
  );
  return result.rows[0]?.id ?? null;
}

async function ensureSampleMessages(
  channelId: string,
  people: Array<DevSeedPerson & { user: DbUser }>,
): Promise<void> {
  const existing = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE channel_id = $1`,
    [channelId],
  );
  if (Number(existing.rows[0]?.n ?? 0) > 0) {
    return;
  }
  const bySuffix = new Map(people.map((person) => [person.suffix, person.user]));
  for (const sample of SAMPLE_MESSAGES) {
    const author = bySuffix.get(sample.suffix);
    if (!author) {
      continue;
    }
    await createMessage(channelId, author, sample.body);
  }
}

async function holdPresence(
  port: number,
  people: Array<DevSeedPerson & { user: DbUser }>,
): Promise<void> {
  for (const socket of heldSockets) {
    socket.close();
  }
  heldSockets = [];
  const live = people.filter((person) => person.presence !== "offline");
  for (const person of live) {
    try {
      const socket = await connectDummySocket(port, person);
      heldSockets.push(socket);
    } catch (error) {
      logEvent("dev-seed.socket-failed", {
        name: person.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function connectDummySocket(
  port: number,
  person: DevSeedPerson,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timeout"));
    }, 8_000);
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "auth",
          token: `${DEV_AUTH_TOKEN}:${person.suffix}`,
        }),
      );
    });
    socket.on("message", (raw) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(String(raw)) as { type?: string };
      } catch {
        return;
      }
      if (msg.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
      }
      if (msg.type === "ready") {
        clearTimeout(timer);
        if (person.presence === "idle") {
          socket.send(JSON.stringify({ type: "set-idle", idle: true }));
        }
        resolve(socket);
      }
    });
    socket.on("error", () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    });
  });
}
