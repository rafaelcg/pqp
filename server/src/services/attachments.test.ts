import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PoolClient } from "pg";

/**
 * Claiming is the only place an attachment's ownership is ever checked — the
 * upload URL was minted before anyone knew which message it would end up on —
 * so these drive the real SQL against a real Postgres and assert that a row
 * cannot be pulled onto a message by the wrong user, into the wrong channel,
 * or twice.
 *
 * The check now spans two calls on two connections: `verifyPendingAttachments`
 * does the HEADs with nothing held, `claimAttachments` does the UPDATE inside
 * the message's transaction. Several tests below deliberately replay a stale
 * verification against the UPDATE, because that is the only way to show the
 * guarantee lives in the UPDATE's own WHERE rather than in a SELECT that is no
 * longer there.
 *
 * Storage is faked. The signature is proved correct against MinIO in
 * `lib/s3.test.ts`; what matters here is what the service does with the answer,
 * which is easier to state when a HEAD can be made to return anything.
 */

const storage = vi.hoisted(() => ({
  objects: new Map<string, { contentLength: number; contentType: string }>(),
  deletedKeys: [] as string[],
  unreachableKeys: new Set<string>(),
}));

vi.mock("../lib/s3.js", () => ({
  isStorageConfigured: () => true,
  presignPut: (key: string) => `https://storage.test/${key}?sig=put`,
  presignGet: (key: string) => `https://storage.test/${key}?sig=get`,
  headObject: async (key: string) => {
    if (storage.unreachableKeys.has(key)) {
      throw new Error("storage unreachable");
    }
    return storage.objects.get(key) ?? null;
  },
  deleteObject: async (key: string) => {
    if (storage.unreachableKeys.has(key)) {
      throw new Error("storage unreachable");
    }
    storage.deletedKeys.push(key);
    storage.objects.delete(key);
  },
}));

// TEST_DATABASE_URL wins — see the note in api.test.ts. Set it to point the
// suite at a scratch database instead of the one `pnpm dev` is using.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

if (DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const { getPool, initDb, closePool } = await import("../db.js");
const { upsertUser } = await import("../services/users.js");
const {
  claimAttachments,
  createPendingAttachment,
  getAttachmentForViewer,
  listAttachmentsForMessages,
  sweepOrphanedAttachments,
  verifyPendingAttachments,
  AttachmentTooLargeError,
} = await import("./attachments.js");

type VerifiedAttachment = Awaited<
  ReturnType<typeof verifyPendingAttachments>
>[number];

describeDb("attachments", () => {
  let uploader: { id: string };
  let other: { id: string };
  let outsider: { id: string };
  let channelId: string;
  let otherChannelId: string;

  /** Mint a pending row and pretend the browser finished the upload. */
  async function upload(
    options: {
      channel?: string;
      user?: string;
      contentType?: "image/png" | "text/plain";
      claimedBytes?: number;
      realBytes?: number;
      /** Skip registering the object — the upload that never happened. */
      skipUpload?: boolean;
      storedContentType?: string;
      width?: number;
      height?: number;
    } = {},
  ) {
    const contentType = options.contentType ?? "image/png";
    const pending = await createPendingAttachment({
      channelId: options.channel ?? channelId,
      uploaderId: options.user ?? uploader.id,
      filename: "shot.png",
      contentType,
      byteSize: options.claimedBytes ?? 1024,
      width: options.width ?? null,
      height: options.height ?? null,
    });

    if (!options.skipUpload) {
      storage.objects.set(pending.attachment.storage_key!, {
        contentLength: options.realBytes ?? options.claimedBytes ?? 1024,
        contentType: options.storedContentType ?? contentType,
      });
    }
    return pending.attachment;
  }

  async function postMessage(channel = channelId, author = uploader.id) {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, body) VALUES ($1, $2, 'hi')
       RETURNING id`,
      [channel, author],
    );
    return result.rows[0]!.id;
  }

  /**
   * The UPDATE half, inside a transaction the way `createMessage` runs it.
   * Takes an already-verified list so a test can hand it a stale one.
   */
  async function claimVerified(
    messageId: string,
    verified: VerifiedAttachment[],
  ) {
    const client: PoolClient = await getPool().connect();
    try {
      await client.query("BEGIN");
      const claimed = await claimAttachments(client, messageId, verified);
      await client.query("COMMIT");
      return claimed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Both halves, as the message-create path calls them. */
  async function claim(
    messageId: string,
    ids: string[],
    options: { channel?: string; user?: string } = {},
  ) {
    const verified = await verifyPendingAttachments(
      options.channel ?? channelId,
      options.user ?? uploader.id,
      ids,
    );
    return claimVerified(messageId, verified);
  }

  async function age(attachmentId: string, interval: string) {
    await getPool().query(
      `UPDATE message_attachments SET created_at = NOW() - $2::interval
       WHERE id = $1`,
      [attachmentId, interval],
    );
  }

  beforeAll(async () => {
    await initDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    storage.objects.clear();
    storage.deletedKeys.length = 0;
    storage.unreachableKeys.clear();

    await getPool().query(
      `TRUNCATE users, servers, channels, messages, server_members,
                message_attachments
       RESTART IDENTITY CASCADE`,
    );

    uploader = await upsertUser({
      clerkId: "clerk_uploader",
      displayName: "Uploader",
      avatarUrl: null,
    });
    other = await upsertUser({
      clerkId: "clerk_other",
      displayName: "Other",
      avatarUrl: null,
    });
    outsider = await upsertUser({
      clerkId: "clerk_outsider",
      displayName: "Outsider",
      avatarUrl: null,
    });

    const server = await getPool().query<{ id: string }>(
      `INSERT INTO servers (name, owner_id) VALUES ('S', $1) RETURNING id`,
      [uploader.id],
    );
    const serverId = server.rows[0]!.id;
    await getPool().query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES
         ($1, $2, 'owner'), ($1, $3, 'member')`,
      [serverId, uploader.id, other.id],
    );

    const channels = await getPool().query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type, position) VALUES
         ($1, 'general', 'text', 0), ($1, 'other', 'text', 1)
       RETURNING id`,
      [serverId],
    );
    channelId = channels.rows[0]!.id;
    otherChannelId = channels.rows[1]!.id;
  });

  describe("minting", () => {
    it("generates the key itself, from the content type", async () => {
      const row = await upload({ contentType: "image/png" });

      // Never the user's filename, and never anything the client chose: a
      // client-picked key is a client-picked overwrite of someone else's object.
      expect(row.storage_key).toMatch(
        new RegExp(`^${channelId}/[0-9a-f-]{36}\\.png$`),
      );
      expect(row.storage_key).not.toContain("shot");
      expect(row.message_id).toBeNull();
    });

    it("refuses a claimed size over the cap before signing anything", async () => {
      await expect(
        upload({ claimedBytes: 11 * 1024 * 1024 }),
      ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    });

    it("stores the declared dimensions, and null when there are none", async () => {
      // Without these the client's layout reservation is dead code: the tile is
      // boxed in the optimistic bubble and unsized from the broadcast onwards.
      const sized = await upload({ width: 1200, height: 800 });
      expect([sized.width, sized.height]).toEqual([1200, 800]);

      const unsized = await upload({ contentType: "text/plain" });
      expect([unsized.width, unsized.height]).toEqual([null, null]);
    });
  });

  describe("claiming", () => {
    it("attaches a row and records the size storage actually holds", async () => {
      // The client said 1 KiB and uploaded 4 KiB. Nothing rejects that — it is
      // under the cap — but the number the database keeps must be the real one.
      const row = await upload({ claimedBytes: 1024, realBytes: 4096 });
      const messageId = await postMessage();

      const claimed = await claim(messageId, [row.id]);

      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.message_id).toBe(messageId);
      expect(claimed[0]!.byte_size).toBe("4096");
    });

    it("refuses a claim by a user who did not upload it", async () => {
      const row = await upload({ user: uploader.id });
      const messageId = await postMessage(channelId, other.id);

      // The attachment id travels in the message frame, so a second user can
      // simply name someone else's id — this is the check that stops them.
      expect(await claim(messageId, [row.id], { user: other.id })).toEqual([]);

      const after = await getPool().query(
        `SELECT message_id FROM message_attachments WHERE id = $1`,
        [row.id],
      );
      expect(after.rows[0]!.message_id).toBeNull();
    });

    it("refuses a claim into a channel the upload was not minted for", async () => {
      const row = await upload({ channel: channelId });
      const messageId = await postMessage(otherChannelId);

      // Otherwise an upload minted in a channel the user has since lost access
      // to could be re-posted anywhere, and the read URL follows the message.
      expect(
        await claim(messageId, [row.id], { channel: otherChannelId }),
      ).toEqual([]);
    });

    it("refuses to re-claim an attachment already on a message", async () => {
      const row = await upload();
      const first = await postMessage();
      const second = await postMessage();

      expect(await claim(first, [row.id])).toHaveLength(1);
      // `message_id IS NULL` is the whole guard: without it one upload could be
      // fanned out across any number of messages.
      expect(await claim(second, [row.id])).toEqual([]);

      const rows = await getPool().query(
        `SELECT message_id FROM message_attachments WHERE id = $1`,
        [row.id],
      );
      expect(rows.rows[0]!.message_id).toBe(first);
    });

    it("refuses a replayed verification, because the UPDATE re-checks the row", async () => {
      const row = await upload();
      const first = await postMessage();
      const second = await postMessage();

      const verified = await verifyPendingAttachments(channelId, uploader.id, [
        row.id,
      ]);
      expect(await claimVerified(first, verified)).toHaveLength(1);

      // The SELECT that produced `verified` ran on another connection and is
      // long gone, so it cannot be what protects the row. The UPDATE's own
      // `message_id IS NULL`, evaluated under the row lock, is.
      expect(await claimVerified(second, verified)).toEqual([]);
    });

    it("refuses a claim whose ownership does not match the row it names", async () => {
      const row = await upload({ user: uploader.id });
      const messageId = await postMessage(channelId, other.id);
      const [verified] = await verifyPendingAttachments(
        channelId,
        uploader.id,
        [row.id],
      );

      // Ownership and channel travel per row into the UPDATE's WHERE, so a
      // claim that names the wrong ones matches nothing rather than quietly
      // inheriting whatever the verification step happened to check.
      expect(
        await claimVerified(messageId, [
          { ...verified!, row: { ...verified!.row, uploader_id: other.id } },
        ]),
      ).toEqual([]);
      expect(
        await claimVerified(messageId, [
          {
            ...verified!,
            row: { ...verified!.row, channel_id: otherChannelId },
          },
        ]),
      ).toEqual([]);
    });

    it("drops an attachment whose bytes were never uploaded", async () => {
      const row = await upload({ skipUpload: true });
      const messageId = await postMessage();

      expect(await claim(messageId, [row.id])).toEqual([]);
    });

    it("drops an upload larger than the cap, whatever it claimed", async () => {
      // The attack the HEAD exists for: a presigned PUT pins the content type
      // but cannot pin a content length, so the mint-time size is a suggestion.
      const row = await upload({ claimedBytes: 100, realBytes: 11 * 1024 * 1024 });
      const messageId = await postMessage();

      expect(await claim(messageId, [row.id])).toEqual([]);
    });

    it("drops an object stored as something other than what was signed", async () => {
      const row = await upload({ storedContentType: "text/html" });
      const messageId = await postMessage();

      expect(await claim(messageId, [row.id])).toEqual([]);
    });

    it("drops an attachment whose storage cannot be reached", async () => {
      const row = await upload();
      storage.unreachableKeys.add(row.storage_key!);
      const messageId = await postMessage();

      // A storage outage must cost the file, never the message.
      expect(await claim(messageId, [row.id])).toEqual([]);
    });

    it("keeps the good ones when one of a batch fails", async () => {
      const good = await upload();
      const missing = await upload({ skipUpload: true });
      const alsoGood = await upload();
      const messageId = await postMessage();

      const claimed = await claim(messageId, [
        good.id,
        missing.id,
        alsoGood.id,
      ]);

      // Order is the sender's, not the database's.
      expect(claimed.map((row) => row.id)).toEqual([good.id, alsoGood.id]);
    });

    it("records the sender's order and survives a reload with it", async () => {
      const mintedFirst = await upload();
      const mintedSecond = await upload();
      const messageId = await postMessage();

      // Sent in the reverse of mint order — the ordinary case, since an image
      // waits on a decode and mints after the video that was dropped later.
      const claimed = await claim(messageId, [mintedSecond.id, mintedFirst.id]);
      expect(claimed.map((row) => row.id)).toEqual([
        mintedSecond.id,
        mintedFirst.id,
      ]);
      expect(claimed.map((row) => row.position)).toEqual([0, 1]);

      // The read path has no memory of the frame, so ordering by created_at
      // here is what silently reshuffles the message on the next refresh.
      const byMessage = await listAttachmentsForMessages([messageId]);
      expect(byMessage.get(messageId)!.map((entry) => entry.id)).toEqual([
        mintedSecond.id,
        mintedFirst.id,
      ]);
    });
  });

  describe("reading", () => {
    it("batches a page of messages into one map", async () => {
      const first = await postMessage();
      const second = await postMessage();
      const a = await upload();
      const b = await upload();
      const c = await upload();
      await claim(first, [a.id, b.id]);
      await claim(second, [c.id]);

      const byMessage = await listAttachmentsForMessages([
        first,
        second,
        await postMessage(),
      ]);

      expect(byMessage.get(first)).toHaveLength(2);
      expect(byMessage.get(second)).toHaveLength(1);
      expect(byMessage.get(first)![0]!.url).toContain("sig=get");
      // BIGINT arrives from node-postgres as a string; a read that forgot to
      // convert it fails `attachmentSchema` on the client.
      expect(byMessage.get(second)![0]!.byteSize).toBe(1024);
    });

    it("carries the stored dimensions out to the wire", async () => {
      const row = await upload({ width: 640, height: 480 });
      const messageId = await postMessage();
      await claim(messageId, [row.id]);

      const byMessage = await listAttachmentsForMessages([messageId]);
      const attachment = byMessage.get(messageId)![0]!;
      expect([attachment.width, attachment.height]).toEqual([640, 480]);
    });

    it("hands a refreshed URL only to someone who can see the channel", async () => {
      const row = await upload();
      const messageId = await postMessage();
      await claim(messageId, [row.id]);

      expect(await getAttachmentForViewer(row.id, uploader.id)).not.toBeNull();
      expect(await getAttachmentForViewer(row.id, other.id)).not.toBeNull();
      expect(await getAttachmentForViewer(row.id, outsider.id)).toBeNull();
    });

    it("hides an unclaimed attachment even from its uploader", async () => {
      const row = await upload();
      expect(await getAttachmentForViewer(row.id, uploader.id)).toBeNull();
    });
  });

  describe("sweeper", () => {
    it("collects an hour-old unclaimed row and spares a fresh one", async () => {
      const stale = await upload();
      const fresh = await upload();
      await age(stale.id, "2 hours");

      expect(await sweepOrphanedAttachments()).toBe(1);

      const remaining = await getPool().query<{ id: string }>(
        `SELECT id FROM message_attachments`,
      );
      expect(remaining.rows.map((row) => row.id)).toEqual([fresh.id]);
      expect(storage.deletedKeys).toEqual([stale.storage_key]);
    });

    it("leaves claimed attachments alone however old they are", async () => {
      const row = await upload();
      const messageId = await postMessage();
      await claim(messageId, [row.id]);
      await age(row.id, "10 days");

      expect(await sweepOrphanedAttachments()).toBe(0);
      expect(storage.deletedKeys).toEqual([]);
    });

    it("collects a message's attachments once the message is deleted", async () => {
      const row = await upload();
      const messageId = await postMessage();
      await claim(messageId, [row.id]);
      await getPool().query(`DELETE FROM messages WHERE id = $1`, [messageId]);
      await age(row.id, "2 hours");

      // ON DELETE SET NULL is what makes this the same case as an upload that
      // was never posted — one predicate, one sweeper, both kinds of orphan.
      expect(await sweepOrphanedAttachments()).toBe(1);
      expect(storage.deletedKeys).toEqual([row.storage_key]);
    });

    it("drops the row even when the object delete fails", async () => {
      const row = await upload();
      await age(row.id, "2 hours");
      storage.unreachableKeys.add(row.storage_key!);

      // Keeping it would only re-attempt the same failing delete on every run,
      // forever, and never free the row.
      expect(await sweepOrphanedAttachments()).toBe(1);
      const remaining = await getPool().query(
        `SELECT id FROM message_attachments`,
      );
      expect(remaining.rows).toEqual([]);
    });
  });
});
