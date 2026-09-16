/**
 * The LL media route (`src/ll-media.ts`, task `L2.3`) — the bytes an LL
 * playlist's own URIs point at.
 *
 * WHY THIS FILE CAN TEST THE WHOLE ROUTE, UNLIKE `index.test.mjs`. That
 * file is scoped to the parts of `handlePlaylistRequest` that never reach
 * `caches.default`, a Workers-only global `node --test` has no counterpart
 * for. `handleLlMediaRequest` takes its `Cache` as an argument instead, so
 * a plain Map-backed fake exercises the real cache-hit, cache-write and
 * coalescing paths here — which is the whole point of the route, and what
 * this task's acceptance test ("two viewers in one colo produce one origin
 * fetch per part") is actually about.
 *
 * Imported from the compiled output (`npm test`'s pretest step) for the
 * same reason `index.test.mjs` documents.
 */

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import test from "node:test";

import { handleLlMediaRequest } from "../dist/ll-media.js";
import { PartyPassRevocationGate } from "../src/party-pass-revocation.js";
import { HLS_VIEWER_TOKEN_PARAM } from "../src/hls-viewer-token.js";
import { HLS_PARTY_PASS_PARAM } from "../src/hls-party-pass.js";
import { LL_AUDIO_RUNG, LL_VIDEO_RUNG } from "../src/ll-state.js";

const SECRET = "test-viewer-secret";
const PARTY_SECRET = "test-party-secret";
const NOW = Date.now();

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function tokenFor(userId, channelId, startedAt, issuedAt = NOW - 1_000) {
  const claims = {
    v: 1,
    u: userId,
    c: channelId,
    s: Number(startedAt),
    e: NOW + 60_000,
    i: issuedAt,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, SECRET)}`;
}

function fakeKv(keyNames = []) {
  return {
    async list({ prefix }) {
      return { keys: keyNames.filter((name) => name.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function baseEnv(overrides = {}) {
  return {
    HLS_VIEWER_TOKEN_SECRET: SECRET,
    HLS_PARTY_PASS_SECRET: undefined,
    HLS_REVOKED_USERS: undefined,
    ENVIRONMENT: "development",
    ...overrides,
  };
}

/**
 * A `Cache`-shaped fake: `put` buffers the body (the real Cache API does
 * too, which is why `safeCachePut` may hand it a `clone()`), `match`
 * rebuilds a fresh `Response` per read, and the key is the request URL —
 * so a test asserting "the token is not part of the key" only has to ask
 * for the same path with a different `?t=`.
 */
function fakeCache() {
  const entries = new Map();
  let matches = 0;
  return {
    get size() {
      return entries.size;
    },
    /**
     * How many reads this cache has answered. Every request makes exactly
     * one before it can join or produce anything, so this is the signal a
     * test AWAITS to know a second request has got as far as the coalescing
     * it is there to exercise -- see `until` for why observing it at an
     * event-loop boundary is enough.
     */
    get matches() {
      return matches;
    },
    keys() {
      return [...entries.keys()];
    },
    async match(request) {
      matches += 1;
      const hit = entries.get(request.url);
      if (!hit) {
        return undefined;
      }
      return new Response(hit.body, { status: hit.status, headers: new Headers(hit.headers) });
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

/** Collects `waitUntil` work so a test can await the cache write the route schedules. */
function collectingCtx() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise).catch(() => {}));
    },
    async drain() {
      await Promise.all(pending);
      pending.length = 0;
    },
  };
}

function fakeMediaOrigin({ ready = true, status = 200, bytes = [1, 2, 3, 4], delayMs = 0 } = {}) {
  let calls = 0;
  const names = [];
  return {
    ready,
    get calls() {
      return calls;
    },
    get names() {
      return names;
    },
    async fetchMedia(_channelId, _startedAt, name) {
      calls += 1;
      names.push(name);
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        status,
        ok: status >= 200 && status < 300,
        body: new Uint8Array(bytes).buffer,
      };
    },
  };
}

/**
 * An origin that answers only when the test says so -- so "everybody joined
 * before it resolved" is a fact the test establishes, not a race it hopes
 * for. Preferred over `fakeMediaOrigin`'s `delayMs` wherever a test needs a
 * fetch to still be in flight when the next request arrives: a real sleep is
 * a bet that the route's own async work (a `crypto.subtle` token check,
 * among others) finishes inside it, and on a loaded runner it does not.
 */
function gatedOrigin(bytes = [7, 7, 7, 7]) {
  let calls = 0;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    ready: true,
    get calls() {
      return calls;
    },
    release,
    async fetchMedia() {
      calls += 1;
      await gate;
      return { status: 200, ok: true, body: new Uint8Array(bytes).buffer };
    },
  };
}

function mediaRequest(channelId, startedAt, rung, name, token) {
  const url =
    `https://hls.pqp.gg/api/voice/hls-playlist/${channelId}/${startedAt}/${rung}/${name}` +
    `?${HLS_VIEWER_TOKEN_PARAM}=${token}`;
  return new Request(url, { method: "GET" });
}

function callMedia(request, origin, cache, ctx, env, route, timers = {}) {
  return handleLlMediaRequest(
    request,
    origin,
    cache,
    ctx,
    env,
    new PartyPassRevocationGate(),
    route,
    timers,
  );
}

test("two concurrent viewers of the same part produce ONE origin fetch (the L2.3 acceptance test)", async () => {
  const channelId = "chan-part-coalesce";
  const startedAt = "1726000100000";
  const name = "part-164.m4s";
  const origin = fakeMediaOrigin({ delayMs: 20 });
  const cache = fakeCache();
  const ctx = collectingCtx();
  const env = baseEnv();
  const route = { channelId, startedAt, rung: LL_VIDEO_RUNG, name };

  // Two DIFFERENT viewers, two DIFFERENT tokens, same part -- exactly the
  // shape a colo sees when a new part is announced.
  const [first, second] = await Promise.all([
    callMedia(
      mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-a", channelId, startedAt)),
      origin,
      cache,
      ctx,
      env,
      route,
    ),
    callMedia(
      mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-b", channelId, startedAt)),
      origin,
      cache,
      ctx,
      env,
      route,
    ),
  ]);

  assert.equal(origin.calls, 1, "the second viewer must ride the first viewer's in-flight fetch");
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(first.headers.get("Content-Type"), "video/iso.segment");
  assert.deepEqual([...new Uint8Array(await first.arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [1, 2, 3, 4]);

  await ctx.drain();
  assert.equal(cache.size, 1, "exactly one cache entry -- only the producer writes");
  assert.equal(
    cache.keys()[0],
    `https://hls.pqp.gg/api/voice/hls-playlist/${channelId}/${startedAt}/${LL_VIDEO_RUNG}/${name}`,
    "the cache key is the path with NO query -- the token never varies the bytes",
  );
});

test("a second request for the same part is served from the cache, with a DIFFERENT viewer's token", async () => {
  const channelId = "chan-part-hit";
  const startedAt = "1726000100001";
  const name = "seg-41.m4s";
  const origin = fakeMediaOrigin();
  const cache = fakeCache();
  const ctx = collectingCtx();
  const env = baseEnv();
  const route = { channelId, startedAt, rung: LL_VIDEO_RUNG, name };

  const first = await callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-a", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
  );
  assert.equal(first.headers.get("X-HLS-Edge-Cache"), "MISS");
  await ctx.drain();

  const second = await callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-b", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
  );

  assert.equal(origin.calls, 1, "the warm entry must serve the second viewer");
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("X-HLS-Edge-Cache"), "HIT");
  assert.equal(second.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [1, 2, 3, 4]);
});

test("a part the box has not written yet passes 404 through, no-store, and is NEVER cached", async () => {
  const channelId = "chan-part-missing";
  const startedAt = "1726000100002";
  // The preload-hint case: the playlist named it, the box has not finished
  // writing it, the player asks a beat early. Ordinary, not an error.
  const name = "part-177.m4s";
  const origin = fakeMediaOrigin({ status: 404 });
  const cache = fakeCache();
  const ctx = collectingCtx();
  const env = baseEnv();
  const route = { channelId, startedAt, rung: LL_VIDEO_RUNG, name };
  const request = () =>
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-a", channelId, startedAt));

  const first = await callMedia(request(), origin, cache, ctx, env, route);
  assert.equal(first.status, 404);
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  await ctx.drain();
  assert.equal(cache.size, 0, "caching a 404 for a year would make the part permanently missing");

  // And the retry genuinely reaches the box again -- which is the whole
  // point of not caching it.
  const second = await callMedia(request(), origin, cache, ctx, env, route);
  assert.equal(second.status, 404);
  assert.equal(origin.calls, 2);
});

test("a revoked viewer is refused BEFORE the origin or the cache is ever touched", async () => {
  const channelId = "chan-part-revoked";
  const startedAt = "1726000100003";
  const userId = "viewer-revoked";
  const issuedAt = NOW - 1_000;
  const name = "part-164.m4s";
  const origin = fakeMediaOrigin();
  const cache = fakeCache();
  const ctx = collectingCtx();
  const env = baseEnv({ HLS_REVOKED_USERS: fakeKv([`${userId}:${channelId}:${issuedAt + 500}`]) });

  const response = await callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor(userId, channelId, startedAt, issuedAt)),
    origin,
    cache,
    ctx,
    env,
    { channelId, startedAt, rung: LL_VIDEO_RUNG, name },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, "revoked");
  assert.equal(origin.calls, 0, "a revoked viewer must never reach the remux box");
  assert.equal(cache.size, 0);
});

test("an invalid token is refused before any origin fetch, and cannot warm the cache for anyone", async () => {
  const channelId = "chan-part-badtoken";
  const startedAt = "1726000100004";
  const name = "part-164.m4s";
  const origin = fakeMediaOrigin();
  const cache = fakeCache();
  const ctx = collectingCtx();

  const response = await callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, "not-a-token"),
    origin,
    cache,
    ctx,
    baseEnv(),
    { channelId, startedAt, rung: LL_VIDEO_RUNG, name },
  );

  assert.equal(response.status, 401);
  assert.equal(origin.calls, 0);
  assert.equal(cache.size, 0);
});

test("a token for a DIFFERENT channel is refused (403), not quietly served this channel's bytes", async () => {
  const channelId = "chan-part-wrongchannel";
  const startedAt = "1726000100005";
  const name = "part-164.m4s";
  const origin = fakeMediaOrigin();
  const cache = fakeCache();
  const ctx = collectingCtx();

  const response = await callMedia(
    mediaRequest(
      channelId,
      startedAt,
      LL_VIDEO_RUNG,
      name,
      tokenFor("viewer-a", "some-other-channel", startedAt),
    ),
    origin,
    cache,
    ctx,
    baseEnv(),
    { channelId, startedAt, rung: LL_VIDEO_RUNG, name },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, "wrong-channel");
  assert.equal(origin.calls, 0);
});

test("the audio twins are served the same way, under their own rung", async () => {
  const channelId = "chan-part-audio";
  const startedAt = "1726000100006";
  const origin = fakeMediaOrigin();
  const cache = fakeCache();
  const ctx = collectingCtx();
  const env = baseEnv();
  const token = tokenFor("viewer-a", channelId, startedAt);

  const part = await callMedia(
    mediaRequest(channelId, startedAt, LL_AUDIO_RUNG, "audio-part-5.m4s", token),
    origin,
    cache,
    ctx,
    env,
    { channelId, startedAt, rung: LL_AUDIO_RUNG, name: "audio-part-5.m4s" },
  );
  const init = await callMedia(
    mediaRequest(channelId, startedAt, LL_AUDIO_RUNG, "audio-init.mp4", token),
    origin,
    cache,
    ctx,
    env,
    { channelId, startedAt, rung: LL_AUDIO_RUNG, name: "audio-init.mp4" },
  );

  assert.equal(part.status, 200);
  assert.equal(part.headers.get("Content-Type"), "video/iso.segment");
  assert.equal(init.status, 200);
  // An initialization segment is a plain fragmented-MP4 header, not a CMAF
  // segment -- `EXT-X-MAP` points at it and players expect the mp4 type.
  assert.equal(init.headers.get("Content-Type"), "video/mp4");
  assert.deepEqual(
    origin.names,
    ["audio-part-5.m4s", "audio-init.mp4"],
    "the name from the URI is the name asked of the box, unchanged",
  );
  await ctx.drain();
  assert.equal(cache.size, 2, "the audio twins get their own cache entries, not the video rung's");
});

test("a CONVENTIONAL rung's media 404s here without any credential work -- those bytes live in R2", async () => {
  const channelId = "chan-part-conventional";
  const startedAt = "1726000100007";
  const name = "seg-1.m4s";
  const origin = fakeMediaOrigin();
  const cache = fakeCache();
  const ctx = collectingCtx();

  const response = await callMedia(
    mediaRequest(channelId, startedAt, "720p30", name, tokenFor("viewer-a", channelId, startedAt)),
    origin,
    cache,
    ctx,
    baseEnv(),
    { channelId, startedAt, rung: "720p30", name },
  );

  assert.equal(response.status, 404);
  assert.equal(origin.calls, 0);
});

test("LL origin not configured: 404, never a 502 -- no playlist ever pointed here", async () => {
  const channelId = "chan-part-noorigin";
  const startedAt = "1726000100008";
  const name = "part-164.m4s";
  const origin = fakeMediaOrigin({ ready: false });
  const cache = fakeCache();
  const ctx = collectingCtx();

  const response = await callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-a", channelId, startedAt)),
    origin,
    cache,
    ctx,
    baseEnv(),
    { channelId, startedAt, rung: LL_VIDEO_RUNG, name },
  );

  assert.equal(response.status, 404);
  assert.equal(origin.calls, 0);
});

test("an origin 5xx is a 502 the player may retry, and is never cached", async () => {
  const channelId = "chan-part-originerror";
  const startedAt = "1726000100009";
  const name = "part-164.m4s";
  const origin = fakeMediaOrigin({ status: 503 });
  const cache = fakeCache();
  const ctx = collectingCtx();

  const response = await callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-a", channelId, startedAt)),
    origin,
    cache,
    ctx,
    baseEnv(),
    { channelId, startedAt, rung: LL_VIDEO_RUNG, name },
  );

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  await ctx.drain();
  assert.equal(cache.size, 0);
});

test("a party-pass viewer with no token at all is served the bytes -- the pass authorizes media too", async () => {
  // Otherwise a pass-holding viewer gets a playable rendition playlist whose
  // every URI 403s, which is the half of the credential story `L2.3` made
  // load-bearing: `stampLlToken` now writes the pass into those URIs
  // (`applyLlRenditionCredential`), so this is the request they produce.
  const channelId = "chan-part-partypass";
  const startedAt = "1726000100010";
  const name = "part-164.m4s";
  const claims = {
    v: 1,
    u: "viewer-pass",
    c: channelId,
    s: Number(startedAt),
    e: NOW + 600_000,
    i: NOW - 1_000,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const pass = `${payload}.${sign(payload, PARTY_SECRET)}`;
  const origin = fakeMediaOrigin();
  const cache = fakeCache();
  const ctx = collectingCtx();
  const url =
    `https://hls.pqp.gg/api/voice/hls-playlist/${channelId}/${startedAt}/${LL_VIDEO_RUNG}/${name}` +
    `?${HLS_PARTY_PASS_PARAM}=${pass}`;

  const response = await callMedia(
    new Request(url, { method: "GET" }),
    origin,
    cache,
    ctx,
    baseEnv({ HLS_PARTY_PASS_SECRET: PARTY_SECRET }),
    { channelId, startedAt, rung: LL_VIDEO_RUNG, name },
  );

  assert.equal(response.status, 200);
  assert.equal(origin.calls, 1);
  await ctx.drain();
  assert.equal(
    cache.keys()[0],
    `https://hls.pqp.gg/api/voice/hls-playlist/${channelId}/${startedAt}/${LL_VIDEO_RUNG}/${name}`,
    "a pass-authorized request writes the SAME token-free cache entry a token-authorized one does",
  );
});

test("a name outside the remux's own filename grammar never reaches the box", async () => {
  // The amplifier Farol caught: a valid token plus an endless supply of
  // path-safe names (`probe-1`, `probe-2`, ...) would be one uncached
  // origin fetch each, since a name the box does not have 404s and a 404 is
  // deliberately never cached.
  const channelId = "chan-part-badname";
  const startedAt = "1726000100011";
  const origin = fakeMediaOrigin();
  const cache = fakeCache();
  const ctx = collectingCtx();
  const token = tokenFor("viewer-a", channelId, startedAt);

  for (const [rung, name] of [
    [LL_VIDEO_RUNG, "probe-1"],
    [LL_VIDEO_RUNG, "state.json"],
    [LL_VIDEO_RUNG, "playlist.m3u8"],
    [LL_VIDEO_RUNG, "part-164.mp4"],
    // The rung and the name must agree: the video rung may not reach into
    // the audio ring, nor the other way round.
    [LL_VIDEO_RUNG, "audio-part-5.m4s"],
    [LL_AUDIO_RUNG, "part-5.m4s"],
    // Numbered video inits are legal on the video rung only — never as a
    // bare name on the audio rung, and never as an unprefixed name the
    // audio rung could somehow fetch.
    [LL_AUDIO_RUNG, "init-2.mp4"],
    [LL_VIDEO_RUNG, "audio-init-2.mp4"],
  ]) {
    const response = await callMedia(
      mediaRequest(channelId, startedAt, rung, name, token),
      origin,
      cache,
      ctx,
      baseEnv(),
      { channelId, startedAt, rung, name },
    );
    assert.equal(response.status, 404, `${rung}/${name}`);
  }

  assert.equal(origin.calls, 0, "not one of those may become an origin fetch");
});

test("a numbered video init (init-2.mp4) is served on the video rung after a parameter-set change", async () => {
  // Without this, a remux that correctly published init-2.mp4 and a
  // playlist that correctly advertised it would still 404 every MAP
  // fetch (PR #656 review): MEDIA_NAME_PATTERN used to allow only
  // exactly `init.mp4`.
  const channelId = "chan-part-init2";
  const startedAt = "1726000100099";
  const name = "init-2.mp4";
  const origin = fakeMediaOrigin();
  const cache = fakeCache();
  const ctx = collectingCtx();
  const token = tokenFor("viewer-a", channelId, startedAt);

  const response = await callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, token),
    origin,
    cache,
    ctx,
    baseEnv(),
    { channelId, startedAt, rung: LL_VIDEO_RUNG, name },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "video/mp4");
  assert.deepEqual(origin.names, ["init-2.mp4"]);
  await ctx.drain();
  assert.equal(cache.size, 1);
});

test("a coalesced waiter is served the cached copy, and the entry is warm the moment the fetch settles", async () => {
  // The window Farol caught: the in-flight entry used to be dropped as soon
  // as the origin answered, with the cache write only scheduled afterwards,
  // so a viewer arriving in between saw an empty cache AND an empty
  // in-flight map and started a second real fetch.
  const channelId = "chan-part-window";
  const startedAt = "1726000100012";
  const name = "part-999.m4s";
  // GATED, NOT SLEPT: this test needs the producer's fetch to still be in
  // flight when the waiter's cache read misses, and a real delay is a bet
  // that the waiter's own token check finishes inside it. It does not on a
  // loaded runner, and the waiter would then be served a plain HIT -- the
  // test passing while testing nothing, or failing for no reason. Real
  // timers everywhere else here on purpose: the guard `handleLlMediaRequest`
  // arms on the default path has to be armed and cancelled for real.
  const origin = gatedOrigin([1, 2, 3, 4]);
  const cache = fakeCache();
  const ctx = collectingCtx();
  const env = baseEnv();
  const route = { channelId, startedAt, rung: LL_VIDEO_RUNG, name };

  const producerRequest = callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-a", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
  );
  await until(() => origin.calls === 1, "the producer's fetch to be in flight");
  const waiterRequest = callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-b", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
  );
  // One cache read per request, and the waiter's is the last await between it
  // and the in-flight map. Microtasks run to exhaustion before the next turn
  // of `until`'s loop, so seeing the second read here means the waiter has
  // already joined.
  await until(() => cache.matches === 2, "the waiter's own cache read to miss");
  origin.release();
  const [producer, waiter] = await Promise.all([producerRequest, waiterRequest]);

  assert.equal(origin.calls, 1);
  assert.equal(producer.headers.get("X-HLS-Edge-Cache"), "MISS");
  assert.equal(
    waiter.headers.get("X-HLS-Edge-Cache"),
    "COALESCED",
    "the waiter is served the cached copy, not its own copy of the shared buffer",
  );
  assert.deepEqual([...new Uint8Array(await waiter.arrayBuffer())], [1, 2, 3, 4]);
  // Warm already, with no `drain()` -- the write happens inside the shared
  // chain, not after it.
  assert.equal(cache.size, 1);
  const third = await callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-c", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
  );
  assert.equal(third.headers.get("X-HLS-Edge-Cache"), "HIT");
  assert.equal(origin.calls, 1);
});

// ---------------------------------------------------------------------------
// THE JOINER, AND THE CONTEXT IT DOES NOT OWN (production, 2026-09-15 21:29-21:41
// UTC, the evening AFTER PR #645 fixed the same bug class on the playlist path).
//
// Five media requests were killed by the Workers runtime with "your Worker's
// code had hung and would never generate a response", each after a WALL TIME OF
// 5-6 ms -- `ll/part-941.m4s`, `ll/part-1004.m4s`, `ll-audio/audio-part-1020.m4s`,
// `ll-audio/audio-part-1030.m4s`, `ll-audio/audio-part-1475.m4s` -- while the
// origin behind them answered 3,093 requests in the same window with two
// legitimate 404s and a max of 691 ms. Two players on one LL session ask for the
// same part within ~15 ms (`ll/part-1622.m4s` at 21:41:36.295 and .310), so this
// route's coalescing runs constantly: one produces, one joins, and hls.js
// cancels a part request the moment it decides to stall, which takes the
// producer's context -- and with it every promise the joiner was parked on.
//
// Every test below would HANG, not fail, against the code that shipped that
// evening, which is why each asserts settlement through `answeredWithin`
// rather than a bare `await`, and reads "still parked" through
// `settledWithin` only once `until` has awaited the attachment that makes the
// answer deterministic.
// ---------------------------------------------------------------------------

/** A timer nothing fires but the test -- same helper, same reasoning, as `hls-blocking-reload.test.mjs`. */
function makeTimers() {
  const armed = new Set();
  return {
    setTimer: (ms, cb) => {
      const entry = { ms, cb };
      armed.add(entry);
      return () => armed.delete(entry);
    },
    get pending() {
      return armed.size;
    },
    /**
     * How many timers of exactly this duration are armed RIGHT NOW. A
     * request arms its bound the instant it attaches to somebody else's
     * promise, so this is the transition a test awaits (`until`) before it
     * counts origin fetches or fires anything -- never a number of
     * event-loop turns, which is what made this file's first draft flaky.
     */
    count(ms) {
      let armedAt = 0;
      for (const entry of armed) {
        if (entry.ms === ms) {
          armedAt += 1;
        }
      }
      return armedAt;
    },
    /** Fires every armed timer matching `predicate` -- the bounds are given distinct values so a test can pick one. */
    fireMatching(predicate) {
      let fired = 0;
      for (const entry of [...armed]) {
        if (!predicate(entry)) {
          continue;
        }
        armed.delete(entry);
        entry.cb();
        fired += 1;
      }
      return fired;
    },
  };
}

/** Distinct on purpose: `fireMatching` picks a bound by its duration. */
const JOIN_BOUND_MS = 111;
const WRITE_BOUND_MS = 222;
const HARD_TIMEOUT_MS = 333;
const BOUNDS = {
  joinBoundMs: JOIN_BOUND_MS,
  writeJoinBoundMs: WRITE_BOUND_MS,
  hardTimeoutMs: HARD_TIMEOUT_MS,
};

/** Lets every already-scheduled microtask and promise callback run. */
async function flush(turns = 12) {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * AWAITS A TRANSITION, RATHER THAN COUNTING EVENT-LOOP TURNS (CI,
 * 2026-09-15, the morning after these tests landed). The joiner test below
 * passed on its PR runner and failed twice on the shared runner for `main`
 * with `expected: 1 actual: 0`, and nothing in between had touched this
 * Worker. The cause was in the test, not the route: a request does REAL
 * asynchronous work before it reaches the coalescing these tests are about
 * -- `authorizeViewer` verifies the viewer token with `crypto.subtle`,
 * which in Node dispatches to the thread pool -- so "the joiner has
 * attached" is not a fixed number of turns away. It is however many turns
 * away that machine needs, and `flush(12)` was a bet on twelve. A busier
 * runner lost it, `origin.calls` was still 0, and the assertion that the
 * joiner had joined read as a hang it never was.
 *
 * So every wait below is a wait for an OBSERVABLE FACT: the origin has been
 * called, a bound of a given duration is armed, the cache has answered a
 * read. Polling on `setImmediate` is what makes that sound -- microtasks
 * run to exhaustion before the next macrotask, so a fact observed at a turn
 * boundary carries with it every promise continuation that fact had already
 * queued. The deadline exists only to turn "this will never happen" into a
 * legible failure instead of a hung suite; no passing run ever waits on it.
 */
async function until(predicate, what, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out after ${deadlineMs} ms waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * `{ v }` / `{ e }` if `promise` has ALREADY settled, `null` if it is still
 * parked.
 *
 * Only ever asked in a state where the answer cannot change by itself --
 * after `until` has awaited the attachment, with every promise the request
 * is parked on owned by a dead context and every timer it armed a fake one
 * only the test fires. `null` there is a property of the code under test,
 * not of how fast the machine is.
 */
async function settledWithin(promise) {
  let outcome = null;
  promise.then(
    (v) => {
      outcome = { v };
    },
    (e) => {
      outcome = { e };
    },
  );
  await flush();
  return outcome;
}

/**
 * Awaits the settlement a test has just made possible (fired the bound,
 * released the gate) and returns it as `{ v }` / `{ e }`. The deadline is
 * the failure path only: a joiner that hangs is what this file exists to
 * catch, and it must fail with a sentence rather than by hanging CI.
 */
const NEVER_SETTLED = Symbol("never-settled");
async function answeredWithin(promise, what, deadlineMs = 10_000) {
  let handle;
  const expiry = new Promise((resolve) => {
    handle = setTimeout(() => resolve(NEVER_SETTLED), deadlineMs);
    handle.unref?.();
  });
  const outcome = await Promise.race([
    promise.then(
      (v) => ({ v }),
      (e) => ({ e }),
    ),
    expiry,
  ]);
  clearTimeout(handle);
  assert.notEqual(outcome, NEVER_SETTLED, `still parked after ${deadlineMs} ms: ${what}`);
  return outcome;
}

/**
 * An origin whose Nth call behaves as the Nth entry says. `"dead"` is a
 * request context that was torn down mid-fetch: a promise nothing will ever
 * settle, which is exactly what a joiner inherits.
 */
function scriptedOrigin(script, bytes = [7, 7, 7, 7]) {
  let calls = 0;
  return {
    ready: true,
    get calls() {
      return calls;
    },
    async fetchMedia() {
      const step = script[calls] ?? "serve";
      calls += 1;
      if (step === "dead") {
        return new Promise(() => {});
      }
      return { status: 200, ok: true, body: new Uint8Array(bytes).buffer };
    },
  };
}

/** A `Cache` whose `put` never completes -- the producer's write dying with its context. */
function hangingPutCache() {
  const inner = fakeCache();
  return {
    get size() {
      return inner.size;
    },
    keys: () => inner.keys(),
    match: (request) => inner.match(request),
    put: () => new Promise(() => {}),
  };
}

test("a joiner parked on an owner whose context died is answered by its own fetch, never hung", async () => {
  const channelId = "chan-dead-owner";
  const startedAt = "1726000100020";
  const name = "part-941.m4s";
  // Call 1 is the producer's, and its context dies with it. Call 2 is the
  // joiner's own, after it detaches.
  const origin = scriptedOrigin(["dead"], [9, 9, 9, 9]);
  const cache = fakeCache();
  const ctx = collectingCtx();
  const env = baseEnv();
  const route = { channelId, startedAt, rung: LL_VIDEO_RUNG, name };
  const timers = makeTimers();

  const producer = callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-a", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
    { ...BOUNDS, setTimer: timers.setTimer },
  );
  await until(() => origin.calls === 1, "the producer's fetch to be in flight against the dying context");
  assert.equal(await settledWithin(producer), null, "the producer is the request whose context is dying");

  const joiner = callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-b", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
    { ...BOUNDS, setTimer: timers.setTimer },
  );
  // THE FIX, and the fact this whole test turns on: the joiner armed a bound
  // OF ITS OWN, in its OWN context, so the runtime always sees pending I/O
  // for it and it can take itself back. Awaited, because the joiner gets
  // there when its token check does -- see `until`.
  await until(() => timers.count(JOIN_BOUND_MS) === 1, "the joiner to arm its own join bound");
  assert.equal(
    await settledWithin(joiner),
    null,
    "still attached: this is the production state, and where the old code stopped forever",
  );
  assert.equal(origin.calls, 1, "the joiner really did join rather than fetch");

  assert.equal(timers.fireMatching((t) => t.ms === JOIN_BOUND_MS), 1, "the joiner armed its own join bound");

  const answered = await answeredWithin(joiner, "the joiner must be answered, not left parked on a dead context");
  assert.ok(answered, "the joiner must be answered, not left parked on a dead context");
  assert.equal(answered.v.status, 200);
  assert.equal(answered.v.headers.get("X-HLS-Edge-Cache"), "MISS", "it detached and produced for itself");
  assert.deepEqual([...new Uint8Array(await answered.v.arrayBuffer())], [9, 9, 9, 9]);
  assert.equal(origin.calls, 2, "exactly one extra fetch -- the joiner's own, never the shared one aborted");
});

test("the last-resort guard answers a request whose own fetch will never settle", async () => {
  const channelId = "chan-hard-timeout";
  const startedAt = "1726000100021";
  const name = "audio-part-1020.m4s";
  const origin = scriptedOrigin(["dead"], [4, 5, 6]);
  const cache = fakeCache();
  const ctx = collectingCtx();
  const env = baseEnv();
  const route = { channelId, startedAt, rung: LL_AUDIO_RUNG, name };
  const timers = makeTimers();

  // A PRODUCER has no join to bound: it awaits its own fetch. The guard is the
  // only thing between it and the hang detector, which is the whole reason it
  // exists (`DEFAULT_MEDIA_HARD_TIMEOUT_MS`).
  const pending = callMedia(
    mediaRequest(channelId, startedAt, LL_AUDIO_RUNG, name, tokenFor("viewer-a", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
    { ...BOUNDS, setTimer: timers.setTimer },
  );
  await until(
    () => origin.calls === 1 && timers.count(HARD_TIMEOUT_MS) === 1,
    "the request's own fetch to be in flight, under its own guard",
  );
  assert.equal(await settledWithin(pending), null);
  assert.equal(timers.fireMatching((t) => t.ms === HARD_TIMEOUT_MS), 1, "the guard is armed in this request's own context");

  const answered = await answeredWithin(pending, "the guard must settle the request");
  assert.ok(answered, "the guard must settle the request");
  assert.equal(answered.v.status, 200);
  assert.equal(answered.v.headers.get("X-HLS-Edge-Cache"), "HARD-TIMEOUT");
  assert.deepEqual([...new Uint8Array(await answered.v.arrayBuffer())], [4, 5, 6]);
  assert.equal(origin.calls, 2, "the guard answers by fetching the part for THIS request");
  // Awaited, never `ctx.drain()`: this request's FIRST fetch is still parked
  // (that is the scenario), so draining every `waitUntil` would hang the test
  // on the very promise the guard exists to stop waiting for.
  await until(() => cache.size === 1, "the guard's bytes to reach the colo");
  assert.equal(cache.size, 1, "and the bytes it had to go and get are left warm for the next viewer");
});

test("twelve viewers of one part still produce exactly ONE origin fetch, and all twelve settle", async () => {
  const channelId = "chan-twelve";
  const startedAt = "1726000100022";
  const name = "part-1622.m4s";
  const origin = gatedOrigin([1, 6, 2, 2]);
  const cache = fakeCache();
  const ctx = collectingCtx();
  const env = baseEnv();
  const route = { channelId, startedAt, rung: LL_VIDEO_RUNG, name };
  const timers = makeTimers();

  const all = Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      callMedia(
        mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor(`viewer-${i}`, channelId, startedAt)),
        origin,
        cache,
        ctx,
        env,
        route,
        { ...BOUNDS, setTimer: timers.setTimer },
      ),
    ),
  );
  // No bound is ever fired: nothing here is sick, so the bounded join must
  // still be a plain join. A regression that answers joiners by detaching
  // would show up as more than one origin call. Eleven join bounds, because
  // the twelfth request is the producer and has nothing to join.
  await until(
    () => origin.calls === 1 && timers.count(JOIN_BOUND_MS) === 11,
    "all eleven joiners to attach to the one fetch",
  );
  assert.equal(await settledWithin(all), null, "nobody is served until the origin answers");
  assert.equal(origin.calls, 1, "all twelve are attached to ONE fetch before it resolves");
  origin.release();
  const settled = await answeredWithin(all, "all twelve settle without any bound firing");
  assert.ok(settled, "all twelve settle without any bound firing");
  assert.equal(origin.calls, 1, "one origin fetch per key, however many viewers ask");
  for (const response of settled.v) {
    assert.equal(response.status, 200);
  }
  assert.equal(cache.size, 1, "and one cache entry, written by the producer only");
  assert.equal(timers.pending, 0, "every bound this request armed is cancelled once it is answered");
});

test("a viewer arriving while the producer's write is in flight joins the WRITE, not the origin", async () => {
  // The window Farol caught on this route's first commit, which
  // `coalesceFetch` clearing its map entry at settlement would have reopened:
  // between the origin answering and the cache being populated, an arrival
  // must have something to join.
  const channelId = "chan-write-window";
  const startedAt = "1726000100023";
  const name = "part-1004.m4s";
  const origin = fakeMediaOrigin({ bytes: [3, 1, 4, 1, 5] });
  let releaseWrite = () => {};
  const gate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const inner = fakeCache();
  const cache = {
    get size() {
      return inner.size;
    },
    keys: () => inner.keys(),
    match: (request) => inner.match(request),
    put: async (request, response) => {
      await gate;
      return inner.put(request, response);
    },
  };
  const ctx = collectingCtx();
  const env = baseEnv();
  const route = { channelId, startedAt, rung: LL_VIDEO_RUNG, name };
  const timers = makeTimers();

  const producer = await callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-a", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
    { ...BOUNDS, setTimer: timers.setTimer },
  );
  assert.equal(producer.headers.get("X-HLS-Edge-Cache"), "MISS");
  assert.equal(inner.size, 0, "the write has not landed yet -- this is the window");

  const arrival = callMedia(
    mediaRequest(channelId, startedAt, LL_VIDEO_RUNG, name, tokenFor("viewer-b", channelId, startedAt)),
    origin,
    cache,
    ctx,
    env,
    route,
    { ...BOUNDS, setTimer: timers.setTimer },
  );
  // The write is released only once the arrival has BOUNDED its wait on it:
  // releasing first would serve the arrival a plain cache HIT and quietly
  // stop testing the window this test is named for.
  await until(() => timers.count(WRITE_BOUND_MS) === 1, "the arrival to bound its wait on the producer's write");
  assert.equal(await settledWithin(arrival), null, "attached to the write, bounded by its own timer");
  assert.equal(origin.calls, 1, "it must NOT have started a second real fetch against the box");

  releaseWrite();
  const answered = await answeredWithin(arrival, "the arrival is served once the write lands");
  assert.ok(answered, "the arrival is served once the write lands");
  assert.equal(answered.v.status, 200);
  assert.equal(answered.v.headers.get("X-HLS-Edge-Cache"), "COALESCED");
  assert.deepEqual([...new Uint8Array(await answered.v.arrayBuffer())], [3, 1, 4, 1, 5]);
  assert.equal(origin.calls, 1);
});

test("a producer's cache write that never lands does not park the joiner either", async () => {
  const channelId = "chan-dead-write";
  const startedAt = "1726000100024";
  const name = "audio-part-1475.m4s";
  const origin = gatedOrigin([2, 7, 1, 8]);
  const cache = hangingPutCache();
  const ctx = collectingCtx();
  const env = baseEnv();
  const route = { channelId, startedAt, rung: LL_AUDIO_RUNG, name };
  const timers = makeTimers();

  const both = Promise.all([
    callMedia(
      mediaRequest(channelId, startedAt, LL_AUDIO_RUNG, name, tokenFor("viewer-a", channelId, startedAt)),
      origin,
      cache,
      ctx,
      env,
      route,
      { ...BOUNDS, setTimer: timers.setTimer },
    ),
    callMedia(
      mediaRequest(channelId, startedAt, LL_AUDIO_RUNG, name, tokenFor("viewer-b", channelId, startedAt)),
      origin,
      cache,
      ctx,
      env,
      route,
      { ...BOUNDS, setTimer: timers.setTimer },
    ),
  ]);
  await until(
    () => origin.calls === 1 && timers.count(JOIN_BOUND_MS) === 1,
    "the joiner to attach to the producer's one fetch",
  );
  assert.equal(await settledWithin(both), null, "nobody is served until the origin answers");
  assert.equal(origin.calls, 1, "the joiner joined rather than fetched");
  origin.release();
  await until(() => timers.count(WRITE_BOUND_MS) === 1, "the joiner to bound its wait on the producer's write");
  assert.equal(await settledWithin(both), null, "the joiner is waiting on a write nothing will finish");
  assert.equal(timers.fireMatching((t) => t.ms === WRITE_BOUND_MS), 1, "the joiner bounded that wait, in its own context");

  const answered = await answeredWithin(both, "the joiner falls back to the shared buffer rather than waiting forever");
  assert.ok(answered, "the joiner falls back to the shared buffer rather than waiting forever");
  const [producerResponse, joinerResponse] = answered.v;
  assert.equal(producerResponse.status, 200);
  assert.equal(joinerResponse.status, 200);
  assert.deepEqual([...new Uint8Array(await joinerResponse.arrayBuffer())], [2, 7, 1, 8]);
  assert.equal(cache.size, 0, "nothing was ever written -- the bytes came out of the shared buffer");
  assert.equal(origin.calls, 1, "and it did not pay for a second fetch to find that out");
});
