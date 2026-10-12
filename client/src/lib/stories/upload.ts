import {
  STORY_IMAGE_MAX_EDGE,
  STORY_MAX_BYTES,
  STORY_MAX_VIDEO_MS,
  STORY_SNIFF_BYTES,
  isStoryImageType,
  sniffStoryMediaType,
  type StoryContentType,
  type StoryMediaInput,
  type StoryUpload,
} from "@pqp/shared";

/**
 * Getting a photo or a clip ready to post, in the browser.
 *
 * - The TYPE is read from the bytes (`sniffStoryMediaType`), not from the
 *   file name or the browser's guess, so a renamed `.mov` is refused here
 *   with a reason instead of at publish with none.
 * - A video's LENGTH is read from a hidden element before anything is
 *   uploaded (design §3.3: "over-limit video is refused before upload").
 * - An image is RE-ENCODED through a canvas: at most `STORY_IMAGE_MAX_EDGE`
 *   on the long side, and with no EXIF, because drawing pixels copies no
 *   metadata. The bytes never pass the API, so this is the only place the
 *   location a phone wrote into a photo can be dropped.
 */

export type StoryFileProblem =
  | { kind: "wrong-type" }
  | { kind: "too-big" }
  | { kind: "too-long"; seconds: number }
  | { kind: "unreadable" };

export interface PreparedStoryMedia {
  kind: "image" | "video";
  blob: Blob;
  contentType: StoryContentType;
  width: number;
  height: number;
  durationMs: number | null;
  /** An object URL for the composer's preview. The caller revokes it. */
  previewUrl: string;
}

export type PrepareResult =
  | { ok: true; media: PreparedStoryMedia }
  | { ok: false; problem: StoryFileProblem };

export async function sniffFile(file: Blob): Promise<StoryContentType | null> {
  const head = new Uint8Array(await file.slice(0, STORY_SNIFF_BYTES).arrayBuffer());
  return sniffStoryMediaType(head);
}

/**
 * The checks that need no decoding, separated so they are testable on their
 * own: size, then type. A video's length needs an element, see below.
 */
export function checkStoryFile(
  sniffed: StoryContentType | null,
  byteSize: number,
  limits: { maxBytes?: number; videoEnabled: boolean } = { videoEnabled: true },
): StoryFileProblem | null {
  if (!sniffed) {
    return { kind: "wrong-type" };
  }
  if (!isStoryImageType(sniffed) && !limits.videoEnabled) {
    return { kind: "wrong-type" };
  }
  // An image is re-encoded smaller before upload, so only a video's size is
  // final here; an enormous photo is still refused, as no canvas should hold it.
  if (byteSize > (limits.maxBytes ?? STORY_MAX_BYTES) * (isStoryImageType(sniffed) ? 4 : 1)) {
    return { kind: "too-big" };
  }
  return null;
}

export function checkVideoDuration(
  durationMs: number,
  maxMs: number = STORY_MAX_VIDEO_MS,
): StoryFileProblem | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { kind: "unreadable" };
  }
  if (durationMs > maxMs) {
    return { kind: "too-long", seconds: Math.round(durationMs / 1000) };
  }
  return null;
}

/** The long side capped at `maxEdge`, the aspect kept, never upscaled. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = STORY_IMAGE_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function readVideo(url: string): Promise<{ durationMs: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const done = () => {
      video.removeAttribute("src");
      video.load();
    };
    video.onloadedmetadata = () => {
      const result = {
        durationMs: Math.round(video.duration * 1000),
        width: video.videoWidth,
        height: video.videoHeight,
      };
      done();
      resolve(result);
    };
    video.onerror = () => {
      done();
      reject(new Error("video unreadable"));
    };
    video.src = url;
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image unreadable"));
    image.src = url;
  });
}

async function reencodeImage(
  file: Blob,
): Promise<{ blob: Blob; width: number; height: number; contentType: StoryContentType }> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(sourceUrl);
    const size = fitWithin(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("no canvas");
    }
    // JPEG has no alpha: a transparent PNG would turn its holes black anyway,
    // so say so on purpose and paint them the colour a story card sits on.
    context.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-surface-0")
      .trim() || "black";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.88),
    );
    if (!blob) {
      throw new Error("encode failed");
    }
    return { blob, width: size.width, height: size.height, contentType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export async function prepareStoryFile(
  file: Blob,
  limits: { maxBytes: number; maxVideoMs: number; videoEnabled: boolean },
): Promise<PrepareResult> {
  const sniffed = await sniffFile(file);
  const early = checkStoryFile(sniffed, file.size, limits);
  if (early) {
    return { ok: false, problem: early };
  }
  if (isStoryImageType(sniffed!)) {
    try {
      const encoded = await reencodeImage(file);
      if (encoded.blob.size > limits.maxBytes) {
        return { ok: false, problem: { kind: "too-big" } };
      }
      return {
        ok: true,
        media: {
          kind: "image",
          blob: encoded.blob,
          contentType: encoded.contentType,
          width: encoded.width,
          height: encoded.height,
          durationMs: null,
          previewUrl: URL.createObjectURL(encoded.blob),
        },
      };
    } catch {
      return { ok: false, problem: { kind: "unreadable" } };
    }
  }
  const previewUrl = URL.createObjectURL(file);
  try {
    const video = await readVideo(previewUrl);
    const problem = checkVideoDuration(video.durationMs, limits.maxVideoMs);
    if (problem) {
      URL.revokeObjectURL(previewUrl);
      return { ok: false, problem };
    }
    if (!video.width || !video.height) {
      URL.revokeObjectURL(previewUrl);
      return { ok: false, problem: { kind: "unreadable" } };
    }
    return {
      ok: true,
      media: {
        kind: "video",
        blob: file,
        contentType: "video/mp4",
        width: video.width,
        height: video.height,
        durationMs: video.durationMs,
        previewUrl,
      },
    };
  } catch {
    URL.revokeObjectURL(previewUrl);
    return { ok: false, problem: { kind: "unreadable" } };
  }
}

export function mediaInputFor(media: PreparedStoryMedia): StoryMediaInput {
  return {
    contentType: media.contentType,
    byteSize: media.blob.size,
    width: media.width,
    height: media.height,
    ...(media.durationMs !== null ? { durationMs: media.durationMs } : {}),
  };
}

/**
 * Headers a browser refuses to set from script. The signed `Content-Length`
 * is set by the browser from the body itself, which is the same number.
 */
const FORBIDDEN_HEADERS = new Set(["content-length", "host"]);

/**
 * PUT the bytes with exactly the headers the server signed (any other header,
 * including a Content-Type the browser would pick on its own, breaks the
 * signature). `XMLHttpRequest` for `upload.onprogress`: the "Teu story" arc
 * is bytes sent over bytes total, never a timer.
 */
export function putStoryMedia(
  upload: StoryUpload,
  blob: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url, true);
    for (const [name, value] of Object.entries(upload.headers)) {
      if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) {
        xhr.setRequestHeader(name, value);
      }
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`Storage rejected the upload (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Could not reach storage"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}
