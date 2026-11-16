import {
  JAM_ARTIST_MAX,
  JAM_COVER_CONTENT_TYPES,
  JAM_COVER_MAX_BYTES,
  JAM_COVER_SIZE,
  JAM_TITLE_MAX,
  type JamSongSummary,
} from "@pqp/shared";
import { cropImageToRect } from "@/lib/avatar";
import type { CropRegion } from "@/lib/image-crop";
import { createJamUpload } from "@/lib/jam-api";
import { putWithProgress } from "@/lib/jam-upload";

/**
 * A song's cover, from a picked file to an upload ready to be claimed (the
 * contract is "A SONG'S COVER" in `packages/shared/src/jam.ts`).
 *
 * The same three steps the avatar and the banner take, with the claim moved to
 * the edit sheet's Save: the picture is framed, cropped to a square JPEG HERE
 * (the API never decodes an image), a ticket is minted for exactly that many
 * bytes, and the bytes go straight to storage with progress. What comes back is
 * an upload id, not a cover: nothing about the song changes until the sheet
 * claims it, so a person who walks away leaves the old cover in place, and the
 * unclaimed object is swept by the server an hour later.
 */

/** What the file picker offers: the three types the server accepts. */
export const JAM_COVER_ACCEPT = JAM_COVER_CONTENT_TYPES.join(",");

/**
 * The smallest side, in pixels, a cover photo may have. The wall shows it up to
 * about 470 px wide on a sharp screen, and a smaller one is a blur on a big
 * tile; the crop step then scales it up to the 1024 square it sends.
 */
export const JAM_COVER_MIN_SIDE = 400;

export type JamCoverCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: "unreadable" | "small"; width: number; height: number };

/**
 * Looks inside a picked file BEFORE the crop step opens: is it a picture a
 * browser can draw at all (a text file renamed `.jpg` is not), and is it big
 * enough? Reads only the size, through an `<img>` that decodes lazily, so a
 * 48 MP phone photo is not held in memory twice.
 */
export function checkCoverPicture(file: Blob): Promise<JamCoverCheck> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const done = (check: JamCoverCheck) => {
      URL.revokeObjectURL(url);
      resolve(check);
    };
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (width <= 0 || height <= 0) {
        done({ ok: false, reason: "unreadable", width, height });
      } else if (Math.min(width, height) < JAM_COVER_MIN_SIDE) {
        done({ ok: false, reason: "small", width, height });
      } else {
        done({ ok: true, width, height });
      }
    };
    image.onerror = () => done({ ok: false, reason: "unreadable", width: 0, height: 0 });
    image.src = url;
  });
}

/**
 * The colour a transparent part of a picture becomes in the JPEG: the near-white
 * of text on a picture, read from the theme's own token (a colour is never
 * written here). Null when the page has no such token (a test).
 */
export function coverFlatten(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue("--color-on-media").trim();
  return value === "" ? null : value;
}

/** Is this file one the cover accepts? A phone photo (HEIC) is decoded by the browser or refused there. */
export function isCoverPicture(file: { type: string; name?: string }): boolean {
  if ((JAM_COVER_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return true;
  }
  // Some pickers give no type for a file dropped from a folder.
  return file.type === "" && /\.(jpe?g|png|webp)$/i.test(file.name ?? "");
}

export interface JamCoverUpload {
  uploadId: string;
  /** A local address of what was uploaded, for the preview. The caller revokes it. */
  previewUrl: string;
}

export interface JamCoverUploadArgs {
  songId: string;
  file: Blob;
  /** What the person framed; without it, the centre of the picture. */
  region?: CropRegion | null;
  /** The crop step's decoded picture: given, the file is not decoded twice. */
  picture?: ImageBitmap | null;
  /** The framed picture, as a local address, as soon as it is cropped and before a byte is sent. The caller revokes it. */
  onPreview?: (previewUrl: string) => void;
  /** 0..1 of the bytes sent. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Why a cover did not go up, for the sheet to say in words. */
export class JamCoverError extends Error {
  constructor(readonly kind: "unreadable" | "tooLarge" | "network") {
    super(kind);
  }
}

export async function uploadJamCover(args: JamCoverUploadArgs): Promise<JamCoverUpload> {
  let jpeg: Blob;
  try {
    jpeg = await cropImageToRect(
      args.picture ?? args.file,
      JAM_COVER_SIZE,
      JAM_COVER_SIZE,
      args.region ?? null,
      coverFlatten(),
    );
  } catch {
    // `createImageBitmap` refuses anything that is not a decodable image: the
    // picker's `accept` is a hint, and this is the only validation needed.
    throw new JamCoverError("unreadable");
  }
  if (jpeg.size > JAM_COVER_MAX_BYTES) {
    throw new JamCoverError("tooLarge");
  }
  const previewUrl = URL.createObjectURL(jpeg);
  args.onPreview?.(previewUrl);
  const ticket = await createJamUpload(args.songId, {
    kind: "cover",
    contentType: "image/jpeg",
    byteSize: jpeg.size,
  });
  args.onProgress?.(0);
  await putWithProgress(
    ticket.uploadUrl,
    jpeg,
    "image/jpeg",
    (loaded) => args.onProgress?.(Math.min(1, loaded / Math.max(1, jpeg.size))),
    args.signal,
  );
  args.onProgress?.(1);
  return { uploadId: ticket.uploadId, previewUrl };
}

// ---------------------------------------------------------------- the edit

/** What the person did to the cover in the sheet. */
export type JamCoverChoice =
  | { kind: "keep" }
  | { kind: "remove" }
  | { kind: "new"; uploadId: string };

export interface JamEditDraft {
  title: string;
  artist: string;
  cover: JamCoverChoice;
}

export interface JamEditPlan {
  /** The PATCH body, or null when title and artist are as they were. */
  patch: { title?: string; artist?: string | null } | null;
  /** The cover write, if any. */
  cover: { op: "set"; uploadId: string } | { op: "remove" } | null;
  /** Nothing to save. */
  empty: boolean;
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** The title as the server will store it, or null when it is empty or too long. */
export function cleanSongTitle(value: string): string | null {
  const title = oneLine(value);
  return title.length > 0 && title.length <= JAM_TITLE_MAX ? title : null;
}

/**
 * What saving this sheet means: only what changed is sent (a title edited back
 * to what it was is not a write and does not bump the song), the artist is
 * cleared with null (an original), and a cover removed from a song that has none
 * is nothing.
 */
export function planJamEdit(song: Pick<JamSongSummary, "title" | "artist" | "coverUrl">, draft: JamEditDraft): JamEditPlan {
  const patch: NonNullable<JamEditPlan["patch"]> = {};
  const title = cleanSongTitle(draft.title);
  if (title !== null && title !== song.title) {
    patch.title = title;
  }
  const artist = oneLine(draft.artist).slice(0, JAM_ARTIST_MAX);
  if ((artist === "" ? null : artist) !== song.artist) {
    patch.artist = artist === "" ? null : artist;
  }
  const hasPatch = Object.keys(patch).length > 0;
  const cover: JamEditPlan["cover"] =
    draft.cover.kind === "new"
      ? { op: "set", uploadId: draft.cover.uploadId }
      : draft.cover.kind === "remove" && song.coverUrl !== null
        ? { op: "remove" }
        : null;
  return { patch: hasPatch ? patch : null, cover, empty: !hasPatch && cover === null };
}
