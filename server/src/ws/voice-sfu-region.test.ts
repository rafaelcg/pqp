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
 * What is pinned: the first joiner's country picks the box; everybody after
 * goes to that box; a second API instance adopts the stored region instead of
 * deciding its own; a resume across a restart keeps the box, with the
 * registry (the row) and without it (the resume token); an old client and a
 * watch party keep the room home; and with `LIVEKIT_REGIONS` unset nothing
 * is written at all.
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

vi.mock("../services/servers.js", () => ({
  getChannel: async (id: string) => ({
    id,
    kind: "server",
    type: channelTypes.get(id) ?? "voice",
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
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_REGIONS",
  "LIVEKIT_REGION_COUNTRIES",
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
    process.env.LIVEKIT_URL = "wss://sfu.example.test";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";
    process.env.LIVEKIT_REGIONS = "mia:wss://sfu-mia.example.test";
    process.env.LIVEKIT_REGION_COUNTRIES = "US:mia,CA:mia";
    process.env.CLERK_SECRET_KEY ??= "sk_test_regions";
    channelTypes.clear();
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
    vi.restoreAllMocks();
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

  it("keeps a room home when its first joiner is an old client without the cap", async () => {
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
