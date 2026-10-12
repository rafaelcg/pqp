import {
  COMMUNITY_HOME_COVER_CONTENT_TYPES,
  COMMUNITY_HOME_COVER_MAX_BYTES,
  COMMUNITY_HOME_IMAGE_SNIFF_BYTES,
  sniffCommunityHomeImageType,
} from "@pqp/shared";

/**
 * A Baú video's cover (`bau_custom_cover`): the picture the player shows
 * before play. Without one the player paints the video's first frame, which
 * is what every video had before.
 *
 * The author gets it two ways, and both end the same: as an image upload
 * through the same mint / PUT / claim as any Baú picture, which the post then
 * names as `posterUploadId`. Picking a frame draws that frame onto a canvas
 * here, in the browser, and uploads the JPEG; nothing on the server ever
 * decodes a video.
 */

export { COMMUNITY_HOME_COVER_MAX_BYTES };

const COVER_TYPES: ReadonlySet<string> = new Set(COMMUNITY_HOME_COVER_CONTENT_TYPES);

/** The longest side of a captured frame. A cover is a card, not a still for print. */
export const COVER_FRAME_MAX_EDGE = 1920;

/** JPEG quality of a captured frame. */
const COVER_FRAME_QUALITY = 0.86;

/** What is wrong with an image picked as a cover, or null when it can be one. */
export type CoverImageProblem = "type" | "size" | "unreadable";

/**
 * Judge a picked image by its bytes, not its name: a cover is a JPEG, PNG or
 * WebP (no GIF, a cover is one frame) no bigger than
 * `COMMUNITY_HOME_COVER_MAX_BYTES`. The server checks all of it again when
 * the cover is put on the post; this is so the author hears it before an
 * upload, not after.
 */
export async function coverImageProblem(file: File): Promise<CoverImageProblem | null> {
  if (file.size > COMMUNITY_HOME_COVER_MAX_BYTES) {
    return "size";
  }
  if (!COVER_TYPES.has(file.type.trim().toLowerCase())) {
    return "type";
  }
  let head: ArrayBuffer;
  try {
    head = await file.slice(0, COMMUNITY_HOME_IMAGE_SNIFF_BYTES).arrayBuffer();
  } catch {
    return "unreadable";
  }
  const sniffed = sniffCommunityHomeImageType(new Uint8Array(head));
  return sniffed && COVER_TYPES.has(sniffed) ? null : "type";
}

/** The size a captured frame is drawn at: the video's own, the long side capped. */
export function coverFrameSize(
  videoWidth: number,
  videoHeight: number,
  maxEdge = COVER_FRAME_MAX_EDGE,
): { width: number; height: number } | null {
  if (!(videoWidth > 0) || !(videoHeight > 0)) {
    return null;
  }
  const scale = Math.min(1, maxEdge / Math.max(videoWidth, videoHeight));
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}

/**
 * The cover as the composer holds it. `upload` is a cover picked in this
 * session (not on a post yet), `existing` the one already on the post being
 * edited, `cleared` that the author went back to the first frame.
 */
export interface CoverDraft {
  /** The main media is an uploaded video, the only thing a cover goes beside. */
  mainIsVideo: boolean;
  upload: { uploadId: string } | null;
  /** Object URL of `upload`, for the preview. */
  previewUrl: string | null;
  existing: string | null;
  cleared: boolean;
}

/** The cover the preview shows; null is the first frame. */
export function coverForPreview(draft: CoverDraft): string | null {
  if (!draft.mainIsVideo) {
    return null;
  }
  if (draft.upload) {
    return draft.previewUrl;
  }
  return draft.cleared ? null : draft.existing;
}

/**
 * What a new post sends: the picked cover, or nothing (the first frame). A
 * pick made for a video that is no longer the main media never rides along.
 */
export function coverForCreate(draft: CoverDraft): { posterUploadId?: string } {
  return draft.mainIsVideo && draft.upload
    ? { posterUploadId: draft.upload.uploadId }
    : {};
}

/**
 * What an edit sends. Omitted keeps the cover on the post (the server drops it
 * by itself when the main video is replaced); a new pick replaces it; null
 * goes back to the first frame.
 */
export function coverForUpdate(draft: CoverDraft): { posterUploadId?: string | null } {
  if (draft.mainIsVideo && draft.upload) {
    return { posterUploadId: draft.upload.uploadId };
  }
  return draft.cleared ? { posterUploadId: null } : {};
}

/** Thrown when the browser will not hand over the frame's pixels. */
export class CoverFrameError extends Error {
  constructor(
    readonly reason: "no-frame" | "tainted",
    message: string,
  ) {
    super(message);
    this.name = "CoverFrameError";
  }
}

/**
 * The frame the video is showing right now, as a JPEG file ready to upload.
 *
 * A video picked in this session is a `blob:` URL, so its pixels are ours to
 * read. A video already on a post comes from the bucket, and its pixels can
 * only be read when the bucket answers the GET with CORS headers (the bucket
 * policy in `docs/ATTACHMENTS.md` allows it); otherwise the canvas is
 * "tainted" and the browser refuses, which is `reason: "tainted"` and the
 * composer offers the image upload instead.
 */
export async function captureCoverFrame(video: HTMLVideoElement): Promise<File> {
  const size = coverFrameSize(video.videoWidth, video.videoHeight);
  if (!size) {
    throw new CoverFrameError("no-frame", "The video has no frame to draw yet.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new CoverFrameError("no-frame", "No 2D canvas here.");
  }
  context.drawImage(video, 0, 0, size.width, size.height);
  let blob: Blob | null;
  try {
    blob = await new Promise<Blob | null>((resolve, reject) => {
      try {
        canvas.toBlob(resolve, "image/jpeg", COVER_FRAME_QUALITY);
      } catch (error) {
        reject(error);
      }
    });
  } catch {
    throw new CoverFrameError("tainted", "The browser will not read this video's pixels.");
  }
  if (!blob || blob.size === 0) {
    throw new CoverFrameError("no-frame", "The frame came out empty.");
  }
  return new File([blob], "capa.jpg", { type: "image/jpeg" });
}
