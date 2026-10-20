import { getPool } from "../db.js";
import { presignGet } from "../lib/s3.js";
import { isTranscriptionOnFor } from "./attachments.js";
import type { BotImage } from "./bot-llm.js";

/**
 * What a server bot takes in besides text: the images in the conversation and
 * the transcripts of its voice notes. Code: `bot-runner.ts` (the transcript)
 * and `bot-actions.ts` (`read_channel`). Plan: `docs/plans/CUSTOM_BOTS.md`.
 */

/** Images sent with one request. Each costs input tokens on every model turn. */
export const BOT_IMAGES_PER_REQUEST = 2;

/** The image types every provider takes. Anything else is described, not shown. */
const IMAGE_TYPES = new Set<BotImage["mediaType"]>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Anthropic refuses an image over 5 MB once base64 encoded; this keeps under it. */
const IMAGE_MAX_BYTES = 3_700_000;

const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/** How long, from its creation, a run waits for the transcript of a voice note it was called with. */
export const TRANSCRIPT_WAIT_MS = 20_000;

/** How often a waiting run looks again. */
export const TRANSCRIPT_RECHECK_MS = 2_000;

export interface VoiceNoteMedia {
  durationMs: number;
  /** Null when there is none, or it may not be shown (flag off, sender declined). */
  text: string | null;
}

export interface ImageCandidate {
  attachmentId: string;
  storageKey: string;
  mediaType: BotImage["mediaType"];
  width: number | null;
  height: number | null;
}

export interface MessageMedia {
  voiceNotes: VoiceNoteMedia[];
  /** Images the bot may be shown. */
  images: ImageCandidate[];
  /** Images it may not be shown (a GIF link, a flagged scan, too big) and other files. */
  hiddenImages: number;
  files: number;
}

/**
 * The attachments of these messages, sorted into what a bot may take in.
 * A flagged image (visible, but reported by the scanner) is never sent to a
 * model provider, and a GIF on somebody else's host is never fetched.
 */
export async function loadMessageMedia(
  messageIds: string[],
  serverId: string,
): Promise<Map<string, MessageMedia>> {
  const byMessage = new Map<string, MessageMedia>();
  if (messageIds.length === 0) {
    return byMessage;
  }
  const rows = await getPool().query<{
    id: string;
    message_id: string;
    storage_key: string | null;
    content_type: string;
    byte_size: string;
    width: number | null;
    height: number | null;
    scan_status: string;
    duration_ms: number | null;
    transcribe_allowed: boolean | null;
    transcript_status: string | null;
    transcript_text: string | null;
  }>(
    `SELECT a.id, a.message_id, a.storage_key, a.content_type, a.byte_size, a.width, a.height,
            a.scan_status, v.duration_ms, v.transcribe_allowed, v.transcript_status, v.transcript_text
       FROM message_attachments a
       LEFT JOIN message_attachment_voice v ON v.attachment_id = a.id
      WHERE a.message_id = ANY($1::uuid[])
      ORDER BY a.position ASC, a.created_at ASC, a.id ASC`,
    [messageIds],
  );
  const transcriptsShown = isTranscriptionOnFor(serverId);
  for (const row of rows.rows) {
    const media = byMessage.get(row.message_id) ?? { voiceNotes: [], images: [], hiddenImages: 0, files: 0 };
    byMessage.set(row.message_id, media);
    if (row.duration_ms !== null) {
      media.voiceNotes.push({
        durationMs: row.duration_ms,
        text:
          transcriptsShown && row.transcribe_allowed !== false && row.transcript_status === "done"
            ? (row.transcript_text ?? "").trim() || null
            : null,
      });
      continue;
    }
    const type = row.content_type.trim().toLowerCase() as BotImage["mediaType"];
    if (!row.content_type.toLowerCase().startsWith("image/")) {
      media.files += 1;
    } else if (
      IMAGE_TYPES.has(type) &&
      row.storage_key &&
      row.scan_status !== "flagged" &&
      Number(row.byte_size) <= IMAGE_MAX_BYTES
    ) {
      media.images.push({
        attachmentId: row.id,
        storageKey: row.storage_key,
        mediaType: type,
        width: row.width,
        height: row.height,
      });
    } else {
      media.hiddenImages += 1;
    }
  }
  return byMessage;
}

/** The questions of the polls among these messages, by message. */
export async function loadPollQuestions(messageIds: string[]): Promise<Map<string, string>> {
  if (messageIds.length === 0) {
    return new Map();
  }
  const rows = await getPool().query<{ message_id: string; question: string }>(
    `SELECT message_id, question FROM polls WHERE message_id = ANY($1::uuid[])`,
    [messageIds],
  );
  return new Map(rows.rows.map((row) => [row.message_id, row.question]));
}

/**
 * The images to show, at most `BOT_IMAGES_PER_REQUEST`: those in the messages
 * named first (the one that called the bot, then the one it replies to), then
 * the newest in the conversation.
 */
export function pickImages(
  media: Map<string, MessageMedia>,
  first: Array<string | null>,
  newestFirst: string[],
): ImageCandidate[] {
  const picked: ImageCandidate[] = [];
  const seen = new Set<string>();
  for (const messageId of [...first, ...newestFirst]) {
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    for (const image of media.get(messageId)?.images ?? []) {
      if (picked.length >= BOT_IMAGES_PER_REQUEST) return picked;
      picked.push(image);
    }
  }
  return picked;
}

/**
 * What a message carried, as text after its body: `[voice note, 12s: "…"]`,
 * `[image 1]` for an image the model is shown, `[image, not shown]` otherwise.
 */
export function describeMedia(
  media: MessageMedia | undefined,
  options: { hearVoice: boolean; imageNumbers: Map<string, number> },
): string {
  if (!media) return "";
  const parts: string[] = [];
  for (const note of media.voiceNotes) {
    const seconds = Math.max(1, Math.round(note.durationMs / 1000));
    parts.push(
      options.hearVoice && note.text
        ? `[voice note, ${seconds}s, transcribed: "${note.text.replace(/\s+/g, " ").slice(0, 1500)}"]`
        : `[voice note, ${seconds}s, not transcribed]`,
    );
  }
  for (const image of media.images) {
    const number = options.imageNumbers.get(image.attachmentId);
    parts.push(number ? `[image ${number}]` : "[image, not shown]");
  }
  for (let i = 0; i < media.hiddenImages; i += 1) parts.push("[image, not shown]");
  if (media.files > 0) parts.push(media.files === 1 ? "[a file]" : `[${media.files} files]`);
  return parts.join(" ");
}

type ImageLoader = (candidate: ImageCandidate) => Promise<BotImage | null>;
let imageLoaderForTests: ImageLoader | null = null;

/** Tests hand images over here instead of fetching them from storage. */
export function setBotImageLoaderForTests(loader: ImageLoader | null): void {
  imageLoaderForTests = loader;
}

/**
 * The bytes of the picked images, base64. Fetched here and sent as data, never
 * as a link: a presigned URL handed to a provider is a working key to a private
 * object, and a local bucket is not reachable from outside anyway. An image
 * that cannot be fetched is dropped and its number goes with it.
 */
export async function fetchImages(
  candidates: ImageCandidate[],
): Promise<Array<{ candidate: ImageCandidate; image: BotImage }>> {
  const loaded = await Promise.all(
    candidates.map(async (candidate) => {
      const image = await (imageLoaderForTests ?? loadFromStorage)(candidate).catch(() => null);
      return image ? { candidate, image } : null;
    }),
  );
  return loaded.filter((entry): entry is { candidate: ImageCandidate; image: BotImage } => entry !== null);
}

async function loadFromStorage(candidate: ImageCandidate): Promise<BotImage | null> {
  const url = presignGet(candidate.storageKey, { ttlSeconds: 60 });
  const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    return null;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) {
    return null;
  }
  return { mediaType: candidate.mediaType, data: bytes.toString("base64") };
}

/**
 * Input tokens an image costs, for the spend estimate: about width × height /
 * 750, after the provider shrinks the long edge to 1568. Unknown size bills
 * as the largest.
 */
export function imageTokenEstimate(width: number | null, height: number | null): number {
  const LARGEST = 1600;
  if (!width || !height) return LARGEST;
  const scale = Math.min(1, 1568 / Math.max(width, height));
  return Math.min(LARGEST, Math.ceil((width * scale * height * scale) / 750));
}

/**
 * Whether a voice note in these messages (the one that called the bot, and the
 * one it replies to) still has a transcript coming. A note nobody asked about
 * yet is asked for here, as the bot, through the same request a member's tap
 * makes: the flag, the sender's consent and the daily speech budget all apply,
 * and a refusal just means there will be no transcript.
 */
export async function transcriptsPending(
  messageIds: Array<string | null>,
  botUserId: string,
): Promise<boolean> {
  const ids = messageIds.filter((id): id is string => !!id);
  if (ids.length === 0) {
    return false;
  }
  const notes = await getPool().query<{ id: string; transcript_status: string }>(
    `SELECT a.id, v.transcript_status
       FROM message_attachments a
       JOIN message_attachment_voice v ON v.attachment_id = a.id
      WHERE a.message_id = ANY($1::uuid[]) AND v.transcribe_allowed`,
    [ids],
  );
  let pending = false;
  for (const note of notes.rows) {
    if (note.transcript_status === "pending") {
      pending = true;
    } else if (note.transcript_status === "none") {
      const { requestVoiceNoteTranscript } = await import("./voice-transcription.js");
      const asked = await requestVoiceNoteTranscript(note.id, botUserId).catch(() => null);
      if (asked?.transcript.status === "pending") {
        pending = true;
      }
    }
  }
  return pending;
}
