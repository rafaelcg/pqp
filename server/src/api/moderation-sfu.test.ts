import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WebSocket } from "ws";
import type { DbUser } from "../db.js";

/**
 * Moderation against a LiveKit deployment, end to end through the real routes,
 * SQL and eviction wiring — with only the identity layer and the LiveKit RPCs
 * faked.
 *
 * Two properties are load-bearing and neither is visible from an HTTP response:
 *
 * 1. A kick or a ban reaches the SFU. Before this existed, the membership row
 *    disappeared and the person carried on talking in the live call.
 * 2. A ban that cannot reach the SFU is still a ban. The eviction runs after
 *    the row is committed and can never unwind it — an unreachable SFU must
 *    not turn "banned" into a 500 and no ban at all.
 */

// TEST_DATABASE_URL wins, for the same reason as in api.test.ts: a developer
// always has DATABASE_URL set, and these tests truncate what they touch.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

/** The identity the next request will authenticate as. */
let actor: { id: string; clerk_id: string } | null = null;

vi.mock("../auth/clerk.js", () => ({
  DEV_AUTH_TOKEN: "dev-local-token",
  isDevAuthBypassEnabled: () => false,
  assertAuthConfig: () => {},
  invalidateUserCache: () => {},
  clearAuthCaches: () => {},
  resolveAuthUser: async () => (actor ? { user: actor } : null),
  // Every actor in this suite is an adult who already answered the age
  // gate — the gate itself is proved end-to-end against a real database in
  // api/age-gate.test.ts, which does not stub this module.
  resolveAuthSession: async () =>
    actor ? { user: actor, ageGate: "passed" as const } : null,
  verifyAuthHeader: async () => null,
}));

const lk = vi.hoisted(() => ({
  listRooms: vi.fn(),
  listParticipants: vi.fn(),
  removeParticipant: vi.fn(),
}));

// Only the RPC surface is faked. `AccessToken` stays real, so the token this
// suite mints is the token a deployment would hand out.
vi.mock("livekit-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...actual,
    RoomServiceClient: class {
      listRooms = lk.listRooms;
      listParticipants = lk.listParticipants;
      removeParticipant = lk.removeParticipant;
    },
  };
});

const { handleApi, resetApiRateLimits } = await import("./index.js");
const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const { isBanned } = await import("../services/moderation.js");
const { handleVoiceMessage, resetVoiceRateLimits } = await import(
  "../ws/voice.js"
);
const { resetSfuAdminClient, settleSfuEvictions } = await import(
  "../voice/admin.js"
);

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
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describeDb("moderation ejects from the SFU", () => {
  let owner: { id: string; clerk_id: string };
  let member: { id: string; clerk_id: string };

  beforeAll(async () => {
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";

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
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    resetSfuAdminClient();
  });

  beforeEach(async () => {
    resetApiRateLimits();
    resetVoiceRateLimits();
    resetSfuAdminClient();
    lk.listRooms.mockReset().mockResolvedValue([]);
    lk.listParticipants.mockReset().mockResolvedValue([]);
    lk.removeParticipant.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await getPool().query(
      `TRUNCATE users, servers, channels, server_members, channel_members,
                server_bans
       RESTART IDENTITY CASCADE`,
    );

    owner = await upsertUser({
      clerkId: "clerk_sfu_owner",
      displayName: "Owner",
      avatarUrl: null,
    });
    member = await upsertUser({
      clerkId: "clerk_sfu_member",
      displayName: "Member",
      avatarUrl: null,
    });
  });

  /** A server with the member joined, plus its voice channel id. */
  async function makeServer() {
    const created = await call<{
      server: { id: string };
      channels: Array<{ id: string; type: string }>;
    }>(owner, "POST", "/api/servers", { name: "SFU test" });
    expect(created.status).toBe(201);

    const serverId = created.body.server.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
      [serverId, member.id],
    );
    const voiceChannel = created.body.channels.find((c) => c.type === "voice")!;
    // A two-member server opens its rooms on mesh under the transport policy
    // (voice/transport-policy.ts); these tests are about SFU rooms, so pin
    // the channel to the SFU the way a small streamer's server would.
    await getPool().query(
      `UPDATE channels SET voice_transport = 'livekit' WHERE id = $1`,
      [voiceChannel.id],
    );
    return { serverId, voiceChannelId: voiceChannel.id };
  }

  async function asDbUser(id: string): Promise<DbUser> {
    const result = await getPool().query<DbUser>(
      `SELECT * FROM users WHERE id = $1`,
      [id],
    );
    return result.rows[0]!;
  }

  /** Put the member in the voice room and return their peer id. */
  async function joinVoice(voiceChannelId: string): Promise<string> {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      send: (payload: string) => sent.push(payload),
      on: () => {},
    } as unknown as WebSocket;

    await handleVoiceMessage(
      { socket, user: await asDbUser(member.id) },
      { type: "join-voice-room", voiceChannelId },
    );
    const welcome = sent
      .map((raw) => JSON.parse(raw) as { type: string; peerId?: string })
      .find((message) => message.type === "welcome");
    expect(welcome).toBeDefined();
    return welcome!.peerId!;
  }

  it("removes the banned participant from the LiveKit room", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    const peerId = await joinVoice(voiceChannelId);
    lk.listRooms.mockResolvedValue([{ name: voiceChannelId }]);
    lk.listParticipants.mockResolvedValue([
      { identity: peerId, metadata: JSON.stringify({ userId: member.id }) },
    ]);

    const banned = await call(
      owner,
      "DELETE",
      `/api/servers/${serverId}/members/${member.id}`,
      { ban: true },
    );
    expect(banned.status).toBe(200);
    await settleSfuEvictions();

    expect(lk.removeParticipant).toHaveBeenCalledTimes(1);
    const [room, identity, options] = lk.removeParticipant.mock.calls[0]!;
    expect(room).toBe(voiceChannelId);
    expect(identity).toBe(peerId);
    // Not just a disconnect: the token they already hold is voided too.
    expect(typeof options.revokeTokenTs).toBe("bigint");
  });

  it("removes the kicked participant too, not only the banned one", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    const peerId = await joinVoice(voiceChannelId);
    lk.listRooms.mockResolvedValue([{ name: voiceChannelId }]);
    lk.listParticipants.mockResolvedValue([
      { identity: peerId, metadata: JSON.stringify({ userId: member.id }) },
    ]);

    const kicked = await call(
      owner,
      "DELETE",
      `/api/servers/${serverId}/members/${member.id}`,
      { ban: false },
    );
    expect(kicked.status).toBe(200);
    await settleSfuEvictions();

    expect(lk.removeParticipant).toHaveBeenCalledWith(
      voiceChannelId,
      peerId,
      expect.anything(),
    );
  });

  it("still records the ban when the SFU is unreachable", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    await joinVoice(voiceChannelId);
    lk.listRooms.mockRejectedValue(new Error("livekit unreachable"));

    const banned = await call(
      owner,
      "DELETE",
      `/api/servers/${serverId}/members/${member.id}`,
      { ban: true },
    );

    expect(banned.status).toBe(200);
    expect(await isBanned(serverId, member.id)).toBe(true);
    await expect(settleSfuEvictions()).resolves.toBeUndefined();
  });

  /**
   * Ejecting somebody who can walk straight back in is theater. Two things stop
   * the rejoin: the token they hold is revoked at the SFU (asserted above), and
   * a replacement cannot be minted — the peer record the mint path authenticates
   * against is destroyed by the same eviction, and channel access is gone.
   */
  it("closes the token path behind the ban", async () => {
    const { serverId, voiceChannelId } = await makeServer();
    const peerId = await joinVoice(voiceChannelId);

    // Sanity: a working mint before the ban, so the 403 below is the ban's
    // doing and not a malformed request.
    const before = await call(member, "POST", "/api/voice/token", {
      voiceChannelId,
      peerId,
    });
    expect(before.status).toBe(200);

    await call(
      owner,
      "DELETE",
      `/api/servers/${serverId}/members/${member.id}`,
      { ban: true },
    );
    await settleSfuEvictions();

    // The peer record the mint path authenticates against went with the
    // eviction, so the credential cannot be re-issued for the old identity...
    const after = await call(member, "POST", "/api/voice/token", {
      voiceChannelId,
      peerId,
    });
    expect(after.status).toBe(403);

    // ...and rejoining voice over the WebSocket is refused, so no *new* peer id
    // — and therefore no new token — can be obtained either.
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      send: (payload: string) => sent.push(payload),
      on: () => {},
    } as unknown as WebSocket;
    await handleVoiceMessage(
      { socket, user: await asDbUser(member.id) },
      { type: "join-voice-room", voiceChannelId },
    );
    expect(sent).toEqual([]);
  });
});
