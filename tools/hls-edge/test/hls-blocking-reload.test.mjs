import { strict as assert } from "node:assert";
import test from "node:test";
import {
  HLS_MSN_PARAM,
  HLS_PART_PARAM,
  MAX_POLL_STATE_ENTRIES,
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
    /** Jumps the clock forward without going through `sleep` (simulates quiet time between two viewer requests). */
    advance: (ms) => {
      now += ms;
    },
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

// The tests below hold across MULTIPLE poll ticks, which (from the second
// tick onward) races each fetch against the soonest waiter's own deadline
// (`fetchWithDeadlineRace`). That race is a genuine `Promise.race` against a
// REAL timer inside the module, so it needs REAL relative timing to behave
// deterministically -- `makeClock`'s instant-resolving fake `sleep` collapses
// every duration onto the same microtask tick and would make the race's
// outcome an accident of scheduling order rather than a reflection of actual
// elapsed time. These use real `setTimeout`/`Date.now` (by omitting `now`/
// `sleep` from `deps`) with a 30ms `PART-TARGET` fixture (comfortably above
// `MIN_POLL_INTERVAL_MS`) so the tests
// stay fast (tens of milliseconds) while the relative ordering is real.

/** Same as PLAYLIST_A, but a 30ms PART-TARGET so real-timer tests stay fast. */
const PLAYLIST_A_FAST = PLAYLIST_A.replace("PART-TARGET=0.5", "PART-TARGET=0.03");
/** Same as PLAYLIST_B, but a 30ms PART-TARGET. */
const PLAYLIST_B_FAST = PLAYLIST_B.replace("PART-TARGET=0.5", "PART-TARGET=0.03");

test("awaitBlockingReload: holds, then resolves once the origin advances", async () => {
  resetBlockingReloadStateForTests();
  const playlists = [PLAYLIST_A_FAST, PLAYLIST_B_FAST];
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      const text = playlists[Math.min(fetchCalls, playlists.length - 1)];
      fetchCalls += 1;
      return toFetched(text);
    },
  };

  // Part 0 of segment 102 does not exist in PLAYLIST_A, only in PLAYLIST_B.
  const outcome = await awaitBlockingReload("rendition-3", { msn: 102, part: 0 }, deps);
  assert.equal(outcome.kind, "available");
  assert.equal(fetchCalls, 2, "should have polled once, found nothing, polled again");
});

test("awaitBlockingReload: never polls faster than once per part duration", async () => {
  resetBlockingReloadStateForTests();
  // Measures spacing between actual origin fetches, not internal `sleep`
  // calls: from the second poll tick onward, a tick's fetch is raced
  // against the soonest waiter's own deadline (`fetchWithDeadlineRace`),
  // whose internal sleep duration is "time left until that deadline", not
  // "the part-duration cadence" -- a different number the loop's own
  // per-tick pacing sleep already enforces. Fetch spacing is what the
  // "never faster than once per part" requirement actually constrains.
  const fetchTimestamps = [];
  const deps = {
    fetchRendition: async () => {
      fetchTimestamps.push(Date.now());
      return toFetched(PLAYLIST_A_FAST);
    },
  };

  // Never satisfied by PLAYLIST_A_FAST, never too far ahead (live edge 101, +2 = 103).
  await awaitBlockingReload("rendition-4", { msn: 103 }, deps);
  assert.ok(fetchTimestamps.length >= 2, "expected more than one origin fetch");
  for (let i = 1; i < fetchTimestamps.length; i += 1) {
    const gapMs = fetchTimestamps[i] - fetchTimestamps[i - 1];
    // 30ms part target, with slack for real-timer jitter.
    assert.ok(gapMs >= 20, `fetches ${i - 1} and ${i} were only ${gapMs}ms apart, faster than the part target`);
  }
});

test("awaitBlockingReload: times out at 3x the part target and returns the current playlist", async () => {
  resetBlockingReloadStateForTests();
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A_FAST);
    },
  };

  const start = Date.now();
  // msn 103 is never satisfied by PLAYLIST_A_FAST (live edge 101) and is not
  // too far ahead (101 + 2 = 103), so this holds all the way to the timeout.
  const outcome = await awaitBlockingReload("rendition-5", { msn: 103 }, deps);
  const elapsed = Date.now() - start;
  assert.equal(outcome.kind, "timeout");
  assert.equal(outcome.playlist.status, 200);

  const expectedTimeoutMs = 30 * 3; // PLAYLIST_A_FAST's PART-TARGET is 0.03s
  assert.ok(elapsed >= expectedTimeoutMs, `expected at least ${expectedTimeoutMs}ms, took ${elapsed}ms`);
  assert.ok(elapsed < expectedTimeoutMs + 300, `expected close to ${expectedTimeoutMs}ms (real-timer slack), took ${elapsed}ms`);
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
  const playlists = [PLAYLIST_A_FAST, PLAYLIST_B_FAST]; // clamps to B once exhausted
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      const text = playlists[Math.min(fetchCalls, playlists.length - 1)];
      fetchCalls += 1;
      return toFetched(text);
    },
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

test("awaitBlockingReload: a slow origin fetch does not block a waiter past its own deadline", async () => {
  resetBlockingReloadStateForTests();
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        // Populates `lastPlaylist` so the SECOND tick onward is eligible to
        // race against the deadline at all.
        return toFetched(PLAYLIST_A_FAST);
      }
      // Every tick after the first stalls far longer than the 30ms timeout
      // budget (30ms x 3) -- simulates an origin that has stopped answering.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return toFetched(PLAYLIST_A_FAST);
    },
  };

  const start = Date.now();
  // msn 103 is never satisfied by PLAYLIST_A_FAST and is not too far ahead.
  const outcome = await awaitBlockingReload("rendition-slow-origin", { msn: 103 }, deps);
  const elapsed = Date.now() - start;
  assert.equal(outcome.kind, "timeout");
  // Without the deadline race, this would have blocked for (at least) the
  // stalled tick's artificial 500ms delay before ever checking a deadline.
  assert.ok(elapsed < 400, `expected the hold to give up near its own ~90ms deadline, took ${elapsed}ms`);
});

test("awaitBlockingReload: a cold hold's provisional timeout is corrected once the real PART-TARGET is known", async () => {
  resetBlockingReloadStateForTests();
  // No prior fetch for this key, so the FIRST tick's timeout is provisional
  // (computed from DEFAULT_PART_TARGET_SECONDS = 0.5s, i.e. a 1500ms
  // budget) until that first tick's response reveals the REAL target, 30ms
  // (a 90ms budget). If the correction never ran, this would take ~1500ms.
  const deps = {
    fetchRendition: async () => toFetched(PLAYLIST_A_FAST),
  };

  const start = Date.now();
  const outcome = await awaitBlockingReload("rendition-provisional-timeout", { msn: 103 }, deps);
  const elapsed = Date.now() - start;
  assert.equal(outcome.kind, "timeout");
  assert.ok(
    elapsed < 500,
    `expected the corrected ~30ms budget, not the provisional ~1500ms one; took ${elapsed}ms`,
  );
});

test("awaitBlockingReload: retained state stops trusting the fast path once it goes stale", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  const key = "rendition-freshness";

  // First call: populates `lastEdge` from PLAYLIST_A (live edge msn 101).
  const firstDeps = {
    fetchRendition: async () => toFetched(PLAYLIST_A),
    now: clock.now,
    sleep: clock.sleep,
  };
  const first = await awaitBlockingReload(key, { msn: 100 }, firstDeps);
  assert.equal(first.kind, "available");

  // Time passes well beyond FAST_PATH_FRESHNESS_MS (2000ms) with no further
  // requests -- in the real Worker this is exactly a quiet rendition between
  // two viewer polls.
  clock.advance(3_000);

  // The rendition has genuinely moved on to msn 200 by now, but a stale
  // fast path (Farol's 2026-09-13 finding) would classify this as "more
  // than two segments beyond the STALE edge (101)" and reject it with a 400
  // WITHOUT ever asking the origin. A fresh fetch must run instead.
  const ADVANCED_PLAYLIST = [
    "#EXTM3U",
    "#EXT-X-VERSION:9",
    "#EXT-X-PART-INF:PART-TARGET=0.5",
    "#EXT-X-MEDIA-SEQUENCE:199",
    "#EXTINF:4.0,",
    "seg199.m4s",
    "#EXTINF:4.0,",
    "seg200.m4s",
  ].join("\n");
  let secondFetchCalls = 0;
  const secondDeps = {
    fetchRendition: async () => {
      secondFetchCalls += 1;
      return toFetched(ADVANCED_PLAYLIST);
    },
    now: clock.now,
    sleep: clock.sleep,
  };
  const second = await awaitBlockingReload(key, { msn: 200 }, secondDeps);
  assert.equal(second.kind, "available", "a fresh fetch should have found msn 200, not a stale 400");
  assert.equal(secondFetchCalls, 1, "the stale edge must not shortcut past a real fetch");
});

test("awaitBlockingReload: a non-2xx origin response never poisons the retained fast path", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  const key = "rendition-non-2xx";

  const failing = {
    fetchRendition: async () => toFetched("service unavailable", 503),
    now: clock.now,
    sleep: clock.sleep,
  };
  const failed = await awaitBlockingReload(key, { msn: 100 }, failing);
  assert.equal(failed.kind, "origin-error");
  assert.equal(failed.playlist.status, 503);

  // If the 503 had been allowed to populate `lastEdge`/`lastPlaylist`, this
  // second call would take the fast path and serve the 503 body back as if
  // it were an "available" playlist. It must instead run its own real fetch.
  let secondFetchCalls = 0;
  const succeeding = {
    fetchRendition: async () => {
      secondFetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    now: clock.now,
    sleep: clock.sleep,
  };
  const second = await awaitBlockingReload(key, { msn: 100 }, succeeding);
  assert.equal(second.kind, "available");
  assert.equal(second.playlist.status, 200);
  assert.equal(secondFetchCalls, 1, "the failed fetch must not have been retained as a fast-path answer");
});

test("awaitBlockingReload: an already-aborted signal resolves immediately, with no fetch at all", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    now: clock.now,
    sleep: clock.sleep,
    signal: controller.signal,
  };

  const outcome = await awaitBlockingReload("rendition-abort-pre", { msn: 103 }, deps);
  assert.deepEqual(outcome, { kind: "aborted" });
  assert.equal(fetchCalls, 0);
});

test("awaitBlockingReload: aborting mid-hold resolves as aborted without waiting for the timeout", async () => {
  resetBlockingReloadStateForTests();
  const controller = new AbortController();
  const deps = {
    // Never satisfies msn 103; PLAYLIST_A_FAST's timeout budget is 90ms.
    fetchRendition: async () => toFetched(PLAYLIST_A_FAST),
    signal: controller.signal,
  };

  setTimeout(() => controller.abort(), 20);
  const start = Date.now();
  const outcome = await awaitBlockingReload("rendition-abort-mid", { msn: 103 }, deps);
  const elapsed = Date.now() - start;
  assert.deepEqual(outcome, { kind: "aborted" });
  assert.ok(elapsed < 90, `expected the abort at ~20ms to win well before the ~90ms timeout, took ${elapsed}ms`);
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

test("handleBlockingReload: a non-2xx origin response passes through, logged, never a BLOCKING-* hit", async () => {
  resetBlockingReloadStateForTests();
  const events = [];
  const response = await handleBlockingReload(
    "rendition-h5",
    { msn: 1 },
    async () => toFetched("service unavailable", 503),
    (event, fields) => events.push({ event, fields }),
    { channelId: "chan-1", rung: "720p30" },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-HLS-Edge-Cache"), "SKIP");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.ok(events.some((e) => e.event === "hlsEdge.blockingReloadOriginRejected"));
});

test("handleBlockingReload: an already-aborted signal short-circuits to a 499, no fetch", async () => {
  resetBlockingReloadStateForTests();
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const response = await handleBlockingReload(
    "rendition-h6",
    { msn: 1 },
    async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    () => {},
    { channelId: "chan-1", rung: "720p30" },
    controller.signal,
  );
  assert.equal(response.status, 499);
  assert.equal(fetchCalls, 0);
});

// ---------------------------------------------------------------------------
// Farol 2026-09-14: bounded pollStates must never evict an active rendition,
// and the retained-state fast path must honor an already-aborted signal.
// ---------------------------------------------------------------------------

/**
 * A `fetchRendition` that never settles -- keeps a poll loop permanently
 * "polling" (no `lastPlaylist` yet, so `fetchWithDeadlineRace` awaits this
 * directly with nothing to race it against), which is exactly what an ACTIVE
 * rendition looks like from `insertPollState`'s point of view: a live loop,
 * a live waiter, never idle. Records each call so a test can tell whether a
 * loop was started more than once for the same key.
 */
function neverSettlingFetch(calls, key) {
  return async () => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return new Promise(() => {});
  };
}

test("insertPollState: an active rendition survives eviction pressure at a full map", async () => {
  resetBlockingReloadStateForTests();
  const calls = new Map();

  const survivorKey = "capacity-survivor";
  // Registered first so it is an early entry in insertion order -- exactly
  // the entry the OLD "evict the oldest" fallback would have sacrificed.
  void awaitBlockingReload(survivorKey, { msn: 1 }, { fetchRendition: neverSettlingFetch(calls, survivorKey) });
  assert.equal(calls.get(survivorKey), 1, "the survivor's loop should have started immediately");

  // Fill the rest of the map with other equally-active renditions.
  for (let i = 0; i < MAX_POLL_STATE_ENTRIES - 1; i += 1) {
    const key = `capacity-filler-${i}`;
    void awaitBlockingReload(key, { msn: 1 }, { fetchRendition: neverSettlingFetch(calls, key) });
  }

  // The map is now completely full and every entry is active (a live loop,
  // a live waiter). One more distinct key must NOT evict any of them.
  const overflow = await awaitBlockingReload(
    "capacity-overflow",
    { msn: 1 },
    { fetchRendition: neverSettlingFetch(calls, "capacity-overflow") },
  );
  assert.deepEqual(overflow, { kind: "capacity-fallback" });
  assert.equal(calls.get("capacity-overflow"), undefined, "a fallback must never start its own loop");

  // The survivor must still be the SAME retained state: a second request for
  // its key joins the existing waiter set of the SAME loop rather than
  // starting a fresh one. If it had been evicted, this call would create a
  // brand-new entry with its own loop and call `fetchRendition` again.
  void awaitBlockingReload(survivorKey, { msn: 2 }, { fetchRendition: neverSettlingFetch(calls, survivorKey) });
  assert.equal(calls.get(survivorKey), 1, "the survivor's loop must not have been restarted");
});

test("handleBlockingReload: a full map of active renditions falls back to the plain fetch instead of a hold", async () => {
  resetBlockingReloadStateForTests();
  const calls = new Map();
  const events = [];

  for (let i = 0; i < MAX_POLL_STATE_ENTRIES; i += 1) {
    const key = `h-capacity-filler-${i}`;
    void awaitBlockingReload(key, { msn: 1 }, { fetchRendition: neverSettlingFetch(calls, key) });
  }

  let plainFetchCalls = 0;
  const response = await handleBlockingReload(
    "h-capacity-overflow",
    { msn: 1 },
    async () => {
      // Represents the CALLER's own plain, non-blocking fetch -- this must
      // never be reached, because a capacity-fallback outcome is a `null`
      // Response, not a call into the hold machinery's own fetch closure.
      plainFetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    (event, fields) => events.push({ event, fields }),
    { channelId: "chan-1", rung: "720p30" },
  );

  assert.equal(response, null, "the caller must fall back to its own non-blocking path");
  assert.equal(plainFetchCalls, 0, "handleBlockingReload's own fetch closure must not run on a capacity fallback");
  assert.ok(
    events.some((e) => e.event === "hlsEdge.blockingReloadCapacityFallback"),
    "the fallback must be logged",
  );
});

test("awaitBlockingReload: an aborted signal wins even when retained state could answer instantly", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  const key = "rendition-abort-fastpath";

  // Warm the retained state: a normal call populates lastEdge/lastPlaylist
  // so a SECOND call for the same satisfiable msn would, before this fix,
  // resolve "available" straight from that state with no abort check at all.
  const warm = await awaitBlockingReload(key, { msn: 100 }, {
    fetchRendition: async () => toFetched(PLAYLIST_A),
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(warm.kind, "available");

  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const outcome = await awaitBlockingReload(key, { msn: 100 }, {
    fetchRendition: async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    now: clock.now,
    sleep: clock.sleep,
    signal: controller.signal,
  });

  assert.deepEqual(outcome, { kind: "aborted" });
  assert.equal(fetchCalls, 0, "an already-aborted request must not even reach the fast path check");
});

test("handleBlockingReload: an already-aborted signal wins over a warm retained state, no body served", async () => {
  resetBlockingReloadStateForTests();
  const key = "rendition-h-abort-fastpath";

  const warm = await handleBlockingReload(
    key,
    { msn: 100 },
    async () => toFetched(PLAYLIST_A),
    () => {},
    { channelId: "chan-1", rung: "720p30" },
  );
  assert.equal(warm.status, 200);
  assert.equal(warm.headers.get("X-HLS-Edge-Cache"), "BLOCKING-HIT");

  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  const response = await handleBlockingReload(
    key,
    { msn: 100 },
    async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    () => {},
    { channelId: "chan-1", rung: "720p30" },
    controller.signal,
  );

  assert.equal(response.status, 499);
  assert.equal(fetchCalls, 0, "an aborted request must never be served the retained playlist body");
});
