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
const { canSearchWithoutWords, decodeSearchCursor, parseSearchFilters, searchMessages } = await import("./search.js");

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

  it("puts the day boundary at the viewer's midnight", async () => {
    // 02:00Z on the 15th is 23:00 on the 14th in UTC-3, and 05:00 on the 15th in UTC+3.
    const night = await post(general, ana.id, "mapa noite", "2026-10-15T02:00:00Z");
    const day = await post(general, ana.id, "mapa dia", "2026-10-15T12:00:00Z");
    expect(await find({ since: "2026-10-15" })).toEqual([night, day].sort());
    expect(await find({ since: "2026-10-15", tz: -180 })).toEqual([day]);
    expect(await find({ until: "2026-10-15", tz: -180 })).toEqual([night]);
    expect(await find({ since: "2026-10-15", tz: 180 })).toEqual([night, day].sort());
    expect(await find({ until: "2026-10-15", tz: 180 })).toEqual([]);
  });

  it("runs a filter with no words, newest first", async () => {
    const old = await post(general, bia.id, "um", "2026-10-01T10:00:00Z");
    const mid = await post(general, bia.id, "dois", "2026-10-02T10:00:00Z");
    await post(general, ana.id, "três", "2026-10-03T10:00:00Z");
    const page = await searchMessages(serverId, ana.id, "", 1, undefined, { authorId: bia.id });
    expect(page.results.map((r) => r.messageId)).toEqual([mid]);
    expect(page.results[0]!.snippet).toBe("dois");
    expect(page.hasMore).toBe(true);
    const all = await searchMessages(serverId, ana.id, "", 20, undefined, { authorId: bia.id });
    expect(all.results.map((r) => r.messageId)).toEqual([mid, old]);
  });

  it("pages a channel search with no words through the window", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(await post(general, bia.id, `m${i}`, `2026-10-0${i}T10:00:00Z`));
    }
    // A thread under the channel is part of the scope.
    const thread = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, parent_id, position) VALUES ($1, 't', 'thread', $2, 10) RETURNING id`,
      [serverId, general],
    );
    const inThread = await post(thread.rows[0]!.id, bia.id, "fio", "2026-10-06T10:00:00Z");
    await post(offTopic, bia.id, "fora", "2026-10-07T10:00:00Z");
    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeSearchCursor> | undefined;
    let pages = 0;
    for (;;) {
      const page = await searchMessages(serverId, ana.id, "", 20, cursor ?? undefined, { channelId: general, has: undefined }, 2);
      seen.push(...page.results.map((r) => r.messageId));
      pages++;
      if (!page.hasMore) break;
      cursor = decodeSearchCursor(page.nextCursor!);
      expect(pages).toBeLessThan(10);
    }
    expect(seen).toEqual([inThread, ...ids.slice().reverse()]);
    // 6 candidates through a window of 2: three full windows, then an empty one.
    expect(pages).toBe(4);
  });

  it("pages an author search with no words, and filters inside the window", async () => {
    const a = await post(general, bia.id, "https://a.example", "2026-10-01T10:00:00Z");
    await post(general, bia.id, "sem link", "2026-10-02T10:00:00Z");
    const c = await post(offTopic, bia.id, "https://c.example", "2026-10-03T10:00:00Z");
    await post(general, ana.id, "https://ana.example", "2026-10-04T10:00:00Z");
    const first = await searchMessages(serverId, ana.id, "", 20, undefined, { authorId: bia.id, has: "link" }, 2);
    expect(first.results.map((r) => r.messageId)).toEqual([c]);
    expect(first.hasMore).toBe(true);
    const second = await searchMessages(
      serverId,
      ana.id,
      "",
      20,
      decodeSearchCursor(first.nextCursor!)!,
      { authorId: bia.id, has: "link" },
      2,
    );
    expect(second.results.map((r) => r.messageId)).toEqual([a]);
    expect(second.hasMore).toBe(false);
  });

  it("refuses to run with no words and no channel or author", async () => {
    await expect(searchMessages(serverId, ana.id, "", 20, undefined, { has: "link" })).rejects.toThrow();
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
      tz: undefined,
    });
  });

  it("keeps the offset only as a whole number of minutes in range", () => {
    const tz = (value: string) => parseSearchFilters(new URLSearchParams({ tz: value })).tz;
    expect(tz("-180")).toBe(-180);
    expect(tz("840")).toBe(840);
    expect(tz("841")).toBeUndefined();
    expect(tz("-841")).toBeUndefined();
    expect(tz("1.5")).toBeUndefined();
    expect(tz("abc")).toBeUndefined();
    expect(parseSearchFilters(new URLSearchParams()).tz).toBeUndefined();
  });

  it("allows no words only with a channel or an author", () => {
    expect(canSearchWithoutWords({})).toBe(false);
    expect(canSearchWithoutWords({ tz: -180 })).toBe(false);
    expect(canSearchWithoutWords({ has: "link" })).toBe(false);
    expect(canSearchWithoutWords({ until: "2026-10-30" })).toBe(false);
    expect(canSearchWithoutWords({ mentionsId: "x" })).toBe(false);
    expect(canSearchWithoutWords({ channelId: "x" })).toBe(true);
    expect(canSearchWithoutWords({ authorId: "x" })).toBe(true);
  });

  it("accepts a real day and drops one the calendar does not have", () => {
    const filters = (since: string, until: string) =>
      parseSearchFilters(new URLSearchParams({ since, until }));
    expect(filters("2026-02-28", "2024-02-29")).toMatchObject({
      since: "2026-02-28",
      until: "2024-02-29",
    });
    expect(filters("2026-02-31", "2026-13-01")).toMatchObject({
      since: undefined,
      until: undefined,
    });
  });
});
