import { ApiError } from "@/lib/api";
import { deleteStoryUpload, mintStoryUpload } from "./api";
import { putStoryMedia } from "./upload";

/**
 * A story's file, uploaded the moment it is final (a photo or clip right after
 * it is captured or picked, a placed photo as soon as it is added), long
 * before "Postar" is pressed. Pressing it then only has to create and publish
 * the story, which is what makes it feel instant.
 *
 * One `EagerUpload` is one file: it mints an upload (`POST /api/stories/uploads`),
 * PUTs the bytes to storage while the editor stays usable, and says how far it
 * is. Throwing the file away (`cancel`) aborts the PUT and asks the server to
 * delete the object, fire and forget; the server's 6 hour sweep is the backstop
 * for a DELETE that never arrives, so nothing here retries it.
 *
 * It is an optimisation, never a requirement. A server without the route (a web
 * deploy that got ahead of the API), a storage hiccup, a dropped connection:
 * the handle ends `failed`, and posting then falls back to the plain flow with
 * the same bytes (`post.ts`). The draft keeps the blob either way.
 */

export type EagerState = "uploading" | "done" | "failed" | "cancelled";

export interface EagerInput {
  kind: "base" | "layer";
  blob: Blob;
  contentType: string;
}

/** The server deletes an unclaimed upload after 6 hours: an hour of margin. */
const STALE_AFTER_MS = 5 * 60 * 60 * 1000;

/** Set once the server has said it has no such route: stop asking for the rest of the session. */
let unavailable = false;

export function eagerUploadsAvailable(): boolean {
  return !unavailable;
}

/** Tests only. */
export function resetEagerAvailabilityForTests(): void {
  unavailable = false;
}

export class EagerUpload {
  readonly kind: EagerInput["kind"];
  readonly blob: Blob;
  readonly contentType: string;
  private current: EagerState = "uploading";
  private sent = 0;
  private id: string | null = null;
  private controller = new AbortController();
  private attempt: Promise<string | null> = Promise.resolve(null);
  private generation = 0;
  private claimed = false;
  private doneAt = 0;
  private readonly listeners = new Set<() => void>();

  constructor(input: EagerInput) {
    this.kind = input.kind;
    this.blob = input.blob;
    this.contentType = input.contentType;
    this.start();
  }

  get state(): EagerState {
    return this.current;
  }

  /** Bytes sent over bytes to send, 0..1. */
  get fraction(): number {
    return this.current === "done" ? 1 : this.sent;
  }

  /** The id to put in `uploadId` when creating the story; null until the bytes are stored. */
  get uploadId(): string | null {
    return this.current === "done" ? this.id : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Wait for the bytes to be stored and answer the upload id, starting over
   * once when the last attempt failed. Null when it cannot be done (the draft
   * then uses the plain flow for this file). Never throws.
   */
  async ensure(): Promise<string | null> {
    if (this.current === "done" && !this.claimed && Date.now() - this.doneAt > STALE_AFTER_MS) {
      // A draft kept for hours (a failed post nobody retried): the server sweeps an
      // unclaimed upload after 6 h, so this one may be gone. Upload it again.
      if (this.id) {
        this.discard(this.id);
      }
      this.start();
    } else if (this.current === "failed") {
      this.start();
    }
    return this.attempt;
  }

  /** The story took this file: from here on a `cancel` must never delete what the story now holds. */
  markClaimed(): void {
    this.claimed = true;
  }

  /** The author threw it away: abort the PUT and ask the server to delete the object. */
  cancel(): void {
    if (this.claimed || this.current === "cancelled") {
      return;
    }
    this.current = "cancelled";
    this.controller.abort();
    if (this.id) {
      this.discard(this.id);
    }
    this.notify();
  }

  private start(): void {
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.current = "uploading";
    this.sent = 0;
    this.id = null;
    this.attempt = this.run(generation, this.controller.signal);
    this.notify();
  }

  private discard(uploadId: string): void {
    void deleteStoryUpload(uploadId).catch(() => undefined);
  }

  private live(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && !signal.aborted && this.current === "uploading";
  }

  private async run(generation: number, signal: AbortSignal): Promise<string | null> {
    let minted: Awaited<ReturnType<typeof mintStoryUpload>> | null = null;
    try {
      const request = {
        kind: this.kind,
        contentType: this.contentType,
        byteLength: this.blob.size,
      } as Parameters<typeof mintStoryUpload>[0];
      minted = await mintStoryUpload(request);
      if (!this.live(generation, signal)) {
        // Cancelled while the id was on its way: the object does not exist yet, but the row does.
        this.discard(minted.uploadId);
        return null;
      }
      this.id = minted.uploadId;
      await putStoryMedia(
        minted,
        this.blob,
        (fraction) => {
          if (this.live(generation, signal)) {
            this.sent = fraction;
            this.notify();
          }
        },
        signal,
      );
      if (!this.live(generation, signal)) {
        this.discard(minted.uploadId);
        return null;
      }
      this.current = "done";
      this.doneAt = Date.now();
      this.notify();
      return minted.uploadId;
    } catch (error) {
      if (generation !== this.generation) {
        return null;
      }
      if (error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 501)) {
        // No such route here: the plain flow does everything this would have.
        unavailable = true;
      }
      if (this.current === "uploading") {
        this.current = "failed";
        if (minted && !this.claimed) {
          this.discard(minted.uploadId);
        }
        this.id = null;
        this.notify();
      }
      return null;
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** Start uploading `input` now, or null when this server has no eager uploads. */
export function startEagerUpload(input: EagerInput): EagerUpload | null {
  return unavailable ? null : new EagerUpload(input);
}
