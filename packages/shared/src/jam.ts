import { z } from "zod";

/**
 * Jam channels: the wire contract. Server: `server/src/services/jam.ts` and
 * `server/src/api/jam-routes.ts`. Operator doc: `docs/JAM.md`. The client audio
 * engine, the recorder and every screen are built against THIS file.
 *
 * THE MODEL, STATED ONCE
 *
 * A jam is a channel (`type = 'jam'`) that holds SONGS instead of messages. A
 * song is a post: a title, an optional artist, and a pile of TRACKS. A track is
 * one recorded stem, one instrument, one person, optionally with a video of
 * them playing it. A client plays every track that is `inMix` in sync, the
 * mix, and lets a person add theirs on top. A jam channel never carries a
 * message (a send into one is refused `no-access`, the forum's rule).
 *
 * Nothing is mixed on the server. Every track is its own object in the bucket;
 * the engine in the client decodes them, places each one on the timeline and
 * sums them. The server's whole job is to keep the pieces, say who may add one,
 * and tell the room when something moved.
 *
 * Storage. Rows live in `jam_songs`, `jam_tracks`, `jam_track_votes`,
 * `jam_uploads` and `jam_song_covers` (`server/src/schema.sql`, "jam
 * channels"). Nothing is added to `channels` beyond the `'jam'` entry in its
 * type CHECK (CLAUDE.md pitfall 22).
 * The audio and video bytes do NOT go through the message attachment path: a
 * stem is longer and bigger than a message attachment may be (10 MiB cap, no
 * duration), and an attachment is tied to a message, which a jam does not have.
 * They use the same object store and the same presigned PUT / GET, with their
 * own limits below and their own ledger, `jam_uploads`, the way the Baú's media
 * does. The bytes never pass through the API.
 *
 * PRIVACY. There is no private state on a song: a song is exactly as private as
 * its channel. Whoever can see the channel (`canAccessChannel`, which resolves
 * private channels and overwrites) can read every song, every track and every
 * media URL in it. Deleting a channel, a server or an account deletes the
 * objects as well (the author's tracks go with the account).
 *
 * A SONG WITH NO TRACK IS ITS AUTHOR'S ALONE. A song is created first and its
 * first take uploaded after, so for a while (a page closed mid-upload, a take
 * that never finished, the last track deleted by somebody who is not the
 * song's author) a song has `trackCount: 0`. The list and the detail leave such
 * a song out for everybody but its author (404 on the detail), and its
 * `jam-song-created` / `jam-song-updated` frames are not sent: the first track
 * announces the song to the room (`jam-track-added` carries the whole summary,
 * and a client applies it by id, so it is the song appearing). A song nobody
 * put a track in for 24 hours is deleted by the sweep. Deleting the LAST track
 * as the song's author or a moderator deletes the song (`jam-song-deleted`,
 * not `jam-track-deleted`). Anybody else's last take leaves the song empty and
 * its author's alone, and is announced as `jam-song-deleted` too (a
 * `jam-track-deleted` would hand the room a summary the list hides): the author's
 * wall reads the song again on its next ask. `DELETE /api/jam-songs/:id?ifEmpty=true`
 * is the studio cleaning up a song it made and never filled; it answers 409
 * `jam_song_not_empty` when a take is in it. This adds behaviour and one optional
 * query parameter, no field: no client has to change to keep parsing.
 *
 * -------------------------------------------------------------------------
 * THE TIMELINE (what `offsetMs`, `trimStartMs`, `trimEndMs` and `durationMs` mean)
 *
 * A song has no length of its own: its zero is a moment every track is placed
 * against. For one track:
 *
 *   durationMs     the full length of the stored audio, as recorded.
 *   offsetMs       the song time of the stored file's FIRST SAMPLE. May be
 *                  negative: a take recorded with a count-in has its first
 *                  sample before the song's zero, and the count-in stays in
 *                  the file. |offsetMs| <= JAM_OFFSET_MAX_MS.
 *   trimStartMs    milliseconds of the file's HEAD that are not heard (>= 0).
 *   trimEndMs      milliseconds of the file's TAIL that are not heard (>= 0).
 *
 * A trim HIDES audio and never MOVES it. Stored frame `f` (milliseconds into
 * the file) sounds at song time `offsetMs + f`, whatever the trims are, and
 * only the frames from `trimStartMs` to `durationMs - trimEndMs` are heard. So
 * the track is heard from `offsetMs + trimStartMs` (`jamTrackStartMs`) to
 * `offsetMs + durationMs - trimEndMs` (`jamTrackEndMs`), for `durationMs -
 * trimStartMs - trimEndMs` milliseconds (`jamTrackPlayedMs`).
 * `trimStartMs + trimEndMs < durationMs`, always: a track never plays nothing.
 * Trims are applied at PLAY time and never touch the stored bytes, so every one
 * of them can be changed back, and changing a trim never makes any other sound
 * in the song move.
 *
 * Worked example. The web recorder records a take from song time 0 with a
 * one-bar count-in (2000 ms at 120 BPM) and a 23 ms round trip, and uploads
 * `offsetMs -2023, trimStartMs 2023, trimEndMs 0, durationMs 62023`. The
 * count-in is in the file at song times -2023..0 and is hidden by the head
 * trim; the first sample heard is at song time 0 and the last at 60000. A
 * second take recorded with no count-in and then trimmed 500 ms at its head in
 * the editor has `offsetMs -137, trimStartMs 637`: it is heard from song time
 * 500. Reading `offsetMs` as "where the first HEARD sample sits" would play the
 * first take 2023 ms early against the second, which is how this header once
 * read and what the two phone players once did.
 *
 * The song's `mixDurationMs` is the latest end (`jamTrackEndMs`) of any
 * `inMix` track minus the earliest start (`jamTrackStartMs`), or null when it
 * has no `inMix` track. The engine decides where it zeroes the transport (the
 * web's is song time 0 and never later; the phones zero it at the earliest
 * heard sample); the server gives only this length.
 *
 *   gain           a linear multiplier on the track, 0 (silent) to 2 (+6 dB),
 *                  default 1. Applied by the engine; the stored audio is raw.
 *   peaks          up to JAM_PEAKS_MAX numbers in 0..1, the track's loudness
 *                  envelope across `durationMs` (the WHOLE recording, before
 *                  trims), for drawing a waveform with no audio downloaded.
 *                  The recorder computes them; the server stores what it is
 *                  sent, bounded and clamped to 0..1, and never reads audio.
 *   inMix          whether the default mix plays it. Several takes of one
 *                  instrument may exist; this says which ones are heard. The
 *                  FIRST take of an instrument in a song (no live track of that
 *                  instrument there) is created `inMix: true`, every later
 *                  take `false`. The song's author or a moderator turns takes
 *                  on and off.
 *
 * -------------------------------------------------------------------------
 * JOIN MODES (`joinMode`): who may add a track to a song
 *
 *   open     anybody who can post in the channel, any instrument.
 *   wanted   the author is looking for specific instruments
 *            (`wantedInstruments`, at least one): others may add a track only
 *            for an instrument in that list. The song's author may always add
 *            any instrument, in every mode.
 *   closed   only the song's author adds tracks.
 *
 * "Can post in the channel" is the SEND_MESSAGES permission on the jam channel
 * (overwrites included). A moderator (MANAGE_MESSAGES or MANAGE_CHANNELS on the
 * channel) may edit and delete anything but is bound by `joinMode` when adding
 * a track of their own, like everybody else.
 * `wantedInstruments` is `[]` in every mode but `wanted`.
 *
 * -------------------------------------------------------------------------
 * THE UPLOAD FLOW (adding a track, three steps)
 *
 *   1. `POST /api/jam-songs/:songId/uploads` once for the audio and, if there
 *      is a video, once more for it. Body `createJamUploadSchema`. Answer
 *      `JamUploadTicket`: a presigned PUT and an `uploadId`.
 *   2. PUT the bytes straight to `uploadUrl`. The request MUST send exactly the
 *      `Content-Type` that was asked for and a `Content-Length` of exactly
 *      `byteSize` (both are signed into the URL; any other body is refused by
 *      the bucket). The URL is good for 15 minutes. The bucket's CORS policy
 *      must allow PUT and GET from the page's origin (`docs/ATTACHMENTS.md`
 *      §4).
 *   3. `POST /api/jam-songs/:songId/tracks` with `addJamTrackSchema`, naming
 *      the `audioUploadId` (and `videoUploadId`). The server then HEADs both
 *      objects (outside any transaction), checks size and stored type, and
 *      inserts the track. Retrying step 3 with the same `audioUploadId` returns
 *      the same track with 200 instead of a second one.
 *
 * WHAT A CLIENT MAY UPLOAD (these are the jam's own limits, not the message
 * attachment ones; `MAX_ATTACHMENT_BYTES` does not apply):
 *
 *   audio   JAM_AUDIO_CONTENT_TYPES, at most JAM_AUDIO_MAX_BYTES, and at most
 *           JAM_TRACK_MAX_DURATION_MS long. MediaRecorder output fits: Opus in
 *           WebM or Ogg, AAC in MP4. Uncompressed WAV is not accepted (ten
 *           minutes of it is ~57 MB); the recorder encodes first.
 *   video   JAM_VIDEO_CONTENT_TYPES, at most JAM_VIDEO_MAX_BYTES. Not scanned,
 *           like every audio and video object in the product
 *           (`docs/CONTENT_SAFETY.md`).
 *
 *   cover   (a song's picture, not part of a track) JAM_COVER_CONTENT_TYPES,
 *           at most JAM_COVER_MAX_BYTES. The web client frames it square and
 *           sends a JPEG of `JAM_COVER_SIZE` pixels. Same three steps with a
 *           different third one: `PUT /api/jam-songs/:songId/cover` with the
 *           `uploadId` (see "A SONG'S COVER" below). Not scanned, like the
 *           avatars and server pictures (`docs/CONTENT_SAFETY.md`).
 *
 * An upload that is never claimed is deleted, object and ledger row, about an
 * hour later. A deleted track's objects are deleted a day after it.
 *
 * -------------------------------------------------------------------------
 * A SONG'S COVER
 *
 * A song may carry one picture, shown on its tile and in its panel. It is
 * additive and optional: `JamSongSummary.coverUrl` is null for a song with
 * none, and a client that predates it ignores the key (the phones' decoders
 * skip unknown keys). The URL is a presigned GET minted when the summary was
 * built, valid for the deployment's `ATTACHMENT_URL_TTL_SECONDS` like a track's
 * `audioUrl`; the key inside it never changes for a given picture, so a client
 * can recognise "the same cover" by the URL's PATH (everything before `?`) and
 * keep what it already drew. A summary read again (list, detail, any song
 * frame) carries a fresh signature. A replaced or removed cover is announced
 * with `jam-song-updated`, the frame an edit of the title already is.
 *
 * Who may set or remove it: the song's author or a moderator, the rule for
 * `PATCH /api/jam-songs/:songId`. Setting is gated by the flag; removing is
 * NOT (a picture somebody should not see must stay removable while the feature
 * is paused), so removal joins the other three removals under THE FLAG below. The
 * replaced object is deleted after the write and, as a backstop, by the sweep.
 *
 * -------------------------------------------------------------------------
 * REST SURFACE (every route authenticated like the rest of `/api`)
 *
 * | Route                                         | Body / query                | Answer                         | Who |
 * |-----------------------------------------------|-----------------------------|--------------------------------|-----|
 * | GET    /api/jam/config?serverId=              |                             | `JamConfig`                    | any signed-in account |
 * | GET    /api/channels/:channelId/jam-songs     | `listJamSongsQuerySchema`   | `JamSongListResponse`          | can see the channel |
 * | POST   /api/channels/:channelId/jam-songs     | `createJamSongSchema`       | 201 `{ song }`; 200 on a nonce retry | SEND_MESSAGES, flag on |
 * | GET    /api/jam-songs/:songId                 |                             | `JamSongDetailResponse`        | can see the channel (deep links) |
 * | PATCH  /api/jam-songs/:songId                 | `updateJamSongSchema`       | `{ song }`                     | the song's author or a moderator, flag on |
 * | DELETE /api/jam-songs/:songId                 |                             | 204                            | the song's author or a moderator |
 * | POST   /api/jam-songs/:songId/uploads         | `createJamUploadSchema`     | 201 `JamUploadTicket`          | `audio` / `video`: may add a track, flag on. `cover`: the song's author or a moderator, flag on |
 * | PUT    /api/jam-songs/:songId/cover           | `setJamCoverSchema`         | `{ song }`                     | the song's author or a moderator, flag on |
 * | DELETE /api/jam-songs/:songId/cover           |                             | `{ song }`                     | the song's author or a moderator |
 * | POST   /api/jam-songs/:songId/tracks          | `addJamTrackSchema`         | 201 `{ track, song }`; 200 on a retry | may add a track (`joinMode`), flag on |
 * | PATCH  /api/jam-tracks/:trackId               | `updateJamTrackSchema`      | `{ track, song }`              | per field, see below, flag on |
 * | DELETE /api/jam-tracks/:trackId               |                             | 204                            | the track's author, the song's author or a moderator |
 * | PUT    /api/jam-tracks/:trackId/vote          |                             | `JamVoteResponse`              | can see the channel, flag on |
 * | DELETE /api/jam-tracks/:trackId/vote          |                             | `JamVoteResponse`              | can see the channel |
 *
 * Creating the jam CHANNEL itself is the ordinary
 * `POST /api/servers/:serverId/channels` with `type: "jam"`, which needs
 * MANAGE_CHANNELS and is refused 403 `jam_channels_off` unless the runtime flag
 * `jam_channels` is on for that server.
 *
 * PATCH /api/jam-tracks/:trackId, field by field: `label`, `offsetMs`,
 * `trimStartMs`, `trimEndMs` and `gain` are the TRACK's AUTHOR's alone (the
 * song's author and moderators do not nudge somebody else's take; they
 * delete it or leave it out of the mix); `inMix` is the SONG's author's or a
 * moderator's alone (the track's author cannot put their own take in the mix
 * unless they also wrote the song).
 *
 * THE FLAG. `jam_channels` (per server, default off) gates creating a jam
 * channel and every write that adds or changes something: create and update a
 * song, mint an upload, set a cover, add and update a track, vote. It NEVER
 * gates a read, and it does not gate the four removals (delete a song, delete a
 * track, take a vote back, remove a cover), so turning it off freezes the
 * feature without stranding anybody's moderation or their own content. Off, a
 * write is 403 `jam_channels_off`.
 *
 * ERRORS: `{ error: <JAM_ERRORS value> }`, the house `sendError` shape. A 400
 * for a body that does not parse, 404 for anything the caller may not see (a
 * channel they cannot open, a song in it, a channel that is not a jam: all the
 * same 404), 403 for a permission or `joinMode` refusal, 409 for a limit,
 * 413 for a file over its limit, 429 for the per-person rate.
 *
 * -------------------------------------------------------------------------
 * LIVE FRAMES (`jamFrameSchema`)
 *
 * Fanned out to every socket that sent `join-channel` for the jam channel
 * (join-channel itself checks that the person may see it), through the channel
 * relay, so it works across API instances (`CLUSTER_BUS=postgres`). So an
 * open jam channel is joined with the channel's own id, one join covers the
 * list and any open song.
 *
 * Frames are shared by every viewer, so they carry nothing about the viewer
 * (no `votedByMe`): a person's own votes come from the detail read and from
 * the answer to their own vote. The frames are NOT yet members of
 * `chatServerMessageSchema` (the union every client is typed and tested
 * against), the same arrangement `voiceNoteFrameSchema` has; a client that
 * does not know a type drops it. They ARE in `CHAT_SERVER_MESSAGE_TYPES`,
 * which is what lets the relay carry them to the sibling instance.
 *
 * A change reaches the writer's own socket too: apply a frame idempotently
 * (replace by id).
 */

// ------------------------------------------------------------------ caps

/** Song title length, 1 to this. */
export const JAM_TITLE_MAX = 100;
/** Artist length, 1 to this. */
export const JAM_ARTIST_MAX = 100;
/** A track's free-text label ("Take 2, com pedal"). */
export const JAM_LABEL_MAX = 40;
/** Songs per list page by default, and the most a client may ask for. */
export const JAM_PAGE_SIZE = 25;
export const JAM_PAGE_MAX = 50;
/** List search query length. */
export const JAM_SEARCH_MAX = 100;
/** Live tracks one song may hold. */
export const JAM_MAX_TRACKS_PER_SONG = 32;
/** Live tracks one person may have in one song (takes included). */
export const JAM_MAX_TRACKS_PER_AUTHOR = 8;
/** Numbers in a track's `peaks`. */
export const JAM_PEAKS_MAX = 400;
/** `gain` runs 0 to this. */
export const JAM_GAIN_MAX = 2;
/** The longest recording a track may hold: ten minutes. */
export const JAM_TRACK_MAX_DURATION_MS = 10 * 60 * 1000;
/** Shorter than this is a tap on the record button. */
export const JAM_TRACK_MIN_DURATION_MS = 300;
/** `previewPeaks` on a song summary: at most this many values. */
export const JAM_PREVIEW_PEAKS_MAX = 64;
/** `contributors` on a song summary: at most this many people. */
export const JAM_PREVIEW_CONTRIBUTORS_MAX = 4;
/** `|offsetMs|` may not exceed this: ten minutes either side of the song's zero. */
export const JAM_OFFSET_MAX_MS = 10 * 60 * 1000;
/** Audio object ceiling in bytes: 32 MiB. Ten minutes at 320 kbps is ~24 MB. */
export const JAM_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
/** Video object ceiling in bytes: 100 MiB, the Baú's number. */
export const JAM_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
/**
 * What a recorder may upload as audio, bare (no `;codecs=`): the claim HEAD
 * compares the stored type with the signed one exactly.
 *
 * `audio/flac` is what the web engine (`client/src/lib/jam/upload.ts`) sends,
 * and the one every client decodes without moving a sample: MP3 lands 12 ms
 * late in WebKit and on iOS, and iOS cannot open WebM at all
 * (`docs/JAM_ENGINE.md`). The lossy types stay for a file somebody uploads.
 */
export const JAM_AUDIO_CONTENT_TYPES = [
  "audio/flac",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
] as const;
export const JAM_VIDEO_CONTENT_TYPES = ["video/webm", "video/mp4"] as const;
/** A song's cover: the three picture types every browser and phone draws. */
export const JAM_COVER_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/**
 * Cover object ceiling in bytes: 4 MiB. The web client sends a `JAM_COVER_SIZE`
 * square JPEG (a few hundred KB); the ceiling is for a client that sends the
 * picture as it is.
 */
export const JAM_COVER_MAX_BYTES = 4 * 1024 * 1024;
/** The side, in pixels, of the square a client frames and sends. */
export const JAM_COVER_SIZE = 1024;
/** Songs a person may create per window, cluster-wide. */
export const JAM_SONGS_PER_WINDOW = 10;
/** Upload tickets a person may ask for per window, cluster-wide (a track is one or two). */
export const JAM_UPLOADS_PER_WINDOW = 30;
export const JAM_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- errors

/** The `error` token of a jam refusal. Clients i18n these by value. */
export const JAM_ERRORS = {
  /** 403: the runtime flag `jam_channels` is off for this server. */
  off: "jam_channels_off",
  /** 403: the song's `joinMode` is `closed` and the caller is not its author. */
  closed: "jam_song_closed",
  /** 403: `wanted`, and the instrument is not in `wantedInstruments`. */
  instrumentNotWanted: "jam_instrument_not_wanted",
  /**
   * 422: a PATCH that leaves a song `wanted` with no wanted instrument. A
   * create that sends `joinMode: "wanted"` with none fails body validation
   * instead (400), with this token as the issue's message.
   */
  wantedNeedsInstruments: "jam_wanted_needs_instruments",
  /**
   * 409: `DELETE /api/jam-songs/:id?ifEmpty=true` found a track in the song. The
   * studio of a song it made asks for the song to go only while it has no
   * take, so a claim that committed unseen (the answer was lost) is never deleted.
   */
  songNotEmpty: "jam_song_not_empty",
  /** 409: the song already holds `JAM_MAX_TRACKS_PER_SONG` tracks. */
  songFull: "jam_song_full",
  /** 409: the caller already has `JAM_MAX_TRACKS_PER_AUTHOR` tracks in it. */
  authorTrackLimit: "jam_author_track_limit",
  /** 422: the trims would leave nothing to play. */
  trimInvalid: "jam_trim_invalid",
  /** 404: an upload id that is not the caller's, not this song's or already used. */
  uploadUnknown: "jam_upload_unknown",
  /** 422: the object is missing, the wrong type or over its limit at the bucket. */
  uploadNotVerified: "jam_upload_not_verified",
  /** 413: a requested size over the limit for its kind. */
  uploadTooLarge: "jam_upload_too_large",
  /** 503: object storage is not configured on this deployment. */
  storageOff: "jam_storage_off",
  /**
   * 409: a create whose nonce kept colliding with a song deleted under it. Not
   * reachable in practice (a deleted song's nonce is free); it exists so a
   * constraint can never surface as a 500.
   */
  nonceConflict: "jam_nonce_conflict",
  /** 429: too many songs or uploads in the window. */
  rateLimited: "jam_rate_limited",
} as const;
export type JamErrorCode = (typeof JAM_ERRORS)[keyof typeof JAM_ERRORS];

// ------------------------------------------------------------ primitives

// Same rule as `safeTextSchema` in api.ts, restated: this module imports
// nothing from `api.ts` or `chat.ts` (`chat.ts` imports the frames from here).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const uuid = z.string().uuid();

/** One line, whitespace collapsed, trimmed, 1 to `max`, no control characters. */
function oneLine(max: number) {
  return z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((value) => !CONTROL_CHARS.test(value), "Invalid characters"),
    );
}

export const jamTitleSchema = oneLine(JAM_TITLE_MAX);

/** An artist or a label: one line, or null / empty meaning "none". */
function optionalLine(max: number) {
  return z
    .string()
    .nullable()
    .transform((value) => (value === null ? "" : value.replace(/\s+/g, " ").trim()))
    .pipe(
      z
        .string()
        .max(max)
        .refine((value) => !CONTROL_CHARS.test(value), "Invalid characters"),
    )
    .transform((value) => (value === "" ? null : value));
}

export const jamArtistSchema = optionalLine(JAM_ARTIST_MAX);
export const jamLabelSchema = optionalLine(JAM_LABEL_MAX);

/**
 * Order is the picker's order. Adding a value is safe for an older client only
 * where it falls back to "other" (`.catch("other")` on the read schemas below);
 * renaming or removing one is not.
 */
export const JAM_INSTRUMENTS = [
  "guitar",
  "bass",
  "drums",
  "vocals",
  "keys",
  "other",
] as const;
export const jamInstrumentSchema = z.enum(JAM_INSTRUMENTS);
export type JamInstrument = z.infer<typeof jamInstrumentSchema>;

export const JAM_JOIN_MODES = ["open", "wanted", "closed"] as const;
export const jamJoinModeSchema = z.enum(JAM_JOIN_MODES);
export type JamJoinMode = z.infer<typeof jamJoinModeSchema>;

export const JAM_SORTS = ["activity", "created"] as const;
export const jamSortSchema = z.enum(JAM_SORTS);
export type JamSort = z.infer<typeof jamSortSchema>;

/** Distinct instruments, at most one of each. */
const wantedListSchema = z
  .array(jamInstrumentSchema)
  .max(JAM_INSTRUMENTS.length)
  .refine((list) => new Set(list).size === list.length, "Duplicate instrument");

/** A time in milliseconds on the timeline: finite, and bounded. */
const offsetSchema = z.number().finite().min(-JAM_OFFSET_MAX_MS).max(JAM_OFFSET_MAX_MS);
const trimSchema = z.number().finite().min(0).max(JAM_TRACK_MAX_DURATION_MS);
const gainSchema = z.number().finite().min(0).max(JAM_GAIN_MAX);
const peaksSchema = z.array(z.number().finite().min(0).max(1)).max(JAM_PEAKS_MAX);

/** The length a track is heard for, on the song timeline. See the header. */
export function jamTrackPlayedMs(track: {
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number;
}): number {
  return Math.max(0, track.durationMs - track.trimStartMs - track.trimEndMs);
}

/**
 * Song time of a track's first HEARD sample: the file's first sample
 * (`offsetMs`) plus the head the trim hides. See the header.
 */
export function jamTrackStartMs(track: { offsetMs: number; trimStartMs: number }): number {
  return track.offsetMs + track.trimStartMs;
}

/**
 * Song time just past a track's last HEARD sample: the file's last sample
 * (`offsetMs + durationMs`) less the tail the trim hides. Always
 * `jamTrackStartMs + jamTrackPlayedMs`.
 */
export function jamTrackEndMs(track: {
  offsetMs: number;
  durationMs: number;
  trimEndMs: number;
}): number {
  return track.offsetMs + track.durationMs - track.trimEndMs;
}

// ---------------------------------------------------------------- config

/** `GET /api/jam/config?serverId=`: the runtime flag `jam_channels` for that server. */
export const jamConfigSchema = z.object({
  /**
   * Creating jam channels, songs and tracks is allowed here. Off never hides
   * anything: existing jams stay readable and playable; a client shows its
   * "paused" copy in place of the add buttons.
   */
  enabled: z.boolean(),
  /**
   * Object storage is configured on this deployment. Without it nothing can be
   * uploaded, so a client hides "add a track" even when `enabled`.
   */
  uploads: z.boolean(),
});
export type JamConfig = z.infer<typeof jamConfigSchema>;

// ----------------------------------------------------------------- songs

/**
 * One person with a live track in a song, as a song tile draws them: a name and
 * a face, and nothing else. Same naming as `JamTrack.authorName` (the server
 * nickname first).
 */
export const jamContributorSchema = z.object({
  id: uuid,
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type JamContributor = z.infer<typeof jamContributorSchema>;

/**
 * One song as every viewer who can see the channel sees it. Carried by the
 * list, the detail, and the song frames, so it never holds anything about the
 * viewer. Arrays carry no `.max()` on purpose: an older client must not reject a
 * whole frame because a newer server sent more.
 */
export const jamSongSummarySchema = z.object({
  id: uuid,
  channelId: uuid,
  serverId: uuid,
  title: z.string(),
  /** The original artist. Null means the song is an original. */
  artist: z.string().nullable(),
  joinMode: jamJoinModeSchema,
  /** Empty unless `joinMode` is `wanted`. */
  wantedInstruments: z.array(jamInstrumentSchema.catch("other")),
  /** Null once the account is gone ("Conta excluída"). */
  authorId: uuid.nullable(),
  authorName: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  createdAt: z.string(),
  /** The bump: created, edited, a track added, changed or removed. The list sorts on it. */
  updatedAt: z.string(),
  /** Live tracks, `inMix` or not. */
  trackCount: z.number().int().nonnegative(),
  /** Distinct instruments among the live tracks, in `JAM_INSTRUMENTS` order. */
  instruments: z.array(jamInstrumentSchema.catch("other")),
  /** Distinct people with a live track in it, the author included when they have one. */
  contributorCount: z.number().int().nonnegative(),
  /** Length of the default mix, see the header. Null with no `inMix` track. */
  mixDurationMs: z.number().nonnegative().nullable(),
  // ---- the preview: what a wall of songs draws without opening each one.
  // Additive: every field has a default, so a client reading an older server
  // sees the empty value, and a client that predates them ignores them. The
  // list, the detail and the song frames all carry them, computed by the same
  // query, so a tile never differs between the three.
  /**
   * A waveform for the tile: the `peaks` of the `inMix` track with the most
   * signal (the largest sum of peaks), reduced to at most
   * `JAM_PREVIEW_PEAKS_MAX` values by taking the loudest value of each bucket,
   * each in 0..1. Empty when no `inMix` track has peaks. It is the loudest
   * single stem, not a sum of the mix: the tile is a hint, and the real
   * waveforms are in the detail.
   */
  previewPeaks: z.array(z.number()).default([]),
  /** At least one live track has a video: draw a camera badge. */
  hasVideo: z.boolean().default(false),
  /**
   * The song's cover picture (a presigned GET, see "A SONG'S COVER" in the
   * header), or null when it has none. Additive: absent from an older server's
   * answer, so it reads null.
   */
  coverUrl: z.string().nullable().default(null),
  /**
   * Up to `JAM_PREVIEW_CONTRIBUTORS_MAX` people with a live track, in the order
   * of their first track. `contributorCount` is the full number ("+3").
   */
  contributors: z.array(jamContributorSchema).default([]),
  /**
   * For a `wanted` song, the wanted instruments nobody has a live track for
   * yet, in `JAM_INSTRUMENTS` order ("procura baixo"). Empty for every other
   * mode and once every wanted instrument is covered.
   */
  missingInstruments: z.array(jamInstrumentSchema.catch("other")).default([]),
});
export type JamSongSummary = z.infer<typeof jamSongSummarySchema>;

/** What the caller may do in one song. Per viewer: never cached, never framed. */
export const jamSongViewerSchema = z.object({
  /** The caller wrote the song. */
  isAuthor: z.boolean(),
  /** MANAGE_MESSAGES or MANAGE_CHANNELS on the channel: may edit and delete anything. */
  canModerate: z.boolean(),
  /**
   * The instruments the caller may add a track for right now: every instrument
   * for the author or an `open` song, the wanted ones for `wanted`, none for
   * `closed`. Empty also when the flag is off, the caller cannot post, the song
   * is full or they hit their own limit: it is the one thing the "add a track"
   * button needs to read.
   */
  addableInstruments: z.array(jamInstrumentSchema.catch("other")),
  /** The tracks (ids) the caller has voted for. */
  votedTrackIds: z.array(uuid),
});
export type JamSongViewer = z.infer<typeof jamSongViewerSchema>;

export const jamSongListResponseSchema = z.object({
  songs: z.array(jamSongSummarySchema),
  /** Opaque keyset cursor; null at the end. */
  nextCursor: z.string().nullable(),
});
export type JamSongListResponse = z.infer<typeof jamSongListResponseSchema>;

/** Query-string boolean: only `true` / `1` is on. */
const queryBoolean = z.preprocess(
  (value) => value === true || value === "true" || value === "1",
  z.boolean(),
);

/**
 * `GET /api/channels/:channelId/jam-songs`. Two orders, keyset on (sort key,
 * song id): `activity` (`updatedAt`, the default) and `created`. `q` matches
 * title and artist, case- and accent-insensitive. `wanting` lists the songs
 * that are `wanted` for that instrument ("bandas procurando baixista").
 */
export const listJamSongsQuerySchema = z.object({
  sort: jamSortSchema.optional(),
  q: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(JAM_SEARCH_MAX))
    .optional(),
  wanting: jamInstrumentSchema.optional(),
  /** Only the caller's own songs. */
  mine: queryBoolean.optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(JAM_PAGE_MAX).optional(),
});
export type ListJamSongsQuery = z.infer<typeof listJamSongsQuerySchema>;

/**
 * `POST /api/channels/:channelId/jam-songs`. `joinMode` defaults to `open`.
 * `wanted` needs at least one instrument; any other mode stores an empty list
 * whatever was sent. `nonce` makes a retry return the same song (200).
 */
export const createJamSongSchema = z
  .object({
    title: jamTitleSchema,
    artist: jamArtistSchema.optional(),
    joinMode: jamJoinModeSchema.optional(),
    wantedInstruments: wantedListSchema.optional(),
    nonce: z.string().min(1).max(64).optional(),
  })
  .refine(
    (song) =>
      song.joinMode !== "wanted" || (song.wantedInstruments?.length ?? 0) > 0,
    { message: JAM_ERRORS.wantedNeedsInstruments, path: ["wantedInstruments"] },
  );
export type CreateJamSongRequest = z.infer<typeof createJamSongSchema>;

/**
 * `PATCH /api/jam-songs/:songId`. Every field optional, at least one present.
 * `artist: null` clears it (an original). Leaving `wanted` clears the list;
 * staying in or entering `wanted` with none is 422 `jam_wanted_needs_instruments`.
 */
export const updateJamSongSchema = z
  .object({
    title: jamTitleSchema.optional(),
    artist: jamArtistSchema.optional(),
    joinMode: jamJoinModeSchema.optional(),
    wantedInstruments: wantedListSchema.optional(),
  })
  .refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    "Nothing to update",
  );
export type UpdateJamSongRequest = z.infer<typeof updateJamSongSchema>;

// ---------------------------------------------------------------- tracks

/**
 * One track, shared by every viewer. `audioUrl` and `videoUrl` are presigned
 * GETs minted when the track was read, valid until `mediaExpiresAt` (the
 * deployment's `ATTACHMENT_URL_TTL_SECONDS`, 12 h by default); a client whose
 * tab outlives that re-reads `GET /api/jam-songs/:songId` for fresh ones. They
 * are plain object-store URLs: fetch them with `fetch()` for the audio engine
 * (needs the bucket's CORS GET), or hand the video URL to a `<video>`.
 */
export const jamTrackSchema = z.object({
  id: uuid,
  songId: uuid,
  /** Never null: a deleted account's tracks are deleted with it. */
  authorId: uuid,
  authorName: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  /** An instrument a newer server invented reads as `other`. */
  instrument: jamInstrumentSchema.catch("other"),
  /** Free text ("Take 2, com pedal"), or null. */
  label: z.string().nullable(),
  audioUrl: z.string(),
  audioContentType: z.string(),
  audioBytes: z.number().int().nonnegative(),
  /** Null when the track has no video. */
  videoUrl: z.string().nullable(),
  videoContentType: z.string().nullable(),
  videoBytes: z.number().int().nonnegative().nullable(),
  mediaExpiresAt: z.string(),
  /** See "THE TIMELINE" in the header. */
  offsetMs: z.number(),
  trimStartMs: z.number().nonnegative(),
  trimEndMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  gain: z.number().nonnegative(),
  peaks: z.array(z.number()),
  inMix: z.boolean(),
  /** People who voted for it. */
  voteCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type JamTrack = z.infer<typeof jamTrackSchema>;

/** `GET /api/jam-songs/:songId`: the deep link and the song view. */
export const jamSongDetailResponseSchema = z.object({
  song: jamSongSummarySchema,
  /** Live tracks, oldest first: the order they were added is the stable one. */
  tracks: z.array(jamTrackSchema),
  viewer: jamSongViewerSchema,
});
export type JamSongDetailResponse = z.infer<typeof jamSongDetailResponseSchema>;

export const jamUploadKindSchema = z.enum(["audio", "video", "cover"]);
export type JamUploadKind = z.infer<typeof jamUploadKindSchema>;

/**
 * `POST /api/jam-songs/:songId/uploads`, sent before a byte is uploaded. The
 * kind decides the allowed types and the size ceiling. `byteSize` is signed
 * into the URL: the upload must be exactly that long.
 */
export const createJamUploadSchema = z
  .object({
    kind: jamUploadKindSchema,
    contentType: z.string().min(1).max(100),
    byteSize: z.number().int().positive(),
  })
  .superRefine((upload, ctx) => {
    const allowed: readonly string[] =
      upload.kind === "audio"
        ? JAM_AUDIO_CONTENT_TYPES
        : upload.kind === "video"
          ? JAM_VIDEO_CONTENT_TYPES
          : JAM_COVER_CONTENT_TYPES;
    if (!allowed.includes(upload.contentType)) {
      ctx.addIssue({
        code: "custom",
        path: ["contentType"],
        message: `A ${upload.kind} upload must be ${allowed.join(", ")}`,
      });
    }
  });
export type CreateJamUploadRequest = z.infer<typeof createJamUploadSchema>;

/**
 * `PUT /api/jam-songs/:songId/cover`: make an upload of kind `cover`, already
 * PUT to the bucket, the song's picture. 404 `jam_upload_unknown` for an upload
 * that is not the caller's, not this song's, not a cover or already used; 422
 * `jam_upload_not_verified` when the object is missing, over its limit or not
 * the type that was signed.
 */
export const setJamCoverSchema = z.object({ uploadId: uuid });
export type SetJamCoverRequest = z.infer<typeof setJamCoverSchema>;

export const jamUploadTicketSchema = z.object({
  uploadId: uuid,
  /** Presigned PUT. Send exactly the asked `Content-Type` and a `Content-Length` of `byteSize`. */
  uploadUrl: z.string().url(),
  expiresAt: z.string(),
});
export type JamUploadTicket = z.infer<typeof jamUploadTicketSchema>;

/**
 * `POST /api/jam-songs/:songId/tracks`. The recorder's own numbers
 * (`durationMs`, `peaks`) are the client's word, bounded: the server never
 * decodes audio. `inMix` is not here; the server decides it (the first take of
 * an instrument is in the mix) and the song's author changes it after.
 */
export const addJamTrackSchema = z
  .object({
    instrument: jamInstrumentSchema,
    label: jamLabelSchema.optional(),
    audioUploadId: uuid,
    videoUploadId: uuid.nullable().optional(),
    // Whole milliseconds: it is stored as an integer, and the trim check is
    // against that number.
    durationMs: z
      .number()
      .int()
      .min(JAM_TRACK_MIN_DURATION_MS)
      .max(JAM_TRACK_MAX_DURATION_MS),
    offsetMs: offsetSchema.default(0),
    trimStartMs: trimSchema.default(0),
    trimEndMs: trimSchema.default(0),
    gain: gainSchema.default(1),
    peaks: peaksSchema.default([]),
  })
  .refine((track) => track.trimStartMs + track.trimEndMs < track.durationMs, {
    message: JAM_ERRORS.trimInvalid,
    path: ["trimStartMs"],
  });
export type AddJamTrackRequest = z.infer<typeof addJamTrackSchema>;

/** The answer of an add and of a track edit: the track and the song's fresh summary. */
export const jamTrackWithSongSchema = z.object({
  track: jamTrackSchema,
  song: jamSongSummarySchema,
});
export type JamTrackWithSong = z.infer<typeof jamTrackWithSongSchema>;

/**
 * `PATCH /api/jam-tracks/:trackId`. Every field optional, at least one present.
 * Who may send which field is in the header. `label: null` clears it. The trims
 * are checked against the stored `durationMs`: 422 `jam_trim_invalid`.
 */
export const updateJamTrackSchema = z
  .object({
    label: jamLabelSchema.optional(),
    offsetMs: offsetSchema.optional(),
    trimStartMs: trimSchema.optional(),
    trimEndMs: trimSchema.optional(),
    gain: gainSchema.optional(),
    inMix: z.boolean().optional(),
  })
  .refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    "Nothing to update",
  );
export type UpdateJamTrackRequest = z.infer<typeof updateJamTrackSchema>;

/** The answer of a vote or an unvote: the new count and where the caller stands. */
export const jamVoteResponseSchema = z.object({
  trackId: uuid,
  songId: uuid,
  voteCount: z.number().int().nonnegative(),
  voted: z.boolean(),
});
export type JamVoteResponse = z.infer<typeof jamVoteResponseSchema>;

// ------------------------------------------------------------- WS frames

/** A song was created. */
export const jamSongCreatedSchema = z.object({
  type: z.literal("jam-song-created"),
  channelId: uuid,
  song: jamSongSummarySchema,
});
export type JamSongCreated = z.infer<typeof jamSongCreatedSchema>;

/** A song's title, artist, join mode or wanted list changed. */
export const jamSongUpdatedSchema = z.object({
  type: z.literal("jam-song-updated"),
  channelId: uuid,
  song: jamSongSummarySchema,
});
export type JamSongUpdated = z.infer<typeof jamSongUpdatedSchema>;

/** A song was deleted, with all its tracks. */
export const jamSongDeletedSchema = z.object({
  type: z.literal("jam-song-deleted"),
  channelId: uuid,
  songId: uuid,
});
export type JamSongDeleted = z.infer<typeof jamSongDeletedSchema>;

/** A track was added. `song` is the refreshed summary (counts, mix length). */
export const jamTrackAddedSchema = z.object({
  type: z.literal("jam-track-added"),
  channelId: uuid,
  song: jamSongSummarySchema,
  track: jamTrackSchema,
});
export type JamTrackAdded = z.infer<typeof jamTrackAddedSchema>;

/** A track changed: its offset, trims, gain, label or `inMix`. `voteCount` is current. */
export const jamTrackUpdatedSchema = z.object({
  type: z.literal("jam-track-updated"),
  channelId: uuid,
  song: jamSongSummarySchema,
  track: jamTrackSchema,
});
export type JamTrackUpdated = z.infer<typeof jamTrackUpdatedSchema>;

/** A track was deleted. */
export const jamTrackDeletedSchema = z.object({
  type: z.literal("jam-track-deleted"),
  channelId: uuid,
  song: jamSongSummarySchema,
  trackId: uuid,
});
export type JamTrackDeleted = z.infer<typeof jamTrackDeletedSchema>;

/** A track's vote count changed. No voter is named. */
export const jamTrackVotesSchema = z.object({
  type: z.literal("jam-track-votes"),
  channelId: uuid,
  songId: uuid,
  trackId: uuid,
  voteCount: z.number().int().nonnegative(),
});
export type JamTrackVotes = z.infer<typeof jamTrackVotesSchema>;

export const jamFrameSchema = z.discriminatedUnion("type", [
  jamSongCreatedSchema,
  jamSongUpdatedSchema,
  jamSongDeletedSchema,
  jamTrackAddedSchema,
  jamTrackUpdatedSchema,
  jamTrackDeletedSchema,
  jamTrackVotesSchema,
]);
export type JamFrame = z.infer<typeof jamFrameSchema>;

/** Every jam frame type, for the relay's allowlist (`CHAT_SERVER_MESSAGE_TYPES`). */
export const JAM_FRAME_TYPES = [
  "jam-song-created",
  "jam-song-updated",
  "jam-song-deleted",
  "jam-track-added",
  "jam-track-updated",
  "jam-track-deleted",
  "jam-track-votes",
] as const satisfies readonly JamFrame["type"][];
