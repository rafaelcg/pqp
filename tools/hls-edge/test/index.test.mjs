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
// SCOPE: this file exercises ONLY the session/master route
// (`handlePlaylistRequest` called with `rung` undefined) -- the one branch
// that never touches `caches.default` or `ctx.waitUntil`, both Workers-only
// globals `node --test` has no counterpart for. The rendition route (the
// 2s shared cache, blocking reload) stays untested here for that reason,
// same as before this file existed.
import { handlePlaylistRequest } from "../dist/index.js";
import { HLS_VIEWER_TOKEN_PARAM } from "../src/hls-viewer-token.js";

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

/** An `LlPlaylistOrigin`-shaped fake that records whether it was ever asked
 * to serve a master playlist -- the assertion this whole file exists for:
 * a revoked viewer must never reach this call at all. */
function fakeLlOrigin({ ready, response = null } = {}) {
  let calls = 0;
  return {
    get ready() {
      return ready;
    },
    async fetchMultivariantPlaylist() {
      calls += 1;
      return response;
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
    requestFor(channelId, startedAt, token),
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
    requestFor(channelId, startedAt, token),
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
    requestFor(channelId, startedAt, token),
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

test("LL master route: LL origin not ready falls through to the API forward, no revocation check needed", async () => {
  const channelId = "chan-noll-1";
  const startedAt = "1726000000003";
  const userId = "user-noll-1";
  const token = tokenFor(userId, channelId, startedAt);
  // Not-ready LL origin: fetchMultivariantPlaylist must never be called, so
  // asserting `.calls` catches a regression that stops checking `ready`.
  const ll = fakeLlOrigin({ ready: false });
  const env = baseEnv({
    // Even a revoked user reaches the plain API forward here -- this route
    // relies on the API's OWN always-current check when the LL path isn't
    // in play at all, matching the module doc comment ("WHAT THIS WORKER
    // DOES NOT MAKE FASTER"). This case is about the LL branch being
    // skipped cleanly, not about revocation.
    HLS_REVOKED_USERS: fakeKv([]),
  });

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
  assert.equal(ll.calls, 0);
});
