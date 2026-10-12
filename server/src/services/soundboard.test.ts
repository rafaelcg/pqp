import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The soundboard's upload ledger, on a real Postgres. The S3 calls are faked;
 * what is pinned is who owns a file: a claim and the sweep must never both
 * act on the same object, and the cap must count pending uploads from
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
  copyObject: async (from: string, to: string) => {
    const source = s3.objects.get(from);
    if (!source) {
      throw new Error("NoSuchKey");
    }
    s3.objects.set(to, { ...source });
  },
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
const { SOUNDBOARD_MAX_SOUNDS } = await import("@pqp/shared");
const { upsertUser } = await import("./users.js");
const { createServer } = await import("./servers.js");
const {
  claimSoundboardSound,
  countSoundboardSlotsUsed,
  createSoundboardUpload,
  deleteSoundboardSound,
  soundboardClipKey,
  sweepPendingUploads,
  updateSoundboardSound,
} = await import("./soundboard.js");
const { createMemoryHub, createMemoryTransport, setBusTransport } = await import(
  "../lib/bus.js"
);

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

  function claimOutcome(key: string, name = "airhorn") {
    return claimSoundboardSound({ serverId, userId, key, name, emoji: "📣" });
  }

  async function claim(key: string, name = "airhorn") {
    return (await claimOutcome(key, name)).sound;
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
    // The clip is a copy; the upload file is deleted once the row exists.
    expect(s3.deleted).toEqual([key]);
    expect(s3.objects.has(soundboardClipKey(key))).toBe(true);
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
    // The refused claim's copy, then the upload the sweep owned.
    expect(s3.deleted).toEqual([soundboardClipKey(key), key]);
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
    // Only the claimed upload's own file, deleted by its claim.
    expect(s3.deleted).toEqual([claimed]);
    expect(s3.objects.has(soundboardClipKey(claimed))).toBe(true);
  });

  it("counts pending uploads in the cap from the table", async () => {
    for (let i = 0; i < SOUNDBOARD_MAX_SOUNDS; i += 1) {
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

  it("does not let two simultaneous requests pass a count one short of the cap", async () => {
    for (let i = 0; i < SOUNDBOARD_MAX_SOUNDS - 1; i += 1) {
      await upload();
    }
    const results = await Promise.allSettled([upload(), upload()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("deletes the object, then the row, and a second delete finds nothing", async () => {
    const key = await upload();
    const sound = await claim(key);
    expect(await deleteSoundboardSound(serverId, sound.id)).toBe(sound.name);
    expect(s3.deleted).toEqual([key, soundboardClipKey(key)]);
    expect(await deleteSoundboardSound(serverId, sound.id)).toBeNull();
  });

  it("keeps the row when storage is not configured", async () => {
    const key = await upload();
    const sound = await claim(key);
    s3.unconfigured = true;
    // A SoundboardError the route turns into 503 `storage`, not a 500.
    await expect(deleteSoundboardSound(serverId, sound.id)).rejects.toMatchObject({
      code: "storage",
    });
    s3.unconfigured = false;
    expect(await deleteSoundboardSound(serverId, sound.id)).toBe(sound.name);
  });

  it("reports stored sounds plus uploads in flight as the slots used", async () => {
    const before = await countSoundboardSlotsUsed(serverId);
    const key = await upload();
    expect(await countSoundboardSlotsUsed(serverId)).toBe(before + 1);
    await claim(key, "slot");
    expect(await countSoundboardSlotsUsed(serverId)).toBe(before + 1);
  });

  it("deletes the clip even when storage fails, and leaves the file to the sweep", async () => {
    const sound = await claim(await upload(), "fails");
    s3.failDeletes = true;
    expect(await deleteSoundboardSound(serverId, sound.id)).toBe(sound.name);
    s3.failDeletes = false;
    const rows = await getPool().query(`SELECT 1 FROM soundboard_sounds WHERE id = $1`, [sound.id]);
    expect(rows.rowCount).toBe(0);
    // The file is a leased, expired ticket now: once the lease lapses the
    // sweep deletes it, so nothing is orphaned.
    const ticket = await getPool().query<{ storage_key: string }>(
      `SELECT storage_key FROM soundboard_pending_uploads WHERE server_id = $1
         AND cleanup_until > NOW() AND expires_at < NOW()`,
      [serverId],
    );
    expect(ticket.rows).toHaveLength(1);
    await getPool().query(
      `UPDATE soundboard_pending_uploads SET cleanup_until = NOW() - INTERVAL '1 second'
        WHERE storage_key = $1`,
      [ticket.rows[0]!.storage_key],
    );
    s3.deleted.length = 0;
    await sweepPendingUploads();
    expect(s3.deleted).toContain(ticket.rows[0]!.storage_key);
    // A second delete finds nothing.
    expect(await deleteSoundboardSound(serverId, sound.id)).toBeNull();
  });

  it("tells the other API machines to forget a deleted clip", async () => {
    const hub = createMemoryHub();
    const seen: unknown[] = [];
    // Stands in for the other machine: every frame this one publishes.
    hub.listeners.add((frame) => {
      if (frame.topic === "soundboard.forget") {
        seen.push(frame.data);
      }
    });
    setBusTransport(createMemoryTransport(hub));
    try {
      const sound = await claim(await upload(), "gone");
      await deleteSoundboardSound(serverId, sound.id);
      await vi.waitFor(() => expect(seen).toContainEqual({ soundId: sound.id }));
    } finally {
      setBusTransport(null);
    }
  });

  it("reports that only the first claim of a key created the clip", async () => {
    const key = await upload();
    const first = await claimOutcome(key);
    const second = await claimOutcome(key);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sound.id).toBe(first.sound.id);
  });

  it("lets exactly one of several parallel claims of a key create the clip", async () => {
    const key = await upload();
    const outcomes = await Promise.all([
      claimOutcome(key),
      claimOutcome(key),
      claimOutcome(key),
    ]);
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.sound.id)).size).toBe(1);
  });

  it("gives exactly one of several parallel deletes the clip's name", async () => {
    const sound = await claim(await upload(), "contested");
    const results = await Promise.all([
      deleteSoundboardSound(serverId, sound.id),
      deleteSoundboardSound(serverId, sound.id),
      deleteSoundboardSound(serverId, sound.id),
    ]);
    expect(results.filter((name) => name === "contested")).toHaveLength(1);
    expect(results.filter((name) => name === null)).toHaveLength(2);
  });

  it("reports what an edit changed from, and nothing for a no-op", async () => {
    const sound = await claim(await upload(), "before");
    const renamed = await updateSoundboardSound({
      serverId,
      soundId: sound.id,
      name: "after",
      volume: 0.35,
    });
    expect(renamed).toMatchObject({
      changed: true,
      before: { name: "before", volume: 1 },
      sound: { name: "after", volume: 0.35 },
    });
    const same = await updateSoundboardSound({
      serverId,
      soundId: sound.id,
      name: "after",
      volume: 0.35,
    });
    expect(same?.changed).toBe(false);
    expect(same?.sound.name).toBe("after");
    expect(
      await updateSoundboardSound({
        serverId,
        soundId: "00000000-0000-4000-8000-000000000000",
        name: "nothing",
      }),
    ).toBeNull();
  });

  it("stores a copy, so a second PUT through the upload's signature cannot reach the clip", async () => {
    const key = await upload();
    const { sound } = await claimSoundboardSound({ serverId, userId, key, name: "copied", emoji: "x" });
    const stored = await getPool().query<{ storage_key: string }>(
      `SELECT storage_key FROM soundboard_sounds WHERE id = $1`,
      [sound.id],
    );
    expect(stored.rows[0]!.storage_key).not.toBe(key);
    expect(stored.rows[0]!.storage_key).toContain(".clip.");
    // The upload file is gone; a late PUT would only recreate it there.
    expect(s3.objects.has(key)).toBe(false);
    expect(s3.objects.has(stored.rows[0]!.storage_key)).toBe(true);
    // A repeated claim answers with the same clip and does not need the file.
    const again = await claimSoundboardSound({ serverId, userId, key, name: "copied", emoji: "x" });
    expect(again).toMatchObject({ created: false, sound: { id: sound.id } });
  });
});
