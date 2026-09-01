import {
  attachmentFilenameSchema,
  COMMUNITY_HOME_MAX_BYTES,
  COMMUNITY_HOME_MIME_ALLOWLIST,
  communityHomeMediaKindFromContentType,
  parseYoutubeVideoId,
  youtubeEmbedSrc,
  type CommunityHomeContentType,
} from "@pqp/shared";
import {
  claimCommunityHomeMediaUpload,
  createCommunityHomeMediaUpload,
} from "@/lib/api";

/**
 * Baú media helpers.
 *
 * Bytes go through the same mint → PUT → claim dance as attachments (see
 * `lib/attachments.ts`) — the API only ever signs a URL and later HEADs the
 * object; the bytes themselves never pass through the Node process. There is
 * no local-only path any more: a data URL was fine for a client-only mock,
 * but it is never a production media representation.
 */

export { COMMUNITY_HOME_MAX_BYTES, parseYoutubeVideoId, youtubeEmbedSrc };
export type {
  CommunityHomeMedia,
  CommunityHomeMediaKind,
} from "@pqp/shared";

const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(
  COMMUNITY_HOME_MIME_ALLOWLIST,
);

/** Human size label for the compose hint and the file media card. */
export function formatHomeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    const kib = bytes / 1024;
    return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KiB`;
  }
  const mib = bytes / (1024 * 1024);
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
}

export function isHomeVideoFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "video/mp4" || type === "video/webm") {
    return true;
  }
  const name = file.name.toLowerCase();
  return name.endsWith(".mp4") || name.endsWith(".webm");
}

export function isHomeImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

/**
 * A name the server will accept, generated when the browser gives us one it
 * will not. Same reasoning as `lib/attachments.ts`'s `safeFilename` — the
 * storage key is generated server-side, so this is display text only.
 */
function safeHomeFilename(raw: string, contentType: string): string {
  const parsed = attachmentFilenameSchema.safeParse(raw.trim());
  if (parsed.success) {
    return parsed.data;
  }
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType] ?? "bin";
  return `upload-${Date.now().toString(36)}.${extension}`;
}

/**
 * PUT the bytes at storage. `XMLHttpRequest` rather than `fetch` purely for
 * `upload.onprogress` — see `lib/attachments.ts`'s `putObject` for the same
 * trade, copied here rather than shared because that function is private to
 * its module.
 */
function putHomeObject(
  url: string,
  file: File,
  contentType: string,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Upload cancelled", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType);

    function abort() {
      xhr.abort();
    }

    function cleanup() {
      options.signal?.removeEventListener("abort", abort);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(event.loaded / event.total);
      }
    };
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(1);
        resolve();
        return;
      }
      reject(new Error(`Storage rejected the upload (${xhr.status}).`));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Could not reach storage."));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new Error("Upload timed out."));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}

export interface UploadedHomeMedia {
  uploadId: string;
  kind: "image" | "video" | "file";
  name: string;
  contentType: CommunityHomeContentType;
  byteSize: number;
}

/**
 * A picked file, all the way to being a claimed Baú media upload.
 *
 *  1. `POST /api/servers/:id/home/media` mints a key and a presigned PUT;
 *  2. the bytes go straight to storage;
 *  3. `POST …/home/media/claim` HEADs the object and marks it verified.
 *
 * The returned `uploadId` is not yet attached to any post — the caller passes
 * it as `mediaUploadId` on create/update, which is what claims it onto a row.
 */
export async function uploadHomeMedia(
  serverId: string,
  file: File,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<UploadedHomeMedia> {
  const contentType = file.type.trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(
      contentType
        ? `${contentType} files are not allowed here.`
        : "Unrecognised file type.",
    );
  }
  if (file.size <= 0) {
    throw new Error("That file is empty.");
  }
  if (file.size > COMMUNITY_HOME_MAX_BYTES) {
    throw new Error(
      `Larger than the ${formatHomeBytes(COMMUNITY_HOME_MAX_BYTES)} limit.`,
    );
  }

  const typedContentType = contentType as CommunityHomeContentType;
  const filename = safeHomeFilename(file.name, typedContentType);

  const minted = await createCommunityHomeMediaUpload(serverId, {
    contentType: typedContentType,
    byteSize: file.size,
    filename,
  });

  if (options.signal?.aborted) {
    throw new DOMException("Upload cancelled", "AbortError");
  }

  await putHomeObject(minted.uploadUrl, file, typedContentType, options);

  return claimCommunityHomeMediaUpload(serverId, {
    uploadId: minted.uploadId,
  });
}

/** Client-side guess, used only to pick an `accept` hint before upload. */
export function homeMediaKindFromFile(
  file: File,
): "image" | "video" | "file" {
  const type = file.type.trim().toLowerCase();
  if (type) {
    return communityHomeMediaKindFromContentType(
      type as CommunityHomeContentType,
    );
  }
  if (isHomeVideoFile(file)) {
    return "video";
  }
  if (isHomeImageFile(file)) {
    return "image";
  }
  return "file";
}
