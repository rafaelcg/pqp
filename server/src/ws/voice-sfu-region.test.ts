import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
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
 * SFU regions through the real join handler, against a real Postgres, with
 * `VOICE_REGISTRY=postgres` ON (CLAUDE.md pitfall 12: production sets the
 * flag, so the flag is what the test sets), and once with it off where the
 * off path is the point.
 *
 * What is pinned: a server's recently active members pick the box when
 * they hold a clear majority, whoever opens the room, and the whole path
 * runs with `CLUSTER_BUS=postgres` on too (a bus transport installed), as
 * production does; with too few known members the first joiner's country picks the box; everybody after
 * goes to that box; a second API instance adopts the stored region instead of
 * deciding its own; a resume across a restart keeps the box, with the
 * registry (the row) and without it (the resume token); a phone-shaped
 * client that never declared `sfu-region` opens rooms by the same policy,
 * and keeps them home only under the rollback `LIVEKIT_REGION_REQUIRE_CAP`;
 * a watch party keeps the room home; and with `LIVEKIT_REGIONS` unset
 * nothing is written at all.
 *
 * TEST_DATABASE_URL wins, and the suite skips without a database.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

vi.mock("../voice/backends.js", () => ({
  getServerVoiceBackend: () => "livekit",
  isLiveKitConfigured: () => true,
}));

vi.mock("../services/users.js", () => ({
  resolveMemberName: async (
    _serverId: string | null,
    user: { display_name: string },
  ) => user.display_name,
  canAccessChannel: async () => true,
}));

vi.mock("../services/sanctions.js", () => ({
  findTimeoutForChannel: async () => null,
  timeoutMessage: () => "",
}));

vi.mock("../services/permissions.js", () => ({
  computeMemberPermissions: async () => (1n << 64n) - 1n,
  resolveMemberChannelPermissions: async () => ({
    permissions: (1n << 64n) - 1n,
    nickname: null,
  }),
}));

vi.mock("../services/dms.js", () => ({
  isDmSendBlocked: async () => false,
}));

const channelTypes = vi.hoisted(() => new Map<string, string>());
const channelServers = vi.hoisted(() => new Map<string, string>());

vi.mock("../services/servers.js", () => ({
  getChannel: async (id: string) => ({
    id,
    kind: "server",
    type: channelTypes.get(id) ?? "voice",
    server_id: channelServers.get(id) ?? null,
  }),
  getChannelAudience: async () => null,
  // No server row: the transport policy answers `livekit` / `default`, so
  // every room here is an SFU room and the region is the thing under test.
  getServerVoiceProfile: async () => null,
}));

vi.mock("../voice/admin.js", () => ({
  evictSfuRoom: vi.fn(() => Promise.resolve()),
  evictSfuUser: vi.fn(() => Promise.resolve()),
  evictSfuUsersExcept: vi.fn(() => Promise.resolve()),
  setSfuUserCanPublish: vi.fn(() => Promise.resolve(true)),
  cancelSfuPrivateResweep: vi.fn(() => Promise.resolve()),
  tickSfuResweeps: vi.fn(() => Promise.resolve(0)),
}));

const { getPool, initDb, closePool } = await import("../db.js");
const {
  handleVoiceMessage,
  removeVoicePeerBySocket,
  resetVoicePeers,
  resetVoiceRateLimits,
  resetVoiceRoomTransports,
} = await import("./voice.js");
const { settleVoiceRegistryWrites } = await import("../voice/registry.js");
const { resetRegionAudience } = await import("../voice/region-audience.js");
const { createMemoryHub, createMemoryTransport, setBusTransport } = await import(
  "../lib/bus.js"
);
const { noteSocketCountry, pinnedRoomRegion, SFU_REGION_CAP } = await import(
  "../voice/regions.js"
);
const { setAuthenticatedSocket, deleteAuthenticatedSocket } = await import(
  "./sockets.js"
);

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface Recorder {
  socket: WebSocket;
  frames: Frame[];
  user: DbUser;
}

const opened: Recorder[] = [];

/**
 * A socket as the upgrade left it: a country from Cloudflare (or none) and
 * the caps its `auth` frame declared.
 */
function client(
  country: string | null,
  options: { caps?: boolean; userId?: string } = {},
): Recorder {
  const frames: Frame[] = [];
  const socket = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Frame),
    on: () => {},
  } as unknown as WebSocket;
  const id = options.userId ?? randomUUID();
  const user = {
    id,
    display_name: `User ${id.slice(0, 8)}`,
    avatar_url: null,
  } as unknown as DbUser;
  noteSocketCountry(socket, country ? { "cf-ipcountry": country } : {});
  setAuthenticatedSocket(
    socket,
    user,
    options.caps === false ? [] : [SFU_REGION_CAP],
  );
  const rec = { socket, frames, user };
  opened.push(rec);
  return rec;
}

function welcome(rec: Recorder): Frame | undefined {
  return rec.frames.find((f) => f.type === "welcome");
}

async function join(
  rec: Recorder,
  voiceChannelId: string,
  resume: { peerId: string; token: string } | null = null,
): Promise<Recorder> {
  await handleVoiceMessage(
    { socket: rec.socket, user: rec.user },
    {
      type: "join-voice-room",
      voiceChannelId,
      resume: true,
      transports: ["mesh", "livekit"],
      ...(resume ? { resumePeerId: resume.peerId, resumeToken: resume.token } : {}),
    },
  );
  await settleVoiceRegistryWrites();
  return rec;
}

async function storedRegion(channelId: string): Promise<string | null | undefined> {
  const result = await getPool().query<{ sfu_region: string | null }>(
    `SELECT sfu_region FROM voice_rooms WHERE channel_id = $1`,
    [channelId],
  );
  return result.rows[0]?.sfu_region;
}

function tokenClaims(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

/** A process restart, or the other API replica: none of the in-process maps. */
function restart(): void {
  resetVoicePeers();
  resetVoiceRoomTransports();
}

const SAVED = [
  "VOICE_REGISTRY",
  "CLUSTER_BUS",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_REGIONS",
  "LIVEKIT_REGION_COUNTRIES",
  "LIVEKIT_REGION_REQUIRE_CAP",
  "CLERK_SECRET_KEY",
] as const;
const saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));

describeDb("voice room SFU region", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
    for (const name of SAVED) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  beforeEach(async () => {
    process.env.VOICE_REGISTRY = "postgres";
    process.env.CLUSTER_BUS = "postgres";
    setBusTransport(createMemoryTransport(createMemoryHub()));
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    process.env.LIVEKIT_REGIONS = "mia:wss://sfu-mia.example.test";
    process.env.LIVEKIT_REGION_COUNTRIES = "US:mia,CA:mia";
    delete process.env.LIVEKIT_REGION_REQUIRE_CAP;
    process.env.CLERK_SECRET_KEY ??= "sk_test_regions";
    channelTypes.clear();
    channelServers.clear();
    resetRegionAudience();
    restart();
    resetVoiceRateLimits();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await getPool().query(
      `TRUNCATE voice_rooms, voice_peers, voice_server_mutes, voice_raised_hands, voice_retired_peers, voice_instances`,
    );
  });

  afterEach(async () => {
    await settleVoiceRegistryWrites();
    for (const rec of opened) {
      deleteAuthenticatedSocket(rec.socket);
    }
    opened.length = 0;
    restart();
    setBusTransport(null);
    vi.restoreAllMocks();
  });

  /**
   * A server whose members were last seen in these countries, with a voice
   * channel in it. Real rows: the tally is the query under test.
   */
  async function serverChannel(countries: string[]): Promise<string> {
    const pool = getPool();
    const ids: string[] = [];
    for (const country of countries) {
      const user = await pool.query<{ id: string }>(
        `INSERT INTO users (clerk_id, display_name, last_country, last_country_at)
         VALUES ($1, 'Member', $2, NOW() - INTERVAL '1 day') RETURNING id`,
        [`clerk_region_${randomUUID()}`, country],
      );
      ids.push(user.rows[0]!.id);
    }
    const server = await pool.query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('region', $1) RETURNING id`,
      [ids[0]],
    );
    for (const id of ids) {
      await pool.query(
        `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member')`,
        [server.rows[0]!.id, id],
      );
    }
    const channel = randomUUID();
    channelServers.set(channel, server.rows[0]!.id);
    return channel;
  }

  it("a Brazilian server stays home when a visitor from the US opens the room", async () => {
    const log = vi.mocked(console.log);
    const channel = await serverChannel(["BR", "BR", "BR", "BR", "BR", "US"]);
    const visitor = await join(client("US"), channel);
    const local = await join(client("BR"), channel);

    expect(await storedRegion(channel)).toBe("sao");
    expect(pinnedRoomRegion(channel)).toBe("sao");
    expect(tokenClaims(welcome(visitor)!.resumeToken as string).r).toBe("sao");
    expect(tokenClaims(welcome(local)!.resumeToken as string).r).toBe("sao");
    const line = log.mock.calls
      .map((call) => String(call[0]))
      .find((text) => text.includes("voice.regionPinned"));
    expect(line).toContain("reason=server-majority");
    expect(line).toContain("share=0.83");
    expect(line).toContain("sample=6");
  });

  it("a North American server goes to Miami, even when a Brazilian opens it", async () => {
    const channel = await serverChannel(["US", "US", "CA", "US", "BR"]);
    await join(client("BR"), channel);
    expect(await storedRegion(channel)).toBe("mia");
  });

  it("a split server stays home, whoever opens it", async () => {
    const channel = await serverChannel(["US", "US", "US", "BR", "BR", "BR"]);
    await join(client("US"), channel);
    expect(await storedRegion(channel)).toBe("sao");
  });

  it("an override naming a region no longer configured still consults the server", async () => {
    const channel = await serverChannel(["BR", "BR", "BR", "BR", "BR"]);
    await getPool().query(
      `INSERT INTO channels (id, server_id, name, type, position, sfu_region)
       VALUES ($1, $2, 'voz', 'voice', 0, 'lon')`,
      [channel, channelServers.get(channel)],
    );
    await join(client("US"), channel);
    expect(await storedRegion(channel)).toBe("sao");
  });

  it("too few known members: the first joiner's country, as before", async () => {
    const channel = await serverChannel(["BR", "BR"]);
    await join(client("US"), channel);
    expect(await storedRegion(channel)).toBe("mia");
  });

  it("the other replica adopts a server-majority pin rather than re-deciding", async () => {
    const channel = await serverChannel(["US", "US", "US", "US", "US"]);
    await join(client("BR"), channel);
    expect(await storedRegion(channel)).toBe("mia");
    restart();
    resetRegionAudience();
    // Replica B's tally has changed its mind (members moved); the room is
    // still Miami while anybody is in it.
    await getPool().query(
      `UPDATE users SET last_country = 'BR'
        WHERE id IN (SELECT user_id FROM server_members WHERE server_id = $1)`,
      [channelServers.get(channel)],
    );
    const b = await join(client("BR"), channel);
    expect(tokenClaims(welcome(b)!.resumeToken as string).r).toBe("mia");
  });

  it("writes no region and mints no region claim with LIVEKIT_REGIONS unset", async () => {
    delete process.env.LIVEKIT_REGIONS;
    const channel = randomUUID();
    const a = await join(client("US"), channel);

    expect(welcome(a)?.transport).toBe("livekit");
    expect(await storedRegion(channel)).toBeNull();
    expect(pinnedRoomRegion(channel)).toBeNull();
    expect(tokenClaims(welcome(a)!.resumeToken as string)).not.toHaveProperty("r");
  });

  it("pins the first joiner's region, and everybody after goes there", async () => {
    const channel = randomUUID();
    const a = await join(client("US"), channel);
    const b = await join(client("BR"), channel);

    expect(await storedRegion(channel)).toBe("mia");
    expect(pinnedRoomRegion(channel)).toBe("mia");
    expect(tokenClaims(welcome(a)!.resumeToken as string).r).toBe("mia");
    // The Brazilian joins the Miami room: one room, one box.
    expect(tokenClaims(welcome(b)!.resumeToken as string).r).toBe("mia");
  });

  it("an unmapped country opens on home", async () => {
    const channel = randomUUID();
    await join(client("BR"), channel);
    expect(await storedRegion(channel)).toBe("sao");
  });

  it("a phone-shaped first joiner (no sfu-region cap) follows the region policy by default", async () => {
    const channel = randomUUID();
    const phone = await join(client("US", { caps: false }), channel);
    const next = await join(client("BR"), channel);

    expect(await storedRegion(channel)).toBe("mia");
    expect(tokenClaims(welcome(phone)!.resumeToken as string).r).toBe("mia");
    expect(tokenClaims(welcome(next)!.resumeToken as string).r).toBe("mia");
  });

  it("a phone opening a Brazilian server's room follows the server, not its own country", async () => {
    const channel = await serverChannel(["BR", "BR", "BR", "BR", "BR"]);
    await join(client("US", { caps: false }), channel);
    expect(await storedRegion(channel)).toBe("sao");
    const other = await serverChannel(["US", "US", "US", "US", "CA"]);
    await join(client("BR", { caps: false }), other);
    expect(await storedRegion(other)).toBe("mia");
  });

  it("LIVEKIT_REGION_REQUIRE_CAP=true keeps a room home when its first joiner lacks the cap", async () => {
    process.env.LIVEKIT_REGION_REQUIRE_CAP = "true";
    const majority = await serverChannel(["US", "US", "US", "US", "US"]);
    await join(client("US", { caps: false }), majority);
    expect(await storedRegion(majority)).toBe("sao");
    const channel = randomUUID();
    const old = await join(client("US", { caps: false }), channel);
    const next = await join(client("US"), channel);

    expect(await storedRegion(channel)).toBe("sao");
    expect(tokenClaims(welcome(old)!.resumeToken as string).r).toBe("sao");
    expect(tokenClaims(welcome(next)!.resumeToken as string).r).toBe("sao");
  });

  it("keeps a watch party channel home, whoever opens it", async () => {
    const channel = randomUUID();
    channelTypes.set(channel, "watch_party");
    await join(client("US"), channel);
    expect(await storedRegion(channel)).toBe("sao");
    expect(pinnedRoomRegion(channel)).toBe("sao");
  });

  it("the other API replica adopts the stored region instead of deciding its own", async () => {
    const channel = randomUUID();
    await join(client("US"), channel);
    expect(await storedRegion(channel)).toBe("mia");

    // Replica B: same database, none of A's maps. Its joiner is Brazilian,
    // so B's own decision would be home; the row says Miami.
    restart();
    const b = await join(client("BR"), channel);

    expect(pinnedRoomRegion(channel)).toBe("mia");
    expect(tokenClaims(welcome(b)!.resumeToken as string).r).toBe("mia");
    expect(await storedRegion(channel)).toBe("mia");
  });

  it("a room row naming a region since removed from the config is home", async () => {
    const channel = randomUUID();
    await getPool().query(
      `INSERT INTO voice_rooms (channel_id, transport, sfu_region) VALUES ($1, 'livekit', 'lon')`,
      [channel],
    );
    await join(client("US"), channel);
    expect(pinnedRoomRegion(channel)).toBe("sao");
  });

  it("a resume across an API restart keeps the region (registry on: the row)", async () => {
    const channel = randomUUID();
    const userId = randomUUID();
    const first = await join(client("US", { userId }), channel);
    const hello = welcome(first)!;
    removeVoicePeerBySocket(first.socket);
    await settleVoiceRegistryWrites();

    restart();
    // Same person, now seen from a Brazilian edge (a VPN, a phone that
    // roamed): the room stays where its media is.
    const again = await join(client("BR", { userId }), channel, {
      peerId: hello.peerId as string,
      token: hello.resumeToken as string,
    });

    expect(welcome(again)).toMatchObject({ peerId: hello.peerId, resumed: true });
    expect(pinnedRoomRegion(channel)).toBe("mia");
    expect(await storedRegion(channel)).toBe("mia");
  });

  it("a phone that opened a room off home resumes onto the same box after a restart", async () => {
    // iOS in a LiveKit room keeps its media across an API restart and
    // presents the claim; it never declared `sfu-region`. The resume token
    // must name the box it is on, and the reconstructed pin must agree, or
    // the next token minted for the room would point at another box.
    const channel = randomUUID();
    const userId = randomUUID();
    const first = await join(client("US", { userId, caps: false }), channel);
    const hello = welcome(first)!;
    expect(tokenClaims(hello.resumeToken as string).r).toBe("mia");
    removeVoicePeerBySocket(first.socket);
    await settleVoiceRegistryWrites();

    restart();
    const again = await join(client("US", { userId, caps: false }), channel, {
      peerId: hello.peerId as string,
      token: hello.resumeToken as string,
    });

    expect(welcome(again)).toMatchObject({ peerId: hello.peerId, resumed: true });
    expect(pinnedRoomRegion(channel)).toBe("mia");
    expect(await storedRegion(channel)).toBe("mia");
  });

  it("a resume across an API restart keeps the region (registry off: the token)", async () => {
    process.env.VOICE_REGISTRY = "off";
    const channel = randomUUID();
    const userId = randomUUID();
    const first = await join(client("US", { userId }), channel);
    const hello = welcome(first)!;
    removeVoicePeerBySocket(first.socket);

    restart();
    const again = await join(client("BR", { userId }), channel, {
      peerId: hello.peerId as string,
      token: hello.resumeToken as string,
    });

    expect(welcome(again)).toMatchObject({ peerId: hello.peerId, resumed: true });
    expect(pinnedRoomRegion(channel)).toBe("mia");
  });

  it("a resume holding media on another box is a cold join, never a split", async () => {
    process.env.VOICE_REGISTRY = "off";
    const channel = randomUUID();
    const userId = randomUUID();
    const first = await join(client("US", { userId }), channel);
    const hello = welcome(first)!;
    removeVoicePeerBySocket(first.socket);

    // After a restart somebody else reopens the room first, from Brazil,
    // so it is home now; the Miami token must not reconstruct into it.
    restart();
    await join(client("BR"), channel);
    expect(pinnedRoomRegion(channel)).toBe("sao");

    const again = await join(client("US", { userId }), channel, {
      peerId: hello.peerId as string,
      token: hello.resumeToken as string,
    });
    expect(welcome(again)?.peerId).not.toBe(hello.peerId);
    expect(welcome(again)?.resumed).toBeUndefined();
    expect(tokenClaims(welcome(again)!.resumeToken as string).r).toBe("sao");
  });
});
