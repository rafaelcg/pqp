import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The soundboard's upload ledger, on a real Postgres. The S3 calls are faked;
 * what is pinned is who owns a file: a claim and the sweep must never both
 * act on the same object, and the cap of 24 must count pending uploads from
 * every API machine because the ledger is a table, not a Map.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const s3 = vi.hoisted(() => ({
  deleted: [] as string[],
  failDeletes: false,
  failSigning: false,
  unconfigured: false,
  objects: new Map<string, { contentType: string; contentLength: number }>(),
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => !s3.unconfigured,
  presignPut: (key: string) => {
    if (s3.failSigning) {
      throw new Error("signer down");
    }
    return `https://bucket.test/${key}?sig=1`;
  },
  presignGet: (key: string) => `https://bucket.test/${key}?get=1`,
  headObject: async (key: string) => s3.objects.get(key) ?? null,
  getObjectPrefix: async (key: string) =>
    s3.objects.has(key) ? new Uint8Array(16) : null,
  deleteObject: async (key: string) => {
    if (s3.failDeletes) {
      throw new Error("storage down");
    }
    s3.deleted.push(key);
    s3.objects.delete(key);
  },
}));

vi.mock("@pqp/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pqp/shared")>()),
  audioDurationMs: () => 1000,
}));

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const {
  claimSoundboardSound,
  createSoundboardUpload,
  deleteSoundboardSound,
  sweepPendingUploads,
} = await import("./soundboard.js");

describeDb("soundboard upload ledger", () => {
  let userId: string;
  let serverId: string;

  async function upload(): Promise<string> {
    const { key } = await createSoundboardUpload({
      serverId,
      contentType: "audio/mpeg",
      byteSize: 1000,
    });
    s3.objects.set(key, { contentType: "audio/mpeg", contentLength: 1000 });
    return key;
  }

  function claim(key: string, name = "airhorn") {
    return claimSoundboardSound({ serverId, userId, key, name, emoji: "📣" });
  }

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await getPool().query(`TRUNCATE users RESTART IDENTITY CASCADE`);
    s3.deleted.length = 0;
    s3.unconfigured = false;
    s3.failDeletes = false;
    s3.failSigning = false;
    s3.objects.clear();
    const user = await upsertUser({
      clerkId: "clerk_sb",
      displayName: "sb",
      avatarUrl: null,
    });
    userId = user.id;
    serverId = (await createServer("Board", userId)).server.id;
  });

  it("claims a pending upload and clears its ticket", async () => {
    const key = await upload();
    const sound = await claim(key);
    expect(sound.name).toBe("airhorn");
    const pending = await getPool().query(
      `SELECT 1 FROM soundboard_pending_uploads WHERE storage_key = $1`,
      [key],
    );
    expect(pending.rowCount).toBe(0);
    expect(s3.deleted).toEqual([]);
  });

  it("answers a repeated claim of the same key with the same sound", async () => {
    const key = await upload();
    const first = await claim(key);
    const second = await claim(key);
    expect(second.id).toBe(first.id);
  });

  it("refuses a claim whose ticket the sweep already took", async () => {
    const key = await upload();
    await getPool().query(
      `UPDATE soundboard_pending_uploads SET expires_at = NOW() - INTERVAL '10 minutes'`,
    );
    expect(await sweepPendingUploads()).toBe(1);
    expect(s3.deleted).toEqual([key]);
    s3.objects.set(key, { contentType: "audio/mpeg", contentLength: 1000 });
    await expect(claim(key)).rejects.toMatchObject({ code: "missing" });
    const rows = await getPool().query(`SELECT 1 FROM soundboard_sounds`);
    expect(rows.rowCount).toBe(0);
  });

  it("keeps the ticket when the object delete fails, and retries after the lease", async () => {
    const key = await upload();
    await getPool().query(
      `UPDATE soundboard_pending_uploads SET expires_at = NOW() - INTERVAL '10 minutes'`,
    );
    s3.failDeletes = true;
    expect(await sweepPendingUploads()).toBe(1);
    const kept = await getPool().query(
      `SELECT 1 FROM soundboard_pending_uploads WHERE storage_key = $1`,
      [key],
    );
    expect(kept.rowCount).toBe(1);
    // Leased: neither another sweep nor a claim may take it meanwhile.
    s3.failDeletes = false;
    expect(await sweepPendingUploads()).toBe(0);
    await expect(claim(key)).rejects.toMatchObject({ code: "missing" });
    // The lease lapses; the next sweep deletes the object and the ticket.
    await getPool().query(
      `UPDATE soundboard_pending_uploads SET cleanup_until = NOW() - INTERVAL '1 second'`,
    );
    expect(await sweepPendingUploads()).toBe(1);
    expect(s3.deleted).toEqual([key]);
    const gone = await getPool().query(`SELECT 1 FROM soundboard_pending_uploads`);
    expect(gone.rowCount).toBe(0);
  });

  it("leaves no ticket behind when signing the upload URL fails", async () => {
    s3.failSigning = true;
    await expect(upload()).rejects.toThrow("signer down");
    const rows = await getPool().query(`SELECT 1 FROM soundboard_pending_uploads`);
    expect(rows.rowCount).toBe(0);
  });

  it("never sweeps an upload that is claimed or still inside its signature", async () => {
    const claimed = await upload();
    await claim(claimed);
    await upload();
    expect(await sweepPendingUploads()).toBe(0);
    expect(s3.deleted).toEqual([]);
    expect(s3.objects.has(claimed)).toBe(true);
  });

  it("counts pending uploads in the 24 cap from the table", async () => {
    for (let i = 0; i < 24; i += 1) {
      await upload();
    }
    await expect(
      createSoundboardUpload({
        serverId,
        contentType: "audio/mpeg",
        byteSize: 1000,
      }),
    ).rejects.toMatchObject({ code: "slots" });
  });

  it("does not let two simultaneous requests pass a count of 23", async () => {
    for (let i = 0; i < 23; i += 1) {
      await upload();
    }
    const results = await Promise.allSettled([upload(), upload()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("deletes the object, then the row, and a second delete finds nothing", async () => {
    const key = await upload();
    const sound = await claim(key);
    expect(await deleteSoundboardSound(serverId, sound.id)).toBe(true);
    expect(s3.deleted).toEqual([key]);
    expect(await deleteSoundboardSound(serverId, sound.id)).toBe(false);
  });

  it("keeps the row when storage is not configured", async () => {
    const key = await upload();
    const sound = await claim(key);
    s3.unconfigured = true;
    await expect(deleteSoundboardSound(serverId, sound.id)).rejects.toThrow(
      "storage_unavailable",
    );
    s3.unconfigured = false;
    expect(await deleteSoundboardSound(serverId, sound.id)).toBe(true);
  });
});
