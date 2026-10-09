import { z } from "zod";

/**
 * File attachments: the wire contract for minting an upload URL, for claiming
 * the resulting rows onto a message, and for every read of a stored message.
 *
 * Bytes never pass through the API — the server hands out a presigned PUT and
 * the browser uploads straight to object storage — so this file is the only
 * place both sides agree on what may be uploaded at all. The limits below are
 * re-checked server-side when the URL is minted; a client that skipped them
 * would only get a 4xx, never a stored object.
 */

/**
 * Content types the server will sign an upload for.
 *
 * An allowlist rather than a denylist, because the failure mode is serving
 * hostile content from our own origin. Notably absent: `image/svg+xml` and
 * `text/html`, which are documents that execute script, not media.
 */
export const ATTACHMENT_MIME_ALLOWLIST = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  // Voice notes (`voice` below): Safari records AAC-LC in MP4, Chrome and
  // Firefox record Opus in WebM. Both are accepted as recorded and never
  // transcoded. They are ordinary audio files too, so a client that does not
  // know `voice` shows a plain audio player.
  "audio/mp4",
  "audio/webm",
  "application/pdf",
  "text/plain",
] as const;

export type AttachmentContentType = (typeof ATTACHMENT_MIME_ALLOWLIST)[number];

export const attachmentContentTypeSchema = z.enum(ATTACHMENT_MIME_ALLOWLIST);

/** Attachments one message may carry, matching Discord's own limit. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Upload ceiling in bytes. The deployment may lower it with
 * `MAX_ATTACHMENT_BYTES`; it cannot raise it past this without a rebuild,
 * because `createAttachmentSchema` rejects the mint request before the
 * server's own cap is ever consulted.
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ATTACHMENT_FILENAME_MAX_LENGTH = 255;

/**
 * Stricter than `safeTextSchema`, which tolerates newline and tab because
 * message bodies are multi-line. A filename is not prose: it is echoed into a
 * `Content-Disposition` header on the presigned read, where a CR or LF is
 * header injection.
 */
// eslint-disable-next-line no-control-regex
const FILENAME_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * `\` is a path separator on Windows *and* the escape character inside a
 * quoted `Content-Disposition` filename, so rejecting it closes both doors at
 * once. The storage key is generated server-side and never derived from this
 * value, so a filename is display text and nothing else — this check exists so
 * it can never become anything else by accident.
 */
const FILENAME_PATH_SEPARATORS = /[/\\]/;

export const attachmentFilenameSchema = z
  .string()
  .min(1)
  .max(ATTACHMENT_FILENAME_MAX_LENGTH)
  .refine((value) => !FILENAME_CONTROL_CHARS.test(value), "Invalid filename")
  .refine((value) => !FILENAME_PATH_SEPARATORS.test(value), "Invalid filename");

/**
 * Ceiling for a declared image dimension. Well past any camera or screenshot,
 * and far short of what an `INTEGER` column or a layout calculation can be
 * pushed into by a client that decides to send 2^31 - 1.
 */
export const ATTACHMENT_MAX_DIMENSION = 65535;

const attachmentDimensionSchema = z
  .number()
  .int()
  .positive()
  .max(ATTACHMENT_MAX_DIMENSION);

// ------------------------------------------------------------- voice notes

/**
 * A voice note is an attachment with a `voice` block: ordinary bytes in the
 * bucket, plus what the playback card needs before it fetches them (the
 * duration and a waveform). It is a sibling slot rather than a "kind" enum, so
 * a later `video` block sits next to it without renaming anything.
 *
 * The containers a recorder may upload, bare (no `;codecs=`): the claim HEAD
 * compares the stored type to the signed one exactly, so a parameterised type
 * would never verify.
 */
export const VOICE_NOTE_CONTENT_TYPES = [
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
] as const satisfies readonly AttachmentContentType[];

export function isVoiceNoteContentType(contentType: string): boolean {
  return (VOICE_NOTE_CONTENT_TYPES as readonly string[]).includes(contentType);
}

/** Shorter than this is a tap on the mic, not a message. */
export const VOICE_NOTE_MIN_DURATION_MS = 300;
/** Five minutes, the recorder's hard stop. */
export const VOICE_NOTE_MAX_DURATION_MS = 5 * 60 * 1000;
/** Peaks the recorder samples, one byte each, before base64. */
export const VOICE_NOTE_WAVEFORM_PEAKS = 64;
/** The waveform as it travels: base64 text, never longer than this. */
export const VOICE_NOTE_WAVEFORM_MAX_LENGTH = 128;

/**
 * The bytes a recorded note of this length may take, checked at mint. 16 KiB
 * a second is 128 kbps, twice the 64 kbps the recorder targets, and the 32 KiB
 * on top covers the container headers of a very short clip. A client that
 * claims two seconds and uploads ten megabytes is refused before anything is
 * signed. Shared so a recorder can stop itself before the server would refuse.
 */
export function noteByteBudget(durationMs: number): number {
  return 16 * 1024 * Math.ceil(durationMs / 1000) + 32 * 1024;
}

/** `0:12`, `4:05`. Whole seconds, never below one. */
export function formatNoteDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Exactly `VOICE_NOTE_WAVEFORM_PEAKS` bytes, base64: 64 bytes are 88
 * characters, the last two `==`. Anything else is not the waveform the card
 * draws. The column allows up to `VOICE_NOTE_WAVEFORM_MAX_LENGTH`, so a later
 * format can widen this without a migration.
 */
const WAVEFORM_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

export const voiceNoteWaveformSchema = z
  .string()
  .max(VOICE_NOTE_WAVEFORM_MAX_LENGTH)
  .regex(WAVEFORM_BASE64, `Waveform must be ${VOICE_NOTE_WAVEFORM_PEAKS} peaks, base64`);

/** The `voice` block of a mint request. The client's word, bounded. */
export const createVoiceNoteSchema = z.object({
  durationMs: z
    .number()
    .int()
    .min(VOICE_NOTE_MIN_DURATION_MS)
    .max(VOICE_NOTE_MAX_DURATION_MS),
  waveform: voiceNoteWaveformSchema,
});

export type CreateVoiceNote = z.infer<typeof createVoiceNoteSchema>;

/**
 * Transcript state, reserved for the transcription work. `none` means nobody
 * asked yet; `unavailable` means the deployment has no speech provider.
 */
export const noteTranscriptStatusSchema = z.enum([
  "none",
  "pending",
  "done",
  "no_speech",
  "failed",
  "unavailable",
]);

export type NoteTranscriptStatus = z.infer<typeof noteTranscriptStatusSchema>;

/** Longest transcript stored or sent, in characters. */
export const VOICE_NOTE_TRANSCRIPT_MAX_LENGTH = 4000;

/**
 * A note's transcript as it travels: on the `voice` block, on the
 * `voice-note-transcript` frame and as the answer to
 * `POST /api/attachments/:id/transcript`. `text` is set only when `status` is
 * `done`. Absent from a read when the `voice_note_transcription` flag is off
 * where the note lives, even if a transcript is stored.
 */
export const voiceNoteTranscriptSchema = z.object({
  status: noteTranscriptStatusSchema,
  text: z.string().max(VOICE_NOTE_TRANSCRIPT_MAX_LENGTH).nullable().optional(),
  language: z.string().nullable().optional(),
});

export type VoiceNoteTranscript = z.infer<typeof voiceNoteTranscriptSchema>;

/**
 * Receipts are shown only in a conversation this small. Past it, "ouviu" is a
 * roll call and the author would be reading a crowd, so the server neither
 * sends the list nor the frame that would grow it. `DM_MAX_PARTICIPANTS` is
 * the same number today; this is its own name because the rule is about what
 * is shown, and a group DM may one day be allowed to grow past it.
 */
export const VOICE_NOTE_RECEIPTS_MAX_PARTICIPANTS = 10;

/** One person who has played a note, as the author's copy lists them. */
export const voiceNoteListenSchema = z.object({
  userId: z.string().uuid(),
  /** ISO 8601, the first time that person played it. */
  listenedAt: z.string(),
});

export type VoiceNoteListen = z.infer<typeof voiceNoteListenSchema>;

/**
 * The `voice` block on a stored attachment. `durationMs` is what the card
 * shows. `listenedByMe` is per viewer and absent where nothing knows the
 * viewer (a live broadcast reaches everyone with one copy): read it as "not
 * yet", never as a reset. `listenedBy` is on the AUTHOR's copy only, in a
 * conversation of at most `VOICE_NOTE_RECEIPTS_MAX_PARTICIPANTS`; absent
 * anywhere else, and `[]` there means nobody has played it yet. `transcript`
 * is filled by later work and optional until then, so a reader written now
 * keeps parsing.
 */
export const voiceNoteSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  waveform: z.string(),
  listenedByMe: z.boolean().optional(),
  /** Who has played it, with when. Only in a conversation small enough to show receipts. */
  listenedBy: z.array(voiceNoteListenSchema).optional(),
  transcript: voiceNoteTranscriptSchema.optional(),
  /**
   * A presigned GET for an AAC-in-MP4 copy (`audio/mp4`), present once the
   * worker has made one. Only an Opus note (`audio/webm`, `audio/ogg`) ever
   * gets one; a player that cannot play the original prefers this. The
   * `voice-note-updated` frame is what says it now exists.
   */
  playbackUrl: z.string().url().optional(),
});

export type VoiceNote = z.infer<typeof voiceNoteSchema>;

/**
 * Somebody played a voice note for the first time. Addressed per person, like
 * `friend-activity`, so it is out of `CHAT_SERVER_MESSAGE_TYPES` and never goes
 * through the channel relay: it reaches the listener's own sockets (so the dot
 * on their other devices clears) and, in a conversation small enough to show
 * receipts, the author's. In a server channel the author gets nothing.
 *
 * Sent once, on the first play. Repeats are not a second frame.
 */
export const voiceNoteListenedSchema = z.object({
  type: z.literal("voice-note-listened"),
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  attachmentId: z.string().uuid(),
  userId: z.string().uuid(),
  listenedAt: z.string(),
});

export type VoiceNoteListened = z.infer<typeof voiceNoteListenedSchema>;

/**
 * Body of `POST /api/channels/:channelId/attachments`, sent before a single
 * byte is uploaded.
 *
 * `byteSize` is signed into the presigned PUT, so the bucket rejects a body of
 * any other length — but it is still the client's number, and the size the
 * database records is the one read back with a HEAD at claim time.
 *
 * `width` / `height` are display-only hints with the same trust posture: they
 * exist so the message can reserve the right box before the image loads, and a
 * client that lies about them mis-sizes its own placeholder and nothing else.
 * Bounded rather than trusted, because "nothing else" stops being true once a
 * number is absurd enough to be a layout weapon.
 */
// Written `= z.object({` on one line on purpose: the Android contract test
// (`AttachmentContractTest`) reads this schema's keys off the source.
export const createAttachmentSchema = z.object({
  filename: attachmentFilenameSchema,
  contentType: attachmentContentTypeSchema,
  byteSize: z.number().int().positive().max(DEFAULT_MAX_ATTACHMENT_BYTES),
  width: attachmentDimensionSchema.nullish(),
  height: attachmentDimensionSchema.nullish(),
  /**
   * Present only for a voice note. The server also checks the runtime flag
   * and the byte budget for this duration (`noteByteBudget`).
   */
  voice: createVoiceNoteSchema.optional(),
}).refine((value) => !value.voice || isVoiceNoteContentType(value.contentType), {
  message: "A voice note must be audio/mp4, audio/webm or audio/ogg",
  path: ["contentType"],
});

export type CreateAttachmentRequest = z.infer<typeof createAttachmentSchema>;

export const createAttachmentResponseSchema = z.object({
  attachmentId: z.string().uuid(),
  /** Presigned PUT. The upload must send exactly the signed `Content-Type`. */
  uploadUrl: z.string().url(),
  expiresAt: z.string(),
});

export type CreateAttachmentResponse = z.infer<
  typeof createAttachmentResponseSchema
>;

/**
 * A stored attachment as it travels with a message.
 *
 * `contentType` is a plain string here rather than the allowlist enum: it is
 * whatever the object store reported at claim time, and a row written under an
 * older or newer allowlist must still parse. Nothing downstream trusts it —
 * `isImageContentType` fails closed, and the server sends anything that is not
 * an inline image as a download.
 *
 * `url` is minted per read and expires, which is why it is not stored anywhere.
 */
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** Set only for images whose dimensions could be read; null otherwise. */
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Presigned GET, valid for `ATTACHMENT_URL_TTL_SECONDS`. */
  url: z.string().url(),
  /** Set only on a voice note. Absent on every other attachment. */
  voice: voiceNoteSchema.optional(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * Response of `GET /api/attachments/:attachmentId/url`, which a client calls
 * when an `<img>` fails — the tab has outlived the presigned URL baked into
 * the message it is rendering.
 */
export const attachmentUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
  /** A voice note's playable copy, when it has one. See `voiceNoteSchema`. */
  playbackUrl: z.string().url().optional(),
});

export type AttachmentUrlResponse = z.infer<typeof attachmentUrlResponseSchema>;

/**
 * Answer of `POST /api/attachments/:attachmentId/transcript`: 202 while the
 * job is queued or running (`status: "pending"`), 200 once the note has a
 * settled answer, which is kept for everybody who can hear the note.
 */
export const voiceNoteTranscriptResponseSchema = z.object({
  transcript: voiceNoteTranscriptSchema,
});

export type VoiceNoteTranscriptResponse = z.infer<
  typeof voiceNoteTranscriptResponseSchema
>;

/**
 * Types the client may put in an `<img>`.
 *
 * Enumerated rather than tested with a `image/` prefix, because the prefix
 * would also match `image/svg+xml` — a document that runs script in our origin.
 * Widening `ATTACHMENT_MIME_ALLOWLIST` must never silently widen what renders
 * inline, so the two lists are deliberately separate.
 */
const INLINE_IMAGE_CONTENT_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
];

/** True when an attachment renders inline; false means a download chip. */
/**
 * Media that renders as an inline player rather than a download chip. Split
 * from images because the render contract differs: an image is fetched on
 * sight, while video and audio render a player with `preload="none"` and cost
 * nothing until somebody presses play — on purpose, so a channel full of
 * clips does not download every clip to every reader.
 */
export function isVideoContentType(contentType: string): boolean {
  return contentType.trim().toLowerCase().startsWith("video/");
}

export function isAudioContentType(contentType: string): boolean {
  return contentType.trim().toLowerCase().startsWith("audio/");
}

export function isImageContentType(contentType: string): boolean {
  return INLINE_IMAGE_CONTENT_TYPES.includes(contentType.trim().toLowerCase());
}
