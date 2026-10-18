/**
 * How the presigned address behind a PUBLIC picture's redirect is signed
 * (`/api/avatars/:userId`, `/api/users/:userId/banner`, `/api/servers/:id/icon`
 * and friends, `/api/emoji/:id`): so that it is the same address for a long
 * time.
 *
 * `presignGet` signs with the request's own second, so every redirect used to
 * mint a different URL, and a browser's image cache is keyed by URL: a picture
 * it had already downloaded was fetched again as soon as the redirect itself
 * (cached for `STORED_IMAGE_CACHE`) expired. A page of messages is a megabyte of
 * avatars, again every few minutes, for the life of the tab. Signing at the
 * START of a window instead makes every request inside the window produce the
 * identical URL, so the browser can keep the bytes.
 *
 * The signature is made at the start of the current window and lives for two
 * windows, so an address handed out at the very end of one is still good for a
 * whole window, which is longer than anything holds on to it (the redirect's
 * `max-age`, the browser's copy). `cacheControl` is signed into the query so the
 * bucket itself says how long the bytes may be kept, instead of leaving it to a
 * heuristic over `Last-Modified`.
 *
 * ONLY for objects whose route is unauthenticated, where a longer-lived address
 * discloses nothing a request to the route would not (anyone can mint a fresh
 * one by asking). Anything handed to a signed-in viewer (attachments, stories,
 * Baú media) keeps a short, per-request `presignGet`.
 *
 * Its own file, with no imports, so the services that use it do not depend on
 * `s3.ts` for a constant (and a test that replaces `s3.ts` wholesale keeps working).
 */

export const STABLE_IMAGE_WINDOW_SECONDS = 6 * 60 * 60;

export const STABLE_IMAGE_READ = {
  ttlSeconds: STABLE_IMAGE_WINDOW_SECONDS * 2,
  stableWindowSeconds: STABLE_IMAGE_WINDOW_SECONDS,
  cacheControl: `public, max-age=${STABLE_IMAGE_WINDOW_SECONDS}`,
} as const;
