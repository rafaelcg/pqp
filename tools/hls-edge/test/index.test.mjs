import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import test from "node:test";

// Imported from the compiled output (`npm test`'s pretest step, `tsc -p
// tsconfig.test-build.json`, emits `dist/` -- gitignored), the same
// convention `ll-playlist-origin.test.mjs` documents: `index.ts` uses the
// "import './log.js' but the file on disk is `log.ts`" convention
// `tsconfig.json`'s `moduleResolution: "Bundler"` requires, which only
// `tsc` itself resolves.
//
// SCOPE: this file exercises the session/master route
// (`handlePlaylistRequest` called with `rung` undefined), which never
// touches `caches.default` or `ctx.waitUntil`, both Workers-only globals
// `node --test` has no counterpart for -- plus ONE slice of the rendition
// route (`rung` set): the revocation gate, which runs and returns EARLY,
// before `caches.default` or the blocking-reload machinery are ever
// reached (see `handlePlaylistRequest`'s "THE FIX FOR..." comment for where
// that check sits). Anything past that point on the rendition route (the
// 2s shared cache, blocking reload, the LL token-stamping path) stays
// untested here for that reason, same as before this file existed.
import { handlePlaylistRequest } from "../dist/index.js";
import { HLS_VIEWER_TOKEN_PARAM } from "../src/hls-viewer-token.js";
import { LL_MODE_PARAM, LL_MODE_VALUE } from "../dist/playlist-route.js";
import { LL_VIDEO_RUNG } from "../src/ll-state.js";

/** Same minting scheme as `hls-viewer-token.test.mjs` -- see that file's
 * header for why signing with Node's `createHmac` (rather than the
 * `crypto.subtle` the module under test verifies with) is deliberate. */
function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function mintToken(claims, secret) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

const SECRET = "test-viewer-secret";
// `handlePlaylistRequest` calls `verifyHlsViewerToken` with no explicit
// `now` override (unlike `hls-viewer-token.test.mjs`, which can pin one),
// so it always checks expiry against the REAL clock -- tokens here must be
// minted against `Date.now()`, not a fixed epoch.
const NOW = Date.now();

function tokenFor(userId, channelId, startedAt, issuedAt = NOW - 1_000) {
  // `s` is compared against `Number(startedAt)` (`handlePlaylistRequest`
  // builds `expected` that way from the route's own string param) -- must
  // be a number here too, or every token reads as "wrong-session" before
  // revocation is ever checked.
  return mintToken(
    { v: 1, u: userId, c: channelId, s: Number(startedAt), e: NOW + 60_000, i: issuedAt },
    SECRET,
  );
}

/** Same shape `party-pass-revocation.test.mjs` uses for its KV fake. */
function fakeKv(keyNames = []) {
  return {
    async list({ prefix }) {
      return { keys: keyNames.filter((name) => name.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function throwingKv() {
  return {
    async list() {
      throw new Error("kv unavailable");
    },
  };
}

const noopCtx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };

function baseEnv(overrides = {}) {
  return {
    HLS_VIEWER_TOKEN_SECRET: SECRET,
    HLS_PARTY_PASS_SECRET: undefined,
    HLS_REVOKED_USERS: undefined,
    ENVIRONMENT: "development",
    ...overrides,
  };
}

function requestFor(channelId, startedAt, token) {
  const url = `https://hls.pqp.gg/api/voice/hls-playlist/${channelId}/${startedAt}?${HLS_VIEWER_TOKEN_PARAM}=${token}`;
  return new Request(url, { method: "GET" });
}

/**
 * The URL an LL session's `hlsUrl` actually is: `?mode=ll` FIRST (the API
 * builds the path with the marker already on it, `llPlaylistUrl`) and the
 * viewer token appended after, which is the order `stampViewerStream`
 * produces.
 */
function llRequestFor(channelId, startedAt, token) {
  const url =
    `https://hls.pqp.gg/api/voice/hls-playlist/${channelId}/${startedAt}` +
    `?${LL_MODE_PARAM}=${LL_MODE_VALUE}&${HLS_VIEWER_TOKEN_PARAM}=${token}`;
  return new Request(url, { method: "GET" });
}

/** An `LlPlaylistOrigin`-shaped fake that records whether it was ever asked
 * to serve a master playlist -- the assertion this whole file exists for:
 * a revoked viewer must never reach this call at all. */
function fakeLlOrigin({ ready, response = null, notReady = null } = {}) {
  let calls = 0;
  return {
    get ready() {
      return ready;
    },
    async fetchMultivariantPlaylist() {
      calls += 1;
      if (notReady) {
        return { kind: "not-ready", reason: notReady };
      }
      return { kind: "ready", response };
    },
    get calls() {
      return calls;
    },
  };
}

function fakeApiOrigin() {
  return {
    ready: true,
    async fetchPlaylist() {
      return new Response("#EXTM3U\n", { status: 200 });
    },
  };
}

test("LL master route: a revoked viewer is refused BEFORE the LL origin is ever asked", async () => {
  const channelId = "chan-revoked-1";
  const startedAt = "1726000000000";
  const userId = "user-revoked-1";
  const issuedAt = NOW - 1_000;
  const token = tokenFor(userId, channelId, startedAt, issuedAt);
  const ll = fakeLlOrigin({
    ready: true,
    response: new Response("#EXTM3U\nLL SHOULD NOT BE REACHED\n", { status: 200 }),
  });
  const env = baseEnv({
    // A revocation newer than the token's own `issuedAt` -- the same
    // "was this minted before or after the most recent eviction" rule the
    // rendition route's gate already applies.
    HLS_REVOKED_USERS: fakeKv([`${userId}:${channelId}:${issuedAt + 500}`]),
  });

  const response = await handlePlaylistRequest(
    llRequestFor(channelId, startedAt, token),
    { api: fakeApiOrigin(), ll },
    noopCtx,
    env,
    channelId,
    startedAt,
    undefined,
  );

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.reason, "revoked");
  assert.equal(ll.calls, 0, "a revoked viewer must never reach the LL origin");
});

test("LL master route: an unrevoked viewer is served the LL master, unchanged", async () => {
  const channelId = "chan-clean-1";
  const startedAt = "1726000000001";
  const userId = "user-clean-1";
  const issuedAt = NOW - 1_000;
  const token = tokenFor(userId, channelId, startedAt, issuedAt);
  const llBody = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nll/index.m3u8\n";
  const ll = fakeLlOrigin({
    ready: true,
    response: new Response(llBody, { status: 200 }),
  });
  const env = baseEnv({ HLS_REVOKED_USERS: fakeKv([]) });

  const response = await handlePlaylistRequest(
    llRequestFor(channelId, startedAt, token),
    { api: fakeApiOrigin(), ll },
    noopCtx,
    env,
    channelId,
    startedAt,
    undefined,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-HLS-Edge-Mode"), "ll");
  assert.equal(await response.text(), llBody);
  assert.equal(ll.calls, 1);
});

test("LL master route: a KV read error fails CLOSED, same as the rendition route", async () => {
  const channelId = "chan-kverror-1";
  const startedAt = "1726000000002";
  const userId = "user-kverror-1";
  const token = tokenFor(userId, channelId, startedAt);
  const ll = fakeLlOrigin({
    ready: true,
    response: new Response("#EXTM3U\nSHOULD NOT BE REACHED\n", { status: 200 }),
  });
  const env = baseEnv({ HLS_REVOKED_USERS: throwingKv() });

  const response = await handlePlaylistRequest(
    llRequestFor(channelId, startedAt, token),
    { api: fakeApiOrigin(), ll },
    noopCtx,
    env,
    channelId,
    startedAt,
    undefined,
  );

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.reason, "revoked");
  assert.equal(ll.calls, 0);
});

test("conventional master route: no `mode=ll` means the LL origin is never asked, even when it is ready", async () => {
  // THE 2026-09-15 BUG, FROM THE OTHER SIDE. Before the marker existed this
  // branch probed the remux for EVERY master request once `LL_ORIGIN_BASE`
  // was set -- a conventional session paid the probe's latency and an
  // unhealthy remux could hold every conventional viewer's join open. A
  // request that does not ask for LL must be the byte-for-byte API forward
  // it was before any of this existed.
  const channelId = "chan-conventional-1";
  const startedAt = "1726000000003";
  const userId = "user-conventional-1";
  const token = tokenFor(userId, channelId, startedAt);
  const ll = fakeLlOrigin({
    ready: true,
    response: new Response("#EXTM3U\nLL SHOULD NOT BE REACHED\n", { status: 200 }),
  });
  const env = baseEnv({ HLS_REVOKED_USERS: fakeKv([]) });

  const response = await handlePlaylistRequest(
    requestFor(channelId, startedAt, token),
    { api: fakeApiOrigin(), ll },
    noopCtx,
    env,
    channelId,
    startedAt,
    undefined,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-HLS-Edge-Cache"), "BYPASS");
  assert.equal(response.headers.get("X-HLS-Edge-Mode"), null);
  assert.equal(await response.text(), "#EXTM3U\n");
  assert.equal(ll.calls, 0, "a conventional master must never touch the LL origin");
});

test("LL master route: a session whose state is not written yet gets 503 + Retry-After, NEVER the conventional ladder", async () => {
  // The whole point of this change. On 2026-09-15 the audience's only
  // master request arrived 300 ms into an LL session, found no state, and
  // was answered with the conventional ladder's master -- for a session
  // whose conventional ladder the API had deliberately not started. The
  // player fetched `/720p30`, got nothing, and the party read "A
  // transmissão caiu". A retryable refusal is the honest answer.
  const channelId = "chan-warming-1";
  const startedAt = "1726000000006";
  const userId = "user-warming-1";
  const token = tokenFor(userId, channelId, startedAt);
  const ll = fakeLlOrigin({ ready: true, notReady: "no-state" });
  const api = fakeApiOrigin();
  const env = baseEnv({ HLS_REVOKED_USERS: fakeKv([]) });

  const response = await handlePlaylistRequest(
    llRequestFor(channelId, startedAt, token),
    { api, ll },
    noopCtx,
    env,
    channelId,
    startedAt,
    undefined,
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-HLS-Edge-LL-Not-Ready"), "no-state");
  assert.equal(ll.calls, 1);
});

test("LL master route: an unconfigured LL origin is a loud 503, not a silent conventional answer", async () => {
  // The API only stamps `mode=ll` when it has both a remux control plane
  // and an edge front (`resolveHlsMode`), so this is a Worker deployed
  // without `LL_ORIGIN_BASE` while the API already selects LL -- a deploy
  // ordering mistake. The API forward would 404 (it has never known how to
  // render a `mode = 'll'` row) and would do it silently.
  const channelId = "chan-noll-1";
  const startedAt = "1726000000007";
  const userId = "user-noll-1";
  const token = tokenFor(userId, channelId, startedAt);
  const ll = fakeLlOrigin({ ready: false });
  const env = baseEnv({ HLS_REVOKED_USERS: fakeKv([]) });

  const response = await handlePlaylistRequest(
    llRequestFor(channelId, startedAt, token),
    { api: fakeApiOrigin(), ll },
    noopCtx,
    env,
    channelId,
    startedAt,
    undefined,
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-HLS-Edge-LL-Not-Ready"), "origin-not-configured");
  assert.equal(ll.calls, 0, "an unready origin must not be asked");
});

test("LL rendition route (ll): a revoked viewer is refused before any origin -- API or LL -- is ever selected", async () => {
  const channelId = "chan-revoked-rendition-1";
  const startedAt = "1726000000004";
  const userId = "user-revoked-rendition-1";
  const issuedAt = NOW - 1_000;
  const token = tokenFor(userId, channelId, startedAt, issuedAt);
  const ll = fakeLlOrigin({ ready: true });
  const env = baseEnv({
    HLS_REVOKED_USERS: fakeKv([`${userId}:${channelId}:${issuedAt + 500}`]),
  });

  const response = await handlePlaylistRequest(
    requestFor(channelId, startedAt, token),
    { api: fakeApiOrigin(), ll },
    noopCtx,
    env,
    channelId,
    startedAt,
    LL_VIDEO_RUNG,
  );

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.reason, "revoked");
  // Neither origin -- and, past that, neither `caches.default` nor the
  // blocking-reload machinery -- is ever reached: the check returns before
  // `playlistOriginKindForRung` even runs.
  assert.equal(ll.calls, 0);
});

test("LL rendition route (ll): a CHANNEL-WIDE revocation (not just a per-viewer one) also refuses the request", async () => {
  const channelId = "chan-revoked-rendition-2";
  const startedAt = "1726000000005";
  const userId = "user-untouched-1";
  const issuedAt = NOW - 1_000;
  const token = tokenFor(userId, channelId, startedAt, issuedAt);
  const ll = fakeLlOrigin({ ready: true });
  const env = baseEnv({
    // No per-viewer key at all -- only the whole-channel prefix, e.g. the
    // channel going private or being deleted (see party-pass-revocation.js
    // module doc comment, "TWO PREFIXES PER CHECK, NOT ONE").
    HLS_REVOKED_USERS: fakeKv([`channel:${channelId}:${issuedAt + 500}`]),
  });

  const response = await handlePlaylistRequest(
    requestFor(channelId, startedAt, token),
    { api: fakeApiOrigin(), ll },
    noopCtx,
    env,
    channelId,
    startedAt,
    LL_VIDEO_RUNG,
  );

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.reason, "revoked");
  assert.equal(ll.calls, 0);
});

// ---------------------------------------------------------------------------
// THE PLAIN (NON-BLOCKING) RENDITION PATH UNDER CONCURRENCY
//
// Two of the thirteen requests the Workers runtime killed on 2026-09-15 were
// PLAIN playlist requests with no `_HLS_*` directive at all, which is what
// put `inFlightRenditionFetches` in scope alongside the blocking-reload
// machinery: a caller joining a shared fetch owned by a request that has
// already returned has no pending I/O of its own. This exercises that path
// end to end -- the 2 s cache lookup, the coalesced origin fetch, the
// response build -- with a burst of concurrent callers on one key, and
// asserts that every one of them settles and that `ctx.waitUntil` is handed
// the producer's fetch.
// ---------------------------------------------------------------------------

/** `caches.default` is a Workers global with no Node counterpart; this is the smallest thing `safeCacheMatch`/`safeCachePut` accept. */
function withFakeCaches(run, match = async () => undefined) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "caches");
  const previous = globalThis.caches;
  const puts = [];
  globalThis.caches = {
    default: {
      match,
      async put(key, response) {
        puts.push(key);
        // Read the body the way the real cache does, so a response that
        // cannot be consumed twice fails here rather than silently.
        await response.arrayBuffer();
      },
    },
  };
  return run(puts).finally(() => {
    if (had) {
      globalThis.caches = previous;
    } else {
      delete globalThis.caches;
    }
  });
}

function renditionRequestFor(channelId, startedAt, rung, token) {
  const url =
    `https://hls.pqp.gg/api/voice/hls-playlist/${channelId}/${startedAt}/${rung}` +
    `?${HLS_VIEWER_TOKEN_PARAM}=${token}`;
  return new Request(url, { method: "GET" });
}

test("the plain rendition path: a burst of concurrent viewers all settle on ONE origin fetch", async () => {
  await withFakeCaches(async () => {
    const channelId = "chan-plain-burst";
    const startedAt = "1726000000000";
    const rung = "720p30";
    const token = tokenFor("user-plain-burst", channelId, startedAt);

    let originCalls = 0;
    const origin = {
      ready: true,
      async fetchPlaylist() {
        originCalls += 1;
        // Not instant: the whole point is that the later callers arrive
        // while the first one's fetch is still in flight.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\n", { status: 200 });
      },
    };

    /** @type {Promise<unknown>[]} */
    const kept = [];
    const ctx = { waitUntil: (promise) => kept.push(Promise.resolve(promise).catch(() => {})) };

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        handlePlaylistRequest(
          renditionRequestFor(channelId, startedAt, rung, token),
          { api: origin, ll: { ready: false } },
          ctx,
          baseEnv({ ORIGIN_BASE: "https://api.example" }),
          channelId,
          startedAt,
          rung,
        ),
      ),
    );

    assert.equal(responses.length, 12);
    for (const response of responses) {
      assert.equal(response.status, 200, "every concurrent caller must get an answer");
      assert.equal(await response.text(), "#EXTM3U\n#EXT-X-TARGETDURATION:4\n");
    }
    assert.equal(originCalls, 1, "twelve viewers, one origin fetch -- the whole reason this Worker exists");
    assert.ok(
      kept.length >= 1,
      "the producing request must extend its own context past its response, or the fetch its joiners share dies with it",
    );
    await Promise.all(kept);
  });
});

test("a cache HIT tells the browser two seconds, never the zone's four-hour Browser Cache TTL", async () => {
  // Production rehearsal G, 2026-09-25: `caches.default` handed back the
  // stored playlist with `Cache-Control: public, max-age=14400` and a
  // `Last-Modified`, the Worker passed them through, and the viewer's browser
  // served hls.js the same stale live playlist from its own cache for six
  // minutes: the film looped a second of video over and over.
  const stale = () =>
    new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\n", {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=14400",
        "Last-Modified": "Fri, 25 Sep 2026 19:52:13 GMT",
        Expires: "Fri, 25 Sep 2026 23:52:13 GMT",
        ETag: '"abc"',
        "Content-Type": "application/vnd.apple.mpegurl",
      },
    });
  await withFakeCaches(async () => {
    const channelId = "chan-hit-headers";
    const startedAt = "1726000000000";
    const rung = "720p30";
    const token = tokenFor("user-hit-headers", channelId, startedAt);
    const origin = {
      ready: true,
      async fetchPlaylist() {
        throw new Error("a cache hit must not reach the origin");
      },
    };
    const response = await handlePlaylistRequest(
      renditionRequestFor(channelId, startedAt, rung, token),
      { api: origin, ll: { ready: false } },
      { waitUntil() {} },
      baseEnv({ ORIGIN_BASE: "https://api.example" }),
      channelId,
      startedAt,
      rung,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-HLS-Edge-Cache"), "HIT");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=2");
    assert.equal(response.headers.get("Last-Modified"), null);
    assert.equal(response.headers.get("Expires"), null);
    assert.equal(response.headers.get("ETag"), null);
    assert.equal(response.headers.get("Content-Type"), "application/vnd.apple.mpegurl");
  }, async () => stale());
});
