/**
 * `parsePlaylistPath` (`src/playlist-route.ts`) — the shape a VIEWER's
 * client requests, and the one place this Worker decides what it is
 * willing to answer at all.
 *
 * Worth its own file since task `L2.3`: this route now has three forms
 * (master, rendition, media) rather than two, and the media form is what
 * turns a path segment into a path against the remux box — so what it
 * accepts is a security boundary, not only a routing convenience.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  LL_MODE_PARAM,
  LL_MODE_VALUE,
  parsePlaylistPath,
  requestsLlMode,
} from "../dist/playlist-route.js";

const BASE = "/api/voice/hls-playlist/chan_abc123/1757865600000";

test("the session/master route: no rung, no media", () => {
  assert.deepEqual(parsePlaylistPath(BASE), {
    channelId: "chan_abc123",
    startedAt: "1757865600000",
    rung: undefined,
    media: undefined,
  });
});

test("a conventional rendition is unchanged", () => {
  const match = parsePlaylistPath(`${BASE}/720p30`);
  assert.equal(match.rung, "720p30");
  assert.equal(match.media, undefined);
});

test("the LL AUDIO rung matches -- a hyphen in a rung name used to 404 the whole rendition", () => {
  // The regression this test exists for: `PLAYLIST_PATH` was a
  // character-for-character copy of the API's own, whose rungs are all
  // alphanumeric, so `ll-audio` -- emitted by `ll-playlist.js` since L2.2 --
  // matched no route at all and 404'd from the edge before any LL code ran.
  const match = parsePlaylistPath(`${BASE}/ll-audio`);
  assert.ok(match, "ll-audio must be a routable rung");
  assert.equal(match.rung, "ll-audio");
  assert.equal(match.media, undefined);
});

test("the LL media route: rung plus the file name the playlist emitted", () => {
  for (const name of ["init.mp4", "seg-41.m4s", "part-164.m4s"]) {
    const match = parsePlaylistPath(`${BASE}/ll/${name}`);
    assert.ok(match, name);
    assert.equal(match.rung, "ll");
    assert.equal(match.media, name);
  }
  const audio = parsePlaylistPath(`${BASE}/ll-audio/audio-part-5.m4s`);
  assert.equal(audio.rung, "ll-audio");
  assert.equal(audio.media, "audio-part-5.m4s");
});

test("a media name can never escape its own segment", () => {
  for (const pathname of [
    `${BASE}/ll/..`,
    `${BASE}/ll/../state.json`,
    `${BASE}/ll/.hidden`,
    `${BASE}/ll/seg 1.m4s`,
    `${BASE}/ll/seg?x=1`,
    `${BASE}/ll/a/b`,
    `${BASE}/ll/${"a".repeat(192)}`,
    `${BASE}/ll/`,
  ]) {
    assert.equal(parsePlaylistPath(pathname), null, pathname);
  }
});

test("anything that is not this route at all is still null", () => {
  for (const pathname of [
    "/",
    "/api/voice/hls-playlist/chan_abc123",
    "/api/voice/hls-playlist/chan_abc123/not-a-number",
    `${BASE}/ll/part-1.m4s/extra`,
    `${BASE}/-leading-hyphen`,
  ]) {
    assert.equal(parsePlaylistPath(pathname), null, pathname);
  }
});

/**
 * `requestsLlMode` — the one signal that decides which master a session
 * gets. These literals are a port of `LIVE_HLS_MODE_PARAM` /
 * `LIVE_HLS_MODE_LL` in `packages/shared/src/live-hls.ts`; the first case
 * below is written against the exact URL `llPlaylistUrl`
 * (`server/src/voice/hls-remux.ts`) builds, with the viewer token appended
 * the way `stampViewerStream` appends it, so a rename on either side fails
 * here rather than in production.
 */
const LL_URL_AS_THE_API_BUILDS_IT =
  "https://hls.pqp.gg/api/voice/hls-playlist/chan_abc123/1757865600000" +
  "?mode=ll&t=payload.signature";

test("requestsLlMode: the exact URL the API hands an LL viewer", () => {
  assert.equal(requestsLlMode(new URL(LL_URL_AS_THE_API_BUILDS_IT)), true);
  assert.equal(LL_MODE_PARAM, "mode");
  assert.equal(LL_MODE_VALUE, "ll");
});

test("requestsLlMode: a conventional session's URL carries no marker at all", () => {
  assert.equal(
    requestsLlMode(
      new URL(`https://hls.pqp.gg${BASE}?t=payload.signature`),
    ),
    false,
  );
});

test("requestsLlMode: only exactly `ll` counts", () => {
  for (const value of ["", "LL", "conventional", "ll2", "l", "true", "1"]) {
    assert.equal(
      requestsLlMode(new URL(`https://hls.pqp.gg${BASE}?mode=${value}`)),
      false,
      `mode=${value} must not be read as low latency`,
    );
  }
});

test("requestsLlMode: a repeated parameter reads the first value, deterministically", () => {
  // Not a security boundary (the marker is not a capability -- `?t=` is),
  // but it must be ONE answer rather than something that depends on which
  // part of the stack parses it. `URLSearchParams.get` takes the first.
  assert.equal(requestsLlMode(new URL(`https://hls.pqp.gg${BASE}?mode=ll&mode=x`)), true);
  assert.equal(requestsLlMode(new URL(`https://hls.pqp.gg${BASE}?mode=x&mode=ll`)), false);
});
