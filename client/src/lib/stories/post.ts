import type { CreateStoryRequest } from "@pqp/shared";
import { ApiError } from "@/lib/api";
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
    const busy = error instanceof ApiError && error.status === 429;
    patchPosting(id, {
      status: "failed",
      progress: null,
      retry: () => {
        void postStory(draft);
      },
    });
    return busy ? "busy" : "failed";
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
          patchPosting(id, { status: "failed", progress: null, retry: null });
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
