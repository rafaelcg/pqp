import {
  ATTACHMENT_MAX_DIMENSION,
  ATTACHMENT_MIME_ALLOWLIST,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  attachmentFilenameSchema,
  isImageContentType,
  type AttachmentContentType,
  type CreateAttachmentRequest,
} from "@pqp/shared";
import { createAttachment, fetchAttachmentConfig } from "@/lib/api";

/**
 * The browser half of the upload path: pick files, check them here, mint a
 * presigned PUT, and push the bytes straight at object storage.
 *
 * Nothing in this file is the enforcement point — the server re-checks the type
 * and re-reads the real size with a HEAD before an attachment is ever claimed
 * onto a message. What it buys is an answer before a 10 MB file has been read
 * off disk and pushed across a phone connection, which is the difference
 * between "that type is not allowed" and a progress bar that ends in an error.
 */

const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(
  ATTACHMENT_MIME_ALLOWLIST,
);

export interface AttachmentConfig {
  enabled: boolean;
  /** Never above the shared ceiling — see `clampMaxBytes`. */
  maxBytes: number;
}

const DISABLED: AttachmentConfig = {
  enabled: false,
  maxBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
};

/**
 * A deployment may lower the cap but cannot raise it: `createAttachmentSchema`
 * rejects the mint request against the shared ceiling before the server's own
 * number is consulted, so honouring a larger one here would only produce
 * uploads that are refused at the first hop.
 */
function clampMaxBytes(reported: number | undefined): number {
  if (!reported || !Number.isFinite(reported) || reported <= 0) {
    return DEFAULT_MAX_ATTACHMENT_BYTES;
  }
  return Math.min(reported, DEFAULT_MAX_ATTACHMENT_BYTES);
}

/**
 * Whether this deployment has object storage, asked once per page load — the
 * same shape as `loadGifSearchEnabled`, and for the same reason: the composer
 * remounts on every channel switch, so a busy session would otherwise re-ask on
 * every click in the sidebar. A failed probe resolves disabled rather than
 * rejecting, because "cannot reach the API" and "no bucket configured" both
 * mean the paperclip should not be there.
 */
let probe: Promise<AttachmentConfig> | null = null;

export function loadAttachmentConfig(): Promise<AttachmentConfig> {
  probe ??= fetchAttachmentConfig()
    .then((config) => ({
      enabled: config.enabled,
      maxBytes: clampMaxBytes(config.maxBytes),
    }))
    .catch(() => DISABLED);
  return probe;
}

// ---------------------------------------------------------------- selection

/** A file that passed every local check, ready to upload. */
export interface AcceptedFile {
  file: File;
  /** `file.name` when it is usable, a generated one when it is not. */
  filename: string;
  contentType: AttachmentContentType;
}

export interface RejectedFile {
  filename: string;
  /** Shown to the user verbatim, so it names the file's own problem. */
  reason: string;
}

export interface AttachmentSelection {
  accepted: AcceptedFile[];
  rejected: RejectedFile[];
}

/** Human sizes, because "10485760" is not a limit anybody can act on. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/**
 * A name the server will accept, generated when the browser gives us one it
 * will not.
 *
 * Screenshot paste is the reason this exists rather than a rejection: a pasted
 * image arrives with whatever name the platform felt like — often `image.png`,
 * sometimes empty, occasionally a path — and refusing the single most common
 * way this feature gets used over a naming technicality would be absurd. The
 * filename is display text either way; the storage key is generated server-side.
 */
function safeFilename(raw: string, contentType: AttachmentContentType): string {
  const parsed = attachmentFilenameSchema.safeParse(raw.trim());
  if (parsed.success) {
    return parsed.data;
  }
  const extension = EXTENSION_BY_TYPE[contentType] ?? "bin";
  return `upload-${Date.now().toString(36)}.${extension}`;
}

/**
 * Split a drop / paste / file-picker batch into what can be uploaded and what
 * cannot, without touching the network.
 *
 * `existingCount` is what the composer already holds: the per-message cap is a
 * property of the message, not of one batch, so three drops of four files have
 * to hit the same ceiling as one drop of twelve.
 */
export function selectAttachments(
  files: readonly File[],
  options: { existingCount: number; maxBytes: number },
): AttachmentSelection {
  const accepted: AcceptedFile[] = [];
  const rejected: RejectedFile[] = [];
  const maxBytes = clampMaxBytes(options.maxBytes);

  for (const file of files) {
    const label = file.name || "This file";

    if (options.existingCount + accepted.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      rejected.push({
        filename: label,
        reason: `only ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`,
      });
      continue;
    }

    // Type first: it is the check most likely to fail and the only one whose
    // answer never changes, so saying it before anything else is the kindest
    // order to be wrong in.
    const contentType = file.type.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      rejected.push({
        filename: label,
        reason: contentType
          ? `${contentType} files are not allowed`
          : "unrecognised file type",
      });
      continue;
    }

    if (file.size <= 0) {
      rejected.push({ filename: label, reason: "the file is empty" });
      continue;
    }

    if (file.size > maxBytes) {
      rejected.push({
        filename: label,
        reason: `larger than the ${formatByteSize(maxBytes)} limit`,
      });
      continue;
    }

    accepted.push({
      file,
      filename: safeFilename(file.name, contentType as AttachmentContentType),
      contentType: contentType as AttachmentContentType,
    });
  }

  return { accepted, rejected };
}

/**
 * Files out of a paste or a drop.
 *
 * `items` is the fallback rather than the primary because a screenshot paste
 * puts several representations on the clipboard at once — the image, plus HTML
 * markup wrapping it — and only `files` is already filtered down to the bytes.
 */
export function filesFromDataTransfer(
  data: DataTransfer | null | undefined,
): File[] {
  if (!data) {
    return [];
  }
  if (data.files?.length) {
    return [...data.files];
  }
  return [...(data.items ?? [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** True when a drag is carrying files rather than selected text or a link. */
export function isFileDrag(data: DataTransfer | null | undefined): boolean {
  return [...(data?.types ?? [])].includes("Files");
}

// ------------------------------------------------------------------ preview

/**
 * A local URL for the file, used by the composer chip and then by the
 * optimistic message bubble.
 *
 * These pin the whole file in memory until they are revoked, which is why
 * ownership is explicit: the composer revokes what it still holds, and hands
 * the rest to the chat controller on send.
 */
export function createPreviewUrl(file: Blob): string {
  return URL.createObjectURL(file);
}

export function revokePreviewUrl(url: string): void {
  if (url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

// ------------------------------------------------------------------- upload

/** Rejection used for a cancelled upload, which is not a failure to report. */
export class AttachmentAbortError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "AttachmentAbortError";
  }
}

export interface UploadedAttachment {
  attachmentId: string;
  /** Intrinsic pixels for images, null for everything else. */
  width: number | null;
  height: number | null;
}

interface Dimensions {
  width: number | null;
  height: number | null;
}

const NO_DIMENSIONS: Dimensions = { width: null, height: null };

/**
 * A dimension the mint request will accept, or null.
 *
 * `createAttachmentSchema` bounds these, and the mint carries them now — so an
 * image past the ceiling would take the whole upload down with a 400 over a
 * number that only ever sized a placeholder. Out of range is therefore treated
 * exactly like unreadable.
 */
function usableDimension(value: number): number | null {
  return value > 0 && value <= ATTACHMENT_MAX_DIMENSION ? value : null;
}

/**
 * Intrinsic size, read before the bytes leave the browser.
 *
 * The message grid reserves a box from these numbers, so an image arriving
 * while you read does not shove the conversation down when it decodes. Every
 * failure path resolves null instead of rejecting: a size we could not read
 * costs one reflow, a rejected upload costs the whole attachment.
 */
function readImageDimensions(
  file: Blob,
  contentType: string,
): Promise<Dimensions> {
  if (!isImageContentType(contentType)) {
    return Promise.resolve(NO_DIMENSIONS);
  }
  return new Promise<Dimensions>((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    function finish(dimensions: Dimensions) {
      URL.revokeObjectURL(url);
      resolve(dimensions);
    }

    image.onload = () =>
      finish({
        width: usableDimension(image.naturalWidth),
        height: usableDimension(image.naturalHeight),
      });
    image.onerror = () => finish(NO_DIMENSIONS);
    image.src = url;
  }).catch(() => NO_DIMENSIONS);
}

/**
 * PUT the bytes at storage.
 *
 * `XMLHttpRequest` rather than `fetch` purely for `upload.onprogress`: fetch
 * still has no upload progress event, and a ten-megabyte upload with no bar is
 * indistinguishable from a hung app.
 */
function putObject(
  url: string,
  file: File,
  contentType: string,
  options: { signal: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new AttachmentAbortError());
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    // The presigned signature covers this exact header. Sending anything else —
    // including the type the browser would infer on its own — fails as
    // SignatureDoesNotMatch, which reads as a broken upload rather than a
    // mismatched header.
    xhr.setRequestHeader("Content-Type", contentType);

    function abort() {
      // Settling happens in `onabort`, so that a cancel and a mid-flight
      // failure cannot both reject the same promise.
      xhr.abort();
    }

    function cleanup() {
      options.signal.removeEventListener("abort", abort);
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
      reject(new Error(`Storage rejected the upload (${xhr.status})`));
    };
    // A CORS rejection is indistinguishable from an offline network here: the
    // browser refuses to say which, so neither can the message.
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Could not reach storage"));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new Error("Upload timed out"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new AttachmentAbortError());
    };

    options.signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}

/**
 * Mint a URL and upload one already-validated file.
 *
 * The row exists in Postgres from the mint onwards with `message_id` NULL; it
 * only becomes part of a message when the composer sends its id. An upload
 * abandoned here is swept an hour later rather than needing a cleanup call, so
 * abort has nothing to undo beyond the request itself.
 */
export async function uploadAttachment(
  channelId: string,
  selected: AcceptedFile,
  options: { signal: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<UploadedAttachment> {
  if (options.signal.aborted) {
    throw new AttachmentAbortError();
  }

  // Before the mint rather than after, because the mint is the request that
  // writes the row these numbers live on. Measured any later they would need a
  // second write to land, and until it did every reader but the sender would
  // get a row with no dimensions — which is the layout jump this exists to stop.
  const dimensions = await readImageDimensions(
    selected.file,
    selected.contentType,
  );
  if (options.signal.aborted) {
    throw new AttachmentAbortError();
  }

  // Both or neither. The grid sizes its placeholder box from the aspect ratio,
  // so a row carrying one dimension without the other would reserve a box of
  // the wrong shape — worse than reserving none at all.
  //
  // Typed as a `Pick` rather than inferred because these fields reach the
  // request through a spread, and TypeScript does not excess-property-check
  // spreads: a name that drifted from the shared schema would otherwise be
  // dropped by the server's parse in silence, which is the exact bug of
  // measuring dimensions and then never storing them.
  const measured: Pick<CreateAttachmentRequest, "width" | "height"> =
    dimensions.width !== null && dimensions.height !== null
      ? { width: dimensions.width, height: dimensions.height }
      : {};

  const body: CreateAttachmentRequest = {
    filename: selected.filename,
    contentType: selected.contentType,
    byteSize: selected.file.size,
    ...measured,
  };

  const minted = await createAttachment(
    channelId,
    body,
    options.signal,
  ).catch((error: unknown) => {
    // `apiFetch` flattens an abort into a timeout-shaped `ApiError`, so the
    // signal is the only way left to tell "the user cancelled" from "the API is
    // unreachable" — and the first of those is not an error to report.
    if (options.signal.aborted) {
      throw new AttachmentAbortError();
    }
    throw error;
  });

  await putObject(
    minted.uploadUrl,
    selected.file,
    selected.contentType,
    options,
  );

  return {
    attachmentId: minted.attachmentId,
    width: dimensions.width,
    height: dimensions.height,
  };
}

/**
 * A finished upload as the composer hands it to the chat controller.
 *
 * Carries the local `previewUrl` so the optimistic bubble can show the image
 * immediately; the controller revokes it once the broadcast replaces the
 * bubble with real storage URLs.
 */
export interface OutgoingAttachment {
  attachmentId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  previewUrl: string;
}
