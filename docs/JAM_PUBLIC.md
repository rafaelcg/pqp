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
  it in with one action (`PATCH /api/jam-tracks/:id { inMix: true }`) and can
  remove any part.
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
| Take a song down, remove a part, review, block | an operator |
| Like, report | any signed-in account |

Not allowed to publish or record publicly (403 `jam_public_blocked`): an account
an operator blocked, an account being deleted, and, on a channel song, an account
banned from its server. A song whose starter is blocked, banned from the origin,
being deleted or gone is not public; a part whose author is blocked or being
deleted is not public.

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
| Audio | **no** | nothing here listens to audio | (never checked) |
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
origin. The edge path below encrypts the key and closes this.

### Media URLs and the edge seam

Media URLs are short-lived GETs (good for at least 50 minutes, identical inside a
ten-minute window so a shared cache can hold a page). Today they are presigned
bucket URLs. `JAM_PUBLIC_MEDIA_BASE_URL` (unset by default) switches them to
`<base>/jam-media/<token>?e=<exp>&s=<sig>`, for an edge Worker on a pqp.gg
hostname, so Cloudflare's zone-level CSAM scanning sees public jam bytes. The
Worker is not built yet. What it must check is written in
`server/src/services/jam-public-media.ts` (the signature, the expiry, decrypting
the token to a `jam/` key, GET and HEAD with ranges only), and
`openJamPublicMediaUrl` there is the reference implementation the tests pin. The
Worker holds the derived secret as `JAM_PUBLIC_MEDIA_SECRET`, never the Clerk key.

## Runbook

### Turn it on

1. Rafael's go, and the content safety read above.
2. Check `CONTENT_SCAN_PROVIDER` is set on the API and the worker, and the worker
   image has ffmpeg (`<sha>-worker`). Without them covers and videos stay
   private (honest, but the site looks bare).
3. Controles → interruptores → `jam_public`, or
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
| `server/src/services/jam-public.ts` | Publish, consent, reads, likes, reports, review, operator, sweep, metrics |
| `server/src/services/jam-public-scan.ts` | Cover and video scans, quarantine |
| `server/src/services/jam-public-plays.ts` | The play counter |
| `server/src/services/jam-public-media.ts` | Media URLs and the edge seam |
| `server/src/services/jam-public-notify.ts` | The `jam-public-notice` frame |
| `server/src/api/jam-public-routes.ts` | Public, authenticated and operator routes |
| `server/src/api/jam-routes.ts` | The private routes, with public access |
| `server/src/api/jam-public.test.ts` | End to end on a real Postgres, with real ffmpeg where installed |
