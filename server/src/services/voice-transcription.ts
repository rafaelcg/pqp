import {
  isVoiceNoteContentType,
  voiceTranscriptionPrefs,
  type UserPreferences,
  type VoiceNoteTranscript,
} from "@pqp/shared";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";
import { isTranscriptionOnFor, type DbAttachment } from "./attachments.js";
import { getPreferences, getPreferencesForUsers } from "./preferences.js";
import { enqueueSpeechJob, type SpeechJobKind } from "./speech-jobs.js";
import { isChannelMember } from "./users.js";

/**
 * WHEN a voice note is transcribed or transcoded, decided on the API side.
 * The work itself runs on the worker (`speech-worker.ts`).
 *
 *   * TRANSCODE: every Opus note (`audio/webm`, `audio/ogg`), at send, behind
 *     `voice_notes` only. Whatever the transcription flag says: playback is
 *     not transcription, and an iPhone cannot play Opus.
 *   * TRANSCRIBE, EAGER: a note in a CONVERSATION, at send, when the
 *     `voice_note_transcription` flag is on (globally: a conversation has no
 *     server), the sender allowed it (`transcribe_allowed`, copied at mint),
 *     and at least one recipient has `voiceTranscription.show` on. Nobody
 *     waits for it: the push and the message go out first.
 *   * TRANSCRIBE, LAZY: a note in a SERVER CHANNEL is transcribed only when
 *     somebody asks (`POST /api/attachments/:id/transcript`). The answer is
 *     stored on the note, so the first request pays and everyone else reads.
 *
 * Every decision is made BEFORE the message transaction opens (a few reads on
 * the pool) and only the INSERTs run inside it, so nothing between BEGIN and
 * COMMIT waits on more than its own rows.
 */

/** Opus notes, which iOS cannot play. An AAC note (`audio/mp4`) plays everywhere. */
export function needsPlaybackCopy(contentType: string): boolean {
  return contentType === "audio/webm" || contentType === "audio/ogg";
}

/** Below this, Whisper's language guess is a coin toss: send the sender's locale. */
export const LANGUAGE_HINT_BELOW_MS = 4_000;

/** `pt-BR` → `pt`. The instance's default when the sender never chose. */
export function languageHintFor(preferences: UserPreferences | null | undefined): string {
  return preferences?.locale === "en" ? "en" : "pt";
}

export interface PlannedSpeechJob {
  kind: Extract<SpeechJobKind, "voice_note" | "voice_transcode">;
  attachmentId: string;
  languageHint: string | null;
}

/**
 * What to enqueue for the notes in a send. Reads only; call before BEGIN and
 * hand the answer to `enqueuePlannedSpeechJobs` inside the transaction.
 */
export async function planVoiceNoteJobs(
  channelId: string,
  authorId: string,
  rows: readonly DbAttachment[],
): Promise<PlannedSpeechJob[]> {
  const notes = rows.filter(
    (row) =>
      row.voice_duration_ms !== null &&
      row.voice_duration_ms !== undefined &&
      isVoiceNoteContentType(row.content_type),
  );
  if (notes.length === 0) {
    return [];
  }
  const channel = await getPool().query<{ server_id: string | null }>(
    `SELECT server_id FROM channels WHERE id = $1`,
    [channelId],
  );
  const serverId = channel.rows[0]?.server_id ?? null;
  if (!isEnabled("voice_notes", { serverId })) {
    return [];
  }

  const planned: PlannedSpeechJob[] = [];
  for (const note of notes) {
    if (needsPlaybackCopy(note.content_type)) {
      planned.push({ kind: "voice_transcode", attachmentId: note.id, languageHint: null });
    }
  }

  const eager =
    serverId === null &&
    isTranscriptionOnFor(null) &&
    notes.some((note) => note.voice_transcribe_allowed !== false) &&
    (await someRecipientWantsTranscripts(channelId, authorId));
  if (eager) {
    const shortest = Math.min(...notes.map((note) => note.voice_duration_ms!));
    const hint =
      shortest < LANGUAGE_HINT_BELOW_MS ? languageHintFor(await getPreferences(authorId)) : null;
    for (const note of notes) {
      if (note.voice_transcribe_allowed === false) continue;
      planned.push({
        kind: "voice_note",
        attachmentId: note.id,
        languageHint: note.voice_duration_ms! < LANGUAGE_HINT_BELOW_MS ? hint : null,
      });
    }
  } else if (serverId === null && isTranscriptionOnFor(null)) {
    // Said only while the flag is on: off is the default, and a line per
    // note sent would say nothing the dashboard does not.
    logEvent("voiceNote.transcription.notEager", {
      reason: notes.every((note) => note.voice_transcribe_allowed === false)
        ? "sender-declined"
        : "no-recipient-shows",
    });
  }
  return planned;
}

/**
 * A conversation's other participants, any of whom reads transcripts. The
 * union with `dm_pairs` matters for the same reason it does in `dms.ts`: a
 * person who closed a 1:1 has no `channel_members` row and still gets the
 * message, so still counts.
 */
async function someRecipientWantsTranscripts(channelId: string, authorId: string): Promise<boolean> {
  const members = await getPool().query<{ user_id: string }>(
    `SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id <> $2
     UNION
     SELECT participant FROM dm_pairs p
       CROSS JOIN LATERAL (VALUES (p.low_user_id), (p.high_user_id)) AS pair(participant)
      WHERE p.channel_id = $1 AND participant <> $2`,
    [channelId, authorId],
  );
  const ids = members.rows.map((row) => row.user_id);
  if (ids.length === 0) {
    return false;
  }
  const preferences = await getPreferencesForUsers(ids);
  return ids.some((id) => voiceTranscriptionPrefs(preferences.get(id)).show);
}

/**
 * The INSERTs, inside the message transaction. A transcription job also
 * marks the note `pending`, in the same transaction, so the very broadcast of
 * the message says a transcript is on its way. Returns the attachment ids now
 * pending, for the caller to patch the rows it is about to hand out.
 */
export async function enqueuePlannedSpeechJobs(
  client: PoolClient,
  planned: readonly PlannedSpeechJob[],
): Promise<Set<string>> {
  const pending = new Set<string>();
  for (const job of planned) {
    const queued = await enqueueSpeechJob(client, job);
    if (queued && job.kind === "voice_note") {
      await client.query(
        `UPDATE message_attachment_voice SET transcript_status = 'pending'
          WHERE attachment_id = $1 AND transcript_status = 'none'`,
        [job.attachmentId],
      );
      pending.add(job.attachmentId);
    }
  }
  return pending;
}

// ------------------------------------------------------------- lazy request

/** 404: no such note, or not one the caller can hear. */
export class VoiceNoteNotFoundError extends Error {
  constructor() {
    super("Voice note not found");
    this.name = "VoiceNoteNotFoundError";
  }
}

/** 403: the flag is off where the note lives, or its sender declined. */
export class VoiceTranscriptionUnavailableError extends Error {
  constructor(readonly reason: "flag-off" | "sender-declined") {
    super(
      reason === "flag-off"
        ? "Voice note transcription is not enabled here"
        : "The sender did not allow this note to be transcribed",
    );
    this.name = "VoiceTranscriptionUnavailableError";
  }
}

/** A settled `unavailable` may be asked again after this long (a provider or a new day's budget may exist by then). */
export const UNAVAILABLE_REQUEST_COOLDOWN_SECONDS = 10 * 60;

export interface TranscriptRequestResult {
  /** 202 while queued or running, 200 once settled. */
  status: 200 | 202;
  transcript: VoiceNoteTranscript;
}

/**
 * `POST /api/attachments/:attachmentId/transcript`. Asks for a transcript
 * once and serves the stored one ever after, to everybody who can hear the
 * note: the request is the trigger in a server channel, never a per-person
 * copy.
 */
export async function requestVoiceNoteTranscript(
  attachmentId: string,
  viewerId: string,
): Promise<TranscriptRequestResult> {
  const found = await getPool().query<{
    channel_id: string;
    uploader_id: string;
    server_id: string | null;
    duration_ms: number;
    transcribe_allowed: boolean;
    transcript_status: VoiceNoteTranscript["status"];
    transcript_text: string | null;
    transcript_language: string | null;
  }>(
    `SELECT a.channel_id, a.uploader_id, c.server_id, v.duration_ms,
            v.transcribe_allowed, v.transcript_status, v.transcript_text,
            v.transcript_language
       FROM message_attachments a
       JOIN message_attachment_voice v ON v.attachment_id = a.id
       JOIN channels c ON c.id = a.channel_id
      WHERE a.id = $1 AND a.message_id IS NOT NULL`,
    [attachmentId],
  );
  const note = found.rows[0];
  // Same predicate as the URL refresh: unclaimed, or a channel the caller
  // cannot see, is "not found" rather than "forbidden".
  if (!note || !(await isChannelMember(note.channel_id, viewerId))) {
    throw new VoiceNoteNotFoundError();
  }
  if (!isTranscriptionOnFor(note.server_id)) {
    throw new VoiceTranscriptionUnavailableError("flag-off");
  }
  if (!note.transcribe_allowed) {
    throw new VoiceTranscriptionUnavailableError("sender-declined");
  }

  const settled = (): TranscriptRequestResult => ({
    status: 200,
    transcript: {
      status: note.transcript_status,
      text: note.transcript_status === "done" ? note.transcript_text : null,
      language: note.transcript_language,
    },
  });
  const pending: TranscriptRequestResult = {
    status: 202,
    transcript: { status: "pending", text: null, language: null },
  };

  if (note.transcript_status === "pending") {
    return pending;
  }
  if (note.transcript_status !== "none" && note.transcript_status !== "unavailable") {
    return settled();
  }

  const languageHint =
    note.duration_ms < LANGUAGE_HINT_BELOW_MS
      ? languageHintFor(await getPreferences(note.uploader_id))
      : null;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // `none` re-queues a settled job at once (a note still `none` has no
    // answer, so whatever settled it did not produce one); `unavailable` only
    // after the cooldown.
    const queued = await enqueueSpeechJob(client, {
      kind: "voice_note",
      attachmentId,
      languageHint,
      requeueSettledAfterSeconds:
        note.transcript_status === "none" ? 0 : UNAVAILABLE_REQUEST_COOLDOWN_SECONDS,
    });
    if (queued) {
      await client.query(
        `UPDATE message_attachment_voice SET transcript_status = 'pending'
          WHERE attachment_id = $1 AND transcript_status IN ('none', 'unavailable')`,
        [attachmentId],
      );
    }
    await client.query("COMMIT");
    if (!queued && note.transcript_status === "unavailable") {
      // Inside the cooldown: the stored answer stands.
      return settled();
    }
    // Not queued and `none`: a live job is already there (a racing request,
    // or the eager enqueue), which is pending all the same.
    logEvent("voiceNote.transcription.requested", {
      attachmentId,
      queued,
      requeued: note.transcript_status === "unavailable",
    });
    return pending;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
