import { z } from "zod";

/**
 * A server soundboard.
 *
 * The clip never enters the call. A seated member sends `soundboard-play`,
 * the server checks the seat and fans the same frame out, and every client
 * plays a file it already cached. Mesh and LiveKit both already have the
 * socket. A second audio track would renegotiate every mesh peer and fight
 * the LiveKit publish allowlist.
 *
 * Built-in clips are a fixed set in this file, shipped with the client.
 * Custom clips are rows on the server, capped, and staff-uploaded.
 * Play clicks are not stored. A missed frame is gone.
 */

/** Discord's ceiling. Longer than this is a song, not a reaction. */
export const SOUNDBOARD_MAX_BYTES = 512 * 1024;

/** 5.2 seconds, same line Discord draws. */
export const SOUNDBOARD_MAX_DURATION_MS = 5200;

/** Custom clips per server. No boost ladder. */
export const SOUNDBOARD_MAX_SOUNDS = 24;

/** How many clips may be sounding in one room at once. High enough to mash the board. */
export const SOUNDBOARD_ROOM_CONCURRENCY = 12;

export const SOUNDBOARD_NAME_MIN = 2;
export const SOUNDBOARD_NAME_MAX = 24;

export const SOUNDBOARD_CONTENT_TYPES = ["audio/mpeg", "audio/ogg"] as const;

export type SoundboardContentType = (typeof SOUNDBOARD_CONTENT_TYPES)[number];

export const soundboardContentTypeSchema = z.enum(SOUNDBOARD_CONTENT_TYPES);

/**
 * Recorded reaction clips in `client/public/sounds/soundboard/`.
 * CC0 or public domain. Trimmed under `SOUNDBOARD_MAX_DURATION_MS`.
 * Sources are listed in `docs/SOUNDBOARD.md`.
 * The id is the wire value. The file name is what the client fetches.
 * Duration is what the server holds the slot for. A person can overlap
 * their own clips. The room cap is the only limit.
 */
export const SOUNDBOARD_BUILTINS = [
  { id: "builtin:palmas", emoji: "👏", file: "palmas.wav", durationMs: 4400 },
  { id: "builtin:risada", emoji: "😄", file: "risada.wav", durationMs: 2200 },
  { id: "builtin:buzina", emoji: "📣", file: "buzina.wav", durationMs: 3100 },
  { id: "builtin:grilo", emoji: "🦗", file: "grilo.wav", durationMs: 2408 },
  { id: "builtin:ba-dum-tss", emoji: "🥁", file: "ba-dum-tss.wav", durationMs: 3100 },
  { id: "builtin:trombone", emoji: "🎺", file: "trombone.wav", durationMs: 4600 },
] as const;

export type SoundboardBuiltinId = (typeof SOUNDBOARD_BUILTINS)[number]["id"];

const builtinById = new Map(
  SOUNDBOARD_BUILTINS.map((sound) => [sound.id, sound]),
);

export function soundboardBuiltin(
  id: string,
): (typeof SOUNDBOARD_BUILTINS)[number] | null {
  return builtinById.get(id as SoundboardBuiltinId) ?? null;
}

export function isSoundboardBuiltinId(id: string): id is SoundboardBuiltinId {
  return builtinById.has(id as SoundboardBuiltinId);
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSoundboardSoundId(id: string): boolean {
  return isSoundboardBuiltinId(id) || UUID.test(id);
}

export const soundboardSoundIdSchema = z
  .string()
  .refine(isSoundboardSoundId, "Unknown sound");

/** One emoji, not a sentence. ZWJ sequences count as one grapheme. */
export function isSoundboardEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 32 || /\s/.test(trimmed)) {
    return false;
  }
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const parts = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        trimmed,
      ),
    ];
    return parts.length === 1;
  }
  return [...trimmed].length <= 8;
}

export const soundboardEmojiSchema = z
  .string()
  .trim()
  .refine(isSoundboardEmoji, "Pick one emoji");

/**
 * Zero-width spaces, word joiners, the byte-order mark and every bidi
 * override or isolate. They make a name blank or render it as other text.
 * The emoji joiner (U+200D) and variation selectors are allowed.
 */
const HIDDEN_NAME_CHARS = /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

/**
 * A clip name, counted the way Postgres's `char_length` counts it (code
 * points, not UTF-16 units), so the database check never sees a name this
 * passed. "🎺" is one character here and there; "🎺🎺" is two.
 */
export function soundboardNameProblem(name: string): "length" | "hidden" | null {
  const length = [...name].length;
  if (length < SOUNDBOARD_NAME_MIN || length > SOUNDBOARD_NAME_MAX) {
    return "length";
  }
  if (HIDDEN_NAME_CHARS.test(name) || !/[\p{L}\p{N}\p{S}\p{P}]/u.test(name)) {
    return "hidden";
  }
  return null;
}

export const soundboardNameSchema = z
  .string()
  .trim()
  .refine((name) => soundboardNameProblem(name) === null, "Invalid name");

export const soundboardVolumeSchema = z.number().min(0).max(1);

/** Client to server. `channelId` is checked against the seat, not trusted. */
export const soundboardPlayMessageSchema = z.object({
  type: z.literal("soundboard-play"),
  channelId: z.string().uuid(),
  soundId: soundboardSoundIdSchema,
});

export type SoundboardPlayMessage = z.infer<typeof soundboardPlayMessageSchema>;

/**
 * Server to the room. `playedAt` is the server clock. A client that is
 * deafened still draws the float and does not play the file.
 */
export const soundboardPlayedMessageSchema = z.object({
  type: z.literal("soundboard-play"),
  channelId: z.string().uuid(),
  soundId: soundboardSoundIdSchema,
  userId: z.string().uuid(),
  displayName: z.string().min(1).max(64),
  emoji: z.string().min(1).max(32),
  playedAt: z.number().int().nonnegative(),
});

export type SoundboardPlayedMessage = z.infer<
  typeof soundboardPlayedMessageSchema
>;

export const soundboardSoundSchema = z.object({
  id: z.string().uuid(),
  name: soundboardNameSchema,
  emoji: soundboardEmojiSchema,
  contentType: soundboardContentTypeSchema,
  byteSize: z.number().int().positive().max(SOUNDBOARD_MAX_BYTES),
  durationMs: z.number().int().positive().max(SOUNDBOARD_MAX_DURATION_MS),
  volume: soundboardVolumeSchema,
  /** Presigned read. Absent when storage cannot sign one. */
  url: z.string().min(1).nullable(),
});

export type SoundboardSound = z.infer<typeof soundboardSoundSchema>;

export const createSoundboardUploadSchema = z.object({
  contentType: soundboardContentTypeSchema,
  byteSize: z.number().int().positive().max(SOUNDBOARD_MAX_BYTES),
});

export const claimSoundboardSoundSchema = z.object({
  key: z.string().min(1).max(512),
  name: soundboardNameSchema,
  emoji: soundboardEmojiSchema,
  volume: soundboardVolumeSchema.optional(),
});

export const updateSoundboardSoundSchema = z
  .object({
    name: soundboardNameSchema.optional(),
    emoji: soundboardEmojiSchema.optional(),
    volume: soundboardVolumeSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.emoji !== undefined ||
      body.volume !== undefined,
    "Nothing to change",
  );
