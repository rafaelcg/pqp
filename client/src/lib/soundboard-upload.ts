import {
  audioDurationMs,
  soundboardClipRejection,
  soundboardNameProblem,
  SOUNDBOARD_MAX_BYTES,
  SOUNDBOARD_MAX_DURATION_MS,
} from "@pqp/shared";
import {
  ApiError,
  claimSoundboardSound,
  createSoundboardUpload,
  updateSoundboardSound,
  type SoundboardSoundDto,
} from "@/lib/api";

export type SoundboardFileError = "type" | "too_big" | "too_long" | "unreadable";

/** Why a clip name was refused, as the locale key that says so. Null: fine. */
export function soundboardNameErrorKey(
  name: string,
): "soundboard.error.name" | "soundboard.error.nameHidden" | null {
  const problem = soundboardNameProblem(name.trim());
  if (problem === "length") {
    return "soundboard.error.name";
  }
  return problem === "hidden" ? "soundboard.error.nameHidden" : null;
}

/**
 * The locale key for a failed mint, upload, claim or edit. The server answers
 * with a short code as the message; a 400 "Invalid request" is its schema
 * refusing the name (the other fields are not the person's to get wrong).
 */
export function soundboardErrorKey(
  err: unknown,
):
  | "soundboard.error.type"
  | "soundboard.error.tooBig"
  | "soundboard.error.tooLong"
  | "soundboard.error.unreadable"
  | "soundboard.error.slots"
  | "soundboard.error.storage"
  | "soundboard.error.nameRejected"
  | "soundboard.error.disabled" {
  if (err instanceof ApiError) {
    switch (err.message) {
      case "type":
        return "soundboard.error.type";
      case "too_big":
        return "soundboard.error.tooBig";
      case "too_long":
        return "soundboard.error.tooLong";
      case "unreadable":
        return "soundboard.error.unreadable";
      case "slots":
        return "soundboard.error.slots";
      case "soundboard_disabled":
        return "soundboard.error.disabled";
      case "Invalid request":
        return "soundboard.error.nameRejected";
    }
  }
  return "soundboard.error.storage";
}

/** What the first bytes say: ogg, mp3, a known other format, or no idea. */
function sniffContainer(bytes: Uint8Array): "audio/ogg" | "audio/mpeg" | "other" | null {
  const ascii = (at: number, text: string) =>
    [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
  if (ascii(0, "OggS")) {
    return "audio/ogg";
  }
  if (ascii(0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  // WAV, AIFF, FLAC, MP4 / m4a, WebM / Matroska.
  if (
    ascii(0, "RIFF") ||
    ascii(0, "FORM") ||
    ascii(0, "fLaC") ||
    ascii(4, "ftyp") ||
    (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
  ) {
    return "other";
  }
  return null;
}

export function soundboardContentType(file: File): "audio/mpeg" | "audio/ogg" | null {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  if (type === "audio/mpeg" || type === "audio/mp3" || name.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  if (type === "audio/ogg" || name.endsWith(".ogg")) {
    return "audio/ogg";
  }
  return null;
}

/** Reject before the bytes leave the machine. The server checks again. */
export async function inspectSoundboardFile(
  file: File,
): Promise<{ contentType: "audio/mpeg" | "audio/ogg" } | SoundboardFileError> {
  const named = soundboardContentType(file);
  if (!named) {
    return "type";
  }
  if (file.size <= 0) {
    return "unreadable";
  }
  if (file.size > SOUNDBOARD_MAX_BYTES) {
    return "too_big";
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // The bytes, not the name, say what the file is: an mp3 renamed .ogg is
  // still a good mp3, and a WAV renamed .mp3 is the wrong format, not a
  // broken file.
  const sniffed = sniffContainer(bytes);
  if (sniffed === "other") {
    return "type";
  }
  const contentType = sniffed ?? named;
  const durationMs = audioDurationMs(bytes, contentType);
  const rejection = soundboardClipRejection(
    file.size,
    durationMs,
    SOUNDBOARD_MAX_BYTES,
    SOUNDBOARD_MAX_DURATION_MS,
  );
  if (rejection === "too_big" || rejection === "too_long" || rejection === "unreadable") {
    return rejection;
  }
  return { contentType };
}

/**
 * The clip was added, but the name or emoji typed before a retry could not be
 * applied to it. The board has the clip, so the caller shows it rather than
 * treating the save as nothing added.
 */
export class SoundboardRenameError extends Error {
  constructor(
    readonly sound: SoundboardSoundDto,
    readonly cause: unknown,
  ) {
    super("rename");
  }
}

export async function uploadSoundboardFile(input: {
  serverId: string;
  file: File;
  contentType: "audio/mpeg" | "audio/ogg";
  name: string;
  emoji: string;
  volume?: number;
  /**
   * Aborting stops the file transfer and keeps the claim from being sent.
   * A claim already on the wire cannot be recalled.
   */
  signal?: AbortSignal;
  /**
   * The key of this same file, already stored by an earlier attempt whose
   * claim never answered. Claimed again instead of storing a second copy:
   * the claim is idempotent by key, a new upload is not.
   */
  uploadedKey?: string;
  /**
   * Called with the key a retry should reuse once the bytes are stored, and
   * with null once the server refused the claim, so a retry starts over.
   */
  onUploaded?: (key: string | null) => void;
}): Promise<SoundboardSoundDto> {
  let key = input.uploadedKey;
  if (!key) {
    const minted = await createSoundboardUpload(input.serverId, {
      contentType: input.contentType,
      byteSize: input.file.size,
    });
    input.signal?.throwIfAborted();
    const response = await fetch(minted.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": input.contentType },
      body: input.file,
      signal: input.signal,
    });
    if (!response.ok) {
      throw new Error("storage");
    }
    key = minted.key;
    input.onUploaded?.(key);
  }
  input.signal?.throwIfAborted();
  // A claim is idempotent by key, so a lost response is retried with the SAME
  // key rather than minting a second upload that would claim a duplicate.
  const claim = () =>
    claimSoundboardSound(input.serverId, {
      key,
      name: input.name,
      emoji: input.emoji,
      volume: input.volume,
    });
  const refused = (error: unknown) =>
    error instanceof ApiError && error.status >= 400 && error.status < 500;
  let sound: SoundboardSoundDto;
  try {
    try {
      sound = (await claim()).sound;
    } catch (error) {
      // A 4xx is the server's final answer (bad name, full board, flag off);
      // asking again with the same key only gets it twice.
      if (refused(error)) {
        throw error;
      }
      input.signal?.throwIfAborted();
      sound = (await claim()).sound;
    }
  } catch (error) {
    if (refused(error)) {
      input.onUploaded?.(null);
    }
    throw error;
  }
  // A repeated claim answers with the clip as the first claim made it, so a
  // name corrected before the retry is applied here. A failure keeps the key:
  // the clip exists, and the next retry renames it rather than adding another.
  if (sound.name !== input.name || sound.emoji !== input.emoji) {
    try {
      sound = (
        await updateSoundboardSound(input.serverId, sound.id, {
          name: input.name,
          emoji: input.emoji,
        })
      ).sound;
    } catch (error) {
      throw new SoundboardRenameError(sound, error);
    }
  }
  return sound;
}
