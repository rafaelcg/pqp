import {
  STORY_POSTS_PER_DAY,
  type CreateStoryRequest,
  type StoryLayerInput,
  type StoryUpload,
} from "@pqp/shared";
import { ApiError } from "@/lib/api";
import type { MessageKey, MessageVars } from "@/lib/i18n";
import { createStory, deleteStory, fetchStories, publishStory } from "./api";
import type { EagerUpload } from "./eager-upload";
import { emitStoriesRefresh, onStoriesSignal } from "./events";
import { mediaInputFor, putStoryMedia, type PreparedStoryMedia } from "./upload";
import { getStoriesUi, patchPosting, setPosting } from "./ui-store";

/**
 * Posting runs outside the composer, which closes the moment "Postar story"
 * is pressed: the card goes into the "Teu story" ring and the ring carries
 * the rest (design §3.3). The arc is the real PUT progress; a failure turns
 * the ring red and a tap on it posts again.
 *
 * A video comes back from publish as `processing`: its frames are checked by
 * a job first. The ring keeps a spinning arc until an `own` frame says
 * something about our stories changed and a re-read shows it live.
 */

export interface StoryDraft {
  request: Omit<CreateStoryRequest, "media" | "requestId">;
  media: PreparedStoryMedia | null;
  /** The pixels of every image and drawing layer, by layer id, to PUT where `layerUploads` says. */
  layerFiles?: ReadonlyMap<string, Blob>;
  /**
   * The create's idempotency key, minted once per draft and kept across
   * retries: a retry after a dropped answer gets the story that was already
   * made (with a fresh upload URL while it still waits for its bytes)
   * instead of posting it twice.
   */
  requestId?: string;
  /**
   * Files already on their way to storage (`eager-upload.ts`), started when the
   * bytes were final: the base, and each photo or drawing layer by layer id.
   * Posting waits for them instead of uploading anything itself, and a file
   * whose eager upload failed (or never started) goes up the plain way with
   * the blob kept above. The draft owns them: `discard` throws them away.
   */
  eager?: { base?: EagerUpload | null; layers?: ReadonlyMap<string, EagerUpload> };
  /**
   * The story the server made for this draft once the create answered. A post that failed after that
   * point (the publish) left it pending there, so discarding the draft deletes it too.
   */
  createdStoryId?: string;
}

export type PostOutcome = "live" | "processing" | "failed" | "busy";

/**
 * Why a post failed, which decides what a tap on the red ring may do.
 *
 * - `failed`: the network or the server let us down. Posting again is worth
 *   it, with the same `requestId`, so an answer that was lost does not post
 *   the story twice.
 * - `busy`: three in a minute. Posting again in a moment works.
 * - `daily`: the 24 h cap. Nothing will work until tomorrow, so the ring
 *   only says so and a tap puts it away.
 * - `refused`: the server said no for good (the scan, a permission, a story
 *   that is gone; see `TERMINAL_STATUSES`). The story that `requestId` made is deleted, so replaying
 *   it can only answer "gone": the tap puts the ring away instead, and the
 *   person composes again if they want to.
 */
export type PostFailure = "failed" | "busy" | "daily" | "refused";

/** What the red ring is called: a retry, or why it will not go up. */
export function failedRingLabel(
  failure: PostFailure | null,
  retryable: boolean,
): { key: MessageKey; vars?: MessageVars } {
  if (failure === "busy") {
    return { key: "stories.upload.busy" };
  }
  if (failure === "daily") {
    return { key: "stories.upload.daily", vars: { limit: STORY_POSTS_PER_DAY } };
  }
  return { key: retryable ? "stories.upload.failed" : "stories.upload.dismiss" };
}

/** The one line said out loud the moment a post fails, so nobody has to hover the ring. */
export function failedPostNotice(failure: PostFailure | null): { key: MessageKey; vars?: MessageVars } {
  switch (failure) {
    case "busy":
      return { key: "stories.upload.busy" };
    case "daily":
      return { key: "stories.upload.daily", vars: { limit: STORY_POSTS_PER_DAY } };
    case "refused":
      return { key: "stories.upload.refused" };
    default:
      return { key: "stories.upload.failedNotice" };
  }
}

export function classifyPostFailure(error: unknown): PostFailure {
  if (!(error instanceof ApiError) || error.status === 0) {
    return "failed";
  }
  if (error.status === 429) {
    // The per-minute limiter answers with `Retry-After`; the daily budget
    // (a "budget" StoryError) does not, because waiting a minute is no help.
    return error.retryAfterMs !== null ? "busy" : "daily";
  }
  // Only the answers that say this story will never go up are final: a bad
  // request, no permission, gone, too big, refused by the scan or AutoMod.
  // Anything else (an expired session, 409 "upload not verified yet", a
  // timeout, 5xx) leaves the story where a retry can still finish it.
  return TERMINAL_STATUSES.has(error.status) ? "refused" : "failed";
}

const TERMINAL_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 410, 413, 422]);

let counter = 0;

export function audienceKeysFor(request: Pick<CreateStoryRequest, "audiences">): string[] {
  return [
    ...request.audiences.serverIds.map((id) => `server:${id}`),
    ...(request.audiences.friends ? ["friends"] : []),
  ];
}

/** The files of a draft with the handle that is uploading each, if any. */
function eagerFiles(draft: StoryDraft): { layerId: string | null; handle: EagerUpload }[] {
  const files: { layerId: string | null; handle: EagerUpload }[] = [];
  if (draft.eager?.base) {
    files.push({ layerId: null, handle: draft.eager.base });
  }
  for (const [layerId, handle] of draft.eager?.layers ?? []) {
    files.push({ layerId, handle });
  }
  return files;
}

/** Bytes of every file this story uploads: the arc is bytes sent over this. */
function totalBytes(draft: StoryDraft): number {
  let total = draft.media?.blob.size ?? 0;
  for (const blob of draft.layerFiles?.values() ?? []) {
    total += blob.size;
  }
  return total || 1;
}

function sentFraction(handle: EagerUpload | null | undefined, plain: number): number {
  return handle && handle.state !== "failed" && handle.state !== "cancelled" ? handle.fraction : plain;
}

/**
 * How far every file is, 0..1: an eager upload by what it has sent, a plain one
 * by what `putAll` reports in `plainSent`, which is keyed `base` or the layer id.
 */
function overallProgress(draft: StoryDraft, plainSent: ReadonlyMap<string, number>): number {
  let sent = 0;
  if (draft.media) {
    sent += sentFraction(draft.eager?.base, plainSent.get("base") ?? 0) * draft.media.blob.size;
  }
  for (const [layerId, blob] of draft.layerFiles ?? []) {
    sent += sentFraction(draft.eager?.layers?.get(layerId), plainSent.get(layerId) ?? 0) * blob.size;
  }
  return Math.min(1, sent / totalBytes(draft));
}

/** The draft's eager uploads, thrown away: the PUTs abort and the server is told to delete the objects. */
export function cancelDraftUploads(draft: Pick<StoryDraft, "eager">): void {
  for (const { handle } of eagerFiles(draft as StoryDraft)) {
    handle.cancel();
  }
}

function releasePreview(draft: StoryDraft): void {
  const url = draft.media?.previewUrl;
  if (url) {
    // A moment late: the card that flew into the ring is a clone showing this very picture.
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

/** Put the draft away: stop its uploads, delete what was stored, free its picture, clear the ring. */
function discardDraft(draft: StoryDraft, id: string): void {
  cancelDraftUploads(draft);
  if (draft.createdStoryId) {
    // Fire and forget: the server's sweep takes a pending story nobody publishes within the hour.
    void deleteStory(draft.createdStoryId).catch(() => undefined);
    draft.createdStoryId = undefined;
  }
  releasePreview(draft);
  if (getStoriesUi().posting?.id === id) {
    setPosting(null);
  }
}

/**
 * Posting, from the moment "Postar" is pressed. It runs outside the composer,
 * which closes at once; every file is either already stored (its eager upload
 * finished while the author was still editing) or still on its way, and this
 * waits for those and uploads nothing a handle already has.
 *
 * With every file stored the whole story is ONE request: create and publish
 * together (`publish: true`), which is why the ring completes almost at once.
 * A file with no stored copy (no eager upload, a failed one, a server without
 * the route) goes the plain way: the create hands back a URL, the bytes are
 * PUT, then publish.
 *
 * The draft, its files and its audience, stays in memory until the story is up
 * or the author discards it from the ring: a failed post keeps everything.
 */
export async function postStory(draft: StoryDraft): Promise<PostOutcome> {
  const id = `post-${Date.now()}-${++counter}`;
  draft.requestId ??= crypto.randomUUID();
  const audienceKeys = audienceKeysFor(draft.request);
  const hasFiles = Boolean(draft.media) || (draft.layerFiles?.size ?? 0) > 0;
  const plainSent = new Map<string, number>();
  const showProgress = () => {
    if (hasFiles) {
      patchPosting(id, { progress: overallProgress(draft, plainSent) });
    }
  };
  setPosting({
    id,
    audienceKeys,
    progress: hasFiles ? overallProgress(draft, plainSent) : null,
    status: "uploading",
    failure: null,
    retry: null,
    discard: () => discardDraft(draft, id),
  });
  const unsubscribe = eagerFiles(draft).map(({ handle }) => handle.subscribe(showProgress));
  try {
    // Wait for the files already on their way. A null is a file the plain flow takes over.
    const stored = await Promise.all(
      eagerFiles(draft).map(async ({ layerId, handle }) => ({ layerId, uploadId: await handle.ensure() })),
    );
    const baseUploadId = stored.find((entry) => entry.layerId === null)?.uploadId ?? null;
    const layerUploadIds = new Map<string, string>();
    for (const entry of stored) {
      if (entry.layerId !== null && entry.uploadId) {
        layerUploadIds.set(entry.layerId, entry.uploadId);
      }
    }
    const layers = draft.request.layers?.map((layer): StoryLayerInput => {
      const uploadId = layerUploadIds.get(layer.id);
      if (!uploadId) {
        return layer;
      }
      if (layer.type === "image") {
        return { ...layer, upload: { ...layer.upload, uploadId } };
      }
      if (layer.type === "drawing") {
        return { ...layer, upload: { ...layer.upload, uploadId } };
      }
      return layer;
    });
    const everyFileStored =
      hasFiles &&
      (!draft.media || baseUploadId !== null) &&
      [...(draft.layerFiles?.keys() ?? [])].every((layerId) => layerUploadIds.has(layerId));
    const body = {
      ...draft.request,
      ...(layers ? { layers } : {}),
      requestId: draft.requestId,
      ...(draft.media
        ? { media: { ...mediaInputFor(draft.media), ...(baseUploadId ? { uploadId: baseUploadId } : {}) } }
        : {}),
      // One round trip when nothing is left to upload.
      ...(everyFileStored ? { publish: true } : {}),
    } as CreateStoryRequest;
    if (everyFileStored) {
      patchPosting(id, { progress: 1 });
    }
    const created = await createStory(body);
    for (const { handle } of eagerFiles(draft)) {
      if (handle.uploadId) {
        handle.markClaimed();
      }
    }
    let storyId = created.story.id;
    draft.createdStoryId = storyId;
    let status = created.story.own?.status ?? "live";
    if (status === "pending") {
      const uploads: { upload: StoryUpload; blob: Blob }[] = [];
      if (created.upload && draft.media) {
        uploads.push({ upload: created.upload, blob: draft.media.blob });
      }
      for (const layerUpload of created.layerUploads ?? []) {
        const blob = draft.layerFiles?.get(layerUpload.layerId);
        if (!blob) {
          // The server minted an upload for a file this draft does not have: posting on would
          // publish a story with a layer missing, or none at all and call it live.
          throw new Error(`No file for layer ${layerUpload.layerId}`);
        }
        uploads.push({ upload: layerUpload, blob });
      }
      if (uploads.length > 0) {
        await putAll(uploads, (fraction) => patchPosting(id, { progress: fraction }));
        patchPosting(id, { progress: null });
      }
      const published = await publishStory(storyId);
      storyId = published.story.id;
      status = published.story.own?.status ?? "live";
    }
    // Published (or live at once): discarding the draft must never delete what the server now shows.
    draft.createdStoryId = undefined;
    unsubscribe.forEach((off) => off());
    if (status === "processing" || status === "pending") {
      patchPosting(id, { status: "processing", progress: null });
      waitUntilLive(id, storyId, draft);
      emitStoriesRefresh();
      return "processing";
    }
    finish(id, draft);
    return "live";
  } catch (error) {
    unsubscribe.forEach((off) => off());
    const failure = classifyPostFailure(error);
    const retryable = failure === "failed" || failure === "busy";
    if (!retryable) {
      // Whatever this key made is gone or never will be: never replay it.
      draft.requestId = undefined;
    }
    patchPosting(id, {
      status: "failed",
      progress: null,
      failure,
      retry: retryable
        ? () => {
            void postStory(draft);
          }
        : null,
    });
    return failure === "busy" || failure === "daily" ? "busy" : "failed";
  }
}

/**
 * Every file of a story, together: the arc on the ring is bytes sent over bytes
 * to send across ALL of them, so a story with a photo and a drawing does not
 * fill the ring twice. They go up in parallel (a handful of small files).
 */
async function putAll(
  uploads: readonly { upload: StoryUpload; blob: Blob }[],
  onProgress: (fraction: number) => void,
): Promise<void> {
  const total = uploads.reduce((sum, entry) => sum + entry.blob.size, 0) || 1;
  const sent = uploads.map(() => 0);
  // One file failing stops the others: they would only upload bytes for a story that is not going up.
  const stop = new AbortController();
  try {
    await Promise.all(
      uploads.map((entry, index) =>
        putStoryMedia(
          entry.upload,
          entry.blob,
          (fraction) => {
            sent[index] = fraction * entry.blob.size;
            onProgress(Math.min(1, sent.reduce((sum, value) => sum + value, 0) / total));
          },
          stop.signal,
        ).catch((error: unknown) => {
          stop.abort();
          throw error;
        }),
      ),
    );
  } finally {
    stop.abort();
  }
}

function finish(id: string, draft?: StoryDraft): void {
  patchPosting(id, { status: "done", progress: null });
  if (draft) {
    releasePreview(draft);
  }
  emitStoriesRefresh();
  // Let the arc complete and the ring sweep into the gradient first.
  window.setTimeout(() => {
    if (getStoriesUi().posting?.id === id) {
      setPosting(null);
    }
  }, 600);
}

/** Re-read a processing video this often even without a frame, for so long. */
const PROCESSING_POLL_MS = 15_000;
const PROCESSING_GIVE_UP_MS = 10 * 60_000;

/**
 * Wait for a processing video to go live: on every `own` frame, on a
 * reconnect (frames sent while the socket was down are lost), and on a slow
 * poll as the last resort, so a missed frame cannot leave the ring spinning.
 * After ten minutes the ring stops waiting; the strip shows the story
 * whenever it does go live.
 */
function waitUntilLive(id: string, storyId: string, draft: StoryDraft): void {
  let done = false;
  let checking = false;
  const startedAt = Date.now();
  const stop = () => {
    done = true;
    off();
    window.clearInterval(poll);
  };
  const check = () => {
    if (done || checking) {
      return;
    }
    if (getStoriesUi().posting?.id !== id) {
      stop();
      return;
    }
    if (Date.now() - startedAt > PROCESSING_GIVE_UP_MS) {
      stop();
      setPosting(null);
      return;
    }
    checking = true;
    void fetchStories([storyId])
      .then(([story]) => {
        if (done) {
          return;
        }
        if (!story) {
          // Refused at processing (a frame failed the scan) or deleted.
          stop();
          patchPosting(id, { status: "failed", progress: null, failure: "refused", retry: null });
          return;
        }
        if (story.own?.status === "live") {
          stop();
          finish(id, draft);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  };
  const off = onStoriesSignal((signal) => {
    if (signal.kind === "refresh" || signal.frame.scope === "own") {
      check();
    }
  });
  const poll = window.setInterval(check, PROCESSING_POLL_MS);
}
