import { MAX_AVATAR_BYTES, type User } from "@pqp/shared";
import { claimAvatar, createAvatarUpload } from "@/lib/api";
import { cropImageToSquare } from "@/lib/avatar";

/**
 * A picked file, all the way to being this account's avatar.
 *
 * Three steps, and the middle one deliberately does not touch the API:
 *
 *  1. `POST /api/me/avatar` mints a key and a presigned PUT;
 *  2. the bytes go **straight to storage** — the same reason attachments do,
 *     which is that a Node process holding the database pool has no business
 *     buffering image uploads;
 *  3. `POST /api/me/avatar/claim` HEADs the object and swaps the columns.
 *
 * The crop happens before any of it. What the server is asked to sign is the
 * length of the *cropped* JPEG, so the browser cannot mint a URL for a 40 KB
 * avatar and then push 5 MiB through it — the length is in the signature.
 *
 * Nothing here is undone on failure and nothing needs to be: an object whose
 * claim never happens is never referenced by any row, and the account keeps the
 * avatar it already had.
 */
export async function uploadAvatar(file: Blob): Promise<User> {
  let cropped: Blob;
  try {
    cropped = await cropImageToSquare(file);
  } catch {
    // `createImageBitmap` refuses anything that is not a decodable image, which
    // is the only validation this needs: the file picker's `accept` is a hint,
    // and a renamed `.exe` fails here rather than at a signature mismatch six
    // seconds later with a message nobody can act on.
    throw new Error("That file is not an image this browser can read.");
  }

  // Should be unreachable — a 512×512 JPEG is tens of kilobytes — but the mint
  // would answer 400 and this says why in words the person can act on.
  if (cropped.size > MAX_AVATAR_BYTES) {
    throw new Error("That image is too large, even after resizing.");
  }

  const minted = await createAvatarUpload({
    contentType: "image/jpeg",
    byteSize: cropped.size,
  });

  const response = await fetch(minted.uploadUrl, {
    method: "PUT",
    // Must match what was signed, exactly. A mismatch comes back from storage
    // as a signature error rather than as anything descriptive.
    headers: { "Content-Type": "image/jpeg" },
    body: cropped,
  });
  if (!response.ok) {
    throw new Error(`Storage refused the upload (${response.status}).`);
  }

  const claimed = await claimAvatar(minted.key);
  return claimed.user;
}
