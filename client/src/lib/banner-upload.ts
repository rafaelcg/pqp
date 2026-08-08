import {
  MAX_USER_BANNER_BYTES,
  USER_BANNER_HEIGHT,
  USER_BANNER_WIDTH,
  type User,
} from "@pqp/shared";
import { claimUserBanner, createUserBannerUpload } from "@/lib/api";
import { cropImageToRect } from "@/lib/avatar";

/**
 * A picked file, all the way to being this account's profile banner.
 *
 * The same three steps `uploadAvatar` and `uploadServerImage` take, and the
 * middle one deliberately does not touch the API:
 *
 *  1. `POST /api/me/banner` mints a key and a presigned PUT;
 *  2. the bytes go **straight to storage**, because a Node process holding the
 *     database pool has no business buffering image uploads;
 *  3. `POST /api/me/banner/claim` HEADs the object and swaps the columns.
 *
 * The crop happens before any of it, so what the server is asked to sign is the
 * length of the *cropped* JPEG — the browser cannot mint a URL for a 200 KB
 * banner and then push eight megabytes through it, because the length is in the
 * signature.
 *
 * Nothing here is undone on failure and nothing needs to be: an object whose
 * claim never happens is referenced by no row, and the account keeps the banner
 * it already had.
 */
export async function uploadUserBanner(file: Blob): Promise<User> {
  let cropped: Blob;
  try {
    cropped = await cropImageToRect(
      file,
      USER_BANNER_WIDTH,
      USER_BANNER_HEIGHT,
    );
  } catch {
    // `createImageBitmap` refuses anything that is not a decodable image, which
    // is the only validation this needs: the picker's `accept` is a hint, and a
    // renamed `.exe` fails here rather than at a signature mismatch six seconds
    // later with a message nobody can act on.
    throw new Error("That file is not an image this browser can read.");
  }

  // Should be unreachable — a 1500×500 JPEG is a few hundred kilobytes — but
  // the mint would answer 400 and this says why in words to act on.
  if (cropped.size > MAX_USER_BANNER_BYTES) {
    throw new Error("That image is too large, even after resizing.");
  }

  const minted = await createUserBannerUpload({
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

  const claimed = await claimUserBanner(minted.key);
  return claimed.user;
}
