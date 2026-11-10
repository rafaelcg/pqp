import {
  JAM_AUDIO_CONTENT_TYPES,
  JAM_VIDEO_CONTENT_TYPES,
  type AddJamTrackRequest,
  type CreateJamUploadRequest,
  type JamInstrument,
  type JamTrackWithSong,
  type JamUploadKind,
  type JamUploadTicket,
} from "@pqp/shared";
import { addJamTrack, createJamUpload } from "@/lib/jam-api";

/**
 * Posting a take: the three steps of `docs/JAM.md` ("Adding a track"), with the
 * progress a person watches and a retry that picks up where the last try
 * stopped.
 *
 *   1. a ticket per file (`POST .../uploads`),
 *   2. `PUT` the bytes to the ticket's URL,
 *   3. `POST .../tracks` naming the uploads.
 *
 * WHY THE STATE IS A VALUE THE CALLER KEEPS. A retry must reuse the same upload
 * id: step 3 is idempotent on `audioUploadId` (the same track comes back with
 * 200 and two concurrent tries land on one), which is what makes "post again"
 * safe after a connection that died with the answer in flight. So the caller
 * holds a `JamPostState`, passes it to every try, and each try does only what
 * is not done yet: a file already stored is not sent again, a ticket still
 * good is reused, and a claim that already succeeded is returned as it was.
 */

export interface JamPostPart {
  kind: JamUploadKind;
  blob: Blob;
  contentType: string;
  ticket: JamUploadTicket | null;
  /** The bytes are in the bucket. */
  stored: boolean;
}

export interface JamPostState {
  audio: JamPostPart;
  video: JamPostPart | null;
  result: JamTrackWithSong | null;
  /** The try that is running. A second call joins it instead of starting another. */
  running?: Promise<JamTrackWithSong> | null;
}

export interface JamPostTake {
  audio: Blob;
  video: Blob | null;
  offsetMs: number;
  trimStartMs: number;
  trimEndMs: number;
  durationMs: number;
  gain: number;
  peaks: number[];
}

export type JamPostStage = "uploading" | "claiming" | "done";

export interface JamPostProgress {
  stage: JamPostStage;
  /** 0..1 across every file. */
  fraction: number;
}

export interface JamPostDeps {
  createUpload: (songId: string, body: CreateJamUploadRequest) => Promise<JamUploadTicket>;
  put: (
    url: string,
    blob: Blob,
    contentType: string,
    onProgress: (loaded: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  addTrack: (songId: string, body: AddJamTrackRequest) => Promise<JamTrackWithSong>;
  now: () => number;
}

/** The type the server signs, bare: `video/webm;codecs=vp9` is `video/webm`. */
export function bareContentType(kind: JamUploadKind, raw: string, fallback: string): string {
  const bare = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  const allowed: readonly string[] =
    kind === "audio" ? JAM_AUDIO_CONTENT_TYPES : JAM_VIDEO_CONTENT_TYPES;
  return allowed.includes(bare) ? bare : fallback;
}

export function startJamPost(take: JamPostTake): JamPostState {
  return {
    audio: {
      kind: "audio",
      blob: take.audio,
      contentType: bareContentType("audio", take.audio.type, "audio/flac"),
      ticket: null,
      stored: false,
    },
    video: take.video
      ? {
          kind: "video",
          blob: take.video,
          contentType: bareContentType("video", take.video.type, "video/webm"),
          ticket: null,
          stored: false,
        }
      : null,
    result: null,
  };
}

/** A ticket is good for 15 minutes; one with under a minute left is not worth the PUT. */
const TICKET_SLACK_MS = 60_000;

function ticketUsable(part: JamPostPart, now: number): boolean {
  return part.ticket !== null && Date.parse(part.ticket.expiresAt) - now > TICKET_SLACK_MS;
}

export interface PostTakeArgs {
  songId: string;
  instrument: JamInstrument;
  label?: string | null;
  take: JamPostTake;
  state: JamPostState;
  onProgress?: (progress: JamPostProgress) => void;
  signal?: AbortSignal;
  deps?: JamPostDeps;
}

/**
 * One try. Throws what failed (the caller shows it and offers the retry);
 * calling it again with the same `state` continues.
 */
export function postTake(args: PostTakeArgs): Promise<JamTrackWithSong> {
  const { state } = args;
  if (state.result) {
    return Promise.resolve(state.result);
  }
  // Two tries at once would each ask for a ticket and claim a different upload id
  // for the same take: the second joins the first, and a failed try is retried
  // only after it has finished failing.
  if (state.running) {
    return state.running;
  }
  const run = runPost(args).finally(() => {
    state.running = null;
  });
  state.running = run;
  return run;
}

async function runPost(args: PostTakeArgs): Promise<JamTrackWithSong> {
  const { songId, instrument, take, state, onProgress, signal } = args;
  const deps = args.deps ?? DEFAULT_DEPS;
  const parts = [state.audio, ...(state.video ? [state.video] : [])];
  const total = parts.reduce((sum, part) => sum + part.blob.size, 0) || 1;
  const loadedBy = new Map<JamPostPart, number>(
    parts.map((part) => [part, part.stored ? part.blob.size : 0]),
  );
  const report = (stage: JamPostStage) => {
    let loaded = 0;
    for (const value of loadedBy.values()) loaded += value;
    onProgress?.({ stage, fraction: Math.min(1, loaded / total) });
  };
  report("uploading");

  // Files go one after the other: the audio is what makes a track, so it is
  // first, and a failed video never leaves a half-sent audio hidden behind it.
  for (const part of parts) {
    if (part.stored) {
      continue;
    }
    if (!ticketUsable(part, deps.now())) {
      part.ticket = await deps.createUpload(songId, {
        kind: part.kind,
        contentType: part.contentType,
        byteSize: part.blob.size,
      });
    }
    await deps.put(
      part.ticket!.uploadUrl,
      part.blob,
      part.contentType,
      (loaded) => {
        loadedBy.set(part, Math.min(part.blob.size, loaded));
        report("uploading");
      },
      signal,
    );
    part.stored = true;
    loadedBy.set(part, part.blob.size);
    report("uploading");
  }

  report("claiming");
  const result = await deps.addTrack(songId, {
    instrument,
    label: args.label ?? null,
    audioUploadId: state.audio.ticket!.uploadId,
    videoUploadId: state.video ? state.video.ticket!.uploadId : null,
    durationMs: Math.round(take.durationMs),
    offsetMs: take.offsetMs,
    trimStartMs: Math.round(take.trimStartMs),
    trimEndMs: Math.round(take.trimEndMs),
    gain: take.gain,
    peaks: take.peaks,
  });
  state.result = result;
  onProgress?.({ stage: "done", fraction: 1 });
  return result;
}

/** `PUT` with progress. `fetch` has no upload progress, `XMLHttpRequest` does. */
export function putWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", contentType);
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`upload failed: ${request.status}`));
    request.onerror = () => reject(new Error("upload failed: network"));
    request.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(blob);
  });
}

/** Give up on the picture and post the sound alone: the audio is already stored. */
export function withoutVideo(state: JamPostState): JamPostState {
  return { ...state, video: null };
}

const DEFAULT_DEPS: JamPostDeps = {
  createUpload: createJamUpload,
  put: putWithProgress,
  addTrack: addJamTrack,
  now: () => Date.now(),
};
