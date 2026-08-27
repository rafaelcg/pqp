/**
 * Real YouTube video ids, each one verified in a real Chromium against the
 * real IFrame API on 2026-08-27. Mocking these would defeat the point: the
 * failure paths are what criterion 5 is about, and they only exist because
 * YouTube behaves in ways a fake would not reproduce.
 *
 * WHAT THE VERIFICATION ACTUALLY FOUND, because it contradicts the plan.
 *
 * Every unplayable video reports **error 150**. Not 101, not 100, not 2, not
 * 5. Embedding disabled reports 150. Age restricted reports 150. A deleted
 * video reports 150. A private video reports 150. An eleven character id that
 * is not a video at all reports 150. This was checked twice: once from an
 * `http://localhost` origin and once from a genuine `https://pqp.gg` origin
 * (fulfilled in the browser so the iframe saw a real registered domain in the
 * Referer), and the answer was the same both times.
 *
 * So a UI that writes a different sentence per error code will, in practice,
 * only ever show the sentence it wrote for 150. Whatever that sentence says
 * has to be true of a deleted video as well as of an embed-disabled one.
 *
 * Two more things every failing case had in common, and both matter:
 *
 *   - `onReady` still fires. Readiness is not playability, so a client that
 *     treats "ready" as "we are watching" is wrong for every case here.
 *   - `getPlayerState()` stays at -1 and `getCurrentTime()` stays at exactly
 *     0, forever. That is the stuck-at-zero hazard the wire contract warns
 *     about, confirmed rather than theorised: a failed player that is allowed
 *     to write will broadcast position 0 on a fresh `rev` and reset the room.
 */

export interface VideoFixture {
  id: string;
  /** What it is, for a failure message that does not send anyone to YouTube to find out. */
  title: string;
  /** Seconds, where known. */
  durationS?: number;
  notes?: string;
}

/**
 * The happy path. Nineteen seconds, the first video ever uploaded to YouTube,
 * and about as unlikely to be deleted as anything on the platform.
 *
 * Too short for the drift ladder, which needs somewhere to seek to. Use
 * `LONG_CONTROL` for anything that measures position.
 */
export const CONTROL: VideoFixture = {
  id: "jNQXAC9IVRw",
  title: "Me at the zoo",
  durationS: 19,
};

/** Long enough to seek around in. Verified playing, unmuted, in headless Chromium. */
export const LONG_CONTROL: VideoFixture = {
  id: "dQw4w9WgXcQ",
  title: "Rick Astley - Never Gonna Give You Up",
  durationS: 213,
};

/**
 * Embedding disabled by the uploader. Official sports club channels are the
 * reliable seam here, and if these rot, any Premier League club's channel will
 * yield a replacement in a minute.
 *
 * Verified: `oembed` answers 401, the thumbnail answers 200 (so the video
 * exists), and the player answers error 150.
 */
export const EMBED_DISABLED: VideoFixture = {
  id: "AenRNoY3D4Q",
  title: "HIGHLIGHTS: Liverpool 9-0 Bournemouth",
  durationS: 134,
  notes: "oembed 401, player error 150",
};

export const EMBED_DISABLED_ALT: VideoFixture = {
  id: "lxU8SM7ETPg",
  title: "Taarak Mehta Ka Ooltah Chashmah 3D, full episode",
  durationS: 674,
  notes: "oembed 401, player error 150",
};

/**
 * Age restricted. The watch page carries
 * `playabilityStatus.status = LOGIN_REQUIRED` with "Sign in to confirm your
 * age", and `oembed` still answers 200, so only the player tells the truth.
 *
 * Geo caveat: age gating is jurisdictional. This was verified from a UK
 * egress, where the Online Safety Act makes YouTube gate more than it does in
 * Brazil. It reported 150 there, which is the same code every other failure
 * reports, so the test does not depend on the distinction holding.
 */
export const AGE_RESTRICTED: VideoFixture = {
  id: "z0NfI2NeDHI",
  title: "Rammstein - Radio (Official Video)",
  durationS: 290,
  notes: "LOGIN_REQUIRED on the watch page, player error 150",
};

/** Deleted. `oembed` 404 and no thumbnail at all, so it is gone rather than private. */
export const DELETED: VideoFixture = {
  id: "QH2-TGUlwu4",
  title: "(deleted)",
  notes: "oembed 404, no thumbnail, player error 150",
};

/** Private rather than deleted: `oembed` 404 but the thumbnail still serves. */
export const PRIVATE: VideoFixture = {
  id: "4ib09C0-yac",
  title: "(private)",
  notes: "oembed 404, thumbnail 200, player error 150",
};

/**
 * Error 153 is not a video, it is a request condition, so there is no id for
 * it and no fixture can be provided.
 *
 * The IFrame API reference (the entry was added on 2025-07-09) defines it as
 * "the request does not include the HTTP Referer header or equivalent API
 * Client identification". It fires when YouTube cannot attribute the embed to
 * an origin at all, which is reproducible three ways and none of them involve
 * choosing a different video:
 *
 *   - open the embedding page from `file://`, so no Referer is sent;
 *   - put the iframe inside a `sandbox` frame without `allow-same-origin`, so
 *     the origin is `null`;
 *   - serve the embedding document with `Referrer-Policy: no-referrer`.
 *
 * The third is the one a test can arrange without leaving the app, and it is
 * also the one worth arranging: 153 means *our page* is misconfigured, not
 * that the video is unavailable, so it is the single error code that must
 * never be shown to a person as a video level problem.
 */
export const ERROR_153_IS_A_REQUEST_CONDITION = true;
