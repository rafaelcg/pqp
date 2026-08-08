import { createHash, randomUUID } from "node:crypto";
import {
  avatarPath,
  MAX_AVATAR_BYTES,
  MAX_USER_BANNER_BYTES,
  userBannerPath,
  type AvatarContentType,
  type UserBannerContentType,
} from "@pqp/shared";
import { getPool, type DbUser } from "../db.js";
import {
  deleteObject,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
} from "../lib/s3.js";

/**
 * Uploaded profile pictures.
 *
 * Deliberately a thin layer over the *attachment* storage primitives rather
 * than a second storage subsystem: same bucket, same SigV4 signer, same
 * presign-then-HEAD contract. What is different is only what an avatar is —
 * one per account, replacing whatever was there, addressed by a stable URL
 * instead of by a row id.
 *
 * That last difference is why there is no `avatars` table. An attachment needs
 * one because it exists in a pending state before any message refers to it, and
 * because unclaimed rows have to be swept. An avatar's whole lifecycle fits in
 * two columns on `users`: the key of the object we hold, and the URL everything
 * else already reads. The cost is that an upload nobody claims leaves an orphan
 * object with no row to find it by — bounded by the 5 MiB cap, by the upload
 * URL's fifteen minutes, and by the fact that reaching that state takes a
 * client that asked to upload and then deliberately did not finish.
 */

/** Same fifteen minutes an attachment's upload URL gets, for the same reason. */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * How long the presigned GET behind `/api/avatars/:userId` stays valid.
 *
 * Its own constant rather than `attachmentUrlTtlSeconds()`, and not only to
 * avoid an import cycle (attachments.ts already imports this file's neighbour,
 * users.ts). The two are different leak windows: an attachment URL is handed to
 * a client and lives in its state, while this one is a `Location` header the
 * browser follows immediately and never stores. An hour is far more than a
 * redirect needs and keeps a URL scraped out of a cache from being a long-lived
 * read grant on the object.
 */
const READ_URL_TTL_SECONDS = 60 * 60;

/**
 * Extension per content type, never per anything the client sends.
 *
 * A `Record` keyed on the allowlist so widening `AVATAR_MIME_ALLOWLIST` fails
 * to compile until a suffix is chosen for it — the same construction
 * `EXTENSION_BY_CONTENT_TYPE` uses in attachments.ts, and for the same reason:
 * a key whose extension came from user input is a key that can be made to end
 * in `.html`.
 */
const EXTENSION_BY_CONTENT_TYPE: Record<AvatarContentType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Mirrors `isAttachmentsConfigured`: no storage, no upload, no button. */
export function isAvatarUploadConfigured(): boolean {
  return isStorageConfigured();
}

/**
 * Every object this account may ever claim lives under this prefix, and the
 * prefix is derived from the session's own user id — never from anything on
 * the request.
 *
 * This is the whole reason the claim can accept a client-supplied key at all.
 * `message_attachments` solves the same problem with a database row that
 * records who minted what; here the account's id is *in the key*, so "is this
 * object mine" is answerable from the string alone, and the worst a forged key
 * can do is point at another of the forger's own objects.
 */
function avatarPrefix(userId: string): string {
  return `avatars/${userId}/`;
}

export function avatarObjectKey(
  userId: string,
  contentType: AvatarContentType,
): string {
  return `${avatarPrefix(userId)}${randomUUID()}${
    EXTENSION_BY_CONTENT_TYPE[contentType]
  }`;
}

/**
 * Does this key belong to this account?
 *
 * Rejects traversal (`..`) explicitly rather than relying on the prefix alone:
 * `avatars/<me>/../<you>/x.jpg` starts with the right prefix and names somebody
 * else's object, and S3 keys are opaque strings that some gateways normalise
 * and some do not. Refusing the character sequence outright means it never
 * matters which kind we are talking to.
 */
export function isOwnAvatarKey(userId: string, key: string): boolean {
  return (
    key.startsWith(avatarPrefix(userId)) &&
    !key.includes("..") &&
    key.length > avatarPrefix(userId).length
  );
}

export interface AvatarUpload {
  key: string;
  uploadUrl: string;
  /** ISO 8601. */
  expiresAt: string;
}

/**
 * Hand back somewhere to put the bytes.
 *
 * Nothing is written to the database here — there is nothing yet to write. The
 * account's avatar does not change until the claim, so an upload that is
 * abandoned halfway leaves the old picture in place rather than a broken one.
 */
export function createAvatarUpload(input: {
  userId: string;
  contentType: AvatarContentType;
  byteSize: number;
}): AvatarUpload {
  const key = avatarObjectKey(input.userId, input.contentType);
  return {
    key,
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
 * Confirm the bytes are really there, and are what was signed for.
 *
 * The same HEAD an attachment claim runs, and it earns its keep for the same
 * three reasons: it is the only thing that tells "never uploaded" apart from
 * "uploaded", it catches an object stored as something other than the type that
 * was signed, and it covers a store that ignores the `Content-Length` in the
 * signature. Returns the measured size, or null for any answer that cannot be
 * trusted — a null is always "do not make this the avatar", never a warning.
 */
export async function verifyAvatarObject(
  userId: string,
  key: string,
): Promise<number | null> {
  if (!isStorageConfigured() || !isOwnAvatarKey(userId, key)) {
    return null;
  }

  let head;
  try {
    head = await headObject(key);
  } catch (error) {
    console.error(
      `[avatars] HEAD failed for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  if (!head) {
    return null;
  }
  if (head.contentLength <= 0 || head.contentLength > MAX_AVATAR_BYTES) {
    return null;
  }
  // The extension is chosen from the signed content type, so a stored type that
  // disagrees with it means the object under this key is not the object the
  // upload URL was minted for.
  const expected = Object.entries(EXTENSION_BY_CONTENT_TYPE).find(([, suffix]) =>
    key.endsWith(suffix),
  )?.[0];
  if (!expected || head.contentType !== expected) {
    return null;
  }
  return head.contentLength;
}

/**
 * The URL that goes in `users.avatar_url`, and from there into every payload.
 *
 * Root-relative — see the note on `avatarPath` in `@pqp/shared` for why the
 * server does not know its own public origin and should not be taught to.
 */
export function avatarUrlForKey(userId: string, key: string): string {
  return avatarPath(userId, createHash("sha256").update(key).digest("hex").slice(0, 8));
}

/**
 * Drop an object that nothing points at any more. Best effort, always.
 *
 * A failure here costs storage, and the alternative — surfacing it — costs the
 * user the profile change they asked for, on a request whose real work has
 * already committed. Logged rather than thrown for that reason. Never call it
 * with a key that is still referenced.
 */
export async function discardAvatarObject(key: string): Promise<void> {
  if (!isStorageConfigured()) {
    return;
  }
  try {
    await deleteObject(key);
  } catch (error) {
    console.error(
      `[avatars] could not delete ${key}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Where the bytes for this account's avatar actually are, presigned.
 *
 * Returns null when the account has no uploaded avatar (it may still have a
 * Clerk picture or a typed URL — those are somebody else's bytes and are not
 * served through here) and when storage is unconfigured, which for an existing
 * key means the deployment lost its credentials rather than that the object is
 * gone. Both are a 404 to the caller: an avatar that cannot be produced is
 * indistinguishable from one that does not exist, and the monogram covers both.
 *
 * Its own query rather than a join, because the one caller is an
 * unauthenticated image request that has no session row to ride on.
 */
export async function presignAvatarRead(userId: string): Promise<string | null> {
  if (!isStorageConfigured()) {
    return null;
  }
  const result = await getPool().query<{ avatar_key: string | null }>(
    `SELECT avatar_key FROM users WHERE id = $1`,
    [userId],
  );
  const key = result.rows[0]?.avatar_key;
  if (!key) {
    return null;
  }
  return presignGet(key, { ttlSeconds: READ_URL_TTL_SECONDS });
}

// ------------------------------------------------------------- user banners

/**
 * The strip across the top of `pqp.gg/@rafa`.
 *
 * IN THIS FILE RATHER THAN IN A THIRD ONE, and the choice is the same one
 * `server-images.ts` explains from the other side. What decides where an image
 * contract lives is not the shape of the picture, it is what makes a claim
 * safe: an avatar key carries the claiming account's own id, so "is this mine"
 * is answerable from the string alone and the route needs no permission check
 * beyond having a session. A banner key carries the same id and is safe for the
 * same reason, so it belongs beside the avatar and not beside the server image,
 * whose key names a room many people are in and which is therefore owner-gated
 * at the route.
 *
 * Everything below is the avatar's own code with a different prefix, a
 * different cap and a different pair of columns. That is not duplication to
 * factor out later — it is the second instance of a pattern whose whole value
 * is that each instance states its own authorisation story in full.
 */

const BANNER_EXTENSION_BY_CONTENT_TYPE: Record<UserBannerContentType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Mirrors `isAvatarUploadConfigured`: no storage, no upload, no button. */
export function isUserBannerUploadConfigured(): boolean {
  return isStorageConfigured();
}

/**
 * A separate prefix from `avatars/<id>/`, not a folder inside it.
 *
 * The prefix is what `isOwnBannerKey` checks, and a banner claim must not be
 * able to install an object that was uploaded as an avatar, nor the reverse:
 * the two have different byte caps, and one shared prefix would let the smaller
 * cap be spent through the larger one's signature. Two prefixes make that a
 * property of the string rather than a rule somebody has to remember.
 */
function bannerPrefix(userId: string): string {
  return `banners/${userId}/`;
}

export function bannerObjectKey(
  userId: string,
  contentType: UserBannerContentType,
): string {
  return `${bannerPrefix(userId)}${randomUUID()}${
    BANNER_EXTENSION_BY_CONTENT_TYPE[contentType]
  }`;
}

/** Does this key belong to this account? `..` refused outright — see `isOwnAvatarKey`. */
export function isOwnBannerKey(userId: string, key: string): boolean {
  const prefix = bannerPrefix(userId);
  return (
    key.startsWith(prefix) && !key.includes("..") && key.length > prefix.length
  );
}

export interface UserBannerUpload {
  key: string;
  uploadUrl: string;
  /** ISO 8601. */
  expiresAt: string;
}

/** Hand back somewhere to put the bytes. Writes nothing — the claim does that. */
export function createUserBannerUpload(input: {
  userId: string;
  contentType: UserBannerContentType;
  byteSize: number;
}): UserBannerUpload {
  const key = bannerObjectKey(input.userId, input.contentType);
  return {
    key,
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
 * Confirm the bytes are really there, and are what was signed for. The same
 * HEAD an avatar claim runs, earning its keep for the same three reasons — see
 * `verifyAvatarObject`. Null is always "do not make this the banner".
 */
export async function verifyUserBannerObject(
  userId: string,
  key: string,
): Promise<number | null> {
  if (!isStorageConfigured() || !isOwnBannerKey(userId, key)) {
    return null;
  }

  let head;
  try {
    head = await headObject(key);
  } catch (error) {
    console.error(
      `[banners] HEAD failed for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  if (!head) {
    return null;
  }
  if (head.contentLength <= 0 || head.contentLength > MAX_USER_BANNER_BYTES) {
    return null;
  }
  const expected = Object.entries(BANNER_EXTENSION_BY_CONTENT_TYPE).find(
    ([, suffix]) => key.endsWith(suffix),
  )?.[0];
  if (!expected || head.contentType !== expected) {
    return null;
  }
  return head.contentLength;
}

/** The URL that goes in `users.banner_url`. Root-relative — see `avatarUrlForKey`. */
export function userBannerUrlForKey(userId: string, key: string): string {
  return userBannerPath(
    userId,
    createHash("sha256").update(key).digest("hex").slice(0, 8),
  );
}

/** Drop an object nothing points at any more. Best effort — see `discardAvatarObject`. */
export async function discardBannerObject(key: string): Promise<void> {
  if (!isStorageConfigured()) {
    return;
  }
  try {
    await deleteObject(key);
  } catch (error) {
    console.error(
      `[banners] could not delete ${key}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Point the row at a new object, or at nothing.
 *
 * NOT FOLDED INTO `updateProfile`, deliberately, and the reason is the one
 * `setServerImage` gives: between a bare read of the old key and a bare write
 * of the new one a second upload can land, and deleting the key the first read
 * saw would delete the picture the second one just installed. So the read is
 * `FOR UPDATE` inside the same transaction as the write, and the previous key
 * comes back with the row so the caller can orphan exactly what it replaced.
 *
 * It is also not a profile change in the sense `updateProfile` means. Nothing
 * about a banner is announced over the socket: no member list, message row,
 * roster or conversation draws one, so `announceProfile` would be a broadcast
 * to every client on the instance carrying a field none of them render.
 */
export async function setUserBanner(
  userId: string,
  next: { url: string; key: string } | null,
): Promise<{ user: DbUser; previousKey: string | null } | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const before = await client.query<{ banner_key: string | null }>(
      `SELECT banner_key FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (before.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await client.query<DbUser>(
      `UPDATE users SET banner_url = $2, banner_key = $3 WHERE id = $1
       RETURNING id, clerk_id, display_name, username, discriminator,
                 avatar_url, avatar_key, is_character, handle, handle_changed_at,
                 banner_url, banner_key`,
      [userId, next?.url ?? null, next?.key ?? null],
    );
    await client.query("COMMIT");
    return {
      user: result.rows[0]!,
      previousKey: before.rows[0]!.banner_key ?? null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Where the bytes for this account's banner actually are, presigned.
 *
 * Null for "no banner", "no such user" and "storage is unconfigured" alike —
 * all three are a 404 to the caller, which draws the generated gradient. Its
 * own query rather than a join, because the one caller is an unauthenticated
 * image request with no session row to ride on.
 */
export async function presignUserBannerRead(
  userId: string,
): Promise<string | null> {
  if (!isStorageConfigured()) {
    return null;
  }
  const result = await getPool().query<{ banner_key: string | null }>(
    `SELECT banner_key FROM users WHERE id = $1`,
    [userId],
  );
  const key = result.rows[0]?.banner_key;
  if (!key) {
    return null;
  }
  return presignGet(key, { ttlSeconds: READ_URL_TTL_SECONDS });
}
