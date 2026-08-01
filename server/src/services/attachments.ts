import { randomUUID } from "node:crypto";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  isImageContentType,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type Attachment,
  type AttachmentContentType,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import {
  deleteObject,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
} from "../lib/s3.js";
import { isChannelMember } from "./users.js";

/**
 * Message attachments: mint an upload URL, claim the resulting row onto a
 * message, hand out read URLs, sweep whatever was never claimed.
 *
 * The database is the index and the bucket holds the bytes, which means the
 * two can disagree — a row whose object was never uploaded, an object whose
 * row was swept. Every path here is written so that disagreement resolves the
 * safe way: an attachment nobody can prove exists is simply not attached.
 */

/** A row of `message_attachments`, as node-postgres returns it. */
export interface DbAttachment {
  id: string;
  message_id: string | null;
  channel_id: string;
  uploader_id: string;
  storage_key: string;
  filename: string;
  content_type: string;
  /** BIGINT: node-postgres hands int8 back as a string, never a number. */
  byte_size: string;
  width: number | null;
  height: number | null;
  /** SMALLINT: the sender's ordering, 0 for anything claimed before it existed. */
  position: number;
  created_at: Date;
}

/**
 * Alias-qualified, and every query below aliases the table `a`. The claim
 * joins against an `UNNEST(...) AS claim(id, ...)`, where a bare `id` in the
 * RETURNING list is ambiguous and fails at runtime.
 */
const ATTACHMENT_COLUMNS = `a.id, a.message_id, a.channel_id, a.uploader_id,
       a.storage_key, a.filename, a.content_type, a.byte_size, a.width,
       a.height, a.position, a.created_at`;

/**
 * Upload URL lifetime. Long enough for a phone on bad signal to finish 10 MiB,
 * short enough that a URL leaked out of a browser's network log is not a
 * standing write grant on the bucket.
 */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Read URL lifetime when `ATTACHMENT_URL_TTL_SECONDS` says nothing. */
const DEFAULT_URL_TTL_SECONDS = 12 * 60 * 60;

/**
 * How long an unclaimed row is given to become part of a message. Anything
 * older was abandoned: the composer was closed, the tab crashed, the send
 * failed. An hour is far past any upload and far short of a bill.
 */
const ORPHAN_GRACE = "1 hour";

/** Rows per sweep. Bounded so one run cannot hold a connection for minutes. */
const SWEEP_BATCH = 200;

/** Mirrors `isGifSearchConfigured`: no storage, no feature, no attach button. */
export function isAttachmentsConfigured(): boolean {
  return isStorageConfigured();
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * The deployment's cap, which can only ever lower the shared ceiling — raising
 * `MAX_ATTACHMENT_BYTES` past it does nothing, because `createAttachmentSchema`
 * rejects the mint request before this is consulted. Clamping here keeps the
 * number the server enforces and the number it would advertise identical.
 */
export function maxAttachmentBytes(): number {
  return Math.min(
    positiveIntFromEnv("MAX_ATTACHMENT_BYTES", DEFAULT_MAX_ATTACHMENT_BYTES),
    DEFAULT_MAX_ATTACHMENT_BYTES,
  );
}

export function attachmentUrlTtlSeconds(): number {
  return positiveIntFromEnv(
    "ATTACHMENT_URL_TTL_SECONDS",
    DEFAULT_URL_TTL_SECONDS,
  );
}

/** The caller answers 413; the service refuses to mint regardless. */
export class AttachmentTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Attachment exceeds the ${limit} byte limit`);
    this.name = "AttachmentTooLargeError";
  }
}

/**
 * Extension per content type, never per filename.
 *
 * A `Record` keyed on the allowlist so widening `ATTACHMENT_MIME_ALLOWLIST`
 * fails to compile until a suffix is chosen for it. The user's filename is
 * display text and only ever that — deriving the key's extension from it would
 * let `evil.html` be stored, and then served, as a document from the bucket's
 * own origin.
 */
const EXTENSION_BY_CONTENT_TYPE: Record<AttachmentContentType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

/**
 * Generated here and never accepted from the client. A client-chosen key is a
 * client-chosen overwrite: whoever picks `channel/avatar.png` twice replaces
 * somebody else's object, and the presigned PUT would sign it happily.
 */
function storageKey(
  channelId: string,
  contentType: AttachmentContentType,
): string {
  return `${channelId}/${randomUUID()}${EXTENSION_BY_CONTENT_TYPE[contentType]}`;
}

export interface CreatePendingAttachmentInput {
  channelId: string;
  uploaderId: string;
  filename: string;
  contentType: AttachmentContentType;
  byteSize: number;
  /**
   * Display-only hints, already bounded by `createAttachmentSchema`. Nothing
   * server-side reads them: they exist so a message can reserve the right box
   * before the image arrives, and a client that lies mis-sizes its own
   * placeholder.
   */
  width?: number | null;
  height?: number | null;
}

export interface PendingAttachment {
  attachment: DbAttachment;
  uploadUrl: string;
  /** ISO 8601, matching `createAttachmentResponseSchema`. */
  expiresAt: string;
}

/**
 * Reserve a row and hand back somewhere to put the bytes.
 *
 * The row lands with `message_id NULL` and stays invisible until a message
 * claims it, so an upload that is never sent costs one row the sweeper will
 * collect. `byteSize` is recorded as the client stated it and overwritten with
 * the truth at claim time — but it is also signed into the upload URL, so the
 * bucket refuses a body of any other length and the claimed size can no longer
 * be a fiction the bucket pays for.
 */
export async function createPendingAttachment(
  input: CreatePendingAttachmentInput,
): Promise<PendingAttachment> {
  const limit = maxAttachmentBytes();
  if (input.byteSize > limit) {
    throw new AttachmentTooLargeError(limit);
  }

  const key = storageKey(input.channelId, input.contentType);
  const result = await getPool().query<DbAttachment>(
    `INSERT INTO message_attachments AS a
       (channel_id, uploader_id, storage_key, filename, content_type, byte_size,
        width, height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ATTACHMENT_COLUMNS}`,
    [
      input.channelId,
      input.uploaderId,
      key,
      input.filename,
      input.contentType,
      input.byteSize,
      input.width ?? null,
      input.height ?? null,
    ],
  );

  return {
    attachment: result.rows[0]!,
    uploadUrl: presignPut(
      key,
      input.contentType,
      input.byteSize,
      UPLOAD_URL_TTL_SECONDS,
    ),
    expiresAt: new Date(
      Date.now() + UPLOAD_URL_TTL_SECONDS * 1000,
    ).toISOString(),
  };
}

/**
 * What the object store says is there, or null when it cannot be trusted.
 *
 * A HEAD that fails for any reason — gone, unreachable, the wrong type, bigger
 * than the cap — drops the attachment. The upload URL signs `Content-Length`
 * as well as `Content-Type`, so this is not the only thing standing between a
 * client's claim and the bucket; it is still the only thing that tells "never
 * uploaded" apart from "uploaded", still catches an object stored as something
 * other than what was signed, and still covers an S3-compatible store that
 * ignores a signed length.
 */
async function verifyUpload(row: DbAttachment): Promise<number | null> {
  let head;
  try {
    head = await headObject(row.storage_key);
  } catch (error) {
    console.error(
      `[attachments] HEAD failed for ${row.storage_key}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  if (!head) {
    return null;
  }
  if (head.contentLength <= 0 || head.contentLength > maxAttachmentBytes()) {
    return null;
  }
  // The stored type is what the presigned PUT signed, so a mismatch means the
  // object under this key is not the object this row describes.
  if (head.contentType !== row.content_type) {
    return null;
  }
  return head.contentLength;
}

/** A row that exists, belongs to the sender, and has bytes behind it. */
export interface VerifiedAttachment {
  row: DbAttachment;
  /** Measured by HEAD, not claimed by the client. */
  byteSize: number;
  /** Index in the sender's list; becomes `position` on the claim. */
  position: number;
}

/**
 * Find the sender's unclaimed rows and confirm the bytes are really there.
 *
 * Deliberately outside any transaction, because every entry here costs an HTTP
 * HEAD with a ten second timeout. Held inside one, a bucket that blackholes
 * packets — as opposed to refusing fast — parks a pooled connection
 * idle-in-transaction for that whole timeout; ten concurrent image sends drain
 * `PG_POOL_MAX` and every unrelated query in the process, down to the
 * `isChannelMember` check on each inbound WS frame, queues behind them. A
 * storage outage would become a total API outage.
 *
 * What that gives up is that the object cannot change between the HEAD and the
 * COMMIT — which was never true anyway, since the presigned PUT stays valid for
 * its own TTL, and which signing `Content-Length` bounds to swapping in a body
 * of identical size.
 */
export async function verifyPendingAttachments(
  channelId: string,
  uploaderId: string,
  attachmentIds: string[],
): Promise<VerifiedAttachment[]> {
  const requested = attachmentIds.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  if (requested.length === 0 || !isStorageConfigured()) {
    return [];
  }

  const candidates = await getPool().query<DbAttachment>(
    `SELECT ${ATTACHMENT_COLUMNS}
     FROM message_attachments a
     WHERE a.id = ANY($1::uuid[])
       AND a.uploader_id = $2
       AND a.channel_id = $3
       AND a.message_id IS NULL`,
    [requested, uploaderId, channelId],
  );
  if (candidates.rows.length === 0) {
    return [];
  }

  const position = new Map(requested.map((id, index) => [id, index]));
  const verified = await Promise.all(
    candidates.rows.map(async (row) => ({
      row,
      byteSize: await verifyUpload(row),
      position: position.get(row.id) ?? 0,
    })),
  );

  return verified
    .filter((entry): entry is VerifiedAttachment => entry.byteSize !== null)
    .sort((left, right) => left.position - right.position);
}

/**
 * Attach verified rows to a message, inside the caller's transaction.
 *
 * This is where enforcement lands. Minting an upload URL proves nothing about
 * who ends up posting it, so ownership, channel and unclaimed-ness are all
 * re-stated in this UPDATE's own WHERE rather than inherited from the SELECT in
 * `verifyPendingAttachments` — that SELECT ran on another connection, outside
 * this transaction, and by itself guarantees nothing.
 *
 * Double-claiming stays impossible without holding a lock across the network:
 * the UPDATE takes the row lock and re-evaluates `message_id IS NULL` under it,
 * so of two messages racing for one attachment the loser simply claims fewer
 * rows.
 *
 * Returns only what it claimed. Anything that fails is left with a NULL
 * `message_id` for the sweeper, which means a rejected attachment costs the
 * sender the file and not the message.
 */
export async function claimAttachments(
  client: PoolClient,
  messageId: string,
  verified: VerifiedAttachment[],
): Promise<DbAttachment[]> {
  if (verified.length === 0) {
    return [];
  }

  // `byte_size` is rewritten with the measured length: the column has held a
  // client's assertion up to this point, and every read after this reports it.
  // The uploader and channel travel per row so the predicate is a fact about
  // the row being written, not about whatever the caller passed along.
  const claimed = await client.query<DbAttachment>(
    `UPDATE message_attachments a
     SET message_id = $1, byte_size = claim.byte_size, position = claim.position
     FROM UNNEST($2::uuid[], $3::bigint[], $4::smallint[], $5::uuid[], $6::uuid[])
       AS claim(id, byte_size, position, uploader_id, channel_id)
     WHERE a.id = claim.id
       AND a.uploader_id = claim.uploader_id
       AND a.channel_id = claim.channel_id
       AND a.message_id IS NULL
     RETURNING ${ATTACHMENT_COLUMNS}`,
    [
      messageId,
      verified.map((entry) => entry.row.id),
      verified.map((entry) => entry.byteSize),
      verified.map((entry) => entry.position),
      verified.map((entry) => entry.row.uploader_id),
      verified.map((entry) => entry.row.channel_id),
    ],
  );

  // Restore the order the sender chose; an UPDATE returns rows in whatever
  // order it touched them, and the composer's ordering is user-visible.
  return claimed.rows.sort((left, right) => left.position - right.position);
}

/**
 * The wire shape, with a freshly minted read URL.
 *
 * Presigning is pure HMAC with no network call, so paying for one per row per
 * read is cheaper than any scheme that caches them — and a cached URL would
 * outlive the access check that produced it.
 */
export function toPublicAttachment(row: DbAttachment): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    width: row.width,
    height: row.height,
    url: presignGet(row.storage_key, {
      ttlSeconds: attachmentUrlTtlSeconds(),
      // Anything that is not an inline image is signed as a download. A
      // `text/plain` or `application/pdf` opened as a top-level document runs
      // in the bucket's origin, and `Content-Disposition: attachment` is what
      // stops a user-uploaded file from ever being a page.
      ...(isImageContentType(row.content_type)
        ? {}
        : { downloadFilename: row.filename }),
    }),
  };
}

/**
 * Attachments for a page of messages, in one query — the same batching as
 * `listReactionsForMessages`, and for the same reason: a per-message query
 * turns a 50-message page into 50 round trips.
 *
 * Ordered by `position`, so a reload shows what the sender arranged. Ordering
 * by `created_at` instead reads back mint order, and mints race: an image waits
 * on a decode before it mints, so a message sent as photo then clip comes back
 * as clip then photo.
 */
export async function listAttachmentsForMessages(
  messageIds: string[],
): Promise<Map<string, Attachment[]>> {
  const byMessage = new Map<string, Attachment[]>();
  // A deployment that loses its storage configuration must still serve its
  // history: the messages read normally and the attachments simply do not
  // appear, rather than every read failing on an unsignable URL.
  if (messageIds.length === 0 || !isStorageConfigured()) {
    return byMessage;
  }

  const result = await getPool().query<DbAttachment>(
    `SELECT ${ATTACHMENT_COLUMNS}
     FROM message_attachments a
     WHERE a.message_id = ANY($1::uuid[])
     ORDER BY a.position ASC, a.created_at ASC, a.id ASC`,
    [messageIds],
  );

  for (const row of result.rows) {
    const list = byMessage.get(row.message_id!) ?? [];
    list.push(toPublicAttachment(row));
    byMessage.set(row.message_id!, list);
  }

  return byMessage;
}

/**
 * One attachment for the URL-refresh route, or null.
 *
 * Same channel predicate as every other read, because this route hands out a
 * working URL to a private object and is the one place an attachment id can be
 * guessed at directly. Unclaimed rows are invisible even to their uploader:
 * until a message carries it, an attachment is not content anyone can see.
 */
export async function getAttachmentForViewer(
  attachmentId: string,
  viewerId: string,
): Promise<Attachment | null> {
  if (!isStorageConfigured()) {
    return null;
  }

  const result = await getPool().query<DbAttachment>(
    `SELECT ${ATTACHMENT_COLUMNS}
     FROM message_attachments a
     WHERE a.id = $1 AND a.message_id IS NOT NULL`,
    [attachmentId],
  );
  const row = result.rows[0];
  if (!row || !(await isChannelMember(row.channel_id, viewerId))) {
    return null;
  }
  return toPublicAttachment(row);
}

/**
 * Delete rows and objects for attachments no message claimed.
 *
 * One predicate covers both ways an attachment is orphaned, which is the whole
 * point of `message_id ON DELETE SET NULL`: an upload nobody posted and an
 * attachment whose message, channel or server was deleted end up looking
 * identical, so there is one sweeper rather than two.
 *
 * The object delete is best effort and the row is dropped either way. Keeping
 * the row on a failed delete would only guarantee the same failing delete is
 * retried every run, forever, while the row is never freed — a wedged sweeper
 * is a correctness problem, whereas leaked bytes are a cost problem with a
 * bucket lifecycle rule as its backstop. The key is logged so it stays
 * recoverable.
 */
export async function sweepOrphanedAttachments(): Promise<number> {
  if (!isStorageConfigured()) {
    return 0;
  }

  const orphans = await getPool().query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key
     FROM message_attachments
     WHERE message_id IS NULL
       AND created_at < NOW() - INTERVAL '${ORPHAN_GRACE}'
     ORDER BY created_at ASC
     LIMIT ${SWEEP_BATCH}`,
  );
  if (orphans.rows.length === 0) {
    return 0;
  }

  await Promise.all(
    orphans.rows.map((row) =>
      deleteObject(row.storage_key).catch((error: unknown) => {
        console.error(
          `[attachments] leaked object ${row.storage_key}:`,
          error instanceof Error ? error.message : error,
        );
      }),
    ),
  );

  const deleted = await getPool().query(
    `DELETE FROM message_attachments WHERE id = ANY($1::uuid[])`,
    [orphans.rows.map((row) => row.id)],
  );
  return deleted.rowCount ?? 0;
}
