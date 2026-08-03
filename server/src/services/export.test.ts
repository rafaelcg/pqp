import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * `buildServerExport` aggregates several tables into one document, so these
 * drive real SQL against a real Postgres rather than mocking each read —
 * the join between messages, their authors, and their attachments is exactly
 * the part worth proving end to end.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { buildServerExport } = await import("./export.js");

describeDb("buildServerExport", () => {
  let ownerId: string;
  let memberId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members, message_attachments
       RESTART IDENTITY CASCADE`,
    );
    const owner = await upsertUser({
      clerkId: "clerk_export_owner",
      displayName: "Export Owner",
      avatarUrl: null,
    });
    ownerId = owner.id;
    const member = await upsertUser({
      clerkId: "clerk_export_member",
      displayName: "Export Member",
      avatarUrl: null,
    });
    memberId = member.id;
  });

  it("returns null for a server that does not exist", async () => {
    expect(
      await buildServerExport("00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });

  it("exports server info, channels, and members", async () => {
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id, message_retention_days)
       VALUES ('Export Test', $1, 90) RETURNING id`,
      [ownerId],
    );
    const serverId = server.rows[0]!.id;
    await getPool().query(
      `INSERT INTO channels (server_id, name, type, position, topic) VALUES
         ($1, 'general', 'text', 0, 'welcome'),
         ($1, 'Lobby', 'voice', 1, NULL)`,
      [serverId],
    );
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES
         ($1, $2, 'owner'), ($1, $3, 'member')`,
      [serverId, ownerId, memberId],
    );

    const data = await buildServerExport(serverId);
    expect(data).not.toBeNull();
    expect(data!.server).toMatchObject({
      id: serverId,
      name: "Export Test",
      ownerId,
      messageRetentionDays: 90,
    });
    expect(data!.channels).toMatchObject([
      { name: "general", type: "text", topic: "welcome" },
      { name: "Lobby", type: "voice", topic: null },
    ]);
    expect(data!.members.map((m) => m.role).sort()).toEqual(["member", "owner"]);
    expect(data!.truncated).toBe(false);
  });

  it("exports messages oldest-first, with author tag, edit/pin state, and attachment metadata", async () => {
    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('Export Test', $1) RETURNING id`,
      [ownerId],
    );
    const serverId = server.rows[0]!.id;
    const channel = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'general', 'text', 0) RETURNING id`,
      [serverId],
    );
    const channelId = channel.rows[0]!.id;

    const first = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body, created_at)
       VALUES ($1, $2, 'first', NOW() - INTERVAL '1 hour') RETURNING id`,
      [channelId, ownerId],
    );
    const second = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body, created_at, edited_at, pinned_at, pinned_by)
       VALUES ($1, $2, 'second', NOW(), NOW(), NOW(), $2) RETURNING id`,
      [channelId, ownerId],
    );
    await getPool().query(
      `INSERT INTO message_attachments
         (message_id, channel_id, uploader_id, storage_key, filename, content_type, byte_size, position)
       VALUES ($1, $2, $3, 'key/one.png', 'one.png', 'image/png', 1024, 0)`,
      [second.rows[0]!.id, channelId, ownerId],
    );

    const data = await buildServerExport(serverId);
    expect(data!.messages.map((m) => m.id)).toEqual([
      first.rows[0]!.id,
      second.rows[0]!.id,
    ]);

    const firstExported = data!.messages[0]!;
    expect(firstExported).toMatchObject({
      body: "first",
      authorId: ownerId,
      editedAt: null,
      pinnedAt: null,
      attachments: [],
    });

    const secondExported = data!.messages[1]!;
    expect(secondExported.editedAt).not.toBeNull();
    expect(secondExported.pinnedAt).not.toBeNull();
    expect(secondExported.attachments).toMatchObject([
      {
        filename: "one.png",
        contentType: "image/png",
        byteSize: 1024,
        storageKey: "key/one.png",
        remoteUrl: null,
      },
    ]);
  });
});
