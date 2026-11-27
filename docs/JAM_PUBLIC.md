# Public jams

A public jam is a song anybody can listen to and watch at jam.pqp.gg without an
account. This page is the operator's: what the feature is, every rule it keeps,
how to turn it on, how to review and take things down, and what is and is not
scanned. The wire contract, with the meaning of every field and route, is
`packages/shared/src/jam-public.ts`. The private jam model it builds on (songs,
tracks, the timeline, uploads, `inMix`) is `packages/shared/src/jam.ts` and
`docs/JAM.md`.

> **Turning this on is a legal category change**, the same kind as
> `COMMUNITIES_ENABLED` (`docs/CONTENT_SAFETY.md` §Communities): the instance
> starts publishing user content to the open web, to people with no account.
> Read [What is and is not scanned](#what-is-and-is-not-scanned) before the flip.
> It ships dark and stays dark until Rafael says so.

## The model

Two ways a song becomes public:

1. **Standalone.** Any account starts one (`POST /api/jam-public/songs`). It
   belongs to no channel and no server.
2. **From a channel.** The song's starter (the account that created it) makes a
   channel song public (`PUT /api/jam-songs/:songId/public`). The song stays in
   its channel exactly as before. The public version is a view of it, never a
   copy.

The public version holds only the parts that are allowed to be there:

- **Consent.** Every person with a part answers for their parts in that song:
  "pode ir" (`yes`, audio and video), "só o áudio" (`audio_only`), or "não, só
  no servidor" (`no`). No answer is no. Making a channel song public asks
  everybody but the starter (a socket notice, and the durable list at
  `GET /api/jam-public/consents`). A part recorded on a song that is already
  public carries its answer in the add-track request (`publicConsent`); a
  channel member on an older client that does not send one stays out until they
  answer. Anybody can change their answer at any time; `no` takes their parts
  out of the next read.
- **The mix.** Only `inMix` tracks are public. A take from anybody but the
  starter that arrives through public access (somebody who is not in the song's
  channel, or any take on a standalone song) is created out of the mix: a
  request in the starter's inbox (`GET /api/jam-public/inbox`). The starter puts
  it in with one action (`PATCH /api/jam-tracks/:id { inMix: true }`), or turns on
  auto-accept for the song and the server does it once the platform's checks
  clear. The starter can remove any part either way.
- **Auto-accept.** A per-song switch of the starter, default off, no expiry
  (`PATCH /api/jam-songs/:songId/public { autoAcceptOutside: true }`,
  `jam_public_songs.auto_accept_since`). It replaces the starter's tap and
  nothing else, see [Auto-accept](#auto-accept-of-outside-takes).
- **Review.** A new account's first public jam and its takes on public jams wait
  for an operator (below).
- **Scans.** The cover and each part's video are public only after the scanner
  passed them (below). Until then a part's public version is its audio.
- **The origin server** is shown by default for a channel song (name and icon,
  linked to `/c/<slug>` only when the server is a public community). The starter
  can hide it (`PATCH /api/jam-songs/:songId/public { showOrigin: false }`).
- **Plays and likes.** Plays are counted once per song per address (signed out)
  or account (signed in) per clock hour. Likes are one per account; the count is
  always in the payload and the clients show it only above 1.

### Who may do what

| Action | Who |
|---|---|
| Publish a channel song, change "show origin" | its starter |
| Start a standalone public jam | any account |
| Unpublish | its starter, or a moderator of the origin channel (MANAGE_MESSAGES or MANAGE_CHANNELS), with an optional reason the starter is shown |
| Answer for a part | the part's author |
| Record a part on a public jam | any account, through the ordinary three upload steps; the song's `joinMode` still applies |
| Put an outside take in the mix, remove any part | the starter |
| Turn auto-accept of outside takes on or off | its starter, for that song only |
| Take a song down, remove a part, review, block | an operator |
| Like, report | any signed-in account |

Not allowed to publish or record publicly (403 `jam_public_blocked`): an account
an operator blocked, an account being deleted, and, on a channel song, an account
banned from its server. A song whose starter is blocked, banned from the origin,
being deleted or gone is not public; a part whose author is blocked or being
deleted is not public.

### Auto-accept of outside takes

Decision D3 of the Jam marketing plan. A song's starter may let outside takes in
without tapping Accept. The switch is per song, default off, and has no expiry;
it is not a list of accounts. It lives in the song's public settings sheet
("Música pública"), which the starter reaches from the song's `...` menu or the
status line under the title, and turning it **on** asks first, in plain words
(`jam.public.autoAccept.confirmBody`). Turning it off needs no question.

What it does and does not do:

- It only replaces the starter's own tap (`in_mix = true`). Every platform gate
  still applies, because the admission asks the reads' own rule
  (`publicTrackSql(t, false)`, `PUBLIC_SONG_SQL`) and then a few more:
  the take is not removed (an operator, the daily take limit), is not waiting
  for review (a new account's take, `JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS`), its
  author's answer is still a yes or "só o áudio", the song is public and not
  hidden by reports, unpublished, blocked or banned from its origin, its video
  (when it has one) **passed** the frame scan (so `pending`, `flagged`,
  `rejected`, `unscanned` and `skipped` all hold it, which means no scanner, no
  auto-accept for a take with a video), and the song's current picture is not
  flagged or rejected.
- Whatever holds a take leaves it in the starter's inbox exactly as before, and
  the take is admitted by itself when the hold clears: after an operator's
  approval (`adminReviewJam`), after a passing video scan
  (`jam-public-scan.ts`), when its author answers yes again, and from the
  minute sweep (`sweepJamPublic`), which is the backstop for everything without
  a hook of its own (a restart in the middle of any of it, a block lifted).
- Only takes recorded **after** the switch went on are covered
  (`auto_accept_since`); the requests already waiting keep waiting for a person.
- A take is admitted **once** (`jam_public_tracks.auto_admitted_at`, set in the
  same statement that sets `in_mix`, one claiming statement with
  `FOR UPDATE SKIP LOCKED`, so two processes cannot both do it). After that it
  is an ordinary part: the starter taking it out of the mix or deleting it, or
  an operator removing it (`remove-part`), stays that way, and so does turning
  the switch off and on again. A hand decision of the starter on a take
  (`PATCH inMix`) also marks it, so a take they took out is never put back.
- Turning it off stops future admissions and removes nothing already admitted.
  The switch-off and an admission cannot cross: the admission statement holds a
  share lock on the song's row (`FOR SHARE OF p`) and re-reads the switch under
  it, so a sweep that selected a take before the toggle either commits before the
  starter is told "off" or finds it off.
- The starter's hand on a take (`PATCH inMix`) writes its marker in the same
  transaction as the mix change (`updateJamTrack`'s `alsoInTransaction`): both or
  neither, so a failed write cannot leave a decided take eligible.
- Everything is audited (`auto-accept-on`, `auto-accept-off` by the starter,
  `auto-admit` by `system`) and counted (`takesAutoAdmitted` in the process
  counters). The starter is told with the existing `jam-public-notice` frame,
  kind `take`, `admitted: true`; the channel's open clients get the same
  `jam-track-updated` the starter's tap would have sent (the worker process has
  no socket layer and does not announce, the next read has it).
- The song page says it is on: `PublicJamSong.autoAcceptOutside` (the list and
  the detail, so jam.pqp.gg shows a line under "Como entra uma parte"), the
  starter's status line, and what an outside recorder is told in the studio.
  `jam.pqp.gg` never offers the switch; it is the starter's, in the app.

### Where a standalone song lives

A standalone song is a `jam_songs` row whose `channel_id` and `server_id` are
NULL (a guarded `DROP NOT NULL` in `schema.sql`, plus a CHECK that keeps the two
together). The alternative was a hidden container channel in a system server.
Reading every query that touches `jam_songs` decided it:

- every channel read filters `s.channel_id = $1`, which a NULL never equals, so
  a standalone song cannot appear in a channel's list, search or frames;
- the server and channel deletes collect keys by `channel_id` / `server_id`, so
  they never reach a standalone song either; the account delete collects by
  author, which is right for both;
- a container would be a server row, members and permissions that every
  server-wide read (sidebar, directory, member counts, permissions, exports)
  would have to learn to skip, which is a leak waiting for the first read that
  forgets;
- an old phone only ever reads songs through a channel, so it never meets a
  song with no channel. `JamSongSummary.channelId` / `serverId` became nullable
  in the contract, and are null only for a standalone song (and for the summary
  a non-member reads through public access).

Objects of a standalone song live under `jam/public/<song id>/`.

### Public access to the private routes

A person who is not in the song's channel reaches the private song routes
(`/api/jam-songs/...`, `/api/jam-tracks/...`) only while the flag is on and the
song is listed, or when it is their own standalone song. Then the write gate is
`jam_public` instead of `jam_channels`, nobody is a moderator, an add-track must
carry `publicConsent`, and a read shows only the public tracks plus the caller's
own, named by account (never a server nickname), with no channel or server id.
When a channel song stops being public, a non-member loses access to it and keeps
the right to delete their own take.

## Safety and abuse controls

### What is and is not scanned

| What | Scanned | How | Not public until |
|---|---|---|---|
| Cover | **yes** | the existing image scanner (`CONTENT_SCAN_PROVIDER`), on the worker, once per picture | it passed |
| Camera video of a part | **yes** | ffmpeg samples the first frame, then one every 5 s (at most 24); each frame goes through the same scanner. Only a process with ffmpeg claims the job | every frame passed |
| Audio | **no** | nothing here listens to audio, and Cloudflare's CSAM Scanning Tool is not documented to cover audio either (see [the edge Worker](#media-urls-and-the-edge-seam)) | (never checked) |
| Titles, artists, labels | the built-in text filter is not applied | | |

- With **no provider configured** the cover and the video are recorded
  `unscanned` and are simply not public: the song is public with no picture and
  its parts as audio only.
- A **flag** is not public (a public site is stricter than a channel) and files
  a report to the instance queue.
- A **rejection** takes the cover off the song, or the video off the track, in
  its channel too, keeps the object as evidence (`jam_public_quarantine`, outside
  every sweep and every cascade delete), and files a report to the instance
  queue. Labelled `illegal` or `csam_suspected`, it is logged as
  `ILLEGAL-CONTENT MATCH` and never deleted automatically
  (`docs/CONTENT_SAFETY.md` §"Runbook: an illegal-content hit"). Other
  rejections expire after `CONTENT_SCAN_QUARANTINE_DAYS`.
- A scan **error** is retried three times, then recorded `unscanned` with a
  `scan_error` label: not public.
- **Nothing is judged before its upload URL expired** (the presigned PUT lives
  15 minutes): judging bytes that can still be replaced would judge the wrong
  bytes. So a new cover or video is public at the earliest about 16 minutes
  after it was uploaded, plus the job's tick.

### Reports

Any signed-in account can report a public song or one part of it
(`POST /api/jam-public/reports`). Signed in only: in `reports`, a NULL reporter
means "a scanner said so", and an anonymous door would let anybody file as one.
The report lands in the **instance** queue (`server_id` NULL, `context_kind`
`none`, the part's author or the starter as the person, `channel_label` "Jam
pública · <title>"), never in a server owner's queue. A song reported by
`JAM_PUBLIC_REPORTS_TO_HIDE` (default 3) distinct people inside
`JAM_PUBLIC_REPORT_WINDOW_HOURS` (default 24) is hidden until an operator looks;
reports filed before an operator's decision do not hide it again.

### Copyright reports

`copyright` is one of the shared report reasons (`REPORT_REASONS`, so the app's
report dialog, the site's "Problema de direitos autorais" items and the phones all
offer it). Filed on a public jam it behaves exactly like any other reason on a
public song: it goes to the instance queue (`reports`, reason `copyright`), counts
toward the auto-hide like any report, and is also counted on its own:
`copyrightReports` on each song of `GET /api/admin/jam-public/songs` and of the
queue (distinct reporters, same window). A song with a number there is the one to
open first. Server-side nothing is routed differently for it.

Where somebody publishes or records, one plain line says "only post what you made
or have the right to share", with a link to the Terms (`/terms`, whose "Direitos
autorais e outras notificações legais" clause is the notice address,
`contato@pqp.gg`): in the app's "Tornar pública" sheet and in the site's
record and start sheets. The Terms page has no section anchors, so the link opens
the page and not the clause.

**There is no DMCA agent and none is claimed.** pqp is not registered with the US
Copyright Office; the Terms clause is what it is. A rights holder writes to
`contato@pqp.gg` or uses a report, and a person reads it.
Accepted as a launch gap, see [Launch gaps accepted (2026-11-20)](#launch-gaps-accepted-2026-11-20).

**Takedown, step by step, when a copyright report arrives** (instance queue,
`GET /api/reports/instance`, or `copyrightReports` above):

1. Open the report. It names the song (details: "Jam pública <songId>", and the
   part when it is one) and the reported account. Listen to the part.
2. **One part is the claim** (a recording of somebody's song, a sample): take that
   part out with `PUT /api/admin/jam-public/remove-part { trackId, reason }`. The
   track stays in its song and channel, the rest of the jam stays up, and its
   author is told with the reason. Write the reason in plain words ("direitos
   autorais, a pedido do titular").
3. **The whole song is the claim** (a cover of a whole recording, the starter's
   own track): `PUT /api/admin/jam-public/unpublish { songId, reason }`. It leaves
   every public read at once and the starter is told; they cannot republish it.
4. Close the report in the instance queue as `actioned` (or `dismissed` when the
   claim does not hold) with a note, and answer the person who wrote in.
5. A repeat offender: `PUT /api/admin/jam-public/block { userId, blocked: true,
   reason }`. Every song and part of theirs leaves the public reads.
6. If the claim comes with a court order or a formal legal notice, that is the
   Terms' "other legal notices" path, not this one: keep the evidence, do not
   delete anything, and ask Rafael.

Every one of these writes a `jam_public_audit` row, which is the record of what
was taken down and when.

### New accounts

An account younger than `JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS` (default 72) may
listen, like and report. Its first public jam is published in `review`, and its
takes on public jams are `review: pending`: invisible publicly until an operator
approves. Approving a song also approves its starter's own pending takes in it.
After one approved jam the account's later songs go straight out; its takes keep
going to review until it is old enough. The age gate is whatever the account gate
already enforces; nothing here stores an age.

### Limits

Per account, counted in Postgres (exact across the two API containers):

| Variable | Default | What |
|---|---|---|
| `JAM_PUBLIC_SONGS_PER_DAY` | 5 | first publishes (standalone or channel) per 24 h |
| `JAM_PUBLIC_TAKES_PER_DAY` | 30 | takes recorded on public songs per 24 h |
| `JAM_PUBLIC_LIKES_PER_MINUTE` | 30 | likes and unlikes per minute (a cluster bucket) |
| `JAM_PUBLIC_REPORTS_PER_DAY` | 20 | public jam reports per 24 h, under the existing 10 an hour report cap |

Every refusal is 429 `jam_public_rate_limited`. The take limit is also enforced
where a take becomes public, under a per-account lock: a take that gets past the
route's check in a race is recorded as removed from the public version (it stays
in its song), never public. A take added to a published song while the flag is
off stays private until the starter publishes again (fail closed). The public routes have their own
address-keyed buckets under the anon backstop (config 30, list 60, song 120,
play 30 in a burst).

Plays never cost a write per request: a per-process memo drops a repeat inside
the hour, and what is left is flushed every 5 s as one statement into
`jam_public_play_marks`, whose primary key (song, viewer, hour) is the dedupe on
both machines at once. Only rows that actually inserted move `plays_count`. A
viewer is an HMAC of the account id or the address, never either in the clear;
marks older than three hours are swept.

### Privacy

A public read names a person by display name, handle (when claimed) and avatar,
the three things `pqp.gg/@handle` already shows, and nothing else: no account
id, no email, no presence, no server membership, no server nickname. Song and
track ids are random and name no account. `api/jam-public.test.ts` walks every
public payload and fails on any key the contract does not name.

Deleting an account, a track or a song, answering `no`, an unpublish, a takedown
or a block removes it from every public read at once: nothing public is cached in
the API. Answers carry `Cache-Control: public, max-age=60` (list) and `30` (a
song), the bound for a shared cache in front.

**Known limit:** with media served as presigned URLs (the default), a channel
song's object keys are `jam/<server id>/...` and the URL shows them, so the
origin server's id is readable in a media URL even when the starter hid the
origin. The edge Worker below encrypts the key and closes this.

### Media URLs and the edge seam

Media URLs are short-lived GETs (good for at least 50 minutes, identical inside a
ten-minute window so a shared cache can hold a page). Today they are presigned
bucket URLs. `JAM_PUBLIC_MEDIA_BASE_URL` (unset by default) switches them to
`<base>/jam-media/<token>?e=<exp>&s=<sig>`, for the edge Worker in
`tools/jam-media-edge/` (its README is the deploy and rollback runbook). The
token is the object key encrypted, so the URL names nothing, and the Worker
accepts exactly this shape: setting the variable is the only switch, unsetting
it is the rollback. The Worker checks the signature, the expiry and that the
decrypted key is under `jam/`, then serves GET and HEAD with ranges from the
bucket through the colo cache. It holds the derived secret as
`JAM_PUBLIC_MEDIA_SECRET`, never the Clerk key, and
`openJamPublicMediaUrl` in `jam-public-media.ts` is the reference it ports, pinned
on both sides by `tools/jam-media-edge/test/golden.json`.

**A removal reaches the Worker only as the URL's expiry.** The API stops handing
out a removed song's or part's URL at once; a URL already out works until its
own `e`, so an unpublish, a withdrawn consent, a removed part, a block or a
quarantine stops being served **within 60 minutes**; an object deleted from the
bucket within 10 minutes (the Worker's cache lifetime). The Worker's
`MEDIA_SERVING=off` switch is the faster lever for an emergency.

#### What this does and does not do for scanning

The reason the Worker exists is that Cloudflare's CSAM Scanning Tool works on
content served through a zone's cache, which a bucket's own endpoint is not.
Read against Cloudflare's documentation (2026-11-14), and no further than it goes:

- **Public audio stays unscanned.** The tool's documentation names images and
  never mentions audio, and nothing of ours listens to audio. The Worker changes
  nothing about that.
- **Video is not documented as covered.** Our own control is the ffmpeg frame
  sampling in the table above.
- **Covers** are scanned by our image scanner before they are public; the
  Cloudflare tool, if it applies, adds a hash-list check of the same pictures.
- **Whether the Worker's cached responses are in the tool's scope is not
  confirmed**: the documentation says nothing about Workers or the Cache API.
  The runbook (README step 4.3) asks Cloudflare support. Until it is answered
  in writing, the tool is not to be described as covering public jams.
  Accepted as a launch gap, see [Launch gaps accepted (2026-11-20)](#launch-gaps-accepted-2026-11-20).
- It is a serving-path control: a daily email with file paths and a block "if
  possible". It cannot stop bytes landing in R2.

The Worker has one effect that is not about scanning: it closes the known limit
above, because the encrypted token hides the origin server's id.

### The listening copy (`jam_audio_copy`)

Public playback used to download every stem as FLAC before the first sound: a
three minute, five stem song is about 54 MB. Behind the runtime flag
`jam_audio_copy` (global, default off, `docs/FEATURE_FLAGS.md`) the worker makes an
Opus copy of each FLAC stem and the public reads offer it to listeners. Design,
measurements and rollout: `docs/JAM_ENGINE.md` §"The listening copy".

- **What a public read says.** `GET /api/public/jams/:songId` adds
  `audioSources` to a track whose copy is confirmed: `[ { url, contentType:
  "audio/ogg", codec: "opus", bytes }, { url, contentType: "audio/flac", bytes } ]`,
  the copy first and the original last, both public media URLs
  (see the edge seam above: the copy's key is under the same `jam/` prefix, ends in
  `.listen.ogg`, and passes the Worker's allowlist). `audioUrl` is still the
  original. The key is **absent** (not empty) with the flag off, for a track with no
  copy yet, and for a failed one, so an older client and the flag off read what they
  always read. The in-app public view (`GET /api/jam-songs/:songId` for somebody who
  is not in the channel) carries the same list; a member of the channel reads the
  whole song with no list, and the studio never uses one.
- **Privacy and consent are unchanged.** The copy is derived from the very bytes of
  the public stem and is offered only where the stem is: the same `publicTrackSql`
  decides, so an unpublish, a withdrawn consent, a removed part, a block or a
  deleted account takes the copy out of the very next read exactly as it takes the
  original. A URL already handed out lives its own expiry (at most an hour), the
  bound above. Audio, copy included, is not scanned (see "What is and is not
  scanned").
- **Cleanup.** The copy's key is reserved on the track's row before the object is
  uploaded, so the purge sweep and the channel, server and account deletes
  (`jam-keys.ts`) remove it with the track, made or half made; a copy that finishes
  after its track was deleted deletes itself. Nothing is quarantined: only video
  and covers are scanned.
- **What the phones would need.** `ios/` and `android/` do not read `audioSources`
  and keep playing `audioUrl`, which is correct and unchanged. To use the copy,
  Android reads `audioSources`, prefers an entry with `codec: "opus"`, and falls
  back to `audioUrl` on any decode or HTTP failure (ExoPlayer and MediaCodec play
  Ogg Opus); iOS has no dependable Ogg Opus decoder before recent releases
  (`AVAudioFile` reads Opus in CAF, not Ogg), so it needs either a second copy in
  CAF or an Opus decoder in the app, which is why this change leaves it alone. Both
  must keep the stem's placement numbers exactly as they are: the copy is
  sample-aligned with the original (the worker verifies every copy's length), so
  nothing in `offsetMs`, the trims or `gain` changes.

## In the app

All of it hides behind `GET /api/jam-public/config` (`enabled`, `publishing`,
`uploads`), read once per account (`lib/jam-public-store.ts`). Flag off or an API
that predates it: no menu entry, no strip, no shelf, no toast.

| Where | What | Code |
|---|---|---|
| A song's `...` menu (its starter, channel song) | "Tornar pública", a sheet that says what becomes public (audio, video when allowed, names), the show-origin switch; once public the same entry is "Música pública": status, who answered what, outside requests waiting, the show-origin switch, the auto-accept switch ("Aceitar partes de fora sozinho", asks before turning on), unpublish | `jam-public-sheet.tsx`, `hooks/use-jam-publication.ts` |
| The Jam wall | a quiet row when songs wait for the person's answer (`/consents`) or outside takes wait for them (`/inbox`); with every waiting part on ONE song the button opens that song, else a dialog. A tile with parts waiting carries an accent pill ("N esperando") | `jam-public-waiting.tsx`, `jam-tile.tsx` |
| Communities (the compass) | for a starter with no Jam channel, a row above the Jam door, "N partes esperando tua resposta", drawn only while something waits | `JamWaitingRow` in `communities-view.tsx` |
| A song with a part of mine, made public | the three answers (pode ir, só o áudio, não) in the song itself too | `jam-public-parts.tsx`, `jam-public-panel.tsx` |
| The starter's song | "N partes esperando tua resposta", an accent-bordered block at the TOP of the song, above the stage (it used to sit below it and a starter needed six minutes to find it): outside takes listed apart from the band; "Ouvir com a banda" is the lane audition (in place of the same instrument, the rest playing), then Aceitar (`inMix: true`) or Recusar (delete) | `JamPublicRequests` |
| `/app/jam/<songId>` | the public view: the song panel, stage, lanes and studio of the channels, held in the jam store under `publicJamKey` (not a channel id), so there is no list, no frame and no reconnect read for it. Like (the count shows above 1), plays, origin, copy link, report the song or one part, "Gravar minha parte" | `jam-public-view.tsx` |
| `/app/jam/new` | the start sheet, then the studio; the first take creates a standalone public jam (`POST /api/jam-public/songs`) | `use-jam-studio.ts` (`standalone`) |
| The studio on a public jam | says whether the take is public or arrives as a request, one switch for the video, sends `publicConsent` | `jam-studio.tsx` |
| The wall, under the songs | a "Públicas" row (`sort=top`, ten, minus the channel's own) and a link to the public site; the channel's own songs get a header only when both sections exist | `jam-public-shelf.tsx` |
| Anywhere | `jam-public-notice` frames (a nudge: read again) become one toast, with "Responder" or "Ver"; the take notices (below) are a card in the same corner, persistent until answered | `jam-public-host.tsx`, `jam-take-notice-cards.tsx` |

The view is a full-screen layer over the app, mounted once by `App`
(`JamPublicHost`), and `syncRoute` leaves the address alone while it is open.
Opening one from anywhere is `openPublicJam` in `lib/jam-public-nav.ts`.

Reports go through the ordinary report dialog (`kind: "jam_public"`). Nothing here
needs a server change.

Not in this PR: a list of all public jams inside the app (the shelf links to the
public site), the operator's review screens (they are in the dashboard), and
votes on public songs (the contract has none).

## Telling the starter (`jam_take_notices`)

Launch user test, round 2, finding N1: a stranger sent a part to a public song and
its starter needed 376 seconds and about 45 actions, by luck, to find it. Nothing
had told them. Three things changed, and one thing about `needs`.

**1. A waiting take is a notice, in the app's own mechanism** (the one the
watch party waitlist and story notices use: a durable row the app reads, a live
frame, a push; no email and no broadcast push).

| Kind | To | When | Item says |
|---|---|---|---|
| `take` | the song's starter | an outside take arrived and waits for their answer (not when auto-accept already put it in) | the song and the instrument; a burst is ONE item with a count |
| `accepted` | the person who sent it | the starter put it in the mix (`PATCH inMix: true`), or auto-accept did, more than 30 s after it was sent | the song and the instrument |
| `refused` | the person who sent it | the starter deleted it while it waited | the song and the instrument |

- **Durable:** `jam_take_notices` (`schema.sql`), one OPEN row per (person, song,
  kind) (a partial unique index). The second take on a song raises `count` and
  adds its instrument instead of making another item, which is the batching. A
  `take` item's count and instruments are read LIVE from the takes still waiting
  (`GET /api/jam-public/notices`), so answering them empties it and it needs no
  clean-up; the stored ones are only what it said when last touched. Spent by
  `POST /api/jam-public/notices/ack { id }` (the card's button or X); answered
  items are swept after a week, unanswered ones after sixty days.
- **Live:** the starter's is the existing `jam-public-notice`, `kind: "take"`, now
  with `instrument` (additive). The sender's is a frame of its own,
  `jam-take-decision`: `jam-public-notice` reads an unknown `kind` as `consent`
  (`.catch`), so a tab that had not reloaded would have shown the sender a consent
  question. A new frame type is ignored by every old client. Both go to every socket
  of the account on every instance (`CLUSTER_BUS`); a lost frame costs nothing,
  the card is on the next read (boot, a reconnect, any frame).
- **Push:** the existing path (`push.ts`, `sendJamTakePush`), kind `jam` in
  `product.pushSkipped`. A person with a live socket anywhere in the cluster, a
  stored DND, or an explicit mute (`none` on the song's channel or server, or the
  account's `default`; the account-wide `mentions` default does NOT silence it, it is
  about their own song) gets none. Copy in the person's language (pt-BR, en, es),
  the song's title as the title, the instrument, never who sent it; one live
  notification per song and kind (`tag`). A tap opens `/app/jam/<songId>`. The
  native apps do not parse that path: their tap opens the app (see the PR).
- **Never told:** the person who recorded it; a recipient who blocked the other
  (one direction, `notBlockedSql`'s rule). The take still waits in the starter's
  inbox either way. See "A block and the notices" below for what that covers.
- **Two machines:** a take lands on exactly one (that is its HTTP request), so the
  frame is sent once and crosses the bus; the row upsert is the push CLAIM
  (`pushed_at`, at most one push per item per 30 minutes, decided inside the one
  statement), so two machines racing on the same song push once. Pinned by
  `server/src/ws/jam-take-notices-cluster.test.ts` on the real bus.
- **Nothing between BEGIN and COMMIT touches the network** and nothing here throws
  into the take's request: the take was stored first, a notice that fails is a nudge
  not given (`takeNotices.failed`).
- **The flag** `jam_take_notices` (global, default ON, `JAM_TAKE_NOTICES=false` is the
  environment off; it is strictly additive). Off is off all the way: no item, no
  decision frame, no push, `GET /notices` answers an empty list, and **no live
  `jam-public-notice` of kind `take` either** (the frame is the live half of the item;
  the web used to draw its old toast from it when there was no item, which is what
  "off" left behind). The persistent markers below and the `needs` rule are not
  behind it, and neither is the inbox, so with the flag off the waiting strip and the
  song's block still list every waiting part, and they do not need the notice to stay
  live: the web re-reads the inbox when a `jam-track-added` / `-updated` / `-deleted`
  frame (or a `jam-song-deleted` for a song in its inbox) arrives for a song the
  viewer started (`scheduleWaitingRead` in `client/src/lib/jam-public-store.ts`,
  debounced 400 ms, one read in flight and at most one queued behind it). Any client
  that applies jam frames should do the same: the frame is the signal, the inbox is the state. The `admitted: true` frame auto-accept sends is not a request notice and
  is not behind this flag (it is behind the block rule below).

### A block and the notices

Rule: **a block silences the nudge, never the state.** The same split `blocks.ts`
makes for messages: "someone you blocked still sees your messages in a shared
server, blocking is not a way to hide from people", and what the block does is
decide "whose feed it may enter" (`notBlockedSql`, one direction). A shared
server's history is deliberately not filtered, because the person has to be able
to see and act on what is there; the client collapses it and nothing pings. Here:

| Surface | Starter blocked the sender |
|---|---|
| Durable `take` item, its count and instruments | none written; and a part from a blocked person is not counted in an item somebody else's part opened, so an item whose only waiting parts are from blocked people is spent |
| Live `jam-public-notice` (`take`), and the auto-accept `admitted: true` one | not sent (it is the live half of the item) |
| Push | not sent |
| The inbox (`GET /api/jam-public/inbox`), the waiting strip, the tile pill, the song's "N partes esperando" block, `pendingTakes` | **listed.** It is the starter's worklist: the part is also readable in the song's own track list, so hiding it here would hide nothing and only remove the one-tap Aceitar / Recusar. These read state, which is why a blocked part counts there and not in a card |
| Accept and Refuse | work as for any part; the answer to the sender (`accepted` / `refused`, and the late `accepted` of an auto-accept) is the sender's own feed and is not stopped by the starter's block |

A blocked sender is not told they are blocked: nothing about their side changes.
Pinned by `jam-take-notices.test.ts` (three cases) and `jam-frame-coherence.test.ts`
(two processes, the starter's socket on the other machine from the take).

### A frame is a read

Rule: **every frame that carries a song summary carries the one the same viewer's
read would return at that moment, and every frame that carries a track carries a
track that read has.** One function builds the summary for a read and for a frame,
`getJamSongSummary` (channel view; `getJamSongSummaryPublicView` is for the non-member
and has no frames), and a frame is built after the write it describes has fully
landed, not before.

The bug this rule was written for: `jam-track-added` carried `result.song`, read
inside `addJamTrack`, but a take's PUBLIC row (the `outside` flag the summary needs
to leave a waiting take out of `instruments` and `missingInstruments`) is written
afterwards by `noteJamTrackAdded`. At that moment an outside take still looked like
a member of the band, so every client that applied the frame (web, iOS, Android) drew
the song as filled ("pronta", the wrong "falta ...", an extra instrument icon, an
extra row in "Faixas") until the wall was read again, while every read said the
opposite. Now the route reads the summary and the track together, from one snapshot
(`getJamSongAndTrack`), after `noteJamTrackAdded` returns (which also settles an
auto-accept that put the take in the mix inside that call), for the frame and for
the sender's own answer. Only an outside take on a published song can differ from
what `addJamTrack` read (for anybody else the public row changes nothing the summary
says), so only those adds pay the extra read. A retry of the claim answers 200 and
announces the take again: a frame is applied by id, and the retry may be the first
request whose post-write read worked (the one before it committed and then failed),
so no other viewer would otherwise ever hear of the take. Every other
frame (`jam-track-updated`, `jam-track-deleted`, `jam-song-updated`, the admission
announcer) already read the summary after its own commit and needed nothing;
`jam-song-created` is never sent for a song with no track, `jam-song-deleted` and
`jam-track-votes` carry no summary.

**Is a waiting outside take broadcast to the channel as a track?** Yes, and it is
decided by the reads, not by the frame. Evidence: a member of the channel reads the
whole song (`seesWholeSong`): `GET /api/jam-songs/:id` returns every live track
through `listJamTracks`, the waiting take with `inMix: false` among them, and the
list's `trackCount` counts it; the public view (`listJamTracksPublicView`, only
in-mix public tracks plus the viewer's own) is for people who are not in the channel,
and they receive no channel frames at all (`join-channel` is refused). A waiting
take is, for the room, what a member's own second take of an instrument already is:
a lane that is not in the mix yet. So the frame to a member adds exactly what that
member's read has, and to the stranger nothing: sending it to "the starter and the
sender only" would leave every other member's wall one take behind their own next
read. If that should ever change (a take nobody has accepted, or an operator has not
reviewed, being invisible to the room), the change is in `listJamTracks`, the
channel summary and the frames together, never in the frames alone. Note for that
decision: today a member can read, with its signed URL, a stranger's take that is
still waiting for the starter or for review.

Pinned by `server/src/api/jam-frame-coherence.test.ts`: two real API processes on
`CLUSTER_BUS=postgres` and `VOICE_REGISTRY=postgres`, real sockets for the starter
(on one machine) and another member (on the other) and one for an outsider, and for
every frame each viewer receives, that viewer's own read (the song's detail and the
channel's list) compared field for field, for an in-mix take, a waiting outside
take, an accept, an undone accept, a refusal, and a song edit with a take waiting.
It fails on the old code with exactly the reported `instruments: ["guitar","bass"]`.
It also checks the sender's answer against the sender's own read.

**2. Where a starter finds it without a notice.** "N partes esperando tua
resposta" is now an accent block at the top of the song, above the stage, with the
takes listed first and Aceitar / Recusar in view; the wall's row opens the song
when every waiting part is on one song; a tile carries a pill; and a starter with
no Jam channel gets a row in the Communities directory. All of it reads the
starter's inbox (the state), not the notice, so it stays when the flag is off.

**3. A pending take does not fill `needs`.** `needs` and `missingInstruments`
(`JamSongSummary`, `PublicJamSong`) used the instruments of EVERY live track, so
one outside take waiting for the starter emptied what the song asks for and took
it out of "Falta alguém" and the site's "wants a part" selection while nothing was
in the mix. The instrument list now leaves out a track that is outside, public and
out of the mix, in the channel summary (`summarySelect` in `jam.ts`), the public
song (`live` in `jam-public.ts`) and the `?needs=` filter. The summary's
`instruments` follows (it is what the band lanes and the web client's
`songNeed` read), so the pending part is not a lane either until it is accepted.
`missingInstruments` has been on the wire since #1579; the phones read it first and
fall back to `instruments`, so both paths agree now.

**3b. An "entrou" item goes when its part does** (round 3, N-5). `listJamTakeNotices`
reads an `accepted` item against the sender's own parts on the song: while none of
them is live and in the mix (the sender deleted it, or the starter took it back out
of the mix, the "Desfazer" below) the item is spent instead of announcing a part
that no longer exists. The client reads again after a delete of its own.

**4. The sender is told how they will hear back.** The after-send copy (the studio's
done screen, the song's status line, the send hint) says that the starter's answer
arrives as a notification here, and on the phone when notifications are on.

**Counters** on `GET /api/admin/metrics`, `jamPublic.process.takeNotices` (per
process, sum the machines): `created`, `merged` (a take folded into an open item),
`byKind`, `decisionFrames`, `pushClaimed` (a push the item claimed), `pushTried`
(of those, reached a device attempt; the rest hit DND, a mute or an open socket,
see `product.pushSkipped.jam`), `pushHeldBack`, `skippedBlocked`, `skippedFlagOff`,
`acked`, `failed`. `jamPublic.takeNoticesOpen` is the unanswered items right now.
Healthy: `created` follows `takesRecorded` for outside takes, `failed` is zero.

## Tuas músicas, the starter's answer, and where notices may draw (round 3 minors)

**Tuas músicas** (`/app/jam/mine`, `components/jam/jam-mine-view.tsx`, `lib/jam-mine.ts`)
is a returning person's one place for what they made: the public songs they
started (`GET /api/jam-public/mine`, each with how many parts wait for their
answer) and the parts they sent to other people's songs
(`GET /api/jam-public/my-parts`, new: `jamPublicMyPartsResponseSchema`), each in
one of `waiting`, `in`, `refused`. A refusal has no row to read once the delete
has happened, so the starter's delete of a waiting outside take stamps
`jam_public_tracks.declined_at` (whatever the notices flag says: a notice is a
nudge, this is a record); the list shows it for thirty days. The sender's own
delete of a waiting take is neither, it is gone; a song unpublished or removed
takes its parts off the list. Doors: the site's account chip (`?jam=mine`, a
`mine` jam intent in `lib/jam-intent.ts`), the Jam wall's header and the
compass's Jam row. It has "Ver no site" and a back arrow that leaves for the site
when the visitor came from it. **`restarts-api`**: the endpoint, the column and the
route are server changes.

**After Aceitar and Recusar** (`jam-answer-notice.tsx`) the starter is told what
happened where they answered: "entrou na música, já aparece pra quem abre ela, no
site e no app", with "Desfazer" for eight seconds (`PATCH inMix: false` on the same
take: it goes back to the queue, and the sender's "entrou" item is voided by §3b),
or "Parte recusada", with no undo (a declined take is deleted and the API cannot
bring it back).

**Where a Jam notice may draw** (`lib/jam-notice-placement.ts`, N-1). One at a
time: the toast holds the cards back, only the newest card is drawn with "Mais N
esperando depois dessa". Never over a transport: with the studio open nothing is
drawn (it waits), over a public view the card is drawn in the flow above the song
(`noticeSlot`), over a channel's own song panel it waits, and the corner queue
yields while one is up (`JamHintContext.notice`). On a desktop it sits at the
bottom right where the corner cards are, not at the top where the app's own
buttons are.

**The share message** (`lib/jam-share-text.ts`, N-2): `jamStillNeeds` is the one
rule for what a song still asks for (the server's `needs` is the same list), the
sent card and the song page's share button both pass the sender's own waiting
parts (`pending`), and the message says that the part "entra quando quem começou
aceitar" and asks only for what is still missing.

## Launch gaps accepted (2026-11-20)

Owner decision, 2026-11-20. These are known gaps. Rafael accepted them for
launch, to be followed up after the flag goes on. None of them blocks it.

- **Custom domain.** `jam.pqp.gg` is not yet added as a custom domain on the
  Pages project `pqp`. The site answers at `pqp.gg/jam` (`docs/JAM_SITE.md`).
- **Cloudflare's CSAM tool and the edge Worker.** There is no written answer
  from Cloudflare yet on whether its CSAM Scanning Tool covers the edge media
  Worker's cached responses. `JAM_PUBLIC_MEDIA_BASE_URL` is unset, so the Worker
  is not in the path, and public media is served from presigned bucket URLs that
  the tool does not see. Do not describe the tool as covering public jams.
- **Audio and text.** Audio is never scanned. Titles, artists and labels skip the
  text filter. Song pages are `index, follow`.
- **No DMCA agent.** Reported takes are reviewed and taken down by hand, per
  [Copyright reports](#copyright-reports) and the [runbook](#take-something-down).
- **No total storage quota per account.** Only per-file sizes and rates limit what
  one account can store. As the code has them today: audio 32 MiB per file
  (`JAM_AUDIO_MAX_BYTES`), video 100 MiB (`JAM_VIDEO_MAX_BYTES`), cover 4 MiB
  (`JAM_COVER_MAX_BYTES`), a part at most 10 minutes
  (`JAM_TRACK_MAX_DURATION_MS`), 30 uploads and 10 new songs per 10 minutes
  (`JAM_UPLOADS_PER_WINDOW`, `JAM_SONGS_PER_WINDOW`, `JAM_WINDOW_MS`), and per 24
  hours 5 public songs and 30 public takes (`JAM_PUBLIC_SONGS_PER_DAY`,
  `JAM_PUBLIC_TAKES_PER_DAY`, [Limits](#limits)).
- **Phones.** The iOS and Android apps have no public jam. A public jam link
  opens the web.
- **Labels.** A take cannot be labelled from the web UI, although the API
  supports labels.

### Checked in production, 2026-11-20 (read only)

- The content scanner is configured (`CONTENT_SCAN_PROVIDER=openai` with its key)
  on both API containers and on the worker.
- ffmpeg is present in the worker image.

**Not yet proven:** a jam cover passing through the scanner end to end, because
nothing is published. The first check after the flag goes on is
`jamPublic.scans.covers` on `GET /api/admin/metrics`.

### Still gating the flag

Code fixes from the 2026-11-20 persona QA, all merged:

- The sign-up sheet that stayed dead after Escape on the public site, and the
  site's other QA findings (#1708).
- The link preview: a jam card for songs with no cover, and a stable cover
  address instead of a signed URL in `og:image` (#1707, `restarts-api`).
- Bidirectional and invisible text in titles, artists and labels, and studio
  messages that were not true (#1710, `restarts-api`). Its site follow-up, the
  legacy bidi controls in the page head and invisible-only titles, is #1717. The
  native isolation in the iOS and Android jam screens is #1716.

No code fix from that QA is known to be open. What is left is the owner's go
(the runbook below) and the first scanner check after the flag goes on. `jam_public`
is off, and turning it on is the owner's decision.

## Runbook

### Turn it on

1. Rafael's go, and the content safety read above.
2. Check `CONTENT_SCAN_PROVIDER` is set on the API and the worker, and the worker
   image has ffmpeg (`<sha>-worker`). Without them covers and videos stay
   private (honest, but the site looks bare).
   Verified in production on 2026-11-20; see [Launch gaps accepted
   (2026-11-20)](#launch-gaps-accepted-2026-11-20) for what is still unproven.
3. Optional, and before the flip rather than after: the edge media Worker
   (`tools/jam-media-edge/README.md`, deploy, the Cloudflare dashboard steps,
   then `JAM_PUBLIC_MEDIA_BASE_URL` on the API). It is not a prerequisite, and
   it does not make audio scanned (above).
   Left out at launch by decision, see [Launch gaps accepted
   (2026-11-20)](#launch-gaps-accepted-2026-11-20).
4. Controles → interruptores → `jam_public`, or
   `PUT /api/admin/flags { key: "jam_public", enabled: true }`. Global, no
   restart. The website reads `GET /api/public/jams/config`.

**Rollback is the flag off.** Every public route stops being a route, every write
is refused, and nothing about channel jams changes. Removals (unpublish, a `no`,
unlike, deleting a track) keep working with it off.

### Review

`GET /api/admin/jam-public/queue` lists songs waiting (`review`: a new account's
first; `hidden`: reports), takes waiting, and videos the scanner flagged or
rejected. Decide with `PUT /api/admin/jam-public/review
{ kind: "song" | "track", id, decision: "approve" | "reject", reason? }`. A
report's moderation record is in the ordinary instance queue
(`GET /api/reports/instance`), where it is closed like any other.

### Take something down

- A song: `PUT /api/admin/jam-public/unpublish { songId, reason }`. Out of every
  read at once; the starter is told and cannot republish. Restore with a `song`
  approve.
- One part: `PUT /api/admin/jam-public/remove-part { trackId, reason }`. The
  track stays in its song and channel.
- A person: `PUT /api/admin/jam-public/block { userId, blocked: true, reason }`.
  Every song and part of theirs leaves the public reads; they cannot publish or
  record publicly. `blocked: false` undoes it.
- Something illegal: the quarantine already holds it; follow
  `docs/CONTENT_SAFETY.md` §"Runbook: an illegal-content hit".

Every one of these writes a `jam_public_audit` row. Full route table:
`tools/admin-dashboard/README.md` §"jams públicas".

### Watch

`GET /api/admin/metrics` → `jamPublic`: published, waiting for review (songs,
takes), hidden by reports, removed, total plays and likes, cover and video
verdicts by status, quarantined objects, and since this process started:
publishes, auto-hides, reports filed, plays counted and deduped, scan outcomes,
and refusals by limit (`rateLimited`) and by address bucket (`addressRefused`).

## Code

| File | |
|---|---|
| `packages/shared/src/jam-public.ts` | The contract |
| `server/src/services/jam-public-sql.ts` | What "public" means, as SQL, once |
| `server/src/services/jam-public.ts` | Publish, consent, reads, likes, reports, review, operator, sweep, metrics, auto-accept (`admitAutoAcceptedTakes`) |
| `server/src/services/jam-public-scan.ts` | Cover and video scans, quarantine |
| `server/src/services/jam-public-plays.ts` | The play counter |
| `server/src/services/jam-public-media.ts` | Media URLs and the edge seam |
| `tools/jam-media-edge/` | The edge Worker (R2 binding, colo cache, ranges); README is its runbook |
| `server/src/services/jam-public-notify.ts` | The `jam-public-notice` frame and the sender's `jam-take-decision` |
| `server/src/services/jam-take-notices.ts` | The take notices: durable items, batching, the push claim, counters (§"Telling the starter") |
| `server/src/api/jam-public-routes.ts` | Public, authenticated and operator routes |
| `server/src/api/jam-routes.ts` | The private routes, with public access |
| `server/src/api/jam-public.test.ts` | End to end on a real Postgres, with real ffmpeg where installed |
