import { z } from "zod";

/**
 * Profile pictures: the wire contract for uploading one, for claiming it, and
 * for the stable URL every other payload then carries as `avatarUrl`.
 *
 * This rides on the **attachment** subsystem — the same S3-compatible bucket,
 * the same hand-rolled SigV4 in `server/src/lib/s3.ts`, the same
 * presign-then-HEAD dance. There is deliberately no second storage path: a
 * bucket the operator already configured, sweeps, and pays for is the one that
 * should hold avatars too. What differs is only what this file says: a smaller
 * cap, a narrower type allowlist, and a key namespaced per account instead of
 * per channel.
 */

/**
 * Types the server will sign an avatar upload for.
 *
 * Narrower than `ATTACHMENT_MIME_ALLOWLIST` on purpose. An avatar is drawn at
 * 40 pixels in a hundred places at once, so an animated GIF here is a hundred
 * decoders running behind a member list; and `image/avif` is left out because
 * both clients re-encode to JPEG before uploading anyway. `image/svg+xml` is
 * absent for the same reason it is absent from attachments — it is a document
 * that executes script, not a picture.
 */
export const AVATAR_MIME_ALLOWLIST = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AvatarContentType = (typeof AVATAR_MIME_ALLOWLIST)[number];

export const avatarContentTypeSchema = z.enum(AVATAR_MIME_ALLOWLIST);

/**
 * Upload ceiling in bytes.
 *
 * Half a megabyte would cover a correctly downscaled 512×512 JPEG many times
 * over. Five is what leaves room for a client that hands us a PNG, or a
 * platform whose re-encode is less aggressive than ours, without the cap
 * becoming the thing that fails an upload for a picture the user can see is
 * perfectly ordinary. It is not a licence to store 5 MiB avatars: both clients
 * downscale to `AVATAR_IMAGE_SIZE` first, and the real files land in the tens
 * of kilobytes.
 */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * The square both clients crop and scale to before uploading.
 *
 * Enforced by neither side — the server cannot cheaply know an image's
 * dimensions without decoding it, and decoding attacker-controlled images in
 * the API process is exactly the thing the presigned-upload design exists to
 * avoid. So this is a shared *convention*, and the byte cap above is what
 * actually bounds the damage of ignoring it. 512 is two retina steps above the
 * largest place an avatar is drawn (the profile sheet, at 92pt).
 */
export const AVATAR_IMAGE_SIZE = 512;

/** `POST /api/me/avatar` — ask for somewhere to put the bytes. */
export const createAvatarUploadSchema = z.object({
  contentType: avatarContentTypeSchema,
  byteSize: z.number().int().positive().max(MAX_AVATAR_BYTES),
});

export type CreateAvatarUploadRequest = z.infer<typeof createAvatarUploadSchema>;

export const createAvatarUploadResponseSchema = z.object({
  /**
   * The storage key, generated server-side and handed back only so the claim
   * can name the object that was just uploaded.
   *
   * A client that tampers with it gets nowhere: the claim re-derives the
   * account's own prefix and refuses any key outside it, so the worst a forged
   * value can do is overwrite the forger's own avatar. Note what is *not* here
   * — the key is never accepted as an upload target, only as a claim target,
   * and the presigned PUT above was signed for one specific key.
   */
  key: z.string(),
  uploadUrl: z.string(),
  /** ISO 8601. */
  expiresAt: z.string(),
});

export type CreateAvatarUploadResponse = z.infer<
  typeof createAvatarUploadResponseSchema
>;

/** `POST /api/me/avatar/claim` — the bytes are up; make it the avatar. */
export const claimAvatarSchema = z.object({
  key: z.string().min(1).max(200),
});

export type ClaimAvatarRequest = z.infer<typeof claimAvatarSchema>;

/**
 * `GET /api/avatars/config`. Mirrors `GET /api/attachments/config`, including
 * that the limits ride along in *both* states so a picker can reject an
 * over-size file against this deployment's own cap rather than discovering it
 * on a 413.
 */
export const avatarConfigSchema = z.object({
  /** False on a deployment with no `S3_*` — upload is absent, not broken. */
  enabled: z.boolean(),
  maxBytes: z.number().int().positive(),
  size: z.number().int().positive(),
});

export type AvatarConfig = z.infer<typeof avatarConfigSchema>;

/**
 * The path an uploaded avatar is served from, relative to the API's origin.
 *
 * ROOT-RELATIVE ON PURPOSE, and the same shape `/api/embeds/:hash/image` uses:
 * the SPA and the API are routinely two different origins (Cloudflare Pages +
 * Railway), and a server that baked its own absolute origin into this string
 * would need to be told what that origin is — one more environment variable
 * that is silently wrong on every self-hosted install. Each client prefixes its
 * own API base instead, which it already knows because every other request goes
 * there. See `resolveAvatarUrl` in the web client and `Avatar.imageUrl` on iOS.
 *
 * `v` is the first eight hex of the key, so the URL changes whenever the avatar
 * does. Without it the address of a person's avatar is a constant and every
 * cache in the path — browser, CDN, the `AsyncImage` cache on iOS — would keep
 * showing the old picture after a change.
 */
export function avatarPath(userId: string, version: string): string {
  return `/api/avatars/${userId}?v=${version}`;
}

/**
 * Is this the app's own avatar route rather than a URL somebody typed?
 *
 * Used by the profile writer to tell "the user pasted a link" apart from "this
 * is the avatar we just stored", which decides whether the stored object is
 * still referenced or has become an orphan to delete.
 */
export function isUploadedAvatarUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("/api/avatars/");
}
