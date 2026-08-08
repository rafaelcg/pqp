import { z } from "zod";
import { AVATAR_MIME_ALLOWLIST } from "./avatars.js";

/**
 * A person's banner: the full-bleed strip across the top of `pqp.gg/@rafa`.
 *
 * THE THIRD COPY OF THE SAME CONTRACT, and deliberately a copy rather than a
 * generalisation. `avatars.ts` and `server-images.ts` already say all of this
 * once each — same bucket, same hand-rolled SigV4, same presign-then-HEAD, same
 * root-relative URL that every payload carries — and the note at the top of
 * `server-images.ts` explains why they were not folded together: what makes a
 * claim safe differs between them, and one function name covering two different
 * guarantees is how a route that never ran `requireOwner` reaches the generic
 * helper.
 *
 * A user banner sits on the avatar's side of that line, not the server's. The
 * key contains the claiming account's own id, so "is this mine" is answerable
 * from the string alone and the route needs no permission check beyond having a
 * session. That is why this rides `services/avatars.ts` rather than
 * `services/server-images.ts` on the server.
 *
 * `AVATAR_MIME_ALLOWLIST` is reused for the reason `SERVER_IMAGE_MIME_ALLOWLIST`
 * reuses it: no animated GIF behind somebody's name, and no SVG, because an SVG
 * is a document that executes script — and this one is drawn on the single page
 * in the product served to people with no account.
 */

export const USER_BANNER_MIME_ALLOWLIST = AVATAR_MIME_ALLOWLIST;

export type UserBannerContentType =
  (typeof USER_BANNER_MIME_ALLOWLIST)[number];

export const userBannerContentTypeSchema = z.enum(USER_BANNER_MIME_ALLOWLIST);

/** Same eight megabytes a server banner gets, and for the same reason. */
export const MAX_USER_BANNER_BYTES = 8 * 1024 * 1024;

/**
 * The rectangle both clients crop and scale to.
 *
 * Wider and shorter than a server banner's 1024×360. A server banner sits in a
 * 256px channel column; this one runs the full width of a page somebody
 * screenshots on a 390px phone and on a 1440px laptop, and 3:1 is the ratio at
 * which the same image is a band on the phone and a hero on the laptop without
 * a second crop. Enforced by neither side — the server would have to decode an
 * attacker-controlled image to check, which is exactly what the presigned
 * upload exists to avoid — so the byte cap above is the real bound.
 */
export const USER_BANNER_WIDTH = 1500;
export const USER_BANNER_HEIGHT = 500;

/** `POST /api/me/banner` — ask for somewhere to put the bytes. */
export const createUserBannerUploadSchema = z.object({
  contentType: userBannerContentTypeSchema,
  byteSize: z.number().int().positive().max(MAX_USER_BANNER_BYTES),
});

export type CreateUserBannerUploadRequest = z.infer<
  typeof createUserBannerUploadSchema
>;

export const createUserBannerUploadResponseSchema = z.object({
  /**
   * The storage key, generated server-side and handed back only so the claim
   * can name the object that was just uploaded. Self-authorising in exactly the
   * way an avatar key is: it carries the account's own id, so the worst a
   * forged value can do is point at another of the forger's own objects.
   */
  key: z.string(),
  uploadUrl: z.string(),
  /** ISO 8601. */
  expiresAt: z.string(),
});

export type CreateUserBannerUploadResponse = z.infer<
  typeof createUserBannerUploadResponseSchema
>;

/** `POST /api/me/banner/claim` — the bytes are up; make it the banner. */
export const claimUserBannerSchema = z.object({
  key: z.string().min(1).max(200),
});

export type ClaimUserBannerRequest = z.infer<typeof claimUserBannerSchema>;

/**
 * `GET /api/me/banner/config`. Mirrors `GET /api/avatars/config`, limits in
 * both states so a picker can refuse an over-size file against this
 * deployment's own cap rather than discovering it on a 413.
 */
export const userBannerConfigSchema = z.object({
  /** False on a deployment with no `S3_*` — upload is absent, not broken. */
  enabled: z.boolean(),
  maxBytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type UserBannerConfig = z.infer<typeof userBannerConfigSchema>;

/**
 * Where an uploaded banner is served from, relative to the API's origin.
 *
 * Root-relative for the reason `avatarPath` is: the SPA and the API are
 * routinely two different origins, and a server that baked its own public
 * origin into this string would need to be told what that origin is. `v` is the
 * first eight hex of the storage key, so changing the banner changes its
 * address and no cache in the path can serve the old one.
 */
export function userBannerPath(userId: string, version: string): string {
  return `/api/users/${userId}/banner?v=${version}`;
}

/**
 * Is this the app's own banner route rather than a URL somebody typed?
 *
 * The profile writer's test for "the stored object is still referenced" versus
 * "this has become an orphan to delete" — same job `isUploadedAvatarUrl` does.
 */
export function isUploadedBannerUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\/api\/users\/[^/]+\/banner/.test(value);
}
