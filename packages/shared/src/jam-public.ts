import { z } from "zod";
import { reportReasonSchema } from "./reports.js";
import {
  createJamSongSchema,
  jamInstrumentSchema,
  jamSongSummarySchema,
  jamTrackSchema,
  jamVideoSourceSchema,
  JAM_PAGE_MAX,
} from "./jam.js";

/**
 * PUBLIC JAMS: the wire contract. Server: `server/src/services/jam-public*.ts`
 * and `server/src/api/jam-public-routes.ts`. Operator doc: `docs/JAM_PUBLIC.md`.
 * The private model (songs, tracks, the timeline, uploads, `inMix`) is
 * `packages/shared/src/jam.ts` and every word of it still holds; this file
 * only adds what "public" means. The website (jam.pqp.gg), the in-app UI and
 * both phones are built against THIS file.
 *
 * THE MODEL, STATED ONCE
 *
 * A public jam is a song anybody can listen to and watch without an account.
 * Two ways a song becomes one:
 *
 *   1. STANDALONE. Any account starts one (`POST /api/jam-public/songs`). It
 *      belongs to no channel and no server.
 *   2. FROM A CHANNEL. The song's starter (its `authorId` in `jam.ts`) makes a
 *      channel song public (`PUT /api/jam-songs/:songId/public`). The song
 *      stays in its channel exactly as before; the public version is a VIEW
 *      of it, never a copy.
 *
 * "Starter" in this file is the song's author (`jam_songs.author_id`).
 *
 * WHERE A SONG LIVES. A standalone song is a `jam_songs` row whose
 * `channel_id` and `server_id` are NULL (`JamSongSummary.channelId` and
 * `serverId` are nullable for exactly this). Every channel query filters
 * `channel_id = $1`, which a NULL never equals, so such a song can never
 * appear in a channel list, a channel frame or a server delete; and an old
 * phone build only ever reads songs through a channel, so it never meets one.
 * Why not a hidden container channel: it would be a server row, members and
 * permissions that every server-wide read would have to learn to skip, which
 * is a leak waiting for the first read that forgets. `docs/JAM_PUBLIC.md`
 * §"Where a standalone song lives" has the whole argument.
 *
 * -------------------------------------------------------------------------
 * WHAT IS IN THE PUBLIC VERSION (the one rule every public read applies)
 *
 * A song is listed publicly while ALL of these hold:
 *   - the runtime flag `jam_public` is on;
 *   - it is published and not unpublished by its starter, not removed by an
 *     operator, not waiting for review (a new account's first public jam),
 *     not auto-hidden by reports;
 *   - its starter's account exists, is not being deleted, is not blocked from
 *     publishing and (for a channel song) is not banned from the origin
 *     server;
 *   - at least one of its tracks is public (below).
 *
 * A TRACK is in the public version while ALL of these hold:
 *   - it is live and `inMix` (out-of-mix takes are the starter's inbox, never
 *     public);
 *   - its recorder CONSENTED for this song (`yes` or `audio_only`, see
 *     CONSENT); no answer is no;
 *   - it is not waiting for review (a new account's take) and was not removed
 *     by an operator;
 *   - its recorder's account exists, is not being deleted and is not blocked.
 *
 * A track's VIDEO is public only when its recorder said `yes` (not
 * `audio_only`) AND the video passed the frame scan (`videoScan: "passed"`,
 * see SCANNING). Until then, and forever when it was rejected or nobody could
 * scan it, the public version of that track is its audio.
 *
 * The COVER is public only when it passed the image scanner. With no scanner
 * configured it is simply not shown publicly (`coverUrl: null`).
 *
 * Every change to any of those (an unpublish, a withdrawn consent, a removed
 * part, a deleted account, a block) takes effect on the very next read: no
 * public read is cached in the API. Answers carry `Cache-Control: public,
 * max-age=` of at most 60 s (lists) and 30 s (a song), which is the bound for
 * a shared cache in front.
 *
 * -------------------------------------------------------------------------
 * CONSENT
 *
 * One answer per person per song, for every part they have in it:
 *
 *   yes          audio and video go public;
 *   audio_only   the audio goes public, the video never does;
 *   no           nothing of theirs goes public ("não, só no servidor").
 *
 * Making a CHANNEL song public asks every person with a part in it except the
 * starter (whose publish is their own `yes`; they may change it like anybody).
 * Until a person answers, their parts are not public. A part recorded on a
 * song that is ALREADY public is public by construction: the recorder is told
 * at record time and sends `publicConsent` (`yes` or `audio_only`) with the
 * add-track request (`addJamTrackSchema` in `jam.ts`). A channel member on an
 * older client that does not send it stays unanswered (not public) until they
 * answer, which is the safe reading of "they were not told". Anybody may
 * change their answer at any time (`PUT /api/jam-songs/:songId/public-consent`);
 * `no` drops their parts from the public version on the next read.
 *
 * -------------------------------------------------------------------------
 * WHO MAY RECORD ON A PUBLIC JAM, AND THE STARTER'S INBOX
 *
 * Any signed-in account may record a part on a public jam, through the SAME
 * three upload steps as a channel song (`jam.ts`, "THE UPLOAD FLOW"): the
 * routes authorise on "this song is public" when the caller is not a member
 * of its channel ("public access"). The song's `joinMode` still applies (a
 * `closed` song takes no outside parts). A take from anybody but the starter
 * that arrives through public access is created OUT of the mix (`inMix:
 * false`): it is a request, listed in the starter's inbox
 * (`GET /api/jam-public/inbox`), and the starter puts it in with the existing
 * `PATCH /api/jam-tracks/:trackId { inMix: true }`. The starter can remove any
 * part (`DELETE /api/jam-tracks/:trackId`). A channel member recording through
 * the channel keeps the channel rules (`jam.ts`).
 *
 * AUTO-ACCEPT. The starter may turn on `autoAcceptOutside` for ONE song
 * (`PATCH /api/jam-songs/:songId/public`, default off, no expiry). It replaces
 * the starter's tap and nothing else: an outside take recorded AFTER the switch
 * went on is put in the mix by the server once nothing of the platform's still
 * holds it, that is: not removed by an operator or by the daily take limit,
 * not waiting for review (a new account's take), its author's answer still a
 * yes, the song public and not hidden, blocked or under review, its video (if
 * it has one) passed the frame scan, and the song's current picture not
 * flagged or rejected. A take held by any of these is admitted by itself when
 * the hold clears (an operator's approval, a passing scan, a sweep every
 * minute). It is admitted ONCE: after that it is an ordinary part, so the
 * starter taking it out of the mix, deleting it, or an operator removing it
 * stays that way. Takes that were already waiting when the switch went on keep
 * waiting for the starter. Turning it off stops future admissions and removes
 * nothing already admitted.
 *
 * Public access, read side: `GET /api/jam-songs/:songId` answers a caller with
 * public access too, but only with the public tracks plus the caller's own,
 * names as the account names itself (never a server nickname), and
 * `channelId` / `serverId` null. Nothing private of the channel leaks to a
 * non-member.
 *
 * Not allowed to publish or record publicly (403 `jam_public_blocked`): an
 * account an operator blocked from publishing, an account being deleted, and
 * (on a channel song) an account banned from its server. A NEW account
 * (younger than `JAM_PUBLIC_MIN_ACCOUNT_AGE_HOURS`, default 72) may publish
 * and record, but its first public jam and its takes on public jams wait for
 * an operator (`status: "review"`, part `review: "pending"`) and are
 * invisible publicly until approved.
 *
 * -------------------------------------------------------------------------
 * SCANNING (`docs/CONTENT_SAFETY.md`, "Public jams")
 *
 *   cover   the existing image scanner, on the worker, once per picture.
 *   video   the worker samples frames with ffmpeg (the first, then one every
 *           5 s, at most 24) and runs each through the same scanner. Only a
 *           process with ffmpeg claims the job.
 *   audio   NOT scanned. No classifier here listens to audio.
 *
 * A rejected image or frame, or one labelled `illegal`, quarantines the
 * object under the existing rules and files a report to the INSTANCE queue.
 *
 * -------------------------------------------------------------------------
 * PRIVACY OF A PUBLIC READ
 *
 * A person in a public read is `PublicJamPerson`: a display name, a handle
 * when they claimed one, and an avatar URL (the same three the public profile
 * at `pqp.gg/@handle` already shows). Nothing else: no account id, no email,
 * no presence, no server membership, no server nickname. Ids that ARE in a
 * public read (song, track) are random and name no account. The origin server
 * is a name and an icon, with a `slug` only when it is a listed-able public
 * community (`/c/<slug>`), and null when the starter hid it.
 *
 * -------------------------------------------------------------------------
 * MEDIA URLS
 *
 * `audioUrl`, `videoUrl` and `coverUrl` are short-lived GETs, valid until the
 * song's `mediaExpiresAt` (an hour at most, and stable for ten minutes so a
 * shared cache can hold a page). Today they are presigned object-store URLs.
 * With `JAM_PUBLIC_MEDIA_BASE_URL` set they are
 * `<base>/jam-media/<token>?e=<unix seconds>&s=<signature>` instead, where the
 * token is the object key encrypted (`tools/jam-media-edge/`, a Worker on a
 * pqp.gg hostname that checks the signature and serves the bytes through our
 * zone). A client treats both as opaque URLs.
 *
 * -------------------------------------------------------------------------
 * THE FLAG
 *
 * `jam_public` (global, default OFF, only `true` turns it on; env
 * `JAM_PUBLIC`). Off: every `/api/public/jams*` route except `config` is not
 * even matched (it answers the 401 an unknown path gets), `config` answers
 * `{ enabled: false }`, every authenticated write here answers 403
 * `jam_public_off`, and nothing about channel jams changes. The removals stay
 * open with the flag off (unpublish, a consent of `no`, unlike, delete a
 * track), so turning it off never strands anybody's own content.
 *
 * -------------------------------------------------------------------------
 * PUBLIC ROUTES (no account; each with its own address-keyed rate limit)
 *
 * | Route                                   | Answer                          |
 * |-----------------------------------------|---------------------------------|
 * | GET  /api/public/jams/config            | `PublicJamConfig`, 200 when off |
 * | GET  /api/public/jams?needs=&sort=&cursor=&limit= | `PublicJamListResponse` |
 * | GET  /api/public/jams/:songId           | `PublicJamSongDetail`; 404 for anything not public |
 * | POST /api/public/jams/:songId/play      | 204; counts at most once per song per address per hour |
 *
 * AUTHENTICATED ROUTES (Bearer, like the rest of `/api`)
 *
 * | Route                                         | Body                         | Answer |
 * |-----------------------------------------------|------------------------------|--------|
 * | GET    /api/jam-public/config                 |                              | `JamPublicMeConfig` |
 * | POST   /api/jam-public/songs                  | `createPublicJamSchema`      | 201 `JamPublicSongCreated`; 200 on a nonce retry |
 * | GET    /api/jam-public/songs/:songId          |                              | `JamPublicSongForViewer` (404 when not public) |
 * | PUT    /api/jam-public/songs/:songId/like     |                              | `JamPublicLikeResponse` |
 * | DELETE /api/jam-public/songs/:songId/like     |                              | `JamPublicLikeResponse` |
 * | POST   /api/jam-public/songs/:songId/play     |                              | 204; once per song per account per hour |
 * | POST   /api/jam-public/reports                | `reportPublicJamSchema`      | 201 `JamPublicReportResponse` |
 * | GET    /api/jam-public/consents               |                              | `JamPublicConsentsResponse` (pending for me) |
 * | GET    /api/jam-public/inbox                  |                              | `JamPublicInboxResponse` (the starter's outside takes) |
 * | GET    /api/jam-public/mine                   |                              | `JamPublicMineResponse` |
 * | GET    /api/jam-songs/:songId/public          |                              | `JamPublicationResponse` (`publication: null` if never published) |
 * | PUT    /api/jam-songs/:songId/public          | `publishJamSongSchema`       | `JamPublicationResponse`; the starter only |
 * | PATCH  /api/jam-songs/:songId/public          | `updateJamPublicationSchema` | `JamPublicationResponse`; the starter only |
 * | DELETE /api/jam-songs/:songId/public          | `?reason=` (moderators)      | `JamPublicationResponse`; the starter, or MANAGE_MESSAGES / MANAGE_CHANNELS on the origin channel |
 * | PUT    /api/jam-songs/:songId/public-consent  | `setJamPublicConsentSchema`  | `JamPublicationResponse`; a person with a part in it |
 *
 * And the three upload steps, track edits and deletes of `jam.ts`, unchanged,
 * which now also answer a caller with public access (above).
 *
 * ERRORS: `{ error: <JAM_PUBLIC_ERRORS value> }` or a `JAM_ERRORS` one. 404 for
 * anything the caller may not see (one answer, no oracle).
 *
 * LIVE FRAME: `jam-public-notice` (`jamPublicNoticeSchema`), sent only to the
 * one account it is about, on every socket it holds, across instances. Not a
 * member of `chatServerMessageSchema` (the `jam.ts` arrangement): a client that
 * does not know it drops it. It is a nudge; the durable state is in the reads
 * above (`/consents`, `/inbox`, `/mine`).
 */

// ------------------------------------------------------------------ caps

/** Songs per public list page by default. The most is `JAM_PAGE_MAX`. */
export const JAM_PUBLIC_PAGE_SIZE = 24;
/** Report details length. */
export const JAM_PUBLIC_REPORT_DETAILS_MAX = 1000;
/** An operator's or moderator's reason for an unpublish or a removal. */
export const JAM_PUBLIC_REASON_MAX = 500;
/** Frames the video scan samples at most, the first included. */
export const JAM_PUBLIC_VIDEO_FRAMES_MAX = 24;
/** Seconds between sampled frames. */
export const JAM_PUBLIC_VIDEO_FRAME_INTERVAL_S = 5;

// ---------------------------------------------------------------- errors

export const JAM_PUBLIC_ERRORS = {
  /** 403: the runtime flag `jam_public` is off. */
  off: "jam_public_off",
  /** 403: only the song's starter may publish it or change its public settings. */
  notStarter: "jam_public_not_starter",
  /** 403: blocked from publishing, account being deleted, or banned from the origin server. */
  blocked: "jam_public_blocked",
  /** 400: an add-track through public access without `publicConsent`. */
  consentRequired: "jam_public_consent_required",
  /** 403: a consent from somebody with no part in the song. */
  noPart: "jam_public_no_part",
  /** 409: an operator removed this song from the public site; only an operator restores it. */
  removed: "jam_public_removed",
  /** 429: a daily or per-minute limit (songs, takes, likes, reports). */
  rateLimited: "jam_public_rate_limited",
} as const;
export type JamPublicErrorCode = (typeof JAM_PUBLIC_ERRORS)[keyof typeof JAM_PUBLIC_ERRORS];

// ------------------------------------------------------------ primitives

const uuid = z.string().uuid();

/** Query-string integer. */
const queryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

// ------------------------------------------------------- public: people

/**
 * A person, as a public read shows them. The three things the public profile
 * already shows, and nothing else (see PRIVACY in the header).
 */
export const publicJamPersonSchema = z.object({
  /** The account's display name (never a server nickname). */
  name: z.string(),
  /** `pqp.gg/@<handle>`, when they claimed one. */
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type PublicJamPerson = z.infer<typeof publicJamPersonSchema>;

/**
 * Where a channel song came from. Null for a standalone jam and when the
 * starter hid it (`showOrigin: false`).
 */
export const publicJamOriginSchema = z.object({
  name: z.string(),
  iconUrl: z.string().nullable(),
  /**
   * `/c/<slug>`, only when the server is a public community (communities on
   * for this deployment, the address on, not suspended). Otherwise null and
   * the origin is shown unlinked.
   */
  slug: z.string().nullable(),
});
export type PublicJamOrigin = z.infer<typeof publicJamOriginSchema>;

/** One public part, as a tile draws it. */
export const publicJamPartSchema = z.object({
  instrument: jamInstrumentSchema.catch("other"),
  person: publicJamPersonSchema,
  /** The video of this part is public (consent `yes` and the scan passed). */
  hasVideo: z.boolean(),
});
export type PublicJamPart = z.infer<typeof publicJamPartSchema>;

// -------------------------------------------------------- public: songs

/**
 * One public song, as the list and the detail carry it. Arrays carry no
 * `.max()`: an older client must not reject a page because a newer server
 * sent more.
 */
export const publicJamSongSchema = z.object({
  id: uuid,
  title: z.string(),
  /** The original artist; null for an original. */
  artist: z.string().nullable(),
  /** Only when the cover passed the scanner. See MEDIA URLS. */
  coverUrl: z.string().nullable(),
  /**
   * Length of the public mix: the latest heard end minus the earliest heard
   * start over the PUBLIC tracks (`jam.ts`, "THE TIMELINE"). Null never
   * happens on a listed song (it has a public track); typed nullable for a
   * song read in the instant its last part left.
   */
  durationMs: z.number().nonnegative().nullable(),
  /** A tile waveform, `JamSongSummary.previewPeaks` computed over public tracks. */
  previewPeaks: z.array(z.number()).default([]),
  /** The public parts, in the order they were recorded. */
  parts: z.array(publicJamPartSchema),
  /**
   * Instruments the song still asks for: the `wanted` instruments nobody has
   * a live part for yet (`JamSongSummary.missingInstruments`), in
   * `JAM_INSTRUMENTS` order. Empty for `open` and `closed` songs.
   */
  needs: z.array(jamInstrumentSchema.catch("other")),
  /** Plays counted (once per song per address or account per hour). */
  plays: z.number().int().nonnegative(),
  /**
   * The starter turned on auto-accept: a part from outside goes in the mix by
   * itself once it clears the platform's checks, with no tap from the starter.
   */
  autoAcceptOutside: z.boolean().default(false),
  /** Likes, one per account. Always exposed; the clients show it above 1. */
  likes: z.number().int().nonnegative(),
  startedBy: publicJamPersonSchema,
  origin: publicJamOriginSchema.nullable(),
  /** When it (last) became public. The `new` sort. */
  publishedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicJamSong = z.infer<typeof publicJamSongSchema>;

/**
 * One public track: the SAME placement fields as `JamTrack` (`jam.ts`, "THE
 * TIMELINE"), so the web engine and the phones place it exactly as they place
 * a channel track. Only public, in-mix tracks are ever listed.
 */
export const publicJamTrackSchema = z.object({
  /** Random, names no account. What a report of one part names. */
  id: uuid,
  instrument: jamInstrumentSchema.catch("other"),
  label: z.string().nullable(),
  person: publicJamPersonSchema,
  offsetMs: z.number(),
  trimStartMs: z.number().nonnegative(),
  trimEndMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  gain: z.number().nonnegative(),
  peaks: z.array(z.number()),
  audioUrl: z.string(),
  audioContentType: z.string(),
  /**
   * Null unless this part's video is public. The best file for every player,
   * as `JamTrack.videoUrl`: the worker's H.264 MP4 copy once it exists, the
   * recorded file until then.
   */
  videoUrl: z.string().nullable(),
  videoContentType: z.string().nullable(),
  /**
   * Every file the public video exists as, best first (`JamTrack.videoSources`:
   * the MP4 copy first, the recorded WebM or MP4 last), each a public media URL
   * (see MEDIA URLS). Empty unless the video is public. A `<video>` takes the
   * first one `canPlayType` accepts; iOS and Safari need the MP4.
   */
  videoSources: z.array(jamVideoSourceSchema),
});
export type PublicJamTrack = z.infer<typeof publicJamTrackSchema>;

export const publicJamConfigSchema = z.object({
  /** The runtime flag `jam_public`. The website shows nothing while it is false. */
  enabled: z.boolean(),
});
export type PublicJamConfig = z.infer<typeof publicJamConfigSchema>;

export const PUBLIC_JAM_SORTS = ["new", "top"] as const;
export const publicJamSortSchema = z.enum(PUBLIC_JAM_SORTS);
export type PublicJamSort = z.infer<typeof publicJamSortSchema>;

/**
 * `GET /api/public/jams`. `new` (the default) is newest published first;
 * `top` is most liked, then newest. Keyset cursor, opaque. `needs` lists the
 * songs that still ask for that instrument ("procurando baixo").
 */
export const publicJamListQuerySchema = z.object({
  needs: jamInstrumentSchema.optional(),
  sort: publicJamSortSchema.optional(),
  cursor: z.string().min(1).max(300).optional(),
  limit: queryInt(1, JAM_PAGE_MAX).optional(),
});
export type PublicJamListQuery = z.infer<typeof publicJamListQuerySchema>;

export const publicJamListResponseSchema = z.object({
  songs: z.array(publicJamSongSchema),
  /** Null at the end. */
  nextCursor: z.string().nullable(),
});
export type PublicJamListResponse = z.infer<typeof publicJamListResponseSchema>;

/** `GET /api/public/jams/:songId`. */
export const publicJamSongDetailSchema = z.object({
  song: publicJamSongSchema,
  /** Public in-mix tracks, oldest first. */
  tracks: z.array(publicJamTrackSchema),
  /** Every media URL in this answer is good until then. Read again for fresh ones. */
  mediaExpiresAt: z.string(),
});
export type PublicJamSongDetail = z.infer<typeof publicJamSongDetailSchema>;

// ------------------------------------------------- authenticated: state

export const JAM_PUBLIC_CONSENTS = ["yes", "audio_only", "no"] as const;
export const jamPublicConsentSchema = z.enum(JAM_PUBLIC_CONSENTS);
export type JamPublicConsent = z.infer<typeof jamPublicConsentSchema>;

/**
 * Where a published song stands, for its starter and its participants.
 *
 *   live         listed publicly.
 *   review       a new account's first public jam, waiting for an operator.
 *   hidden       auto-hidden: enough distinct people reported it; waiting for
 *                an operator.
 *   removed      an operator took it down (`removedReason`); only an operator
 *                restores it (a republish answers 409 `jam_public_removed`).
 *   unpublished  its starter (or a moderator of its server) unpublished it.
 *
 * `live` does not promise that something is listed: a song with no public
 * part yet (consents pending, a video-only scan in flight does not matter, a
 * take in review) is `live` and absent from the list until a part is public.
 * `listed` says that.
 */
export const JAM_PUBLICATION_STATUSES = [
  "live",
  "review",
  "hidden",
  "removed",
  "unpublished",
] as const;
export const jamPublicationStatusSchema = z.enum(JAM_PUBLICATION_STATUSES);
export type JamPublicationStatus = z.infer<typeof jamPublicationStatusSchema>;

/** The video scan of one part. `none`: the part has no video. */
export const JAM_PUBLIC_VIDEO_SCANS = [
  "none",
  "pending",
  "passed",
  "flagged",
  "rejected",
  "unscanned",
  "skipped",
] as const;
export const jamPublicVideoScanSchema = z.enum(JAM_PUBLIC_VIDEO_SCANS);
export type JamPublicVideoScan = z.infer<typeof jamPublicVideoScanSchema>;

export const JAM_PUBLIC_REVIEWS = ["none", "pending", "approved", "rejected"] as const;
export const jamPublicReviewSchema = z.enum(JAM_PUBLIC_REVIEWS);
export type JamPublicReview = z.infer<typeof jamPublicReviewSchema>;

/** One part (a live track) of a published song, as its people see it. */
export const jamPublicationPartSchema = z.object({
  trackId: uuid,
  authorId: uuid,
  authorName: z.string().nullable(),
  instrument: jamInstrumentSchema.catch("other"),
  inMix: z.boolean(),
  /** The author's answer for this song; `pending` until they give one. */
  consent: z.enum(["pending", ...JAM_PUBLIC_CONSENTS]),
  review: jamPublicReviewSchema,
  /** An operator removed this part from the public version. */
  removed: z.boolean(),
  video: jamPublicVideoScanSchema,
  /** In the public version right now (audio at least). */
  public: z.boolean(),
  /** Its video is in the public version right now. */
  publicVideo: z.boolean(),
});
export type JamPublicationPart = z.infer<typeof jamPublicationPartSchema>;

export const jamPublicationSchema = z.object({
  songId: uuid,
  status: jamPublicationStatusSchema,
  /** Listed publicly right now (flag on, `live`, at least one public part). */
  listed: z.boolean(),
  publishedAt: z.string().nullable(),
  /** The song has an origin server to show (a channel song). */
  hasOrigin: z.boolean(),
  /** The starter's choice; meaningless when `hasOrigin` is false. */
  showOrigin: z.boolean(),
  plays: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  /** The operator's or moderator's reason, for `removed` and a moderator's unpublish. */
  removedReason: z.string().nullable(),
  /**
   * The cover's public state: `none` (no cover), `pending` (waiting for the
   * scanner), `shown`, or `hidden` (rejected, flagged, or nothing could scan it).
   */
  cover: z.enum(["none", "pending", "shown", "hidden"]),
  parts: z.array(jamPublicationPartSchema),
  /** Outside takes waiting for the starter to put them in the mix. */
  pendingTakes: z.number().int().nonnegative(),
  /** The starter's switch: outside takes that clear every platform check are put in the mix without their tap. */
  autoAcceptOutside: z.boolean().default(false),
});
export type JamPublication = z.infer<typeof jamPublicationSchema>;

export const jamPublicationResponseSchema = z.object({
  publication: jamPublicationSchema.nullable(),
});
export type JamPublicationResponse = z.infer<typeof jamPublicationResponseSchema>;

/**
 * `GET /api/jam-public/config`: the flag, and what THIS account may do.
 *
 *   open     publishes and records straight to the public version;
 *   review   a new account: its first public jam and its takes wait for an
 *            operator;
 *   blocked  may listen, like and report, may not publish or record publicly.
 */
export const jamPublicMeConfigSchema = z.object({
  enabled: z.boolean(),
  publishing: z.enum(["open", "review", "blocked"]),
  /** Object storage is configured (nothing can be recorded without it). */
  uploads: z.boolean(),
});
export type JamPublicMeConfig = z.infer<typeof jamPublicMeConfigSchema>;

// ------------------------------------------------ authenticated: writes

/**
 * `POST /api/jam-public/songs`: a standalone public jam. The body of a channel
 * song's create (`createJamSongSchema`): title, artist, `joinMode`,
 * `wantedInstruments`, `nonce`. The song is created published; it is listed
 * once its first public take is in.
 */
export const createPublicJamSchema = createJamSongSchema;
export type CreatePublicJamRequest = z.infer<typeof createPublicJamSchema>;

export const jamPublicSongCreatedSchema = z.object({
  song: jamSongSummarySchema,
  publication: jamPublicationSchema,
});
export type JamPublicSongCreated = z.infer<typeof jamPublicSongCreatedSchema>;

/**
 * `PUT /api/jam-songs/:songId/public`: publish a channel song (or republish).
 * The starter only. Idempotent. `showOrigin` defaults to true on a first
 * publish and to the stored choice on a republish.
 */
export const publishJamSongSchema = z.object({
  showOrigin: z.boolean().optional(),
});
export type PublishJamSongRequest = z.infer<typeof publishJamSongSchema>;

/**
 * `PATCH /api/jam-songs/:songId/public`: the starter hides or shows the origin,
 * and/or turns auto-accept of outside takes on or off (see AUTO-ACCEPT in the
 * header). At least one field. Turning it on again while it is on changes
 * nothing; turning it off removes nothing already admitted.
 */
export const updateJamPublicationSchema = z
  .object({
    showOrigin: z.boolean().optional(),
    autoAcceptOutside: z.boolean().optional(),
  })
  .refine((body) => body.showOrigin !== undefined || body.autoAcceptOutside !== undefined, {
    message: "showOrigin or autoAcceptOutside is required",
  });
export type UpdateJamPublicationRequest = z.infer<typeof updateJamPublicationSchema>;

/** `PUT /api/jam-songs/:songId/public-consent`: my answer for all my parts in it. */
export const setJamPublicConsentSchema = z.object({
  choice: jamPublicConsentSchema,
});
export type SetJamPublicConsentRequest = z.infer<typeof setJamPublicConsentSchema>;

/**
 * `POST /api/jam-public/reports`: a public song, or one part of it. Goes to
 * the INSTANCE queue (`docs/CONTENT_SAFETY.md`), never to a server's owner.
 * Signed in only. A song reported by `JAM_PUBLIC_REPORTS_TO_HIDE` distinct
 * people inside the window is hidden until an operator looks.
 */
export const reportPublicJamSchema = z.object({
  songId: uuid,
  trackId: uuid.optional(),
  reason: reportReasonSchema,
  details: z.string().trim().max(JAM_PUBLIC_REPORT_DETAILS_MAX).optional(),
});
export type ReportPublicJamRequest = z.infer<typeof reportPublicJamSchema>;

export const jamPublicReportResponseSchema = z.object({
  /** True when this account had already reported this song (nothing new filed). */
  duplicate: z.boolean(),
});
export type JamPublicReportResponse = z.infer<typeof jamPublicReportResponseSchema>;

export const jamPublicLikeResponseSchema = z.object({
  songId: uuid,
  liked: z.boolean(),
  likes: z.number().int().nonnegative(),
});
export type JamPublicLikeResponse = z.infer<typeof jamPublicLikeResponseSchema>;

// ------------------------------------------------- authenticated: reads

/**
 * `GET /api/jam-public/songs/:songId`: the public song, plus what the caller
 * may do. Same `song` and `tracks` as the public read (no account ids).
 */
export const jamPublicSongForViewerSchema = publicJamSongDetailSchema.extend({
  viewer: z.object({
    liked: z.boolean(),
    /** The caller started this song. */
    isStarter: z.boolean(),
    /**
     * The instruments the caller may record right now (the `joinMode` rule,
     * the limits, the flag, and whether they may record publicly). Empty means
     * no record button.
     */
    addableInstruments: z.array(jamInstrumentSchema.catch("other")),
  }),
});
export type JamPublicSongForViewer = z.infer<typeof jamPublicSongForViewerSchema>;

/** One song where the caller has a part and has not answered yet. */
export const jamPublicConsentRequestSchema = z.object({
  songId: uuid,
  title: z.string(),
  artist: z.string().nullable(),
  startedBy: z.object({ name: z.string().nullable(), avatarUrl: z.string().nullable() }),
  /** The channel's server name, for "na Banda"; null for a standalone song. */
  serverName: z.string().nullable(),
  publishedAt: z.string(),
  /** The caller's live parts in it. */
  parts: z.number().int().nonnegative(),
});
export type JamPublicConsentRequest = z.infer<typeof jamPublicConsentRequestSchema>;

export const jamPublicConsentsResponseSchema = z.object({
  pending: z.array(jamPublicConsentRequestSchema),
});
export type JamPublicConsentsResponse = z.infer<typeof jamPublicConsentsResponseSchema>;

/**
 * The starter's inbox: outside takes on their published songs, out of the
 * mix. `track` is the private shape (`jam.ts`) so the starter can audition it;
 * putting it in is `PATCH /api/jam-tracks/:trackId { inMix: true }`.
 */
export const jamPublicInboxItemSchema = z.object({
  songId: uuid,
  songTitle: z.string(),
  track: jamTrackSchema,
});
export type JamPublicInboxItem = z.infer<typeof jamPublicInboxItemSchema>;

export const jamPublicInboxResponseSchema = z.object({
  takes: z.array(jamPublicInboxItemSchema),
});
export type JamPublicInboxResponse = z.infer<typeof jamPublicInboxResponseSchema>;

/** `GET /api/jam-public/mine`: the caller's published songs, newest first (at most 100). */
export const jamPublicMineResponseSchema = z.object({
  songs: z.array(
    z.object({
      song: jamSongSummarySchema,
      publication: jamPublicationSchema,
    }),
  ),
});
export type JamPublicMineResponse = z.infer<typeof jamPublicMineResponseSchema>;

// -------------------------------------------------------------- frames

/**
 * `jam-public-notice`, to one account:
 *
 *   consent       a song you have a part in was made public: answer.
 *   take          (to the starter) an outside take arrived, out of the mix; with
 *                 `admitted: true` it arrived and auto-accept already put it in.
 *   removed       (to the starter) an operator took your song down; `reason`.
 *   unpublished   (to the starter) a moderator of the origin server unpublished it.
 *   part-removed  (to the part's author) an operator removed your part; `reason`.
 *   approved      (to the starter or the part's author) review passed.
 *   rejected      (to the starter or the part's author) review refused; `reason`.
 */
export const JAM_PUBLIC_NOTICE_KINDS = [
  "consent",
  "take",
  "removed",
  "unpublished",
  "part-removed",
  "approved",
  "rejected",
] as const;
export const jamPublicNoticeSchema = z.object({
  type: z.literal("jam-public-notice"),
  kind: z.enum(JAM_PUBLIC_NOTICE_KINDS).catch("consent"),
  songId: uuid,
  title: z.string(),
  trackId: uuid.nullable().default(null),
  reason: z.string().nullable().default(null),
  /** `take` only: auto-accept put the take in the mix, nothing waits for the starter. */
  admitted: z.boolean().default(false),
});
export type JamPublicNotice = z.infer<typeof jamPublicNoticeSchema>;

// ------------------------------------------------------------- operator

/**
 * The operator's routes (machine token or an instance moderator's session;
 * `ADMIN_MACHINE_ROUTES`, `tools/admin-dashboard/README.md`). Ids travel in
 * the body or the query, never the path (the token's allowlist is exact
 * paths).
 *
 * | Route                                     | Body / query                   |
 * |-------------------------------------------|--------------------------------|
 * | GET /api/admin/jam-public/songs           | `?status=&cursor=`             |
 * | GET /api/admin/jam-public/queue           |                                |
 * | PUT /api/admin/jam-public/unpublish       | `adminUnpublishJamSchema`      |
 * | PUT /api/admin/jam-public/review          | `adminReviewJamSchema`         |
 * | PUT /api/admin/jam-public/remove-part     | `adminRemoveJamPartSchema`     |
 * | PUT /api/admin/jam-public/block           | `adminBlockJamPublisherSchema` |
 */
const reasonSchema = z.string().trim().min(1).max(JAM_PUBLIC_REASON_MAX);

export const adminListJamPublicQuerySchema = z.object({
  status: z.enum([...JAM_PUBLICATION_STATUSES, "all"]).optional(),
  cursor: z.string().min(1).max(300).optional(),
});

export const adminUnpublishJamSchema = z.object({ songId: uuid, reason: reasonSchema });
export type AdminUnpublishJamRequest = z.infer<typeof adminUnpublishJamSchema>;

/**
 * Approve or reject a queued item. `song`: a new account's first public jam
 * (`review`) or a song hidden by reports (`hidden`); approve lists it, reject
 * removes it (`removed`, with `reason`). Approving a `removed` song restores
 * it. `track`: a new account's take; approve makes it public, reject keeps it
 * out of the public version (the track itself is not deleted).
 */
export const adminReviewJamSchema = z.object({
  kind: z.enum(["song", "track"]),
  id: uuid,
  decision: z.enum(["approve", "reject"]),
  reason: reasonSchema.optional(),
});
export type AdminReviewJamRequest = z.infer<typeof adminReviewJamSchema>;

/** Take one part out of the public version. The track stays in its song. */
export const adminRemoveJamPartSchema = z.object({ trackId: uuid, reason: reasonSchema });
export type AdminRemoveJamPartRequest = z.infer<typeof adminRemoveJamPartSchema>;

/** Block (or unblock) an account from publishing and recording publicly. */
export const adminBlockJamPublisherSchema = z.object({
  userId: uuid,
  blocked: z.boolean(),
  reason: reasonSchema.optional(),
});
export type AdminBlockJamPublisherRequest = z.infer<typeof adminBlockJamPublisherSchema>;

export const adminJamPublicSongSchema = z.object({
  songId: uuid,
  title: z.string(),
  artist: z.string().nullable(),
  status: jamPublicationStatusSchema,
  listed: z.boolean(),
  publishedAt: z.string().nullable(),
  starter: z
    .object({ id: uuid, name: z.string(), handle: z.string().nullable(), blocked: z.boolean() })
    .nullable(),
  origin: z.object({ serverId: uuid, name: z.string() }).nullable(),
  plays: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  /** Distinct reporters inside the auto-hide window (since the last approval). */
  reports: z.number().int().nonnegative(),
  /**
   * Of those, the distinct reporters whose reason was `copyright`. A song with
   * more than 0 here is one an operator should open first (the takedown steps
   * are in `docs/JAM_PUBLIC.md`, "Copyright reports").
   */
  copyrightReports: z.number().int().nonnegative().default(0),
  publicParts: z.number().int().nonnegative(),
  hiddenAt: z.string().nullable(),
  removedReason: z.string().nullable(),
});
export type AdminJamPublicSong = z.infer<typeof adminJamPublicSongSchema>;

export const adminJamPublicTrackSchema = z.object({
  trackId: uuid,
  songId: uuid,
  songTitle: z.string(),
  author: z.object({ id: uuid, name: z.string(), handle: z.string().nullable() }),
  instrument: jamInstrumentSchema.catch("other"),
  review: jamPublicReviewSchema,
  video: jamPublicVideoScanSchema,
  createdAt: z.string(),
});
export type AdminJamPublicTrack = z.infer<typeof adminJamPublicTrackSchema>;

export const adminJamPublicQueueSchema = z.object({
  /** `review` and `hidden` songs, oldest first. */
  songs: z.array(adminJamPublicSongSchema),
  /** Takes waiting for review, oldest first. */
  tracks: z.array(adminJamPublicTrackSchema),
  /** Parts whose video was flagged or rejected, newest first (for a second look). */
  videos: z.array(adminJamPublicTrackSchema),
});
export type AdminJamPublicQueue = z.infer<typeof adminJamPublicQueueSchema>;
