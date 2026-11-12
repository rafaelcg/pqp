# Jam channels

A jam is a channel (`type = 'jam'`) that holds **songs**. A song is a pile of
**tracks**: one recorded stem each (guitar, bass, voice...), from one person,
optionally with a video of them playing. A client plays every track that is in
the mix at the same time and lets anybody add theirs on top.

This page is the server half and the contract. The wire types, with a comment on
every field, are in `packages/shared/src/jam.ts`; read that first when building
a client. Code: `server/src/services/jam.ts` (rows and rules),
`server/src/api/jam-routes.ts` (who may do what), `server/src/services/jam-keys.ts`
(object keys for the cascades), `server/src/lib/jam-config.ts` (the flag).

Nothing is mixed on the server. Each track is its own object in the bucket; the
client decodes them, places each one on the timeline and sums them. The server
keeps the pieces, decides who may add one, and tells the room when something
moved.

## The flag

`jam_channels` (env `JAM_CHANNELS`), **per server, default off**, flipped from
the dashboard (controles, interruptores) with no deploy. Registry entry in
`server/src/lib/flags.ts`, notes in `docs/FEATURE_FLAGS.md`.

Served as `enabled` on `GET /api/jam/config?serverId=`, beside `uploads` (object
storage is configured on this deployment; without it a song can be made and no
track can be added).

Off gates **creating and changing**, never reading:

| Refused with 403 `jam_channels_off` while off | Still works while off |
|---|---|
| `POST /api/servers/:id/channels` with `type: "jam"` | Every read: the song list, a song, its tracks, the media URLs |
| create a song, edit a song | Delete a song (author or moderator) |
| ask for an upload ticket (audio, video or cover), add a track, edit a track | Delete a track (its author, the song's author or a moderator) |
| set a cover, vote | Remove a cover (author or moderator), take a vote back |

So turning it off freezes the feature without stranding a moderator or
somebody's own recording. Nothing is hidden or deleted. A client reading
`enabled: false` shows its "paused" copy where the add buttons were.

## The model

- **Channel**: `channels.type = 'jam'`. It never carries a message: a send into
  one is refused `no-access`, the forum's rule. Creating it needs MANAGE_CHANNELS
  (the ordinary create route).
- **Song** (`jam_songs`): title, optional artist (null is an original),
  `joinMode`, `wantedInstruments`, author, timestamps. Soft-deleted.
- **Track** (`jam_tracks`): instrument (`guitar bass drums vocals keys other`),
  optional label, the audio object, an optional video object, and the timeline
  fields. Soft-deleted.
- **Vote** (`jam_track_votes`): one per person per track.
- **Upload ledger** (`jam_uploads`): a signed upload until a track (or a cover)
  claims it.
- **Cover** (`jam_song_covers`): at most one picture per song, naming the
  ledger row (kind `cover`) whose object it is. See "A song's cover".

There is **no private state on a song**: a song is exactly as private as its
channel. Whoever can see the channel can read every song, track and media URL in
it; a private channel's songs fail closed with no jam-specific code.

### Join modes

| `joinMode` | Who may add a track |
|---|---|
| `open` | anybody who can post in the channel, any instrument |
| `wanted` | the author is looking for `wantedInstruments` (at least one): other people may add a track only for one of those. |
| `closed` | only the song's author |

The author may always add any instrument. A moderator is bound by the mode like
everybody else when adding their own track. "Can post" is SEND_MESSAGES on the
jam channel, overwrites included. `wantedInstruments` is empty in every mode but
`wanted`. The rule is written once (`addableInstruments` in `jam.ts`): the add
path enforces it, and the song detail reports it as `viewer.addableInstruments`,
so the button and the refusal cannot drift. It is checked again inside the claim
transaction, so a song closed while a file was uploading refuses the claim.

### Takes and the mix

Several takes of one instrument may exist. `inMix` says which ones play. The
**first** live take of an instrument in a song is created `inMix: true`, every
later one `false`. Deleting the playing take does not promote another: the song's
author (or a moderator) turns one on. When no live take of an instrument is left,
the next one is the first again.

### Timeline

`durationMs` is the stored audio's full length. `offsetMs` is the song time of
the stored file's FIRST sample (it may be negative: a take recorded with a
count-in has its count-in in the file, before the song's zero). The track plays
`audio[trimStartMs, durationMs - trimEndMs]`: a trim hides audio and never moves
it, so the track is heard from `offsetMs + trimStartMs` to
`offsetMs + durationMs - trimEndMs`. Trims are applied at play time and never
touch the bytes. `gain` is a linear multiplier, 0 to 2. `peaks`
is up to 400 numbers in 0..1 across the whole recording, for a waveform with no
audio downloaded. The server stores what the recorder sends, bounded and clamped,
and never decodes audio. The song's `mixDurationMs` is the latest heard end of an
`inMix` track minus the earliest heard start (computed on read, nothing stores it). Full definitions: the header of `jam.ts`.

### The preview on a song summary

The list, the detail and every song frame carry the same `JamSongSummary`,
computed by one query, so a wall of songs draws its tiles without a detail
request per song. Beyond the counts, it carries (all additive, with defaults, so
an older client ignores them and a client on an older server sees the empty
value):

| Field | Meaning |
|---|---|
| `previewPeaks` | at most 64 values in 0..1: the `peaks` of the `inMix` track with the most signal (the largest sum), each bucket reduced to its loudest value. The loudest single stem, not the mix; empty when no `inMix` track has peaks. |
| `hasVideo` | at least one live track has a video |
| `contributors` | up to 4 people with a live track, in the order of their first track: `{ id, name, avatarUrl }`, named as the server names them (nickname first). `contributorCount` is the full number. |
| `missingInstruments` | for a `wanted` song, the wanted instruments nobody has a live track for yet; empty in every other mode |

The three lookups are lateral joins on `idx_jam_tracks_song`, one probe per song
on the page, never a query per song. Measured with `EXPLAIN (ANALYZE)` on a
26-song page where every song has 8 live tracks of 400 peaks: about 9 to 17 ms,
against about 3 to 8 ms without the preview; the extra cost is summing the peaks
of the in-mix tracks, done inside the database so no peak crosses the wire.

## Routes

All authenticated like the rest of `/api`.

| Route | Answer | Who |
|---|---|---|
| `GET /api/jam/config?serverId=` | `{ enabled, uploads }` | any signed-in account |
| `GET /api/channels/:channelId/jam-songs` | `{ songs, nextCursor }` | can see the channel |
| `POST /api/channels/:channelId/jam-songs` | 201 `{ song }`, 200 on a nonce retry of a live song | can post, flag on |
| `GET /api/jam-songs/:songId` | `{ song, tracks, viewer }` | can see the channel |
| `PATCH /api/jam-songs/:songId` | `{ song }` | the song's author or a moderator, flag on |
| `DELETE /api/jam-songs/:songId` | 204 | the song's author or a moderator |
| `POST /api/jam-songs/:songId/uploads` | 201 `{ uploadId, uploadUrl, expiresAt }` | audio and video: may add a track, flag on. Cover: the song's author or a moderator, flag on |
| `PUT /api/jam-songs/:songId/cover` | `{ song }` | the song's author or a moderator, flag on |
| `DELETE /api/jam-songs/:songId/cover` | `{ song }` | the song's author or a moderator (allowed while the flag is off) |
| `POST /api/jam-songs/:songId/tracks` | 201 `{ track, song }`, 200 on a retry | may add a track, flag on |
| `PATCH /api/jam-tracks/:trackId` | `{ track, song }` | see below, flag on |
| `DELETE /api/jam-tracks/:trackId` | 204 | the track's author, the song's author or a moderator |
| `PUT /api/jam-tracks/:trackId/vote` | `{ trackId, songId, voteCount, voted }` | can see the channel, flag on |
| `DELETE /api/jam-tracks/:trackId/vote` | same | can see the channel |

The list takes `sort=activity|created` (default `activity`, the bump of any edit
or track change), `q` (title and artist, case and accent insensitive),
`wanting=<instrument>` (songs looking for that instrument), `mine=true`,
`cursor`, `limit` (25, at most 50).

**Who edits what on a track**: `label`, `offsetMs`, `trimStartMs`, `trimEndMs`
and `gain` are the **track author's alone** (the song's author and moderators do
not nudge somebody else's take; they leave it out of the mix or delete it).
`inMix` is the **song's author's or a moderator's alone**. A moderator is
MANAGE_MESSAGES or MANAGE_CHANNELS on the channel, the forum's pair.

**Refusals**, in this order on every route: 404 for anything the caller may not
see (a channel they cannot open, a song in it, a channel that is not a jam: one
answer), then 403 `jam_channels_off`, then the permission, then the body (400).
Other tokens: `jam_song_closed`, `jam_instrument_not_wanted` (403),
`jam_song_full`, `jam_author_track_limit` (409), `jam_trim_invalid`,
`jam_wanted_needs_instruments`, `jam_upload_not_verified` (422),
`jam_upload_unknown` (404), `jam_upload_too_large` (413), `jam_storage_off`
(503), `jam_rate_limited` (429). A timed-out member takes no part in any write.

**Retry keys.** A song's `nonce` makes a retried create return the same *live*
song (200). A deleted song's nonce is free: reusing it creates a new song (201),
because the unique index is partial on live rows (`idx_jam_songs_nonce_live`; the
first version of the index also covered deleted songs and a reuse answered 500).
Two creates racing on one nonce resolve to the winner's song; a constraint
violation never reaches the client as a 500 (`jam_nonce_conflict`, 409, is the
unreachable last resort). A track claim's key is its `audioUploadId`: a retry
returns the same track (200), and a retry whose track was since deleted is 404
`jam_upload_unknown`, the upload being spent.

Limits: 32 live tracks per song, 8 per person per song, 10 new songs and 30
upload tickets per person per 10 minutes (cluster-wide).

## Adding a track

1. `POST /api/jam-songs/:songId/uploads` with `{ kind: "audio" | "video",
   contentType, byteSize }`, once for the audio and once more for a video.
2. `PUT` the bytes to `uploadUrl`. The request must send exactly the asked
   `Content-Type` and a `Content-Length` of exactly `byteSize` (both are signed
   into the URL). The URL is good for 15 minutes.
3. `POST /api/jam-songs/:songId/tracks` with `{ instrument, audioUploadId,
   videoUploadId?, durationMs, label?, offsetMs?, trimStartMs?, trimEndMs?, gain?,
   peaks? }`. The server HEADs both objects (before the transaction opens, never
   inside it), checks the size and that the stored type is the signed one, then
   in one transaction locks the song, re-checks the join mode and the limits,
   claims the uploads and inserts the track. Retrying step 3 with the same
   `audioUploadId` returns the same track with 200; two concurrent retries land
   on one track.

### What a client may upload

These are the jam's **own** limits. The message attachment path caps an upload at
10 MiB with no duration, and ties it to a message; a stem and a video are longer,
and a jam has no message. So nothing here raises `MAX_ATTACHMENT_BYTES` or touches
the attachment allowlist: jam objects use the same bucket, the same SigV4 presign
and the same HEAD verification (`lib/s3.ts`), with a ledger of their own, the way
the Baú's media does.

| | Types | Ceiling | Length |
|---|---|---|---|
| audio | `audio/flac` (what the web engine sends), `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg` | 32 MiB | at most 10 minutes (`durationMs`, the recorder's word) |
| video | `video/webm`, `video/mp4` | 100 MiB | none enforced |
| cover | `image/jpeg`, `image/png`, `image/webp` | 4 MiB | none; the web client sends a 1024 px square JPEG (a few hundred KB) |

MediaRecorder output fits (Opus in WebM or Ogg, AAC in MP4). Uncompressed WAV is
not accepted (ten minutes of it is about 57 MB), so the recorder encodes first.
Video and audio are not scanned, like every audio and video object in the product
(`docs/CONTENT_SAFETY.md`). Keys are generated by the server
(`jam/<server id>/<song id>/<uuid>.<ext>`), never taken from the client.

The bucket's CORS policy must allow `PUT` and `GET` from the page's origin
(`docs/ATTACHMENTS.md`, section 4), because the audio engine `fetch()`es the
stems. The future public site (jam.pqp.gg) needs its origin added.

Media URLs on a track are presigned GETs valid for `ATTACHMENT_URL_TTL_SECONDS`
(12 hours by default), carried as `mediaExpiresAt`. A tab that outlives them
re-reads `GET /api/jam-songs/:songId`.

### A song's cover

A song may carry one picture, shown on its tile and in its panel header.
`JamSongSummary.coverUrl` is a presigned GET (null for a song with none), minted
when the summary was built and good for `ATTACHMENT_URL_TTL_SECONDS`, like a
track's `audioUrl`. Every list, detail and song frame signs it afresh, so the
query string changes on every read; the object key inside it never changes for a
given picture, so a client recognises "the same cover" by the URL's path and keeps
what it already drew (`useJamCover` in the web client). A cover that fails to load
(an expired signature on a tab that outlived it) falls back to the picture a song
without one has always had.

The flow is the track's own, with a different last step: `POST .../uploads` with
`kind: "cover"` (the author or a moderator only, so nobody else costs the bucket a
signed URL), `PUT` the bytes, then `PUT /api/jam-songs/:songId/cover` with the
`uploadId`. The claim HEADs the object (size and the signed type, as for a track)
and then reads the first 256 KB and checks the bytes ARE the picture type that was
signed (`lib/image-info.ts`, the share card's sniffer): a HEAD only reports what
the uploader claimed, and this is shown in other people's pages. The claim locks
the song row, so two covers set at once leave one.

Setting a cover is an edit, so it is gated by the flag, the timeout gate and the
author-or-moderator rule exactly like `PATCH /api/jam-songs/:songId`. Removing it
is not gated by the flag (a picture somebody should not see must stay removable
while the feature is paused): the fourth removal beside deleting a song, deleting
a track and taking a vote back. Both announce `jam-song-updated`, and a retried
call announces again: a frame is applied by id and is idempotent, and the retry
may be the first call whose summary read failed after the commit.

Cleanup. Replacing or removing a cover deletes the old object and its ledger row
after the commit, best effort and never awaited by the request. The sweep is the
backstop: a claimed `cover` ledger row that no song names after an hour, and the
cover of a deleted song after the same day's grace a deleted track's media gets.
The three cascades (channel, server, account) already name a cover's key, because
every object ever signed has a ledger row; and `jam_song_covers.upload_id`
cascades from the ledger, so an account deleted after setting a cover on somebody
else's song takes that picture with it.

Covers are NOT scanned for explicit content, like avatars, profile banners and
server pictures (`docs/CONTENT_SAFETY.md`). The author or a moderator can remove
one at any time, even with the flag off. Phones: both decoders skip unknown keys
(Kotlin `ignoreUnknownKeys`, Swift `Decodable`), so a shipped build keeps working
and simply shows no cover; showing one is `coverUrl` on the summary, nothing else.

## Realtime

Seven frames (`jamFrameSchema`): `jam-song-created`, `jam-song-updated`,
`jam-song-deleted`, `jam-track-added`, `jam-track-updated`, `jam-track-deleted`,
`jam-track-votes`. Each goes to every socket that did `join-channel` on the jam
channel (join-channel checks that they may see it), through the channel relay, so
it reaches viewers on the other API instance (`CLUSTER_BUS=postgres`). The track
frames carry the song's refreshed summary (counts, mix length). A vote frame
carries only the new count: **no frame names a voter**, and none carries anything
about the viewer, so a client gets its own votes from the detail read and from the
answer to its own vote. A change reaches the writer's own socket too: apply a
frame by id, idempotently.

The frames are in `CHAT_SERVER_MESSAGE_TYPES` (which is what lets the relay carry
them) and in `chatServerMessageSchema`, the union every client is typed against.
The web client applies them in `client/src/lib/jam-store.ts`; both phones leave
the channel out of their list, so the Android wire test names the seven as
deliberately ignored.

Frames go out after the write committed, from the route layer; a failure to
announce never fails the write.

## Storage lifecycle

- An upload nobody claims within an hour is deleted by the sweep (object, then
  ledger row; a cover upload too, and a cover a song stopped showing, see "A
  song's cover"). A deleted track, or a track of a deleted song, loses its objects a
  day after (`media_purged_at`). `sweepJamMedia`, every minute from `jobs.ts`,
  runs whatever the flag says, so switching the feature off never strands an
  object. A bucket outage leaves the row for the next pass.
- A song is created first and its first take uploaded after, so a closed page
  leaves a song with no track. Such a song is its author's alone: the list and
  the detail leave it out for everybody else, and its create and update frames
  are not sent (the first track is what announces it). `sweepEmptyJamSongs`
  (same job, same minute, rows only, `FOR UPDATE SKIP LOCKED`) deletes a song
  with no live track whose `updated_at` is over 24 hours old. Deleting the last
  track as the song's author or a moderator deletes the song too (frame
  `jam-song-deleted`); a guest's last take leaves the author's song empty, and
  the room is told with `jam-song-deleted` too (a `jam-track-deleted` would carry
  the summary the list now hides). The studio cleans up a song it made and never
  filled with `DELETE /api/jam-songs/:id?ifEmpty=true`, which is 409
  `jam_song_not_empty` when a take is in it, so a claim that committed without
  its answer is never deleted.
- Deleting a channel, a server or an account deletes the objects: the keys sit
  only on rows those deletes cascade, so they are read first (`jam-keys.ts`) and
  deleted after the commit, like attachments and soundboard clips. A person's
  tracks go with their account (`jam_tracks.author_id` cascades); the song they
  wrote stays as "Conta excluída" with everybody else's tracks.
- The type CHECK on `channels` gained `'jam'`, written like the forum block (no
  lock when it is already there, every lock error out so a contended boot
  retries); every table is new (pitfall 22). `db-boot-schema.test.ts` runs it
  under a held lock.

### The MP4 copy of a camera video (iOS and Safari)

Chrome records the camera as WebM, which AVPlayer on iOS and Safari cannot
play, so a take's video was blank on every iPhone. The worker therefore makes an
H.264 + AAC MP4 copy (`+faststart`, constant 30 fps, same duration, same time
zero) beside the original, and a track read offers it first.

- **Where it runs.** A `speech_jobs` row of kind `jam_video_transcode` keyed by
  `track_id`, queued in the transaction that inserts a track with a video, and
  by `enqueueMissingJamVideoTranscodes` (job `jam-video-backfill`, a minute)
  for every video recorded before this existed: newest first, never more than 10
  waiting, claimed ONE at a time in a lane of its own. A pass that finds
  nothing to queue means the backlog is over (a new video queues its own job in
  the claim), so the next scan waits half an hour; the scan reads
  `idx_jam_tracks_video_pending`, which holds only live videos with no copy. Only a process whose
  ffmpeg has libx264 and AAC claims it (the `worker` image; the API container
  never does), so with the worker down nothing breaks: the rows wait.
- **What it does with a file.** An MP4 that already is H.264 + AAC with the
  `moov` first and not fragmented is left alone (`last_error =
  'already-playable'`, no second object). The same codecs in MediaRecorder's
  fragmented MP4 are re-wrapped with the streams copied. Everything else (WebM,
  VP9 in MP4) is re-encoded: libx264 Main at the level x264 picks, CRF 23
  capped at 1800 kbps, scaled into 1920x1080 with even sides, AAC 96 kbps. It
  never trims, pads or shifts: the first frame and the first audio sample keep
  their times (pinned on real ffmpeg by `speech/video-transcode.test.ts`, a
  flash and a click found again in the output). A file is an untrusted input:
  it is read through a named demuxer with only the `file` protocol, never
  probed; the decoder refuses a header past 4K UHD before allocating the frame
  (`-max_pixels`), no allocation may pass 256 MiB (`-max_alloc`), the output
  stops at `JAM_VIDEO_MAX_BYTES` (`-fs`, the job then refuses it) and the whole
  pass is killed at ten minutes. The copy is streamed to the bucket from the
  file, never held in memory, and a copy that reached the bucket but could not
  be confirmed is deleted when the job gives up.
- **Reads.** `videoUrl`, `videoContentType` and `videoBytes` become the copy's
  once it is confirmed; `videoSources` lists every file, copy first, original
  last, each with its type, and the web player picks the first one
  `canPlayType` accepts. Until then, and whenever the columns are empty, a read
  is what it always was, so an older client and a worker that is down both land
  on the original.
- **Schema.** `jam_tracks.video_mp4_key`, `video_mp4_content_type`,
  `video_mp4_bytes` (nullable; the key is reserved before the PUT and the type
  written last, so a half-made copy is never offered); `speech_jobs.track_id`
  with the kind and the CHECKs widened, guarded like the Baú captions'.
- **Deletes.** The sweep, a channel, a server and an account delete take the
  copy with the original (`jam-keys.ts`); the job row cascades with the track.
- **Failures are visible.** `jamVideo` on `GET /api/admin/metrics`: `failed` (no
  copy and the job gave up: no picture on iOS) belongs at 0, `waiting`,
  `queue.oldestQueuedSeconds` (nothing is claiming) and `jobs24h`. Every failure
  logs `jamVideo.transcode.failed trackId=... attempt=... next=... reason=...`
  and a success `jamVideo.transcode.done`.

## Phones and older clients

Both native clients leave a channel type they do not know out of the list (iOS
`Channel.isListed`, Android `drawable`), so a jam channel is invisible there, not
a dead row, and the jam frames are dropped as unknown. An older **web** tab has
no such rule: it would draw the channel as text. Turn the flag on for one server
first.

## Not in this PR

Comments on songs, publishing a song publicly, server-side mixdown, a native
client UI (the web one is `docs/JAM_WEB.md`), audit-log actions for moderator deletes (the audit action list is typed on the
client, so adding `jam.*` is a client change too), hiding a blocked author's
tracks from the person who blocked them, a server-side signal for a new song in a jam nobody has open (the web client polls, `docs/JAM_WEB.md`), and
a place for a person's tracks in the account data export.
The two-API proof of the frames is `server/src/api/jam-two-process.test.ts`; the
rest of the behaviour is `server/src/api/jam.test.ts`, run against a fake object
store the real `lib/s3.ts` signs for.
