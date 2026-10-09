import { useSyncExternalStore } from "react";
import type { NoteTranscriptStatus, VoiceNoteTranscript } from "@pqp/shared";
import { ApiError, requestVoiceNoteTranscript } from "@/lib/api";

/**
 * Voice note transcripts, as the client holds them.
 *
 * A transcript arrives two ways: on the attachment read (`voice.transcript`,
 * the BASE, which a message carries for as long as it is in memory) and as a
 * `voice-note-transcript` frame on the note's channel when a job settles or
 * is asked for. Like the listen receipts, the frames land in a store keyed by
 * attachment id rather than being threaded through every copy of the message
 * (the list, a thread panel, a search hit), and a card reads the two together
 * with `resolveTranscript`.
 *
 * The base decides WHETHER there is a transcript at all: the server leaves the
 * block off when the `voice_note_transcription` flag is off where the note
 * lives, and when its sender did not allow it. A stored frame therefore never
 * makes a card draw text the base did not allow.
 */

export type TranscriptStatus = NoteTranscriptStatus;

/** The `voice-note-transcript` frame, as far as the client relies on it. */
export interface VoiceNoteTranscriptFrame {
  type: "voice-note-transcript";
  channelId: string;
  messageId: string;
  attachmentId: string;
  transcript: VoiceNoteTranscript;
}

/** The `voice-note-updated` frame: something a read would now show differently. */
export interface VoiceNoteUpdatedFrame {
  type: "voice-note-updated";
  channelId: string;
  messageId: string;
  attachmentId: string;
  playbackReady: boolean;
}

const STATUSES: readonly string[] = [
  "none",
  "pending",
  "done",
  "no_speech",
  "failed",
  "unavailable",
];

export function isVoiceNoteTranscriptFrame(
  message: unknown,
): message is VoiceNoteTranscriptFrame {
  if (!message || typeof message !== "object") {
    return false;
  }
  const frame = message as Record<string, unknown>;
  const transcript = frame.transcript as Record<string, unknown> | null | undefined;
  return (
    frame.type === "voice-note-transcript" &&
    typeof frame.attachmentId === "string" &&
    !!transcript &&
    typeof transcript === "object" &&
    typeof transcript.status === "string" &&
    STATUSES.includes(transcript.status)
  );
}

export function isVoiceNoteUpdatedFrame(message: unknown): message is VoiceNoteUpdatedFrame {
  if (!message || typeof message !== "object") {
    return false;
  }
  const frame = message as Record<string, unknown>;
  return frame.type === "voice-note-updated" && typeof frame.attachmentId === "string";
}

// ------------------------------------------------------------------ store

const stored = new Map<string, VoiceNoteTranscript>();
const listeners = new Map<string, Set<() => void>>();

function emit(attachmentId: string): void {
  for (const listener of listeners.get(attachmentId) ?? []) {
    listener();
  }
}

function subscribeTo(attachmentId: string, listener: () => void): () => void {
  let set = listeners.get(attachmentId);
  if (!set) {
    set = new Set();
    listeners.set(attachmentId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) {
      listeners.delete(attachmentId);
    }
  };
}

function put(attachmentId: string, transcript: VoiceNoteTranscript): void {
  const previous = stored.get(attachmentId);
  if (
    previous &&
    previous.status === transcript.status &&
    (previous.text ?? null) === (transcript.text ?? null) &&
    (previous.language ?? null) === (transcript.language ?? null)
  ) {
    return;
  }
  stored.set(attachmentId, transcript);
  emit(attachmentId);
}

/** A settled or pending transcript from the channel. */
export function applyVoiceNoteTranscript(frame: VoiceNoteTranscriptFrame): void {
  optimistic.delete(frame.attachmentId);
  put(frame.attachmentId, frame.transcript);
  if (frame.transcript.status !== "pending") {
    // Settled: nobody needs to ask again for this note.
    cancelRecheck(frame.attachmentId);
  }
}

/**
 * The transcript to draw: what the message was read with, or what a frame or
 * our own request has said since.
 *
 * The stored answer wins, with one exception: a `done` base is final. A
 * message re-read after a reconnect can carry the finished text while this tab
 * still holds the `pending` it was told first, and the frame that would have
 * replaced it was missed.
 *
 * No base, no transcript: the server leaves the block off when transcripts do
 * not exist where the note lives (flag off, or the sender declined).
 */
export function resolveTranscript(
  base: VoiceNoteTranscript | undefined,
  fromStore: VoiceNoteTranscript | undefined,
): VoiceNoteTranscript | undefined {
  if (!base) {
    return undefined;
  }
  if (!fromStore) {
    return base;
  }
  if (base.status === "done" && fromStore.status !== "done") {
    return base;
  }
  return fromStore;
}

export function useVoiceNoteTranscript(
  attachmentId: string,
  base: VoiceNoteTranscript | undefined,
): VoiceNoteTranscript | undefined {
  const fromStore = useSyncExternalStore(
    (listener) => subscribeTo(attachmentId, listener),
    () => stored.get(attachmentId),
    () => undefined,
  );
  return resolveTranscript(base, fromStore);
}

// --------------------------------------------------------------- requests

/**
 * Where a request for one note stands, for the card's button:
 *   * `idle`: nothing asked (or an earlier ask failed in a way worth retrying).
 *   * `refused`: the server will not transcribe this note for this person (the
 *     flag is off here, the sender declined, a preference says no) or it is gone.
 *     The card draws nothing to ask with.
 *   * `slow`: the limiter said slow down; the button is back after a moment.
 *   * `failed`: the request did not reach the server.
 */
export type TranscriptRequestState = "idle" | "refused" | "slow" | "failed";

const requestState = new Map<string, TranscriptRequestState>();
/** Notes shown as `pending` because we asked, before the server said so. */
const optimistic = new Set<string>();
const inFlight = new Map<string, Promise<void>>();
const stateListeners = new Map<string, Set<() => void>>();

function emitState(attachmentId: string): void {
  for (const listener of stateListeners.get(attachmentId) ?? []) {
    listener();
  }
}

function setRequestState(attachmentId: string, next: TranscriptRequestState): void {
  if ((requestState.get(attachmentId) ?? "idle") === next) {
    return;
  }
  if (next === "idle") {
    requestState.delete(attachmentId);
  } else {
    requestState.set(attachmentId, next);
  }
  emitState(attachmentId);
}

export function useTranscriptRequestState(attachmentId: string): TranscriptRequestState {
  return useSyncExternalStore(
    (listener) => {
      let set = stateListeners.get(attachmentId);
      if (!set) {
        set = new Set();
        stateListeners.set(attachmentId, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) {
          stateListeners.delete(attachmentId);
        }
      };
    },
    () => requestState.get(attachmentId) ?? "idle",
    () => "idle" as TranscriptRequestState,
  );
}

/** How long the limiter's answer keeps the button away. */
export const SLOW_DOWN_MS = 8_000;

/**
 * A job that was queued answers with a frame. If that frame never arrives (a
 * socket that dropped in the gap, a worker restart) the card would shimmer for
 * good, so a request WE made asks again, a few times, a little later. Asking
 * is idempotent on the server: it answers 200 with the stored result, or 202
 * again while it is still running.
 */
export const RECHECK_AFTER_MS = 45_000;
export const RECHECK_LIMIT = 4;

const rechecks = new Map<string, { timer: ReturnType<typeof setTimeout>; count: number }>();

function cancelRecheck(attachmentId: string): void {
  const entry = rechecks.get(attachmentId);
  if (entry) {
    clearTimeout(entry.timer);
    rechecks.delete(attachmentId);
  }
}

function scheduleRecheck(attachmentId: string, count: number): void {
  cancelRecheck(attachmentId);
  if (count >= RECHECK_LIMIT) {
    return;
  }
  const timer = setTimeout(() => {
    rechecks.delete(attachmentId);
    if (stored.get(attachmentId)?.status !== "pending") {
      return;
    }
    void ask(attachmentId, count + 1);
  }, RECHECK_AFTER_MS);
  rechecks.set(attachmentId, { timer, count });
}

/** The request did not take: the note is what it was before we asked. */
function takeBackOptimism(attachmentId: string): void {
  if (optimistic.delete(attachmentId) && stored.get(attachmentId)?.status === "pending") {
    stored.delete(attachmentId);
    emit(attachmentId);
  }
}

function ask(attachmentId: string, recheck: number): Promise<void> {
  const running = inFlight.get(attachmentId);
  if (running) {
    return running;
  }
  const run = requestVoiceNoteTranscript(attachmentId)
    .then(({ transcript }) => {
      optimistic.delete(attachmentId);
      setRequestState(attachmentId, "idle");
      put(attachmentId, transcript);
      if (transcript.status === "pending") {
        scheduleRecheck(attachmentId, recheck);
      } else {
        cancelRecheck(attachmentId);
      }
    })
    .catch((error: unknown) => {
      const status = error instanceof ApiError ? error.status : 0;
      if (recheck === 0 || status === 403 || status === 404) {
        takeBackOptimism(attachmentId);
      }
      if (status === 403 || status === 404) {
        setRequestState(attachmentId, "refused");
      } else if (status === 429) {
        setRequestState(attachmentId, "slow");
        setTimeout(() => {
          if (requestState.get(attachmentId) === "slow") {
            setRequestState(attachmentId, "idle");
          }
        }, SLOW_DOWN_MS);
      } else if (recheck > 0) {
        // A recheck that failed to get through tries again on its own clock.
        scheduleRecheck(attachmentId, recheck);
      } else {
        setRequestState(attachmentId, "failed");
      }
    })
    .finally(() => {
      inFlight.delete(attachmentId);
    });
  inFlight.set(attachmentId, run);
  return run;
}

/**
 * "Transcrever" was pressed. At most one request per note is ever in flight,
 * whatever number of cards (list, thread, search) show it and however fast
 * the button is pressed. The note reads as `pending` the moment it is asked
 * for, so the card does not sit on a button that has already been used.
 */
export function requestTranscript(attachmentId: string): Promise<void> {
  if (inFlight.has(attachmentId)) {
    return inFlight.get(attachmentId)!;
  }
  const current = stored.get(attachmentId);
  if (!current || current.status === "none" || current.status === "unavailable") {
    optimistic.add(attachmentId);
    put(attachmentId, { status: "pending", text: null, language: null });
  }
  setRequestState(attachmentId, "idle");
  return ask(attachmentId, 0);
}

/** For tests: forget everything. */
export function resetVoiceNoteTranscriptsForTests(): void {
  stored.clear();
  requestState.clear();
  optimistic.clear();
  inFlight.clear();
  for (const entry of rechecks.values()) {
    clearTimeout(entry.timer);
  }
  rechecks.clear();
}

export function getStoredTranscript(attachmentId: string): VoiceNoteTranscript | undefined {
  return stored.get(attachmentId);
}
