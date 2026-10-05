import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * The audience mode routes end to end through the real router, SQL,
 * permission resolution and audit log (`docs/plans/AUDIENCE_MODE.md`), with
 * only the identity layer faked. Who may, where, the flag, and what lands in
 * the audit log. The media half is `ws/voice-audience.test.ts`.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  resolveAuthSession: async () => (actor ? { user: actor, ageGate: "passed" as const } : null),
  verifyAuthHeader: async () => null,
}));

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { handleVoiceMessage, resetVoicePeers, resetVoiceRateLimits, resetVoiceRoomTransports } =
  await import("../ws/voice.js");

let server: Server;
let baseUrl: string;

async function call<T = Record<string, unknown>>(
  as: { id: string; clerk_id: string } | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  actor = as;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describeDb("audience mode routes", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };
  let outsider: { id: string; clerk_id: string };

  beforeAll(async () => {
    await initDb();
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleApi(req, res, pathname);
    });
    await new Promise<void>((done) => server.listen(0, done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await closePool();
    delete process.env.AUDIENCE_MODE;
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetVoicePeers();
    resetVoiceRateLimits();
    resetVoiceRoomTransports();
    process.env.AUDIENCE_MODE = "true";
    vi.spyOn(console, "log").mockImplementation(() => {});
    await getPool().query(
      `TRUNCATE users, servers, channels, server_members, channel_members, audit_log
       RESTART IDENTITY CASCADE`,
    );
    owner = await upsertUser({ clerkId: "clerk_aud_owner", displayName: "Owner", avatarUrl: null });
    member = await upsertUser({ clerkId: "clerk_aud_member", displayName: "Member", avatarUrl: null });
    outsider = await upsertUser({ clerkId: "clerk_aud_out", displayName: "Out", avatarUrl: null });
  });

  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "Audience test" });
    expect(created.status).toBe(201);
    const serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    const voiceChannelId = created.body.channels.find((c) => c.type === "voice")!.id;
    return { serverId, voiceChannelId };
  }

  async function joinVoice(userId: string, voiceChannelId: string) {
    const sent: Array<Record<string, unknown>> = [];
    const socket = {
      readyState: 1,
      send: (payload: string) => sent.push(JSON.parse(payload) as Record<string, unknown>),
      on: () => {},
    } as unknown as WebSocket;
    const user = (
      await getPool().query<DbUser>(`SELECT * FROM users WHERE id = $1`, [userId])
    ).rows[0]!;
    await handleVoiceMessage({ socket, user }, { type: "join-voice-room", voiceChannelId });
    return sent;
  }

  async function auditActions(serverId: string): Promise<string[]> {
    const rows = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE server_id = $1 ORDER BY id`,
      [serverId],
    );
    return rows.rows.map((row) => row.action);
  }

  it("GET /api/voice/config answers the flag for the server", async () => {
    const { serverId } = await makeServer();
    expect((await call(owner, "GET", `/api/voice/config?serverId=${serverId}`)).body).toEqual({
      audienceMode: true,
    });
    process.env.AUDIENCE_MODE = "false";
    expect((await call(owner, "GET", `/api/voice/config?serverId=${serverId}`)).body).toEqual({
      audienceMode: false,
    });
  });

  it("the owner turns it on from inside the call, the room is locked, the audit log says so, and off is audited too", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    await joinVoice(owner.id, voiceChannelId);

    const on = await call<{ audience: { byUserId: string }; enforcement: { transport: string } }>(
      owner,
      "PUT",
      `/api/channels/${voiceChannelId}/voice-audience`,
      { enabled: true },
    );
    expect(on.status).toBe(200);
    expect(on.body.audience.byUserId).toBe(owner.id);
    expect(on.body.enforcement.transport).toBe("mesh");

    const memberFrames = await joinVoice(member.id, voiceChannelId);
    expect(memberFrames.find((f) => f.type === "welcome")).toMatchObject({
      canSpeak: false,
      speakReason: "audience",
    });

    const off = await call(owner, "PUT", `/api/channels/${voiceChannelId}/voice-audience`, {
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ audience: null });
    expect(await auditActions(serverId)).toEqual([
      "channel.voice_audience_on",
      "channel.voice_audience_off",
    ]);

    // Idempotent and quiet: an off that changes nothing is not audited.
    await call(owner, "PUT", `/api/channels/${voiceChannelId}/voice-audience`, { enabled: false });
    expect(await auditActions(serverId)).toHaveLength(2);
  });

  it("refuses a member without MUTE_MEMBERS or MANAGE_CHANNELS, and somebody outside the server", async () => {
    const { voiceChannelId } = await makeServer();
    await joinVoice(member.id, voiceChannelId);
    const asMember = await call(member, "PUT", `/api/channels/${voiceChannelId}/voice-audience`, {
      enabled: true,
    });
    expect(asMember.status).toBe(403);
    const asOutsider = await call(
      outsider,
      "PUT",
      `/api/channels/${voiceChannelId}/voice-audience`,
      { enabled: true },
    );
    expect(asOutsider.status).toBe(404);
  });

  it("refuses to turn it on from outside the call, and when the flag is off; off is always allowed", async () => {
    const { voiceChannelId } = await makeServer();
    const notInCall = await call(owner, "PUT", `/api/channels/${voiceChannelId}/voice-audience`, {
      enabled: true,
    });
    expect(notInCall.status).toBe(409);

    await joinVoice(owner.id, voiceChannelId);
    process.env.AUDIENCE_MODE = "false";
    const flagOff = await call(owner, "PUT", `/api/channels/${voiceChannelId}/voice-audience`, {
      enabled: true,
    });
    expect(flagOff.status).toBe(403);
    const offAnyway = await call(owner, "PUT", `/api/channels/${voiceChannelId}/voice-audience`, {
      enabled: false,
    });
    expect(offAnyway.status).toBe(200);
  });

  it("is for voice channels only: a watch party is refused", async () => {
    const { serverId } = await makeServer();
    const created = await call<{ channel: { id: string } }>(
      owner,
      "POST",
      `/api/servers/${serverId}/channels`,
      { name: "cinema", type: "voice" },
    );
    const watchPartyId = created.body.channel.id;
    await getPool().query(`UPDATE channels SET type = 'watch_party' WHERE id = $1`, [watchPartyId]);
    const refused = await call(owner, "PUT", `/api/channels/${watchPartyId}/voice-audience`, {
      enabled: true,
    });
    expect(refused.status).toBe(400);
  });

  it("letting somebody speak: needs the bit, audience mode on, and the person in the call", async () => {
    const { voiceChannelId } = await makeServer();
    await joinVoice(owner.id, voiceChannelId);
    const path = `/api/channels/${voiceChannelId}/voice-audience/speakers/${member.id}`;

    // A target that is not a member id at all never reaches Postgres: the
    // router refuses any `*Id` param that is not a UUID (lib/router.ts), as
    // a 404 like every other route, never a 500.
    expect(
      (
        await call(owner, "PUT", `/api/channels/${voiceChannelId}/voice-audience/speakers/not-a-uuid`, {
          allowed: true,
        })
      ).status,
    ).toBe(404);
    // Not in the call yet.
    expect((await call(owner, "PUT", path, { allowed: true })).status).toBe(404);
    await joinVoice(member.id, voiceChannelId);
    // Audience mode is off.
    expect((await call(owner, "PUT", path, { allowed: true })).status).toBe(409);

    await call(owner, "PUT", `/api/channels/${voiceChannelId}/voice-audience`, { enabled: true });
    // A member cannot invite anybody, themselves included.
    expect((await call(member, "PUT", path, { allowed: true })).status).toBe(403);
    // The host does not invite themselves.
    expect(
      (
        await call(
          owner,
          "PUT",
          `/api/channels/${voiceChannelId}/voice-audience/speakers/${owner.id}`,
          { allowed: true },
        )
      ).status,
    ).toBe(400);

    const granted = await call<{ audience: { speakerUserIds: string[] } }>(owner, "PUT", path, {
      allowed: true,
    });
    expect(granted.status).toBe(200);
    expect(granted.body.audience.speakerUserIds).toEqual([member.id]);
    const revoked = await call<{ audience: { speakerUserIds: string[] } }>(owner, "PUT", path, {
      allowed: false,
    });
    expect(revoked.body.audience.speakerUserIds).toEqual([]);
  });
});
