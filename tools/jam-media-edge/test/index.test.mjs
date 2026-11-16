/**
 * The public jam media Worker, end to end against fakes of the two Cloudflare
 * things it touches (an R2 bucket and the Cache API), with URLs minted two
 * ways: the golden vector `golden.json` (produced by the REAL server code,
 * `jamPublicMediaUrl`, and pinned on the server side by
 * `server/src/services/jam-public-media-edge.test.ts`), and Node's `createHmac`
 * / `createCipheriv` for the cases the server would never mint (a key outside
 * `jam/`, a traversal).
 *
 * Imports the compiled `dist/` (the package's `pretest` runs `tsc`), for the
 * same reason tools/hls-edge's tests do.
 */

import { strict as assert } from "node:assert";
import { createCipheriv, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handleRequest, resetFillsForTests, servableContentType, CACHE_TTL_SECONDS } from "../dist/handler.js";
import { isServableJamKey, openJamMediaToken } from "../dist/media-token.js";
import { parseRange, resolveRange } from "../dist/range.js";

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
// The Worker is given the API's derived key; derive it here from the (dummy) clerk key the vector was minted with.
const SECRET = createHmac("sha256", golden.clerkSecretKey).update("pqp-jam-public-media").digest("base64url");
const NOW = golden.mintedAtMs + 5 * 60_000; // five minutes after the mint
const AUDIO = golden.urls.audio;
const VIDEO = golden.urls.video;
const COVER = golden.urls.cover;

// ---- a signed URL the server would never mint ----

function mintFor(key, { secret = SECRET, expires = Math.floor(NOW / 1000) + 3000 } = {}) {
  const aesKey = createHmac("sha256", secret).update("aes-key").digest();
  const iv = createHmac("sha256", secret).update(`iv\n${key}`).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const sealed = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  const token = Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${token}\n${expires}`).digest("base64url");
  return `https://jam-media.example.test/jam-media/${token}?e=${expires}&s=${sig}`;
}

// ---- fakes ----

function bytesOf(size, seed = 7) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    out[i] = (i * 31 + seed) & 0xff;
  }
  return out;
}

function fakeBucket(objects) {
  const calls = { get: [], head: [], other: [] };
  const bucket = {
    calls,
    async get(key, options) {
      calls.get.push({ key, options });
      const object = objects[key];
      if (!object) {
        return null;
      }
      let data = object.data;
      const range = options?.range;
      if (range) {
        let start;
        let end;
        if (range.suffix !== undefined) {
          start = Math.max(0, data.length - range.suffix);
          end = data.length;
        } else {
          start = range.offset ?? 0;
          if (start >= data.length) {
            throw new Error("range not satisfiable");
          }
          end = range.length === undefined ? data.length : Math.min(data.length, start + range.length);
        }
        data = data.slice(start, end);
      }
      return {
        key,
        size: object.data.length,
        httpEtag: `"${key.length}"`,
        httpMetadata: object.contentType === undefined ? {} : { contentType: object.contentType },
        body: new Response(data).body,
      };
    },
    async head(key) {
      calls.head.push(key);
      const object = objects[key];
      return object
        ? {
            key,
            size: object.data.length,
            httpEtag: `"${key.length}"`,
            httpMetadata: object.contentType === undefined ? {} : { contentType: object.contentType },
          }
        : null;
    },
  };
  for (const name of ["put", "delete", "createMultipartUpload", "list"]) {
    bucket[name] = async () => {
      calls.other.push(name);
      throw new Error(`the Worker must never call ${name}`);
    };
  }
  return bucket;
}

/** Stores 200s by URL and answers a Range with a 206, like Cloudflare's Cache API does. */
function fakeCache() {
  const entries = new Map();
  return {
    entries,
    async match(request) {
      const hit = entries.get(request.url);
      if (!hit) {
        return undefined;
      }
      const headers = new Headers(hit.headers);
      const range = request.headers.get("Range");
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m && headers.get("Content-Length")) {
        const parsed = parseRange(range);
        const window = parsed && resolveRange(parsed, hit.body.length);
        if (!window) {
          return new Response(null, { status: 416 });
        }
        headers.set("Content-Range", `bytes ${window.start}-${window.end}/${hit.body.length}`);
        headers.set("Content-Length", String(window.end - window.start + 1));
        return new Response(hit.body.slice(window.start, window.end + 1), { status: 206, headers });
      }
      return new Response(hit.body, { status: hit.status, headers });
    },
    async put(request, response) {
      assert.notEqual(response.status, 206, "cache.put throws on a 206, so the Worker must never try");
      entries.set(request.url, {
        status: response.status,
        headers: [...response.headers],
        body: new Uint8Array(await response.arrayBuffer()),
      });
    },
  };
}

function harness(objects, env = {}) {
  resetFillsForTests();
  const bucket = fakeBucket(objects);
  const cache = fakeCache();
  const pending = [];
  const ctx = {
    waitUntil: (promise) => pending.push(promise),
    passThroughOnException() {},
  };
  const fullEnv = {
    JAM_MEDIA: bucket,
    JAM_PUBLIC_MEDIA_SECRET: SECRET,
    CORS_ALLOWED_ORIGINS: "https://jam.pqp.gg,https://pqp.gg",
    MEDIA_SERVING: "on",
    ...env,
  };
  async function call(url, init = {}, nowMs = NOW) {
    const response = await handleRequest(new Request(url, init), fullEnv, ctx, cache, nowMs);
    return response;
  }
  async function settle() {
    await Promise.all(pending.splice(0));
  }
  return { bucket, cache, call, settle, env: fullEnv };
}

const AUDIO_BYTES = bytesOf(1000);
const objects = () => ({
  [AUDIO.key]: { data: AUDIO_BYTES, contentType: "audio/flac" },
  [VIDEO.key]: { data: bytesOf(400, 3), contentType: "video/mp4" },
  [COVER.key]: { data: bytesOf(50, 5), contentType: "image/jpeg" },
});

function bufferOf(response) {
  return response.arrayBuffer().then((b) => new Uint8Array(b));
}

// ---- the token ----

test("every URL the real server minted opens to the key it signed", async () => {
  for (const item of Object.values(golden.urls)) {
    const url = new URL(item.url);
    const token = url.pathname.slice("/jam-media/".length);
    const opened = await openJamMediaToken(token, url.searchParams.get("e"), url.searchParams.get("s"), SECRET, NOW);
    assert.deepEqual(opened, { key: item.key, expires: Number(url.searchParams.get("e")) });
  }
});

test("the URL names no object key and no server id", () => {
  for (const item of Object.values(golden.urls)) {
    assert.ok(!item.url.includes("11111111"));
    assert.ok(!item.url.includes("jam/"));
  }
});

test("a bad signature, an expired URL, another secret and a malformed URL are all refused", async () => {
  const url = new URL(AUDIO.url);
  const token = url.pathname.slice("/jam-media/".length);
  const e = url.searchParams.get("e");
  const s = url.searchParams.get("s");
  assert.deepEqual(await openJamMediaToken(token, e, `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`, SECRET, NOW), {
    failure: "bad-signature",
  });
  assert.deepEqual(await openJamMediaToken(token, String(Number(e) + 1), s, SECRET, NOW), { failure: "bad-signature" });
  assert.deepEqual(await openJamMediaToken(token, e, s, "another-secret", NOW), { failure: "bad-signature" });
  assert.deepEqual(await openJamMediaToken(token, e, s, SECRET, (Number(e) + 1) * 1000), { failure: "expired" });
  assert.deepEqual(await openJamMediaToken(token, e, s, undefined, NOW), { failure: "unconfigured" });
  assert.deepEqual(await openJamMediaToken("", e, s, SECRET, NOW), { failure: "malformed" });
  assert.deepEqual(await openJamMediaToken(token, null, s, SECRET, NOW), { failure: "malformed" });
  assert.deepEqual(await openJamMediaToken(token, "12abc", s, SECRET, NOW), { failure: "malformed" });
  assert.deepEqual(await openJamMediaToken("not base64!", e, s, SECRET, NOW), { failure: "malformed" });
});

test("a correctly signed URL for anything outside jam/ or with a traversal is refused", async () => {
  for (const key of [
    "attachments/00000000/secret.pdf",
    "stories/x.jpg",
    "jam",
    "jam/../attachments/x.png",
    "jam/./x.flac",
    "jam//x.flac",
    "jam/a\\b.flac",
    "jam/a\u0000b.flac",
    "JAM/x.flac",
  ]) {
    const url = new URL(mintFor(key));
    const token = url.pathname.slice("/jam-media/".length);
    const opened = await openJamMediaToken(token, url.searchParams.get("e"), url.searchParams.get("s"), SECRET, NOW);
    assert.deepEqual(opened, { failure: "malformed" }, key);
  }
  assert.equal(isServableJamKey("jam/public/song/a.flac"), true);
  assert.equal(isServableJamKey("jam/11111111-1111-4111-8111-111111111111/song/a.mp4"), true);
});

test("the Worker never reads a key outside jam/ even for a signed URL, and never writes", async () => {
  const h = harness({ ...objects(), "attachments/secret.pdf": { data: bytesOf(10), contentType: "application/pdf" } });
  const response = await h.call(mintFor("attachments/secret.pdf"));
  assert.equal(response.status, 400);
  assert.equal(h.bucket.calls.get.length, 0);
  assert.equal(h.bucket.calls.head.length, 0);
  await h.call(AUDIO.url);
  await h.settle();
  assert.deepEqual(h.bucket.calls.other, []);
});

// ---- serving ----

test("GET serves the object with the stored type, nosniff, CORS for the allowlist and a bounded Cache-Control", async () => {
  const h = harness(objects());
  const response = await h.call(AUDIO.url, { headers: { Origin: "https://jam.pqp.gg" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "audio/flac");
  assert.equal(response.headers.get("Content-Length"), "1000");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://jam.pqp.gg");
  assert.equal(response.headers.get("Vary"), "Origin");
  assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
  assert.equal(response.headers.get("Cache-Control"), `public, max-age=${CACHE_TTL_SECONDS}`);
  assert.deepEqual(await bufferOf(response), AUDIO_BYTES);
});

test("Cache-Control never outlives the URL", async () => {
  const h = harness(objects());
  const e = Number(new URL(AUDIO.url).searchParams.get("e"));
  const response = await h.call(AUDIO.url, {}, (e - 30) * 1000);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=30");
  assert.equal((await h.call(AUDIO.url, {}, (e + 1) * 1000)).status, 403);
});

test("CORS: pqp.gg is allowed, an unknown origin gets the media but no CORS header", async () => {
  const h = harness(objects());
  const ok = await h.call(COVER.url, { headers: { Origin: "https://pqp.gg" } });
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "https://pqp.gg");
  assert.match(ok.headers.get("Access-Control-Expose-Headers"), /Content-Range/);
  const other = await h.call(COVER.url, { headers: { Origin: "https://evil.example" } });
  assert.equal(other.status, 200);
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(other.headers.get("Vary"), "Origin");
});

test("a preflight with Range answers for the allowlist and not for strangers", async () => {
  const h = harness(objects());
  const ok = await h.call(AUDIO.url, {
    method: "OPTIONS",
    headers: { Origin: "https://jam.pqp.gg", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range" },
  });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "https://jam.pqp.gg");
  assert.match(ok.headers.get("Access-Control-Allow-Headers"), /Range/i);
  assert.match(ok.headers.get("Access-Control-Allow-Methods"), /GET/);
  const stranger = await h.call(AUDIO.url, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(stranger.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(h.bucket.calls.get.length, 0);
});

test("Range on a cold object: 206 with the right bytes, and only the window is read from R2", async () => {
  const h = harness(objects());
  const response = await h.call(AUDIO.url, { headers: { Range: "bytes=10-19" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 10-19/1000");
  assert.equal(response.headers.get("Content-Length"), "10");
  assert.deepEqual(await bufferOf(response), AUDIO_BYTES.slice(10, 20));
  assert.deepEqual(h.bucket.calls.get[0].options, { range: { offset: 10, length: 10 } });
});

test("Range forms: open-ended, suffix, past the end clamps, start past the end is a 416", async () => {
  const h = harness(objects());
  const open = await h.call(AUDIO.url, { headers: { Range: "bytes=990-" } });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get("Content-Range"), "bytes 990-999/1000");
  assert.deepEqual(await bufferOf(open), AUDIO_BYTES.slice(990));

  const suffix = await h.call(AUDIO.url, { headers: { Range: "bytes=-4" } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("Content-Range"), "bytes 996-999/1000");
  assert.deepEqual(await bufferOf(suffix), AUDIO_BYTES.slice(996));

  const clamped = await h.call(AUDIO.url, { headers: { Range: "bytes=995-5000" } });
  assert.equal(clamped.status, 206);
  assert.equal(clamped.headers.get("Content-Range"), "bytes 995-999/1000");

  const past = await h.call(AUDIO.url, { headers: { Range: "bytes=1000-" } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("Content-Range"), "bytes */1000");
});

test("a Range it does not understand is served whole, never as an error", async () => {
  const h = harness(objects());
  for (const range of ["bytes=0-1,5-9", "items=0-5", "bytes=9-3", "bytes=-", "garbage"]) {
    const response = await h.call(AUDIO.url, { headers: { Range: range } });
    assert.equal(response.status, 200, range);
    assert.equal(response.headers.get("Content-Length"), "1000", range);
    await response.arrayBuffer();
  }
});

test("a cold ranged request fills the cache in the background, then everything is served from the cache", async () => {
  const h = harness(objects());
  const first = await h.call(AUDIO.url, { headers: { Range: "bytes=0-1" } });
  assert.equal(first.status, 206);
  await first.arrayBuffer();
  await h.settle();
  assert.equal(h.cache.entries.size, 1);
  const stored = [...h.cache.entries.values()][0];
  assert.equal(stored.status, 200);
  assert.equal(new Headers(stored.headers).get("Cache-Control"), `public, max-age=${CACHE_TTL_SECONDS}`);
  assert.equal(new Headers(stored.headers).get("Content-Length"), "1000");
  assert.ok(![...stored.headers].some(([name]) => name.toLowerCase().startsWith("access-control")), "CORS is added per request, never stored");
  const getsBefore = h.bucket.calls.get.length;

  const ranged = await h.call(AUDIO.url, { headers: { Range: "bytes=100-199", Origin: "https://jam.pqp.gg" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("Content-Range"), "bytes 100-199/1000");
  assert.equal(ranged.headers.get("Access-Control-Allow-Origin"), "https://jam.pqp.gg");
  assert.deepEqual(await bufferOf(ranged), AUDIO_BYTES.slice(100, 200));

  const whole = await h.call(AUDIO.url);
  assert.equal(whole.status, 200);
  assert.deepEqual(await bufferOf(whole), AUDIO_BYTES);
  assert.equal(h.bucket.calls.get.length, getsBefore, "no further R2 reads");
});

test("a cold whole GET is streamed and cached in one pass", async () => {
  const h = harness(objects());
  const response = await h.call(COVER.url);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  await h.settle();
  assert.equal(h.cache.entries.size, 1);
  assert.equal(h.bucket.calls.get.length, 1);
});

test("the cache is never a way around the credential", async () => {
  const h = harness(objects());
  await (await h.call(AUDIO.url)).arrayBuffer();
  await h.settle();
  assert.equal(h.cache.entries.size, 1);
  const e = Number(new URL(AUDIO.url).searchParams.get("e"));
  const expired = await h.call(AUDIO.url, {}, (e + 1) * 1000);
  assert.equal(expired.status, 403);
  const tampered = new URL(AUDIO.url);
  tampered.searchParams.set("s", "AAAA");
  assert.equal((await h.call(tampered.toString())).status, 403);
  const noQuery = new URL(AUDIO.url);
  noQuery.search = "";
  assert.equal((await h.call(noQuery.toString())).status, 400);
});

test("HEAD answers headers only, from the cache when it can and from R2 head when it cannot", async () => {
  const h = harness(objects());
  const cold = await h.call(AUDIO.url, { method: "HEAD" });
  assert.equal(cold.status, 200);
  assert.equal(cold.headers.get("Content-Length"), "1000");
  assert.equal(cold.headers.get("Content-Type"), "audio/flac");
  assert.equal(await cold.text(), "");
  assert.equal(h.bucket.calls.get.length, 0);
  await (await h.call(AUDIO.url)).arrayBuffer();
  await h.settle();
  const warm = await h.call(AUDIO.url, { method: "HEAD" });
  assert.equal(warm.status, 200);
  assert.equal(await warm.text(), "");
});

test("an object that has been removed from the bucket is a 404 once nothing is cached", async () => {
  const h = harness({});
  const response = await h.call(AUDIO.url);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

// ---- what is never served ----

test("only the types a jam holds are served; an unset type falls back to the extension", async () => {
  assert.equal(servableContentType("audio/flac", "jam/p/a.flac"), "audio/flac");
  assert.equal(servableContentType("Video/MP4; codecs=avc1", "jam/p/a.mp4"), "video/mp4");
  assert.equal(servableContentType("application/octet-stream", "jam/p/a.m4a"), "audio/mp4");
  assert.equal(servableContentType(undefined, "jam/p/a.jpg"), "image/jpeg");
  assert.equal(servableContentType(undefined, "jam/p/a.bin"), null);
  assert.equal(servableContentType("text/html", "jam/p/a.mp3"), null);
  assert.equal(servableContentType("image/svg+xml", "jam/p/a.jpg"), null);
  assert.equal(servableContentType("application/pdf", "jam/p/a.pdf"), null);

  const h = harness({
    [AUDIO.key]: { data: bytesOf(20), contentType: "text/html" },
    [COVER.key]: { data: bytesOf(20) },
  });
  assert.equal((await h.call(AUDIO.url)).status, 404);
  const cover = await h.call(COVER.url);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get("Content-Type"), "image/jpeg");
  await cover.arrayBuffer();
});

test("a big object is streamed ranged from R2 and never cache-filled", async () => {
  const big = { data: new Uint8Array(70 * 1024 * 1024), contentType: "video/mp4" };
  const h = harness({ [VIDEO.key]: big });
  const response = await h.call(VIDEO.url, { headers: { Range: "bytes=0-9" } });
  assert.equal(response.status, 206);
  await response.arrayBuffer();
  await h.settle();
  assert.equal(h.cache.entries.size, 0);
  assert.equal(h.bucket.calls.get.length, 1);
});

// ---- routing and the switches ----

test("only GET, HEAD and OPTIONS; nothing else is a route", async () => {
  const h = harness(objects());
  assert.equal((await h.call(AUDIO.url, { method: "POST", body: "x" })).status, 405);
  assert.equal((await h.call(AUDIO.url, { method: "PUT", body: "x" })).status, 405);
  assert.equal((await h.call(AUDIO.url, { method: "DELETE" })).status, 405);
  assert.equal((await h.call("https://jam-media.example.test/")).status, 404);
  assert.equal((await h.call("https://jam-media.example.test/api/jam/x")).status, 404);
  assert.equal((await h.call("https://jam-media.example.test/jam-media/")).status, 400);
  const health = await h.call("https://jam-media.example.test/health");
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok");
});

test("the kill switch answers 503 no-store before any credential or bucket work", async () => {
  const h = harness(objects(), { MEDIA_SERVING: "off" });
  const response = await h.call(AUDIO.url);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(h.bucket.calls.get.length, 0);
});

test("a deploy without the secret or without the bucket fails loudly, not as a 404", async () => {
  const noSecret = harness(objects(), { JAM_PUBLIC_MEDIA_SECRET: undefined });
  assert.equal((await noSecret.call(AUDIO.url)).status, 503);
  const noBucket = harness(objects(), { JAM_MEDIA: undefined });
  assert.equal((await noBucket.call(AUDIO.url)).status, 503);
});

test("rotating the secret kills every URL already handed out", async () => {
  const h = harness(objects(), { JAM_PUBLIC_MEDIA_SECRET: "rotated" });
  assert.equal((await h.call(AUDIO.url)).status, 403);
});

test("an R2 fault is the same clean 502 and the same originError event for HEAD and GET", async () => {
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const h = harness(objects());
    h.bucket.head = async () => {
      throw new Error("R2 is down");
    };
    h.bucket.get = async () => {
      throw new Error("R2 is down");
    };
    const head = await h.call(AUDIO.url, { method: "HEAD", headers: { Origin: "https://jam.pqp.gg" } });
    const get = await h.call(AUDIO.url, { headers: { Origin: "https://jam.pqp.gg" } });
    for (const response of [head, get]) {
      assert.equal(response.status, 502);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://jam.pqp.gg");
    }
    assert.deepEqual(await get.json(), { error: "origin-error" });
    assert.equal(lines.filter((line) => line.includes('"jamMedia.originError"')).length, 2);
    assert.ok(!lines.some((line) => line.includes("jamMedia.unhandled")));
  } finally {
    console.log = realLog;
  }
});
