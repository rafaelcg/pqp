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
export function resolveUploadedImageUrl(
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
 * The same rule, under the name every existing call site uses.
 *
 * Kept as an alias rather than as a second implementation because a server's
 * icon and banner arrive in exactly the same three shapes for exactly the same
 * reasons, and the day the https-only rule needs revisiting there must be one
 * place to revisit it.
 */
export const resolveAvatarUrl = resolveUploadedImageUrl;

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

/**
 * The same cut, generalised to any target shape — the biggest centred rectangle
 * of ratio `aspect` (width ÷ height) that fits inside the source.
 *
 * Written when server banners arrived rather than folded into `centerCropRect`,
 * which stays as the square case every avatar path already calls. Split out
 * from the canvas work for exactly the reason that one was: the whole failure
 * mode of a crop is arithmetic. A banner cut wrong is not a subtle defect —
 * pick the wrong branch and a portrait photo becomes a 2.85:1 strip of
 * somebody's forehead, which looks deliberate enough that nobody files a bug.
 *
 * Both branches round *after* dividing, so a one-pixel source that cannot be
 * halved evenly loses its pixel from the far edge rather than from both.
 */
export function centerCropRectForAspect(
  width: number,
  height: number,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  // Source is wider than the target shape: keep the full height, cut the sides.
  if (width / height > aspect) {
    const cropWidth = Math.round(height * aspect);
    return {
      x: Math.round((width - cropWidth) / 2),
      y: 0,
      width: cropWidth,
      height,
    };
  }
  // Source is taller: keep the full width, cut top and bottom.
  const cropHeight = Math.round(width / aspect);
  return {
    x: 0,
    y: Math.round((height - cropHeight) / 2),
    width,
    height: cropHeight,
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

/**
 * A picked file, centre-cropped to `width`×`height` and encoded as a JPEG.
 *
 * The rectangle counterpart of `cropImageToSquare`, and everything that
 * function's comment says applies here unchanged: done in the browser because
 * the API never decodes an uploaded image, always JPEG whatever went in, and
 * `createImageBitmap` rather than an `Image` element so EXIF orientation is
 * honoured and a phone photo does not upload rotated ninety degrees.
 *
 * The one addition is `imageSmoothingQuality`. A banner is the only image in
 * the app that is *downscaled by a large factor and then drawn wide* — a 4000px
 * phone photo into 1024px — and the default box filter leaves visible aliasing
 * on any hard edge at that ratio, which an avatar at 40px never shows.
 */
export async function cropImageToRect(
  file: Blob,
  width: number,
  height: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const crop = centerCropRectForAspect(
      bitmap.width,
      bitmap.height,
      width / height,
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not prepare the image");
    }
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      width,
      height,
    );
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", AVATAR_JPEG_QUALITY);
    });
    if (!blob) {
      throw new Error("Could not prepare the image");
    }
    return blob;
  } finally {
    bitmap.close();
  }
}
