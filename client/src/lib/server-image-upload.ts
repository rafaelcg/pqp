import {
  maxServerImageBytes,
  SERVER_BANNER_HEIGHT,
  SERVER_BANNER_WIDTH,
  SERVER_ICON_SIZE,
  type Server,
  type ServerImageKind,
} from "@pqp/shared";
import { claimServerImage, createServerImageUpload } from "@/lib/api";
import { cropImageToRect, cropImageToSquare } from "@/lib/avatar";

/**
 * A picked file, all the way to being a server's icon or banner.
 *
 * The same three steps `uploadAvatar` takes, and the middle one deliberately
 * does not touch the API:
 *
 *  1. `POST /api/servers/:id/{icon,banner}` mints a key and a presigned PUT;
 *  2. the bytes go **straight to storage**, because a Node process holding the
 *     database pool has no business buffering image uploads;
 *  3. `POST …/claim` HEADs the object and swaps the columns.
 *
 * The crop happens before any of it, and what the server is asked to sign is
 * the length of the *cropped* JPEG — so the browser cannot mint a URL for a
 * 200 KB banner and then push eight megabytes through it. The length is in the
 * signature.
 *
 * Nothing is undone on failure and nothing needs to be: an object whose claim
 * never happens is referenced by no row, and the server keeps the picture it
 * already had.
 */
export async function uploadServerImage(
  serverId: string,
  kind: ServerImageKind,
  file: Blob,
): Promise<Server> {
  let cropped: Blob;
  try {
    cropped =
      kind === "banner"
        ? await cropImageToRect(file, SERVER_BANNER_WIDTH, SERVER_BANNER_HEIGHT)
        : await cropImageToSquare(file, SERVER_ICON_SIZE);
  } catch {
    // `createImageBitmap` refuses anything that is not a decodable image, which
    // is the only validation this needs: the picker's `accept` is a hint, and a
    // renamed `.exe` fails here rather than at a signature mismatch six seconds
    // later with a message nobody can act on.
    throw new Error("That file is not an image this browser can read.");
  }

  // Should be unreachable — a 1024×480 JPEG is a couple of hundred kilobytes —
  // but the mint would answer 413 and this says why in words to act on.
  if (cropped.size > maxServerImageBytes(kind)) {
    throw new Error("That image is too large, even after resizing.");
  }

  const minted = await createServerImageUpload(serverId, kind, {
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

  const claimed = await claimServerImage(serverId, kind, minted.key);
  return claimed.server;
}
