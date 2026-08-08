import { createHash, randomUUID } from "node:crypto";
import {
  maxServerImageBytes,
  serverImagePath,
  type ServerImageContentType,
  type ServerImageKind,
} from "@pqp/shared";
import { getPool, type DbServer } from "../db.js";
import {
  deleteObject,
  headObject,
  isStorageConfigured,
  presignGet,
  presignPut,
} from "../lib/s3.js";

/**
 * A server's icon and banner.
 *
 * Deliberately the same thin layer over the attachment storage primitives that
 * `avatars.ts` is — same bucket, same signer, same presign-then-HEAD contract —
 * and written as a near-copy of it on purpose rather than as a shared
 * abstraction over both. The two differ in the one place that matters, which is
 * *what makes a claim safe*:
 *
 *  - an avatar key contains the claiming account's own id, so "is this mine" is
 *    answerable from the string alone and no permission check is needed;
 *  - a server key contains a *server* id, which many people are members of. The
 *    prefix check below therefore proves only "this object belongs to the server
 *    named in the URL". The route is what proves the caller owns that server,
 *    and it must — this file cannot.
 *
 * Folding both into one generic module would have put those two very different
 * guarantees behind one function name, and the day somebody reached for the
 * generic one from a route that had not run `requireOwner` there would be
 * nothing in the type to stop them.
 */

/** Same fifteen minutes an attachment's and an avatar's upload URL gets. */
const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Same hour `presignAvatarRead` uses, for the same reason — see that comment. */
const READ_URL_TTL_SECONDS = 60 * 60;

/**
 * Extension per content type, never per anything the client sends. A `Record`
 * keyed on the allowlist so widening it fails to compile until a suffix is
 * chosen — a key whose extension came from user input is a key that can be made
 * to end in `.html`.
 */
const EXTENSION_BY_CONTENT_TYPE: Record<ServerImageContentType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Mirrors `isAvatarUploadConfigured`: no storage, no upload, no button. */
export function isServerImageUploadConfigured(): boolean {
  return isStorageConfigured();
}

/** The column pair each kind writes. Kept here so a typo cannot reach SQL. */
const COLUMNS: Record<ServerImageKind, { url: string; key: string }> = {
  icon: { url: "icon_url", key: "icon_key" },
  banner: { url: "banner_url", key: "banner_key" },
};

function serverImagePrefix(kind: ServerImageKind, serverId: string): string {
  return `servers/${serverId}/${kind}/`;
}

export function serverImageObjectKey(
  kind: ServerImageKind,
  serverId: string,
  contentType: ServerImageContentType,
): string {
  return `${serverImagePrefix(kind, serverId)}${randomUUID()}${
    EXTENSION_BY_CONTENT_TYPE[contentType]
  }`;
}

/**
 * Does this key belong to this server's picture of this kind?
 *
 * NOT an authorisation check on its own — see the file comment. It is the
 * second half of one: the route establishes that the caller owns the server,
 * and this establishes that the object named is one of that server's own.
 *
 * `..` is refused outright rather than normalised away: `servers/<mine>/icon/../
 * ../<yours>/banner/x.jpg` starts with the right prefix and names somebody
 * else's object, and S3 keys are opaque strings that some gateways normalise and
 * some do not. Refusing the sequence means it never matters which kind we are
 * talking to.
 */
export function isServerImageKey(
  kind: ServerImageKind,
  serverId: string,
  key: string,
): boolean {
  const prefix = serverImagePrefix(kind, serverId);
  return (
    key.startsWith(prefix) && !key.includes("..") && key.length > prefix.length
  );
}

export interface ServerImageUpload {
  key: string;
  uploadUrl: string;
  /** ISO 8601. */
  expiresAt: string;
}

/**
 * Hand back somewhere to put the bytes.
 *
 * Writes nothing: the server's picture does not change until the claim, so an
 * upload abandoned halfway leaves the old one in place rather than a broken one.
 */
export function createServerImageUpload(input: {
  kind: ServerImageKind;
  serverId: string;
  contentType: ServerImageContentType;
  byteSize: number;
}): ServerImageUpload {
  const key = serverImageObjectKey(
    input.kind,
    input.serverId,
    input.contentType,
  );
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
 * The same HEAD an attachment and an avatar claim run, earning its keep for the
 * same three reasons: it is the only thing that tells "never uploaded" apart
 * from "uploaded", it catches an object stored as something other than the type
 * that was signed, and it covers a store that ignores the signed
 * `Content-Length`. Returns the measured size, or null for any answer that
 * cannot be trusted — a null is always "do not make this the picture".
 */
export async function verifyServerImageObject(
  kind: ServerImageKind,
  serverId: string,
  key: string,
): Promise<number | null> {
  if (!isStorageConfigured() || !isServerImageKey(kind, serverId, key)) {
    return null;
  }

  let head;
  try {
    head = await headObject(key);
  } catch (error) {
    console.error(
      `[server-images] HEAD failed for ${key}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  if (!head) {
    return null;
  }
  if (head.contentLength <= 0 || head.contentLength > maxServerImageBytes(kind)) {
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
 * The URL that goes in `servers.icon_url` / `banner_url`, and from there into
 * every server payload and every directory card. Root-relative — see the note
 * on `serverIconPath` in `@pqp/shared`.
 */
export function serverImageUrlForKey(
  kind: ServerImageKind,
  serverId: string,
  key: string,
): string {
  return serverImagePath(
    kind,
    serverId,
    createHash("sha256").update(key).digest("hex").slice(0, 8),
  );
}

/**
 * Drop an object nothing points at any more. Best effort, always — a failure
 * costs storage, and surfacing it would cost the owner the change they asked
 * for on a request whose real work has already committed.
 */
export async function discardServerImageObject(key: string): Promise<void> {
  if (!isStorageConfigured()) {
    return;
  }
  try {
    await deleteObject(key);
  } catch (error) {
    console.error(
      `[server-images] could not delete ${key}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Point the row at a new object, or at nothing.
 *
 * Returns the row as it now stands together with the key it *stopped* pointing
 * at, so the caller can drop the orphan. Read inside the same transaction and
 * under `FOR UPDATE`, exactly as `updateMessageRetention` reads its previous
 * value, and for a sharper reason than an audit entry: between a bare `SELECT
 * icon_key` and a bare `UPDATE`, a second upload can land — and deleting the key
 * the first read saw would delete the picture the second one just installed.
 *
 * `SERVER_COLUMNS` is threaded in from servers.ts rather than restated so a
 * column added there reaches this write too.
 */
export async function setServerImage(
  kind: ServerImageKind,
  serverId: string,
  next: { url: string; key: string } | null,
  columns: string,
): Promise<{ server: DbServer; previousKey: string | null } | null> {
  const { url, key } = COLUMNS[kind];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const before = await client.query<Record<string, string | null>>(
      `SELECT ${key} AS previous_key FROM servers WHERE id = $1 FOR UPDATE`,
      [serverId],
    );
    if (before.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await client.query<DbServer>(
      `UPDATE servers SET ${url} = $2, ${key} = $3 WHERE id = $1
       RETURNING ${columns}`,
      [serverId, next?.url ?? null, next?.key ?? null],
    );
    await client.query("COMMIT");
    return {
      server: result.rows[0]!,
      previousKey: before.rows[0]!.previous_key ?? null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Where the bytes for this server's picture actually are, presigned.
 *
 * Returns null when the server has no uploaded picture of this kind and when
 * storage is unconfigured — which for an existing key means the deployment lost
 * its credentials rather than that the object is gone. Both are a 404 to the
 * caller: a picture that cannot be produced is indistinguishable from one that
 * does not exist, and the monogram covers both.
 *
 * Its own query rather than a join, because the one caller is an
 * unauthenticated image request with no session row to ride on.
 */
export async function presignServerImageRead(
  kind: ServerImageKind,
  serverId: string,
): Promise<string | null> {
  if (!isStorageConfigured()) {
    return null;
  }
  const { key } = COLUMNS[kind];
  const result = await getPool().query<Record<string, string | null>>(
    `SELECT ${key} AS storage_key FROM servers WHERE id = $1`,
    [serverId],
  );
  const storageKey = result.rows[0]?.storage_key;
  if (!storageKey) {
    return null;
  }
  return presignGet(storageKey, { ttlSeconds: READ_URL_TTL_SECONDS });
}
