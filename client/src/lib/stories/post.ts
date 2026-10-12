import { STORY_POSTS_PER_DAY, type CreateStoryRequest } from "@pqp/shared";
import { ApiError } from "@/lib/api";
import type { MessageKey, MessageVars } from "@/lib/i18n";
import { createStory, fetchStories, publishStory } from "./api";
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
  /**
   * The create's idempotency key, minted once per draft and kept across
   * retries: a retry after a dropped answer gets the story that was already
   * made (with a fresh upload URL while it still waits for its bytes)
   * instead of posting it twice.
   */
  requestId?: string;
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

export async function postStory(draft: StoryDraft): Promise<PostOutcome> {
  const id = `post-${Date.now()}-${++counter}`;
  draft.requestId ??= crypto.randomUUID();
  const audienceKeys = audienceKeysFor(draft.request);
  setPosting({
    id,
    audienceKeys,
    progress: draft.media ? 0 : null,
    status: "uploading",
    failure: null,
    retry: null,
  });
  try {
    const body: CreateStoryRequest = draft.media
      ? { ...draft.request, requestId: draft.requestId, media: mediaInputFor(draft.media) }
      : ({ ...draft.request, requestId: draft.requestId } as CreateStoryRequest);
    const created = await createStory(body);
    let storyId = created.story.id;
    let status = created.story.own?.status ?? "live";
    if (created.upload && draft.media) {
      await putStoryMedia(created.upload, draft.media.blob, (fraction) =>
        patchPosting(id, { progress: fraction }),
      );
      patchPosting(id, { progress: null });
      const published = await publishStory(storyId);
      storyId = published.story.id;
      status = published.story.own?.status ?? "live";
    }
    if (status === "processing" || status === "pending") {
      patchPosting(id, { status: "processing", progress: null });
      waitUntilLive(id, storyId);
      emitStoriesRefresh();
      return "processing";
    }
    finish(id);
    return "live";
  } catch (error) {
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

function finish(id: string): void {
  patchPosting(id, { status: "done", progress: null });
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
function waitUntilLive(id: string, storyId: string): void {
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
          finish(id);
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
