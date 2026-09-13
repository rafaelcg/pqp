import { strict as assert } from "node:assert";
import test from "node:test";
import {
  DEFAULT_PART_TARGET_SECONDS,
  HLS_MSN_PARAM,
  HLS_PART_PARAM,
  awaitBlockingReload,
  handleBlockingReload,
  isMsnPartAvailable,
  isMsnTooFarAhead,
  parseBlockingReloadParams,
  parseLiveEdge,
  resetBlockingReloadStateForTests,
} from "../src/hls-blocking-reload.js";

/**
 * A fake wall clock: `sleep(ms)` advances it and resolves on the next
 * microtask, so a test exercising a multi-tick hold or a timeout runs in
 * real time close to zero instead of actually waiting out
 * `TIMEOUT_PART_MULTIPLIER * PART-TARGET` seconds.
 */
function makeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    sleep: (ms) =>
      new Promise((resolve) => {
        now += ms;
        queueMicrotask(resolve);
      }),
  };
}

/** @param {string} text @returns {{status: number, headers: Headers, body: ArrayBuffer}} */
function toFetched(text, status = 200) {
  return {
    status,
    headers: new Headers({ "Content-Type": "application/vnd.apple.mpegurl" }),
    body: new TextEncoder().encode(text).buffer,
  };
}

const HEADER = [
  "#EXTM3U",
  "#EXT-X-VERSION:9",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-PART-INF:PART-TARGET=0.5",
  "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5",
  "#EXT-X-MEDIA-SEQUENCE:100",
].join("\n");

/** Segments 100, 101 complete. Nothing published for 102 yet. */
const PLAYLIST_A = [
  HEADER,
  "#EXTINF:4.0,",
  "seg100.m4s",
  "#EXTINF:4.0,",
  "seg101.m4s",
].join("\n");

/** Same as A, plus two parts of segment 102 (still not complete). */
const PLAYLIST_B = [
  HEADER,
  "#EXTINF:4.0,",
  "seg100.m4s",
  "#EXTINF:4.0,",
  "seg101.m4s",
  '#EXT-X-PART:DURATION=0.5,URI="seg102.0.m4s"',
  '#EXT-X-PART:DURATION=0.5,URI="seg102.1.m4s"',
].join("\n");

/** Segment 102 now complete too, and one part of 103 has landed. */
const PLAYLIST_C = [
  HEADER,
  "#EXTINF:4.0,",
  "seg100.m4s",
  "#EXTINF:4.0,",
  "seg101.m4s",
  "#EXTINF:4.0,",
  "seg102.m4s",
  '#EXT-X-PART:DURATION=0.5,URI="seg103.0.m4s"',
].join("\n");

/** No `PART-TARGET` at all -- exercises the configured default. */
const PLAYLIST_NO_PART_INF = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:5",
  "#EXTINF:4.0,",
  "seg5.ts",
].join("\n");

// ---------------------------------------------------------------------------
// parseBlockingReloadParams
// ---------------------------------------------------------------------------

test("parseBlockingReloadParams: neither param present is `none`, the zero-behaviour-change path", () => {
  const url = new URL("https://hls.pqp.gg/api/voice/hls-playlist/chan-1/1700000000000/720p30?t=abc");
  assert.deepEqual(parseBlockingReloadParams(url), { kind: "none" });
});

test("parseBlockingReloadParams: msn only", () => {
  const url = new URL(`https://x/y?${HLS_MSN_PARAM}=42`);
  assert.deepEqual(parseBlockingReloadParams(url), { kind: "directives", value: { msn: 42 } });
});

test("parseBlockingReloadParams: msn and part", () => {
  const url = new URL(`https://x/y?${HLS_MSN_PARAM}=42&${HLS_PART_PARAM}=3`);
  assert.deepEqual(parseBlockingReloadParams(url), { kind: "directives", value: { msn: 42, part: 3 } });
});

test("parseBlockingReloadParams: 400, part without msn", () => {
  const url = new URL(`https://x/y?${HLS_PART_PARAM}=3`);
  assert.deepEqual(parseBlockingReloadParams(url), { kind: "invalid", reason: "part-without-msn" });
});

test("parseBlockingReloadParams: 400, non-integer msn", () => {
  for (const bad of ["abc", "1.5", "1e3", "", " 1", "1 "]) {
    const url = new URL(`https://x/y?${HLS_MSN_PARAM}=${encodeURIComponent(bad)}`);
    assert.deepEqual(
      parseBlockingReloadParams(url),
      { kind: "invalid", reason: "invalid-msn" },
      `expected "${bad}" to be rejected as invalid-msn`,
    );
  }
});

test("parseBlockingReloadParams: 400, negative msn", () => {
  const url = new URL(`https://x/y?${HLS_MSN_PARAM}=-1`);
  assert.deepEqual(parseBlockingReloadParams(url), { kind: "invalid", reason: "invalid-msn" });
});

test("parseBlockingReloadParams: 400, non-integer or negative part", () => {
  for (const bad of ["abc", "1.5", "-2"]) {
    const url = new URL(`https://x/y?${HLS_MSN_PARAM}=1&${HLS_PART_PARAM}=${encodeURIComponent(bad)}`);
    assert.deepEqual(
      parseBlockingReloadParams(url),
      { kind: "invalid", reason: "invalid-part" },
      `expected part "${bad}" to be rejected as invalid-part`,
    );
  }
});

// ---------------------------------------------------------------------------
// parseLiveEdge
// ---------------------------------------------------------------------------

test("parseLiveEdge: two complete segments, nothing partial yet", () => {
  assert.deepEqual(parseLiveEdge(PLAYLIST_A), {
    lastCompleteMsn: 101,
    partialMsn: null,
    partialPartCount: 0,
    partTargetSeconds: 0.5,
  });
});

test("parseLiveEdge: a partial segment with two published parts", () => {
  assert.deepEqual(parseLiveEdge(PLAYLIST_B), {
    lastCompleteMsn: 101,
    partialMsn: 102,
    partialPartCount: 2,
    partTargetSeconds: 0.5,
  });
});

test("parseLiveEdge: the partial segment completed, a new one started", () => {
  assert.deepEqual(parseLiveEdge(PLAYLIST_C), {
    lastCompleteMsn: 102,
    partialMsn: 103,
    partialPartCount: 1,
    partTargetSeconds: 0.5,
  });
});

test("parseLiveEdge: no EXT-X-PART-INF at all reads as no known PART-TARGET", () => {
  const edge = parseLiveEdge(PLAYLIST_NO_PART_INF);
  assert.equal(edge.partTargetSeconds, null);
  assert.equal(edge.lastCompleteMsn, 5);
});

// ---------------------------------------------------------------------------
// isMsnPartAvailable / isMsnTooFarAhead
// ---------------------------------------------------------------------------

test("isMsnPartAvailable: a complete segment is available regardless of `part`", () => {
  const edgeA = parseLiveEdge(PLAYLIST_A);
  assert.equal(isMsnPartAvailable(edgeA, { msn: 100 }), true);
  assert.equal(isMsnPartAvailable(edgeA, { msn: 101 }), true);
  assert.equal(isMsnPartAvailable(edgeA, { msn: 101, part: 999 }), true);
});

test("isMsnPartAvailable: a whole-segment request for the still-partial segment is not available", () => {
  const edgeB = parseLiveEdge(PLAYLIST_B);
  assert.equal(isMsnPartAvailable(edgeB, { msn: 102 }), false);
});

test("isMsnPartAvailable: a part request is available exactly once that many parts have landed", () => {
  const edgeB = parseLiveEdge(PLAYLIST_B); // 2 parts published for msn 102
  assert.equal(isMsnPartAvailable(edgeB, { msn: 102, part: 0 }), true);
  assert.equal(isMsnPartAvailable(edgeB, { msn: 102, part: 1 }), true);
  assert.equal(isMsnPartAvailable(edgeB, { msn: 102, part: 2 }), false);
});

test("isMsnPartAvailable: a segment past the partial one is never available yet", () => {
  const edgeB = parseLiveEdge(PLAYLIST_B);
  assert.equal(isMsnPartAvailable(edgeB, { msn: 103 }), false);
});

test("isMsnTooFarAhead: exactly two segments past the live edge is still fine", () => {
  const edgeA = parseLiveEdge(PLAYLIST_A); // live edge msn 101 (no partial)
  assert.equal(isMsnTooFarAhead(edgeA, { msn: 103 }), false);
  assert.equal(isMsnTooFarAhead(edgeA, { msn: 104 }), true);
});

test("isMsnTooFarAhead: the live edge is the PARTIAL segment when one is in progress", () => {
  const edgeB = parseLiveEdge(PLAYLIST_B); // live edge msn 102 (partial)
  assert.equal(isMsnTooFarAhead(edgeB, { msn: 104 }), false);
  assert.equal(isMsnTooFarAhead(edgeB, { msn: 105 }), true);
});

// ---------------------------------------------------------------------------
// awaitBlockingReload
// ---------------------------------------------------------------------------

test("awaitBlockingReload: an already-published msn resolves on the first fetch, no hold", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    now: clock.now,
    sleep: clock.sleep,
  };

  const outcome = await awaitBlockingReload("rendition-1", { msn: 100 }, deps);
  assert.equal(outcome.kind, "available");
  assert.equal(fetchCalls, 1);
});

test("awaitBlockingReload: a second call for an msn the isolate already knows about needs no fetch at all", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    now: clock.now,
    sleep: clock.sleep,
  };

  await awaitBlockingReload("rendition-2", { msn: 100 }, deps);
  assert.equal(fetchCalls, 1);

  const second = await awaitBlockingReload("rendition-2", { msn: 101 }, deps);
  assert.equal(second.kind, "available");
  assert.equal(fetchCalls, 1, "the fast path must not touch the origin again");
});

test("awaitBlockingReload: holds, then resolves once the origin advances", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  const playlists = [PLAYLIST_A, PLAYLIST_B];
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      const text = playlists[Math.min(fetchCalls, playlists.length - 1)];
      fetchCalls += 1;
      return toFetched(text);
    },
    now: clock.now,
    sleep: clock.sleep,
  };

  // Part 0 of segment 102 does not exist in PLAYLIST_A, only in PLAYLIST_B.
  const outcome = await awaitBlockingReload("rendition-3", { msn: 102, part: 0 }, deps);
  assert.equal(outcome.kind, "available");
  assert.equal(fetchCalls, 2, "should have polled once, found nothing, polled again");
});

test("awaitBlockingReload: never polls faster than once per part duration", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  const sleeps = [];
  const deps = {
    fetchRendition: async () => toFetched(PLAYLIST_A),
    now: clock.now,
    sleep: (ms) => {
      sleeps.push(ms);
      return clock.sleep(ms);
    },
  };

  // Never satisfied by PLAYLIST_A, never too far ahead (live edge 101, +2 = 103).
  await awaitBlockingReload("rendition-4", { msn: 103 }, deps);
  assert.ok(sleeps.length > 0);
  for (const ms of sleeps) {
    assert.ok(ms <= Math.round(DEFAULT_PART_TARGET_SECONDS * 1000), `poll interval ${ms}ms exceeded the part target`);
  }
});

test("awaitBlockingReload: times out at 3x the part target and returns the current playlist", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    now: clock.now,
    sleep: clock.sleep,
  };

  const start = clock.now();
  // msn 103 is never satisfied by PLAYLIST_A (live edge 101) and is not too
  // far ahead (101 + 2 = 103), so this holds all the way to the timeout.
  const outcome = await awaitBlockingReload("rendition-5", { msn: 103 }, deps);
  assert.equal(outcome.kind, "timeout");
  assert.equal(outcome.playlist.status, 200);

  const expectedTimeoutMs = Math.round(DEFAULT_PART_TARGET_SECONDS * 1000) * 3;
  assert.equal(clock.now() - start, expectedTimeoutMs);
  assert.ok(fetchCalls >= 2, "should have polled more than once before giving up");
});

test("awaitBlockingReload: an msn more than two segments beyond the live edge is rejected, not held", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    now: clock.now,
    sleep: clock.sleep,
  };

  const outcome = await awaitBlockingReload("rendition-6", { msn: 500 }, deps);
  assert.deepEqual(outcome, { kind: "too-far-ahead" });
  assert.equal(fetchCalls, 1, "should reject on the first fetch, not hold until timeout");
});

test("awaitBlockingReload: an origin failure fails every current waiter instead of holding them to timeout", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  const deps = {
    fetchRendition: async () => {
      throw new Error("origin unreachable");
    },
    now: clock.now,
    sleep: clock.sleep,
  };

  await assert.rejects(
    () => awaitBlockingReload("rendition-7", { msn: 103 }, deps),
    /origin unreachable/,
  );
});

test("awaitBlockingReload: N waiters on the same rendition, wildly different requests, coalesce onto one poll loop", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  const playlists = [PLAYLIST_A, PLAYLIST_B]; // clamps to B once exhausted
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      const text = playlists[Math.min(fetchCalls, playlists.length - 1)];
      fetchCalls += 1;
      return toFetched(text);
    },
    now: clock.now,
    sleep: clock.sleep,
  };

  const key = "rendition-coalesced";
  const requests = [
    { msn: 100 }, // satisfied immediately by A
    { msn: 101 }, // satisfied immediately by A
    { msn: 102, part: 0 }, // needs B
    { msn: 102, part: 1 }, // needs B
    { msn: 103 }, // never satisfied by A or B -- times out
  ];

  // All five requests are issued in the same tick, before any of them is
  // awaited individually -- the shape a burst of simultaneous viewer polls
  // actually takes.
  const results = await Promise.all(requests.map((r) => awaitBlockingReload(key, r, deps)));

  assert.equal(results[0].kind, "available");
  assert.equal(results[1].kind, "available");
  assert.equal(results[2].kind, "available");
  assert.equal(results[3].kind, "available");
  assert.equal(results[4].kind, "timeout");

  // Five viewers, five different (msn, part) pairs -- an unshared
  // implementation (one poll loop each) would cost up to 5 x 4 = 20 origin
  // fetches here. The shared loop costs 4: this is the whole point of L2.1's
  // origin-discipline requirement.
  assert.equal(fetchCalls, 4);
});

// ---------------------------------------------------------------------------
// handleBlockingReload (the Response-building wrapper index.ts calls)
// ---------------------------------------------------------------------------

test("handleBlockingReload: available -> 200 with the BLOCKING-HIT marker, never cacheable", async () => {
  resetBlockingReloadStateForTests();
  const events = [];
  const response = await handleBlockingReload(
    "rendition-h1",
    { msn: 100 },
    async () => toFetched(PLAYLIST_A),
    (event, fields) => events.push({ event, fields }),
    { channelId: "chan-1", rung: "720p30" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-HLS-Edge-Cache"), "BLOCKING-HIT");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(await response.text(), PLAYLIST_A);
});

test("handleBlockingReload: timeout -> 200 with the current playlist and a BLOCKING-TIMEOUT marker, logged", async () => {
  resetBlockingReloadStateForTests();
  const events = [];
  const response = await handleBlockingReload(
    "rendition-h2",
    { msn: 103 },
    async () => toFetched(PLAYLIST_A),
    (event, fields) => events.push({ event, fields }),
    { channelId: "chan-1", rung: "720p30" },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-HLS-Edge-Cache"), "BLOCKING-TIMEOUT");
  assert.ok(events.some((e) => e.event === "hlsEdge.blockingReloadTimeout"));
});

test("handleBlockingReload: too far ahead -> 400, logged with the reason", async () => {
  resetBlockingReloadStateForTests();
  const events = [];
  const response = await handleBlockingReload(
    "rendition-h3",
    { msn: 999 },
    async () => toFetched(PLAYLIST_A),
    (event, fields) => events.push({ event, fields }),
    { channelId: "chan-1", rung: "720p30" },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Bad Request", reason: "msn-too-far-ahead" });
  assert.ok(events.some((e) => e.event === "hlsEdge.blockingReloadRejected"));
});

test("handleBlockingReload: an origin fetch failure -> 502, logged", async () => {
  resetBlockingReloadStateForTests();
  const events = [];
  const response = await handleBlockingReload(
    "rendition-h4",
    { msn: 1 },
    async () => {
      throw new Error("boom");
    },
    (event, fields) => events.push({ event, fields }),
    { channelId: "chan-1", rung: "720p30" },
  );
  assert.equal(response.status, 502);
  assert.ok(events.some((e) => e.event === "hlsEdge.blockingReloadOriginError"));
});
