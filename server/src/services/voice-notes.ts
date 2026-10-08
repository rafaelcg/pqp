import { isVoiceNoteContentType, noteByteBudget } from "@pqp/shared";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";

/**
 * The rules a voice note has to pass, kept out of the attachment and message
 * code so every surface that takes one (chat today, Baú posts later) asks the
 * same questions:
 *
 *   - at mint: is the `voice_notes` flag on where it is going, is the
 *     container one a recorder produces, and do the bytes fit the duration;
 *   - at claim: is the note the only attachment, with no text beside it.
 *
 * Written against "a note" where the rule is not about audio, so a video note
 * can reuse the shape check without anything here being renamed.
 */

/** The caller answers 403. Off where it is going: nothing is minted. */
export class VoiceNotesDisabledError extends Error {
  constructor() {
    super("Voice notes are not enabled here");
    this.name = "VoiceNotesDisabledError";
  }
}

/** The caller answers 413: the bytes are more than the duration can explain. */
export class NoteTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`A note of this length is limited to ${limit} bytes`);
    this.name = "NoteTooLargeError";
  }
}

/** The caller answers 400. The shared schema already refuses this. */
export class VoiceNoteContentTypeError extends Error {
  constructor() {
    super("A voice note must be audio/mp4, audio/webm or audio/ogg");
    this.name = "VoiceNoteContentTypeError";
  }
}

/**
 * The flag, for the server the channel belongs to. A conversation has no
 * server and reads the global value, which is what a DM should get.
 */
export async function voiceNotesEnabledForChannel(
  channelId: string,
): Promise<boolean> {
  const { rows } = await getPool().query<{ server_id: string | null }>(
    `SELECT server_id FROM channels WHERE id = $1`,
    [channelId],
  );
  return isEnabled("voice_notes", { serverId: rows[0]?.server_id ?? null });
}

export interface VoiceNoteUpload {
  contentType: string;
  byteSize: number;
  durationMs: number;
}

/**
 * Everything about the upload itself, with no database: the container and the
 * byte budget. The budget is what stops a client from declaring two seconds
 * and parking ten megabytes behind them.
 */
export function checkVoiceNoteUpload(upload: VoiceNoteUpload): void {
  if (!isVoiceNoteContentType(upload.contentType)) {
    throw new VoiceNoteContentTypeError();
  }
  const limit = noteByteBudget(upload.durationMs);
  if (upload.byteSize > limit) {
    throw new NoteTooLargeError(limit);
  }
}

/**
 * The mint check for a chat attachment: the flag where it is going, then the
 * upload. Throws, so the caller cannot forget to look at an answer.
 */
export async function assertVoiceNoteMintAllowed(
  channelId: string,
  upload: VoiceNoteUpload,
): Promise<void> {
  if (!(await voiceNotesEnabledForChannel(channelId))) {
    throw new VoiceNotesDisabledError();
  }
  checkVoiceNoteUpload(upload);
}

/** The part of an attachment row this module reads. */
export interface NoteCarrier {
  voice_duration_ms?: number | null;
}

/** True when the row carries a note block (voice today). */
export function isNoteAttachment(row: NoteCarrier): boolean {
  return row.voice_duration_ms !== null && row.voice_duration_ms !== undefined;
}

/**
 * The claim rule. A note travels alone: it is the only attachment the sender
 * asked for, and nothing is written beside it. Anything with no note in it
 * passes untouched.
 *
 * Both counts are taken BEFORE verification drops anything. `requestedNotes`
 * is how many of the sender's own pending rows are notes, and `requestedCount`
 * how many ids they asked to attach. Counting only what verified would let a
 * note whose upload failed fall out first and the rest of the send go through
 * as if no note had been asked for; the sender broke the rule either way.
 */
export function noteShapeAllowed(input: {
  requestedNotes: number;
  requestedCount: number;
  body: string;
}): boolean {
  if (input.requestedNotes === 0) {
    return true;
  }
  return (
    input.requestedNotes === 1 &&
    input.requestedCount === 1 &&
    input.body.trim().length === 0
  );
}
