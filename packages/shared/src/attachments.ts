import { z } from "zod";

/**
 * File attachments: the wire contract for minting an upload URL, for claiming
 * the resulting rows onto a message, and for every read of a stored message.
 *
 * Bytes never pass through the API — the server hands out a presigned PUT and
 * the browser uploads straight to object storage — so this file is the only
 * place both sides agree on what may be uploaded at all. The limits below are
 * re-checked server-side when the URL is minted; a client that skipped them
 * would only get a 4xx, never a stored object.
 */

/**
 * Content types the server will sign an upload for.
 *
 * An allowlist rather than a denylist, because the failure mode is serving
 * hostile content from our own origin. Notably absent: `image/svg+xml` and
 * `text/html`, which are documents that execute script, not media.
 */
export const ATTACHMENT_MIME_ALLOWLIST = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
  "text/plain",
] as const;

export type AttachmentContentType = (typeof ATTACHMENT_MIME_ALLOWLIST)[number];

export const attachmentContentTypeSchema = z.enum(ATTACHMENT_MIME_ALLOWLIST);

/** Attachments one message may carry, matching Discord's own limit. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Upload ceiling in bytes. The deployment may lower it with
 * `MAX_ATTACHMENT_BYTES`; it cannot raise it past this without a rebuild,
 * because `createAttachmentSchema` rejects the mint request before the
 * server's own cap is ever consulted.
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ATTACHMENT_FILENAME_MAX_LENGTH = 255;

/**
 * Stricter than `safeTextSchema`, which tolerates newline and tab because
 * message bodies are multi-line. A filename is not prose: it is echoed into a
 * `Content-Disposition` header on the presigned read, where a CR or LF is
 * header injection.
 */
// eslint-disable-next-line no-control-regex
const FILENAME_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * `\` is a path separator on Windows *and* the escape character inside a
 * quoted `Content-Disposition` filename, so rejecting it closes both doors at
 * once. The storage key is generated server-side and never derived from this
 * value, so a filename is display text and nothing else — this check exists so
 * it can never become anything else by accident.
 */
const FILENAME_PATH_SEPARATORS = /[/\\]/;

export const attachmentFilenameSchema = z
  .string()
  .min(1)
  .max(ATTACHMENT_FILENAME_MAX_LENGTH)
  .refine((value) => !FILENAME_CONTROL_CHARS.test(value), "Invalid filename")
  .refine((value) => !FILENAME_PATH_SEPARATORS.test(value), "Invalid filename");

/**
 * Ceiling for a declared image dimension. Well past any camera or screenshot,
 * and far short of what an `INTEGER` column or a layout calculation can be
 * pushed into by a client that decides to send 2^31 - 1.
 */
export const ATTACHMENT_MAX_DIMENSION = 65535;

const attachmentDimensionSchema = z
  .number()
  .int()
  .positive()
  .max(ATTACHMENT_MAX_DIMENSION);

/**
 * Body of `POST /api/channels/:channelId/attachments`, sent before a single
 * byte is uploaded.
 *
 * `byteSize` is signed into the presigned PUT, so the bucket rejects a body of
 * any other length — but it is still the client's number, and the size the
 * database records is the one read back with a HEAD at claim time.
 *
 * `width` / `height` are display-only hints with the same trust posture: they
 * exist so the message can reserve the right box before the image loads, and a
 * client that lies about them mis-sizes its own placeholder and nothing else.
 * Bounded rather than trusted, because "nothing else" stops being true once a
 * number is absurd enough to be a layout weapon.
 */
export const createAttachmentSchema = z.object({
  filename: attachmentFilenameSchema,
  contentType: attachmentContentTypeSchema,
  byteSize: z.number().int().positive().max(DEFAULT_MAX_ATTACHMENT_BYTES),
  width: attachmentDimensionSchema.nullish(),
  height: attachmentDimensionSchema.nullish(),
});

export type CreateAttachmentRequest = z.infer<typeof createAttachmentSchema>;

export const createAttachmentResponseSchema = z.object({
  attachmentId: z.string().uuid(),
  /** Presigned PUT. The upload must send exactly the signed `Content-Type`. */
  uploadUrl: z.string().url(),
  expiresAt: z.string(),
});

export type CreateAttachmentResponse = z.infer<
  typeof createAttachmentResponseSchema
>;

/**
 * A stored attachment as it travels with a message.
 *
 * `contentType` is a plain string here rather than the allowlist enum: it is
 * whatever the object store reported at claim time, and a row written under an
 * older or newer allowlist must still parse. Nothing downstream trusts it —
 * `isImageContentType` fails closed, and the server sends anything that is not
 * an inline image as a download.
 *
 * `url` is minted per read and expires, which is why it is not stored anywhere.
 */
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** Set only for images whose dimensions could be read; null otherwise. */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Presigned GET, valid for `ATTACHMENT_URL_TTL_SECONDS`. */
  url: z.string().url(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * Response of `GET /api/attachments/:attachmentId/url`, which a client calls
 * when an `<img>` fails — the tab has outlived the presigned URL baked into
 * the message it is rendering.
 */
export const attachmentUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
});

export type AttachmentUrlResponse = z.infer<typeof attachmentUrlResponseSchema>;

/**
 * Types the client may put in an `<img>`.
 *
 * Enumerated rather than tested with a `image/` prefix, because the prefix
 * would also match `image/svg+xml` — a document that runs script in our origin.
 * Widening `ATTACHMENT_MIME_ALLOWLIST` must never silently widen what renders
 * inline, so the two lists are deliberately separate.
 */
const INLINE_IMAGE_CONTENT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
];

/** True when an attachment renders inline; false means a download chip. */
export function isImageContentType(contentType: string): boolean {
  return INLINE_IMAGE_CONTENT_TYPES.includes(contentType.trim().toLowerCase());
}
