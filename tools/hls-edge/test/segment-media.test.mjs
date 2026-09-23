/**
 * Conventional segments at the edge (`src/segment-media.ts`) and the
 * capability that gates them (`src/hls-segment-token.js`).
 *
 * The capability is minted here with Node's `createHmac` the way
 * `mintHlsSegmentToken` in `server/src/voice/hls-segment-token.ts` does, and
 * verified by the port with Web Crypto: two backends agreeing on the same
 * bytes is the fidelity check (same reasoning as `hls-viewer-token.test.mjs`).
 */

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  handleSegmentRequest,
  applyRange,
  warmNewSegments,
  resetSegmentWarmingForTests,
} from "../dist/segment-media.js";
import { parseSegmentPath, parsePlaylistPath } from "../dist/playlist-route.js";
import { describeHlsSegmentToken, HLS_SEGMENT_TOKEN_PARAM } from "../src/hls-segment-token.js";

const CLERK = "sk_test_dummy";
const SECRET = createHmac("sha256", CLERK).update("pqp-hls-segment").digest("base64url");
const VIEWER_SECRET = createHmac("sha256", CLERK).update("pqp-hls-viewer").digest("base64url");
const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const STARTED_AT = "1790026895736";
const NAME = `${STARTED_AT}-720p30_00042.ts`;
const NOW = Date.now();

function mint(claims, secret = SECRET) {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, k: "seg", c: CHANNEL, s: Number(STARTED_AT), r: "720p30", e: NOW + 60_000, ...claims }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function segmentUrl({ name = NAME, token = mint(), channel = CHANNEL } = {}) {
  const url = new URL(`https://hls.example.test/api/voice/hls-segment/${channel}/${STARTED_AT}/${name}`);
  if (token !== null) {
    url.searchParams.set(HLS_SEGMENT_TOKEN_PARAM, token);
  }
  return url.toString();
}

function fakeCache() {
  const entries = new Map();
  return {
    get size() {
      return entries.size;
    },
    keys() {
      return [...entries.keys()];
    },
    async match(request) {
      const hit = entries.get(request.url);
      return hit ? new Response(hit.body, { status: hit.status, headers: new Headers(hit.headers) }) : undefined;
    },
    async put(request, response) {
      entries.set(request.url, {
        status: response.status,
        headers: [...response.headers],
        body: await response.arrayBuffer(),
      });
    },
  };
}

function collectingCtx() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise).catch(() => {}));
    },
    async drain() {
      await Promise.all(pending);
    },
  };
}

/** An `R2Bucket`-shaped fake: `get(key)` answers the object or null, and records every key asked for. */
function fakeBucket(objects = {}, { delayMs = 0, throws = false } = {}) {
  const gets = [];
  return {
    gets,
    async get(key) {
      gets.push(key);
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (throws) {
        throw new Error("r2 down");
      }
      const bytes = objects[key];
      if (!bytes) {
        return null;
      }
      return { async arrayBuffer() { return new Uint8Array(bytes).buffer; } };
    },
  };
}

const KEY = `live/${CHANNEL}/${NAME}`;

function env(bucket) {
  return { LIVE_SEGMENTS: bucket, HLS_SEGMENT_TOKEN_SECRET: SECRET };
}

async function get(url, { bucket, cache = fakeCache(), ctx = collectingCtx(), headers = {} } = {}) {
  const request = new Request(url, { headers });
  const parsed = parseSegmentPath(new URL(url).pathname);
  assert.ok(parsed, `route did not parse: ${url}`);
  const response = await handleSegmentRequest(request, env(bucket), cache, ctx, parsed);
  await ctx.drain();
  return response;
}

test("the route is its own path, never a shape of the playlist path", () => {
  const path = `/api/voice/hls-segment/${CHANNEL}/${STARTED_AT}/${NAME}`;
  assert.deepEqual(parseSegmentPath(path), { channelId: CHANNEL, startedAt: STARTED_AT, name: NAME });
  assert.equal(parsePlaylistPath(path), null);
  assert.equal(parseSegmentPath(`/api/voice/hls-segment/${CHANNEL}/${STARTED_AT}/../x.ts`), null);
  assert.equal(parseSegmentPath(`/api/voice/hls-segment/${CHANNEL}/${STARTED_AT}/a/b.ts`), null);
});

test("a valid capability serves the object from R2, immutable, and fills the colo cache keyed on the path alone", async () => {
  const bucket = fakeBucket({ [KEY]: [1, 2, 3, 4, 5] });
  const cache = fakeCache();
  const first = await get(segmentUrl(), { bucket, cache });
  assert.equal(first.status, 200);
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [1, 2, 3, 4, 5]);
  assert.equal(first.headers.get("Content-Type"), "video/mp2t");
  assert.equal(first.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(first.headers.get("X-HLS-Edge-Cache"), "MISS");
  assert.deepEqual(bucket.gets, [KEY]);
  assert.deepEqual(cache.keys(), [`https://hls.example.test/api/voice/hls-segment/${CHANNEL}/${STARTED_AT}/${NAME}`]);

  // A second viewer, holding a DIFFERENT token for the same rendition: a hit.
  const second = await get(segmentUrl({ token: mint({ e: NOW + 120_000 }) }), { bucket, cache });
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("X-HLS-Edge-Cache"), "HIT");
  assert.deepEqual(bucket.gets, [KEY]);
});

test("a burst of viewers asking for a fresh segment at once costs one R2 read", async () => {
  const bucket = fakeBucket({ [KEY]: [9, 9, 9] }, { delayMs: 30 });
  const cache = fakeCache();
  const ctx = collectingCtx();
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => get(segmentUrl(), { bucket, cache, ctx })),
  );
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [9, 9, 9]);
  }
  assert.equal(bucket.gets.length, 1);
});

test("refused before anything is read: missing, forged, expired, wrong channel/session/rendition, or a viewer token", async () => {
  const bucket = fakeBucket({ [KEY]: [1] });
  const cases = [
    [segmentUrl({ token: null }), 401, "missing"],
    [segmentUrl({ token: mint({}, "not-the-key") }), 401, "bad-signature"],
    [segmentUrl({ token: mint({ e: NOW - 1 }) }), 401, "expired"],
    [segmentUrl({ token: mint({ c: "other-channel" }) }), 403, "wrong-channel"],
    [segmentUrl({ token: mint({ s: Number(STARTED_AT) + 1 }) }), 403, "wrong-session"],
    [segmentUrl({ token: mint({ r: "1080p30" }) }), 403, "wrong-rendition"],
    [segmentUrl({ token: mint({ k: undefined }) }), 401, "malformed"],
    // A viewer's own `?t=` shape signed with the viewer key never passes here.
    [segmentUrl({ token: mint({ u: "user" }, VIEWER_SECRET) }), 401, "bad-signature"],
  ];
  for (const [url, status, reason] of cases) {
    const response = await get(url, { bucket });
    assert.equal(response.status, status, reason);
    assert.equal((await response.json()).reason, reason);
  }
  assert.deepEqual(bucket.gets, []);
});

test("a token for this rendition cannot reach a sibling rung, a playlist, or another channel's object", async () => {
  const bucket = fakeBucket({ [KEY]: [1] });
  const sibling = await get(segmentUrl({ name: `${STARTED_AT}-1080p30_00042.ts` }), { bucket });
  assert.equal(sibling.status, 403);
  const playlist = await get(segmentUrl({ name: `${STARTED_AT}-720p30.m3u8` }), { bucket });
  assert.equal(playlist.status, 404);
  const otherSession = await get(segmentUrl({ name: `1111111111111-720p30_00042.ts` }), { bucket });
  assert.equal(otherSession.status, 404);
  assert.deepEqual(bucket.gets, []);
});

test("a segment not in the bucket is a 404 that is never cached", async () => {
  const bucket = fakeBucket({});
  const cache = fakeCache();
  const response = await get(segmentUrl(), { bucket, cache });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(cache.size, 0);
});

test("R2 failing is a 502, never cached, and the next viewer retries", async () => {
  const cache = fakeCache();
  const failing = await get(segmentUrl(), { bucket: fakeBucket({}, { throws: true }), cache });
  assert.equal(failing.status, 502);
  assert.equal(cache.size, 0);
  const bucket = fakeBucket({ [KEY]: [7] });
  const retried = await get(segmentUrl(), { bucket, cache });
  assert.equal(retried.status, 200);
});

test("no bucket bound is a loud 503, not a silent 404", async () => {
  const response = await get(segmentUrl(), { bucket: undefined });
  assert.equal(response.status, 503);
});

test("a Range request is served from the same bytes as a 206", async () => {
  const bucket = fakeBucket({ [KEY]: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  const cache = fakeCache();
  const partial = await get(segmentUrl(), { bucket, cache, headers: { Range: "bytes=2-4" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Range"), "bytes 2-4/10");
  assert.deepEqual([...new Uint8Array(await partial.arrayBuffer())], [2, 3, 4]);
  const suffix = await get(segmentUrl(), { bucket, cache, headers: { Range: "bytes=-3" } });
  assert.deepEqual([...new Uint8Array(await suffix.arrayBuffer())], [7, 8, 9]);
  const beyond = await get(segmentUrl(), { bucket, cache, headers: { Range: "bytes=50-" } });
  assert.equal(beyond.status, 416);
  // And the cache holds the WHOLE object, not a slice.
  const whole = await get(segmentUrl(), { bucket, cache });
  assert.equal((await whole.arrayBuffer()).byteLength, 10);
  assert.equal(bucket.gets.length, 1);
});

test("applyRange leaves non-200 responses alone", async () => {
  const response = await applyRange(
    new Request("https://x/", { headers: { Range: "bytes=0-1" } }),
    new Response("nope", { status: 404 }),
  );
  assert.equal(response.status, 404);
});

test("the port agrees with the origin's reason words", async () => {
  const expected = { channelId: CHANNEL, startedAt: STARTED_AT, name: NAME };
  assert.equal(await describeHlsSegmentToken(mint(), expected, SECRET, NOW), null);
  assert.equal(await describeHlsSegmentToken(mint(), expected, undefined, NOW), "unconfigured");
  assert.equal(
    await describeHlsSegmentToken(mint({ r: "" }), { ...expected, name: `${STARTED_AT}_00001.ts` }, SECRET, NOW),
    null,
  );
});

function playlistListing(names, host = "hls.example.test") {
  return [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:4",
    ...names.flatMap((name) => [
      "#EXTINF:4.000,",
      `https://${host}/api/voice/hls-segment/${CHANNEL}/${STARTED_AT}/${name}?s=${mint()}`,
    ]),
  ].join("\n");
}

const seg = (n) => `${STARTED_AT}-720p30_${String(n).padStart(5, "0")}.ts`;
const PLAYLIST_URL = `https://hls.example.test/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/720p30`;

test("warm before reveal: the newest listed segments are in the colo cache before the playlist is handed on", async () => {
  resetSegmentWarmingForTests();
  const objects = {};
  for (let n = 0; n < 5; n++) objects[`live/${CHANNEL}/${seg(n)}`] = [n];
  const bucket = fakeBucket(objects);
  const cache = fakeCache();
  const ctx = collectingCtx();
  const result = await warmNewSegments(
    playlistListing([0, 1, 2, 3, 4].map(seg)),
    PLAYLIST_URL,
    env(bucket),
    cache,
    ctx,
  );
  assert.deepEqual(result, { attempted: 2, timedOut: false });
  // Only the two newest: the older ones were revealed by earlier playlists.
  // Read in parallel, so in either order.
  assert.deepEqual([...bucket.gets].sort(), [`live/${CHANNEL}/${seg(3)}`, `live/${CHANNEL}/${seg(4)}`]);
  await ctx.drain();
  assert.equal(cache.size, 2);

  // A viewer who now asks for the newest segment is a HIT, with no R2 read.
  const viewer = await get(segmentUrl({ name: seg(4) }), { bucket, cache });
  assert.equal(viewer.headers.get("X-HLS-Edge-Cache"), "HIT");
  assert.equal(bucket.gets.length, 2);

  // The next playlist (one new segment) warms only the new one.
  objects[`live/${CHANNEL}/${seg(5)}`] = [5];
  const next = await warmNewSegments(
    playlistListing([1, 2, 3, 4, 5].map(seg)),
    PLAYLIST_URL,
    env(bucket),
    cache,
    ctx,
  );
  assert.deepEqual(next, { attempted: 1, timedOut: false });
  assert.equal(bucket.gets.at(-1), `live/${CHANNEL}/${seg(5)}`);
});

test("warming is bounded: a slow read does not hold the playlist past the budget, and viewers join it", async () => {
  resetSegmentWarmingForTests();
  const bucket = fakeBucket({ [`live/${CHANNEL}/${seg(9)}`]: [9] }, { delayMs: 200 });
  const cache = fakeCache();
  const ctx = collectingCtx();
  const started = Date.now();
  const result = await warmNewSegments(playlistListing([seg(9)]), PLAYLIST_URL, env(bucket), cache, ctx, 30);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 150, "held the playlist past its budget");
  // A viewer arriving mid-read joins the warm's fetch rather than starting a second one.
  const viewer = await get(segmentUrl({ name: seg(9) }), { bucket, cache, ctx });
  assert.equal(viewer.status, 200);
  assert.equal(bucket.gets.length, 1);
});

test("warming leaves other hosts, presigned lines, and an unconfigured Worker alone", async () => {
  resetSegmentWarmingForTests();
  const bucket = fakeBucket({ [`live/${CHANNEL}/${seg(1)}`]: [1] });
  const ctx = collectingCtx();
  const otherHost = await warmNewSegments(
    playlistListing([seg(1)], "elsewhere.example.test"),
    PLAYLIST_URL,
    env(bucket),
    fakeCache(),
    ctx,
  );
  assert.equal(otherHost.attempted, 0);
  const presigned = await warmNewSegments(
    "#EXTM3U\n#EXTINF:4.000,\nhttps://bucket.r2.cloudflarestorage.com/live/x.ts?X-Amz-Signature=abc",
    PLAYLIST_URL,
    env(bucket),
    fakeCache(),
    ctx,
  );
  assert.equal(presigned.attempted, 0);
  const unbound = await warmNewSegments(
    playlistListing([seg(1)]),
    PLAYLIST_URL,
    { HLS_SEGMENT_TOKEN_SECRET: SECRET },
    fakeCache(),
    ctx,
  );
  assert.equal(unbound.attempted, 0);
  assert.deepEqual(bucket.gets, []);
});
