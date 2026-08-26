import { z } from "zod";
import { AVATAR_MIME_ALLOWLIST } from "./avatars.js";

/**
 * A server's two pictures: the **icon** that identifies it in the rail, and the
 * **banner** that runs across the top of its channel list.
 *
 * The whole file is deliberately the avatar contract with two shapes instead of
 * one. Same bucket, same hand-rolled SigV4 in `server/src/lib/s3.ts`, same
 * presign-then-HEAD dance, same "root-relative URL that every payload carries"
 * arrangement. What differs is what a server picture *is*:
 *
 *  - it belongs to a row that many people can see and exactly one person may
 *    change, so the mint and the claim are owner-gated rather than self-scoped
 *    (an avatar's key contains its own authorisation; a server's cannot);
 *  - there are two of them per row, with different aspect ratios and different
 *    caps, so everything here is parameterised by `kind` rather than duplicated.
 *
 * `AVATAR_MIME_ALLOWLIST` is reused rather than re-declared: the reasoning that
 * chose it (no animated GIF behind a member list, no SVG because an SVG is a
 * document that executes script) applies unchanged to a picture drawn behind a
 * server name, and a second list would drift from the first the day one of them
 * gained a fourth entry.
 */

export const SERVER_IMAGE_MIME_ALLOWLIST = AVATAR_MIME_ALLOWLIST;

export type ServerImageContentType = (typeof SERVER_IMAGE_MIME_ALLOWLIST)[number];

export const serverImageContentTypeSchema = z.enum(SERVER_IMAGE_MIME_ALLOWLIST);

/** Which of a server's two pictures a request is about. */
export const serverImageKindSchema = z.enum(["icon", "banner"]);
export type ServerImageKind = z.infer<typeof serverImageKindSchema>;

/** Same ceiling an avatar gets, for the same reason: it is the same square. */
export const MAX_SERVER_ICON_BYTES = 5 * 1024 * 1024;

/**
 * Eight, not five.
 *
 * A banner is roughly three times the pixels of an icon and is the one image in
 * the app a person will deliberately pick a photograph for. The cap is not a
 * storage budget — the client re-encodes to a 1024×480 JPEG that lands in the
 * low hundreds of kilobytes — it is the ceiling on what a client that ignores
 * the convention can push through a signed URL.
 */
export const MAX_SERVER_BANNER_BYTES = 8 * 1024 * 1024;

/** The square the icon is cropped and scaled to, matching `AVATAR_IMAGE_SIZE`. */
export const SERVER_ICON_SIZE = 512;

/**
 * The rectangle a banner is cropped and scaled to.
 *
 * This is the channel-column band, not a second shape. The column is 256px
 * wide and 120px tall (16rem × 7.5rem). 1024×480 is that ratio at 4×, so the
 * file and the box match: a center crop on upload is the last crop. Display
 * uses the same ratio via `aspect-ratio`, so a narrower drawer does not invent
 * a second crop.
 *
 * Enforced by neither side, exactly as `AVATAR_IMAGE_SIZE` is not: the server
 * would have to decode an attacker-controlled image to check, which is the
 * thing the presigned-upload design exists to avoid. The byte cap above is
 * what actually bounds ignoring it.
 */
export const SERVER_BANNER_WIDTH = 1024;
export const SERVER_BANNER_HEIGHT = 480;

/** Bytes allowed for one kind. The two callers that need it both have a kind. */
export function maxServerImageBytes(kind: ServerImageKind): number {
  return kind === "banner" ? MAX_SERVER_BANNER_BYTES : MAX_SERVER_ICON_BYTES;
}

/** `POST /api/servers/:id/{icon,banner}` — ask for somewhere to put the bytes. */
export const createServerImageUploadSchema = z.object({
  contentType: serverImageContentTypeSchema,
  // The per-kind ceiling is applied by the route, which knows which kind it is;
  // this bound only stops an obviously absurd number reaching the signer.
  byteSize: z.number().int().positive().max(MAX_SERVER_BANNER_BYTES),
});

export type CreateServerImageUploadRequest = z.infer<
  typeof createServerImageUploadSchema
>;

export const createServerImageUploadResponseSchema = z.object({
  /**
   * The storage key, generated server-side and handed back only so the claim
   * can name the object that was just uploaded.
   *
   * Unlike an avatar key this is NOT self-authorising — it names a server, and
   * anyone may be a member of that server. The claim re-checks ownership of the
   * server *and* that the key sits under that server's own prefix, so a forged
   * value can at worst point at another object in a bucket the forger already
   * owns the row for.
   */
  key: z.string(),
  uploadUrl: z.string(),
  /** ISO 8601. */
  expiresAt: z.string(),
});

export type CreateServerImageUploadResponse = z.infer<
  typeof createServerImageUploadResponseSchema
>;

/** `POST /api/servers/:id/{icon,banner}/claim` — the bytes are up. */
export const claimServerImageSchema = z.object({
  key: z.string().min(1).max(200),
});

export type ClaimServerImageRequest = z.infer<typeof claimServerImageSchema>;

/**
 * `GET /api/servers/images/config`. Mirrors `GET /api/avatars/config`, limits
 * included in both states so a picker can refuse an over-size file against this
 * deployment's own cap rather than discovering it on a 413.
 */
export const serverImageConfigSchema = z.object({
  /** False on a deployment with no `S3_*` — upload is absent, not broken. */
  enabled: z.boolean(),
  icon: z.object({
    maxBytes: z.number().int().positive(),
    size: z.number().int().positive(),
  }),
  banner: z.object({
    maxBytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});

export type ServerImageConfig = z.infer<typeof serverImageConfigSchema>;

/**
 * The paths an uploaded server picture is served from, relative to the API's
 * origin — root-relative for the same reason `avatarPath` is: the server does
 * not know its own public origin and should not be taught to. Each client
 * prefixes its own API base.
 *
 * `v` is the first eight hex of the storage key, so changing the picture
 * changes its address and no cache in the path can serve the old one.
 */
export function serverIconPath(serverId: string, version: string): string {
  return `/api/servers/${serverId}/icon?v=${version}`;
}

export function serverBannerPath(serverId: string, version: string): string {
  return `/api/servers/${serverId}/banner?v=${version}`;
}

export function serverImagePath(
  kind: ServerImageKind,
  serverId: string,
  version: string,
): string {
  return kind === "banner"
    ? serverBannerPath(serverId, version)
    : serverIconPath(serverId, version);
}
