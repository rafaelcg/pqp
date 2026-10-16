import {
  MAX_SERVER_EMOJI_BYTES,
  SERVER_EMOJI_MIME_ALLOWLIST,
  SERVER_EMOJI_SIZE,
  type ServerEmoji,
} from "@pqp/shared";
import { claimServerEmoji, createServerEmojiUpload } from "@/lib/api";

export class ServerEmojiUploadError extends Error {
  constructor(readonly code: "unsupported_type" | "unreadable" | "too_large" | "storage") {
    super(code);
  }
}

export function isAcceptedEmojiFile(file: Blob): boolean {
  return (SERVER_EMOJI_MIME_ALLOWLIST as readonly string[]).includes(file.type);
}

/** Where to draw a `width`×`height` picture inside a square so all of it shows. */
export function containRect(
  width: number,
  height: number,
  size: number,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(size / width, size / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { x: Math.round((size - w) / 2), y: Math.round((size - h) / 2), width: w, height: h };
}

/**
 * The picked file as a 128×128 PNG. Fitted rather than cropped, because an
 * emoji is usually a cut-out whose edges matter, and PNG rather than the
 * avatar's JPEG because transparency is the point. Done in the browser for the
 * reason `cropImageToSquare` gives: the API never decodes an upload.
 */
export async function prepareServerEmojiImage(file: Blob): Promise<Blob> {
  if (!isAcceptedEmojiFile(file)) {
    throw new ServerEmojiUploadError("unsupported_type");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ServerEmojiUploadError("unreadable");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SERVER_EMOJI_SIZE;
    canvas.height = SERVER_EMOJI_SIZE;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new ServerEmojiUploadError("unreadable");
    }
    const rect = containRect(bitmap.width, bitmap.height, SERVER_EMOJI_SIZE);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) {
      throw new ServerEmojiUploadError("unreadable");
    }
    if (blob.size > MAX_SERVER_EMOJI_BYTES) {
      throw new ServerEmojiUploadError("too_large");
    }
    return blob;
  } finally {
    bitmap.close();
  }
}

/** Mint, PUT to storage, claim. The image is already prepared. */
export async function uploadServerEmoji(
  serverId: string,
  name: string,
  image: Blob,
): Promise<ServerEmoji> {
  const minted = await createServerEmojiUpload(serverId, {
    name,
    contentType: "image/png",
    byteSize: image.size,
  });
  const response = await fetch(minted.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: image,
  });
  if (!response.ok) {
    throw new ServerEmojiUploadError("storage");
  }
  return (await claimServerEmoji(serverId, minted.key, name)).emoji;
}
