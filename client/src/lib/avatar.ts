import { AVATAR_IMAGE_SIZE } from "@pqp/shared";
import { getApiBaseUrl } from "@/lib/utils";

/**
 * Turning a stored `avatarUrl` into something an `<img>` may be pointed at.
 *
 * Three shapes arrive here and only three:
 *
 *  - `/api/avatars/…` — an avatar uploaded to this deployment. Root-relative,
 *    because the server does not know its own public origin (see `avatarPath`
 *    in `@pqp/shared`), so the API base is prefixed here. The SPA and the API
 *    are routinely two different origins — Cloudflare Pages and Railway — and a
 *    bare relative path would resolve against the wrong one in production. This
 *    is the same treatment `EmbedCard` gives `/api/embeds/…`.
 *  - an `https://` URL — a Clerk picture, a preset, or one somebody typed.
 *  - anything else, which is refused.
 *
 * HTTPS ONLY for the absolute case, matching the channel-image hardening
 * (`isChannelImageUrl` accepts `http://` for historical reasons; nothing needs
 * that here, and a mixed-content image is a blocked request on every hosted
 * deployment anyway). `javascript:` and `data:` are refused by the same rule —
 * the value is a string an account holder typed, and this is the only place it
 * becomes an `src`.
 */
export function resolveAvatarUrl(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  if (value.startsWith("/")) {
    // Not just `/api/avatars/`: `updateProfileSchema` has always accepted any
    // root-relative path, and one that 404s is handled the same way a dead
    // remote URL is — the monogram takes over on error.
    return `${getApiBaseUrl()}${value}`;
  }
  return value.startsWith("https://") ? value : null;
}

/**
 * Where to cut a rectangle to get the biggest centred square out of it.
 *
 * Split out from the canvas work so it is testable without a DOM: the whole
 * failure mode of a crop is arithmetic — an off-by-one that shaves a pixel is
 * invisible, and a transposed width and height silently crops a portrait photo
 * to somebody's forehead.
 */
export function centerCropRect(
  width: number,
  height: number,
): { x: number; y: number; size: number } {
  const size = Math.min(width, height);
  return {
    x: Math.round((width - size) / 2),
    y: Math.round((height - size) / 2),
    size,
  };
}

/** JPEG quality for the upload. High enough that a 512px face holds up. */
const AVATAR_JPEG_QUALITY = 0.85;

/**
 * A picked file, centre-cropped to a square and scaled to 512, as a JPEG.
 *
 * Done in the browser rather than on the server, and deliberately: the API
 * never decodes an uploaded image — decoding attacker-controlled bytes in the
 * process that holds the database connection is the thing the whole
 * presigned-upload design exists to avoid. So the client is what turns a 12 MB
 * phone photo into 40 KB, and the server's byte cap is what stops a client that
 * does not.
 *
 * Always JPEG, whatever went in. A HEIC from an iPhone cannot be displayed by a
 * browser and a PNG of a photograph is many times the size for no gain; the one
 * thing lost is transparency, which an avatar drawn inside a circle does not
 * have.
 *
 * `createImageBitmap` rather than an `Image` element because it decodes off the
 * main thread and — the part that matters — it honours EXIF orientation with
 * `imageOrientation: "from-image"`, without which every photo taken in portrait
 * on an iPhone uploads rotated ninety degrees.
 */
export async function cropImageToSquare(
  file: Blob,
  size: number = AVATAR_IMAGE_SIZE,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const crop = centerCropRect(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not prepare the image");
    }
    context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.size,
      crop.size,
      0,
      0,
      size,
      size,
    );
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", AVATAR_JPEG_QUALITY);
    });
    if (!blob) {
      throw new Error("Could not prepare the image");
    }
    return blob;
  } finally {
    // A bitmap holds decoded pixels — a 48 MP photo is ~190 MB of them — and
    // nothing else releases it until GC gets round to it.
    bitmap.close();
  }
}
