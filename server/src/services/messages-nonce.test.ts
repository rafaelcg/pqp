import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Idempotent sends. The client stores a message in its outbox until the
 * server answers, and replays the outbox on every ready socket, so the same
 * `message-create` can arrive twice: once from the reconnect flush and once
 * more after a reload. The nonce it carries is unique per author and channel,
 * and the second insert must come back as the first row rather than a second
 * message.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { createMessage } = await import("./messages.js");
type DbUser = import("../db.js").DbUser;

async function seed(): Promise<{ user: DbUser; channelId: string }> {
  const pool = getPool();
  const user = await pool.query<DbUser>(
    `INSERT INTO users (clerk_id, display_name, username, discriminator)
     VALUES ('clerk_nonce_a', 'Nonce A', 'nonce_a', '0001') RETURNING *`,
  );
  const server = await pool.query<{ id: string }>(
    `INSERT INTO servers (name, owner_id) VALUES ('Nonce', $1) RETURNING id`,
    [user.rows[0]!.id],
  );
  const channel = await pool.query<{ id: string }>(
    `INSERT INTO channels (server_id, name, type) VALUES ($1, 'geral', 'text') RETURNING id`,
    [server.rows[0]!.id],
  );
  return { user: user.rows[0]!, channelId: channel.rows[0]!.id };
}

describeDb("createMessage nonce", () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users, servers, channels, messages CASCADE`);
  });

  it("returns the first row, flagged duplicate, when the nonce is sent again", async () => {
    const { user, channelId } = await seed();
    const first = await createMessage(
      channelId, user, "hello", null, [], undefined, undefined, "nonce-1",
    );
    const again = await createMessage(
      channelId, user, "hello", null, [], undefined, undefined, "nonce-1",
    );

    expect(first?.duplicate).toBe(false);
    expect(again?.duplicate).toBe(true);
    expect(again?.id).toBe(first?.id);
    const count = await getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM messages WHERE channel_id = $1`,
      [channelId],
    );
    expect(count.rows[0]!.n).toBe("1");
  });

  it("stores two messages when the nonces differ or are absent", async () => {
    const { user, channelId } = await seed();
    await createMessage(channelId, user, "a", null, [], undefined, undefined, "n-a");
    await createMessage(channelId, user, "b", null, [], undefined, undefined, "n-b");
    await createMessage(channelId, user, "c");
    await createMessage(channelId, user, "d");
    const count = await getPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM messages WHERE channel_id = $1`,
      [channelId],
    );
    expect(count.rows[0]!.n).toBe("4");
  });
});
