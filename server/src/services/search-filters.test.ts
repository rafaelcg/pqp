import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The header search's chips: each filter only removes rows, and together
 * they narrow the same words to one channel, one author, a kind of content
 * or a range of days.
 *
 * Only `TEST_DATABASE_URL`, never the dev database: every case truncates.
 */
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const { parseSearchFilters, searchMessages } = await import("./search.js");

describeDb("search filters", () => {
  let ana: { id: string };
  let bia: { id: string };
  let serverId: string;
  let general: string;
  let offTopic: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    ana = await upsertUser({ clerkId: "clerk_ana", displayName: "Ana", avatarUrl: null });
    bia = await upsertUser({ clerkId: "clerk_bia", displayName: "Bia", avatarUrl: null });
    const created = await createServer("Servidor", ana.id);
    serverId = created.server.id;
    general = created.channels.find((c) => c.type === "text")!.id;
    const other = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'off-topic', 'text', 9) RETURNING id`,
      [serverId],
    );
    offTopic = other.rows[0]!.id;
    await getPool().query(`INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [
      serverId,
      bia.id,
    ]);
  });

  async function post(
    channelId: string,
    authorId: string,
    body: string,
    createdAt = "2026-10-15T12:00:00Z",
  ): Promise<string> {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body, created_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [channelId, authorId, body, createdAt],
    );
    return rows[0]!.id;
  }

  async function find(filters: Parameters<typeof searchMessages>[5]): Promise<string[]> {
    const { results } = await searchMessages(serverId, ana.id, "mapa", 20, undefined, filters);
    return results.map((r) => r.messageId).sort();
  }

  it("narrows to one channel, one author, or both", async () => {
    const a = await post(general, ana.id, "o mapa novo");
    const b = await post(general, bia.id, "cadê o mapa");
    const c = await post(offTopic, bia.id, "mapa velho");
    expect(await find({})).toEqual([a, b, c].sort());
    expect(await find({ channelId: general })).toEqual([a, b].sort());
    expect(await find({ authorId: bia.id })).toEqual([b, c].sort());
    expect(await find({ channelId: general, authorId: bia.id })).toEqual([b]);
  });

  it("finds links, images and files apart", async () => {
    const link = await post(general, ana.id, "mapa: https://drive.example/x");
    const image = await post(general, ana.id, "mapa em foto");
    const file = await post(general, ana.id, "mapa em pdf");
    await post(general, ana.id, "mapa só texto");
    await getPool().query(
      `INSERT INTO message_attachments (message_id, channel_id, uploader_id, storage_key, filename, content_type, byte_size)
       VALUES ($1, $3, $4, 'k1', 'mapa.png', 'image/png', 10), ($2, $3, $4, 'k2', 'mapa.pdf', 'application/pdf', 10)`,
      [image, file, general, ana.id],
    );
    expect(await find({ has: "link" })).toEqual([link]);
    expect(await find({ has: "image" })).toEqual([image]);
    expect(await find({ has: "file" })).toEqual([file]);
  });

  it("keeps a range of days, until exclusive", async () => {
    const early = await post(general, ana.id, "mapa um", "2026-10-01T10:00:00Z");
    const mid = await post(general, ana.id, "mapa dois", "2026-10-15T10:00:00Z");
    const late = await post(general, ana.id, "mapa três", "2026-10-30T10:00:00Z");
    expect(await find({ since: "2026-10-15" })).toEqual([mid, late].sort());
    expect(await find({ until: "2026-10-15" })).toEqual([early]);
    expect(await find({ since: "2026-10-02", until: "2026-10-30" })).toEqual([mid]);
  });

  it("finds the messages that mention someone", async () => {
    const mention = await post(general, ana.id, "mapa pra ti");
    await post(general, ana.id, "mapa pra ninguém");
    await getPool().query(`INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2)`, [mention, bia.id]);
    expect(await find({ mentionsId: bia.id })).toEqual([mention]);
  });
});

describe("parseSearchFilters", () => {
  it("drops a malformed value instead of refusing the search", () => {
    const params = new URLSearchParams({
      channelId: "not-a-uuid",
      has: "video",
      since: "ontem",
      until: "2026-10-30",
      authorId: "00000000-0000-4000-8000-000000000001",
    });
    expect(parseSearchFilters(params)).toEqual({
      channelId: undefined,
      authorId: "00000000-0000-4000-8000-000000000001",
      mentionsId: undefined,
      has: undefined,
      since: undefined,
      until: "2026-10-30",
    });
  });
});
