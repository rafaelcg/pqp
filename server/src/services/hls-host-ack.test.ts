import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The one-time host acknowledgment sheet: shown once per user per server,
 * never again once confirmed. Real Postgres, since the entire behavior here
 * is "does the row exist", which is not worth mocking.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { acknowledgeHlsHost, hasAcknowledgedHlsHost } = await import(
  "./hls-host-ack.js"
);

describeDb("hls host acknowledgment", () => {
  let userId: string;
  let otherUserId: string;
  let serverId: string;
  let otherServerId: string;

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(
      `TRUNCATE users, servers, hls_host_acks RESTART IDENTITY CASCADE`,
    );
    const user = await upsertUser({
      clerkId: "clerk_ack_host",
      displayName: "Host",
      avatarUrl: null,
    });
    userId = user.id;
    const other = await upsertUser({
      clerkId: "clerk_ack_other",
      displayName: "Other",
      avatarUrl: null,
    });
    otherUserId = other.id;

    const servers = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('a', $1), ('b', $1) RETURNING id`,
      [userId],
    );
    serverId = servers.rows[0]!.id;
    otherServerId = servers.rows[1]!.id;
  });

  it("is not acknowledged before the sheet is confirmed", async () => {
    expect(await hasAcknowledgedHlsHost(userId, serverId)).toBe(false);
  });

  it("is acknowledged after confirming, and never shows again", async () => {
    await acknowledgeHlsHost(userId, serverId);
    expect(await hasAcknowledgedHlsHost(userId, serverId)).toBe(true);

    // Confirming again (e.g. a second start on a slow network) must not
    // error on the unique constraint.
    await expect(acknowledgeHlsHost(userId, serverId)).resolves.not.toThrow();
    expect(await hasAcknowledgedHlsHost(userId, serverId)).toBe(true);
  });

  it("is scoped per user AND per server, not globally", async () => {
    await acknowledgeHlsHost(userId, serverId);

    // Same user, different server: still needs the sheet.
    expect(await hasAcknowledgedHlsHost(userId, otherServerId)).toBe(false);
    // Different user, same server: still needs the sheet.
    expect(await hasAcknowledgedHlsHost(otherUserId, serverId)).toBe(false);
  });

  it("BROKEN GUARD: querying by server_id alone (dropping the user_id filter) would wrongly report every user as acknowledged", async () => {
    await acknowledgeHlsHost(userId, serverId);

    // Deliberately reproduce the bug this test protects against: a query
    // that forgets to filter on user_id.
    const broken = await getPool().query(
      `SELECT 1 FROM hls_host_acks WHERE server_id = $1`,
      [serverId],
    );
    expect(broken.rowCount).toBe(1);
    // The real function does not have this bug: the other user still needs
    // to see the sheet on the same server.
    expect(await hasAcknowledgedHlsHost(otherUserId, serverId)).toBe(false);
  });
});
