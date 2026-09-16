import { strict as assert } from "node:assert";
import test from "node:test";

// Imported from the compiled output (`npm test`'s pretest step, `tsc -p
// tsconfig.test-build.json`, emits `dist/` -- gitignored, matching this
// repo's `**/dist/` pattern) rather than the `.ts` source directly: this
// class's imports use the "import './log.js' but the file on disk is
// `log.ts`" convention `tsconfig.json`'s `moduleResolution: "Bundler"`
// requires, which only a bundler or `tsc` itself (not Node's own
// `--experimental-strip-types` loader) resolves. Compiling first is what
// lets this file exercise the REAL class Farol's review flagged --
// `ll-playlist-origin.ts` is otherwise, like `playlist-origin.ts` and
// `index.ts`, untested directly in this package (see those files' absence
// from any `*.test.mjs`), covered only by `tsc --noEmit` and the pure
// modules underneath it.
import { LlPlaylistOrigin } from "../dist/ll-playlist-origin.js";
import { LL_AUDIO_RUNG, LL_VIDEO_RUNG } from "../src/ll-state.js";

const ORIGIN_BASE = "https://remux-box.test";
const CHANNEL_ID = "chan_abc123";
const STARTED_AT = "1757865600000";

/** A minimal, valid `state.json` body -- see `ll-state.test.mjs`'s own fixture for the full shape this mirrors. */
function stateFixture({ withAudio = false } = {}) {
  return {
    sessionId: "5a1b2c3d-1234-5678-9abc-1234567890ab",
    channelId: CHANNEL_ID,
    partTargetMs: 500,
    segmentTargetMs: 4000,
    targetDurationSecs: 4.02,
    mediaSequence: 41,
    video: {
      initUri: "init.mp4",
      segments: [
        {
          msn: 41,
          complete: true,
          durationSecs: 4.0,
          programDateTime: "2026-09-14T18:03:21.114Z",
          uri: "seg-41.m4s",
          parts: [{ index: 0, durationSecs: 0.5, independent: true, uri: "part-41.0.m4s" }],
        },
      ],
      preloadHint: null,
    },
    audio: withAudio
      ? {
          initUri: "audio-init.mp4",
          segments: [
            {
              msn: 41,
              complete: true,
              durationSecs: 4.0,
              programDateTime: "2026-09-14T18:03:21.114Z",
              uri: "audio-seg-41.m4s",
              parts: [{ index: 0, durationSecs: 0.5, independent: true, uri: "audio-part-41.0.m4s" }],
            },
          ],
          preloadHint: null,
        }
      : null,
  };
}

/**
 * A minimal, real CMAF init segment (moov > trak > mdia > minf > stbl >
 * stsd > avc1 > avcC) -- the exact box shapes `ll-init-codecs.test.mjs`
 * already exercises directly; duplicated here in miniature since this
 * file's job is exercising `LlPlaylistOrigin`'s FETCH/CACHE behavior, not
 * re-proving the box parser.
 */
function minimalInitSegmentBytes({ profile = 0x64, compatibility = 0x00, level = 0x28, width = 1920, height = 1080 } = {}) {
  function u32(n) {
    return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  function u16(n) {
    return [(n >>> 8) & 0xff, n & 0xff];
  }
  function ascii(s) {
    return Array.from(s).map((c) => c.charCodeAt(0));
  }
  function box(type, payload) {
    const body = [...ascii(type), ...payload];
    return [...u32(body.length + 4), ...body];
  }
  const avcC = box("avcC", [1, profile, compatibility, level, 0xff, 0xe1, ...u16(2), 0xaa, 0xbb, 1, ...u16(2), 0xcc, 0xdd]);
  const visualSampleEntryFixed = [
    ...new Array(8).fill(0),
    ...new Array(16).fill(0),
    ...u16(width),
    ...u16(height),
    ...u32(0x00480000),
    ...u32(0x00480000),
    ...u32(0),
    ...u16(1),
    ...new Array(32).fill(0),
    ...u16(0x0018),
    ...u16(0xffff),
  ];
  const avc1 = box("avc1", [...visualSampleEntryFixed, ...avcC]);
  const stsd = box("stsd", [0, 0, 0, 0, ...u32(1), ...avc1]);
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const mdia = box("mdia", minf);
  const trak = box("trak", mdia);
  const moov = box("moov", trak);
  return new Uint8Array([...moov]).buffer;
}

/**
 * A promise that resolves after `ms`, or rejects with an `AbortError` the
 * moment `signal` fires -- the same shape a real `fetch()`-tied body-read
 * behaves under WHATWG's spec (aborting the controller cancels an in-flight
 * body read, not just the initial headers wait). Used to simulate a remux
 * origin that answers headers promptly but stalls mid-body.
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

/**
 * A configurable `fetch` stub, installed on `globalThis.fetch` for the
 * duration of one test. Counts calls per path SHAPE (`state.json` vs an
 * init segment) so a test can assert "one real fetch, not N" regardless of
 * how many concurrent callers asked. `stateProvider` is called fresh on
 * every state.json request, so a test can hand back a DIFFERENT body on a
 * later call (simulating a session's state changing between requests --
 * "audio appears later").
 */
function installFetchStub({
  stateProvider,
  initBytes = minimalInitSegmentBytes(),
  initBytesForUri,
  headersDelayMs = 0,
  bodyDelayMs = 0,
} = {}) {
  const calls = { state: 0, init: 0, other: 0 };
  // Every request's headers, in call order — a plain array rather than
  // "last seen" so a test asserting "the origin key is on EVERY origin
  // fetch, not just the first" (state.json AND init.mp4, across a join
  // burst) has something to check, not just one sample.
  const requestHeaders = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requestHeaders.push(new Headers(init?.headers));
    const signal = init?.signal;
    await delay(headersDelayMs, signal);
    const href = url.toString();
    if (href.endsWith("/state.json")) {
      calls.state += 1;
      const body = new TextEncoder().encode(JSON.stringify(stateProvider())).buffer;
      return {
        status: 200,
        ok: true,
        arrayBuffer: () => delay(bodyDelayMs, signal).then(() => body),
      };
    }
    if (/\/init(?:-\d+)?\.mp4$/.test(href)) {
      calls.init += 1;
      return {
        status: 200,
        ok: true,
        arrayBuffer: () => delay(bodyDelayMs, signal).then(() => initBytesForUri?.(href) ?? initBytes),
      };
    }
    calls.other += 1;
    return { status: 404, ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  };
  return {
    calls,
    requestHeaders,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("audio appears later: the master playlist grows an audio group on a LATER request without ever caching a stale absence", async () => {
  let withAudio = false;
  const stub = installFetchStub({ stateProvider: () => stateFixture({ withAudio }) });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000);

    const firstMaster = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token-1");
    assert.equal(firstMaster.kind, "ready");
    const firstText = await firstMaster.response.text();
    assert.doesNotMatch(firstText, /EXT-X-MEDIA:TYPE=AUDIO/, "no stage source has spoken yet");

    withAudio = true; // the session's state.json now reports an audio track
    const secondMaster = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token-2");
    assert.equal(secondMaster.kind, "ready");
    const secondText = await secondMaster.response.text();
    assert.match(secondText, /EXT-X-MEDIA:TYPE=AUDIO/, "the audio group must appear once state.json reports one");
    assert.match(secondText, /CODECS="avc1\.640028,mp4a\.40\.2"/);

    // The VIDEO codec is legitimately memoized (avcC cannot change): only
    // ONE init.mp4 fetch across both master requests. state.json, by
    // contrast, is fetched fresh every time -- it is live data, not a
    // codec constant.
    assert.equal(stub.calls.init, 1, "video init segment should be fetched once and cached");
    assert.equal(stub.calls.state, 2, "state.json is fetched fresh on every master request");
  } finally {
    stub.restore();
  }
});

test("a new video init refetches codec and geometry instead of using the previous init's cache", async () => {
  let initUri = "init.mp4";
  const stub = installFetchStub({
    stateProvider: () => {
      const state = stateFixture();
      state.video.initUri = initUri;
      state.video.segments[0].initUri = initUri;
      return state;
    },
    initBytesForUri: (href) =>
      href.endsWith("/init-2.mp4")
        ? minimalInitSegmentBytes({ profile: 0x4d, level: 0x1f, width: 1280, height: 720 })
        : minimalInitSegmentBytes(),
  });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000);
    const first = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token-1");
    assert.equal(first.kind, "ready");
    assert.match(await first.response.text(), /RESOLUTION=1920x1080,CODECS="avc1\.640028"/);

    initUri = "init-2.mp4";
    const second = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token-2");
    assert.equal(second.kind, "ready");
    assert.match(await second.response.text(), /RESOLUTION=1280x720,CODECS="avc1\.4d001f"/);
    assert.equal(stub.calls.init, 2, "each distinct newest init URI must be fetched once");
  } finally {
    stub.restore();
  }
});

test("N concurrent master requests for the same session produce exactly one state.json fetch and one init.mp4 fetch", async () => {
  const stub = installFetchStub({
    stateProvider: () => stateFixture({ withAudio: false }),
    headersDelayMs: 5,
    bodyDelayMs: 15,
  });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000);
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, `token-${i}`)),
    );
    assert.equal(results.length, N);
    for (const r of results) {
      assert.equal(r.kind, "ready", "every concurrent master request should still resolve to a playlist");
    }
    assert.equal(stub.calls.state, 1, `expected exactly 1 state.json fetch for ${N} concurrent joins, got ${stub.calls.state}`);
    assert.equal(stub.calls.init, 1, `expected exactly 1 init.mp4 fetch for ${N} concurrent joins, got ${stub.calls.init}`);
  } finally {
    stub.restore();
  }
});

test("N concurrent rendition requests for the same session produce exactly one state.json fetch", async () => {
  const stub = installFetchStub({
    stateProvider: () => stateFixture({ withAudio: false }),
    headersDelayMs: 5,
    bodyDelayMs: 15,
  });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000);
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        origin.fetchPlaylist({ channelId: CHANNEL_ID, startedAt: STARTED_AT, rung: LL_VIDEO_RUNG, token: "ignored" }),
      ),
    );
    assert.equal(results.length, N);
    for (const response of results) {
      assert.equal(response.status, 200);
    }
    assert.equal(stub.calls.state, 1, `expected exactly 1 state.json fetch for ${N} concurrent rendition polls, got ${stub.calls.state}`);
  } finally {
    stub.restore();
  }
});

test("a request for the ll-audio rung 404s cleanly once audio genuinely does not exist yet, with no crash", async () => {
  const stub = installFetchStub({ stateProvider: () => stateFixture({ withAudio: false }) });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000);
    const response = await origin.fetchPlaylist({
      channelId: CHANNEL_ID,
      startedAt: STARTED_AT,
      rung: LL_AUDIO_RUNG,
      token: "ignored",
    });
    assert.equal(response.status, 404);
  } finally {
    stub.restore();
  }
});

test("a session whose state.json is not written YET answers `not-ready: no-state`, never a conventional fallback", async () => {
  // THE 2026-09-15 BUG, pinned. A 404 on state.json used to be read as
  // "this party is conventional" and resolved to `null`, which `index.ts`
  // turned into the API's conventional master. For an LL session — and by
  // the time this method is called, `requestsLlMode` has already said the
  // request IS for one — that is a ladder nothing is writing. The only
  // honest answer is "not yet", with a reason.
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 404, ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000);
    const result = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token");
    assert.deepEqual(result, { kind: "not-ready", reason: "no-state" });
  } finally {
    globalThis.fetch = original;
  }
});

test("a slow origin does not hold an LL master request out to the full origin timeout -- MASTER_PROBE_TIMEOUT_MS bounds it", async () => {
  // A generously long origin timeout (5000ms) that would normally govern
  // this fetch -- state.json itself answers 404, but only after a delay
  // well PAST the master route's own short probe deadline. Without the
  // probe bound, `fetchMultivariantPlaylist` would wait the full
  // STATE_DELAY_MS before answering; with it, THIS request must come back
  // quickly and tell the player to retry.
  const STATE_DELAY_MS = 2_500; // comfortably past the module's MASTER_PROBE_TIMEOUT_MS (1_500ms), well inside the 5000ms origin timeout below
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, STATE_DELAY_MS));
    return { status: 404, ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  };
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000);
    const startedAt = Date.now();
    const result = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token");
    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(result, { kind: "not-ready", reason: "probe-timeout" });
    assert.ok(
      elapsedMs < STATE_DELAY_MS,
      `expected the master probe's own short deadline to win before the ${STATE_DELAY_MS}ms origin delay (got ${elapsedMs}ms)`,
    );
    assert.equal(calls, 1, "the underlying state.json fetch still happens exactly once, just not waited on by this caller");
  } finally {
    globalThis.fetch = original;
  }
});

test("a not-ready answer is memoed: a second master request inside the TTL skips the origin, and the memo expires", async () => {
  // The bound that keeps five hundred people joining a WARMING party from
  // being five hundred state.json fetches a second against the remux. One
  // second, not five: see `NOT_READY_CACHE_TTL_MS`'s doc comment for why a
  // longer memo would add that long to the start of every LL party.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { status: 404, ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  };
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000);
    const first = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token-1");
    assert.deepEqual(first, { kind: "not-ready", reason: "no-state" });
    assert.equal(calls, 1, "the first request has to ask the origin");

    const second = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token-2");
    assert.deepEqual(second, { kind: "not-ready", reason: "no-state" });
    assert.equal(calls, 1, "a second request within the memo TTL must not ask the origin again");

    // A DIFFERENT session (channel) is unaffected by the first session's
    // memo -- the key includes channelId/startedAt.
    const otherChannel = await origin.fetchMultivariantPlaylist("chan_other", STARTED_AT, "token-3");
    assert.deepEqual(otherChannel, { kind: "not-ready", reason: "no-state" });
    assert.equal(calls, 2, "a different session must still be probed on its own");

    // AND IT LETS GO. A memo that outlived the warm-up would be the bug
    // this whole change is about, one layer down: the session becomes
    // ready and nobody notices.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token-4");
    assert.equal(calls, 3, "past the TTL the origin must be asked again");
  } finally {
    globalThis.fetch = original;
  }
});

test("a stalled body is bounded by the timeout, not just the headers wait", async () => {
  // Headers answer promptly; the body then stalls far longer than the
  // configured timeout. Before this was fixed, `fetchFromOrigin` cleared
  // its abort timer the instant `fetch()` resolved (headers only), so a
  // caller's `.arrayBuffer()`/`.json()` read afterward had no deadline at
  // all -- this master request would have hung for the full body delay
  // (or forever, against a genuinely stuck connection) instead of failing
  // fast. `fetchMultivariantPlaylist` turns the resulting error into a
  // `not-ready` (see this file's "FAILS TOWARD..." doc comment), so what
  // this test can observe is TIMING: it must come back well inside the
  // stall, not after it.
  const TIMEOUT_MS = 50;
  const BODY_STALL_MS = 2000;
  const stub = installFetchStub({
    stateProvider: () => stateFixture({ withAudio: false }),
    headersDelayMs: 5,
    bodyDelayMs: BODY_STALL_MS,
  });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, TIMEOUT_MS);
    const startedAt = Date.now();
    const result = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token");
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.kind, "not-ready", "a stalled remux body must fail the master request, not hang it");
    assert.ok(
      elapsedMs < BODY_STALL_MS / 2,
      `expected the abort to bound the body read well under the ${BODY_STALL_MS}ms stall (got ${elapsedMs}ms)`,
    );
  } finally {
    stub.restore();
  }
});

test("a stalled body also bounds a rendition request (fetchPlaylist rejects, does not hang)", async () => {
  const TIMEOUT_MS = 50;
  const BODY_STALL_MS = 2000;
  const stub = installFetchStub({
    stateProvider: () => stateFixture({ withAudio: false }),
    headersDelayMs: 5,
    bodyDelayMs: BODY_STALL_MS,
  });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, TIMEOUT_MS);
    const startedAt = Date.now();
    await assert.rejects(() =>
      origin.fetchPlaylist({ channelId: CHANNEL_ID, startedAt: STARTED_AT, rung: LL_VIDEO_RUNG, token: "ignored" }),
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs < BODY_STALL_MS / 2,
      `expected the abort to bound the body read well under the ${BODY_STALL_MS}ms stall (got ${elapsedMs}ms)`,
    );
  } finally {
    stub.restore();
  }
});

test("LL_ORIGIN_KEY is sent as X-Pqp-Origin-Key on every origin fetch (state.json AND init.mp4)", async () => {
  const stub = installFetchStub({ stateProvider: () => stateFixture({ withAudio: false }) });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000, "remux-shared-secret");
    await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token");
    assert.ok(stub.requestHeaders.length >= 2, "expected at least one state.json and one init.mp4 fetch");
    for (const headers of stub.requestHeaders) {
      assert.equal(headers.get("X-Pqp-Origin-Key"), "remux-shared-secret");
    }
  } finally {
    stub.restore();
  }
});

test("no LL_ORIGIN_KEY configured: no X-Pqp-Origin-Key header is sent at all", async () => {
  const stub = installFetchStub({ stateProvider: () => stateFixture({ withAudio: false }) });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000);
    await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token");
    assert.ok(stub.requestHeaders.length >= 1);
    for (const headers of stub.requestHeaders) {
      assert.equal(headers.get("X-Pqp-Origin-Key"), null);
    }
  } finally {
    stub.restore();
  }
});

test("the origin key is never forwarded to a viewer: the rendered response carries no such header", async () => {
  const stub = installFetchStub({ stateProvider: () => stateFixture({ withAudio: false }) });
  try {
    const origin = new LlPlaylistOrigin(ORIGIN_BASE, 5000, "remux-shared-secret");
    const master = await origin.fetchMultivariantPlaylist(CHANNEL_ID, STARTED_AT, "token");
    assert.equal(master.kind, "ready");
    assert.equal(master.response.headers.get("X-Pqp-Origin-Key"), null);
    assert.equal(master.response.headers.get("Content-Type"), "application/vnd.apple.mpegurl; charset=utf-8");

    const rendition = await origin.fetchPlaylist({
      channelId: CHANNEL_ID,
      startedAt: STARTED_AT,
      rung: LL_VIDEO_RUNG,
      token: "ignored",
    });
    assert.equal(rendition.headers.get("X-Pqp-Origin-Key"), null);
  } finally {
    stub.restore();
  }
});
