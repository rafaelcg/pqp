import { strict as assert } from "node:assert";
import test from "node:test";
import {
  HLS_MSN_PARAM,
  HLS_PART_PARAM,
  MAX_ACTIVE_POLL_LOOPS,
  MAX_POLL_STATE_ENTRIES,
  MAX_WAITERS_PER_RENDITION,
  VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS,
  VIDEO_RUNG_FAST_POLL_WINDOW_MS,
  VIDEO_RUNG_HOLD_BUDGET_MS,
  awaitBlockingReload,
  handleBlockingReload,
  isMsnPartAvailable,
  isMsnTooFarAhead,
  parseBlockingReloadParams,
  parseLiveEdge,
  resetBlockingReloadStateForTests,
} from "../src/hls-blocking-reload.js";
import { LL_AUDIO_RUNG, LL_VIDEO_RUNG } from "../src/ll-state.js";

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

test("VIDEO_RUNG_HOLD_BUDGET_MS is pinned at 6s -- the remux's ~5s worst case plus margin", () => {
  assert.equal(VIDEO_RUNG_HOLD_BUDGET_MS, 6_000);
});

test("awaitBlockingReload: the video rung (deps.rung === LL_VIDEO_RUNG) outlives the plain 3x-part-target formula's deadline", async () => {
  resetBlockingReloadStateForTests();
  // Real timers on purpose (no `now`/`sleep` injected), like the other
  // multi-tick real-timer tests above -- the fake clock's `sleep` advances
  // its clock synchronously at CALL time, which makes it unsuitable for
  // racing a several-second deadline against an instantly-resolving fetch
  // (the fetch's `.then` always wins the microtask race before the
  // "deadline" promise's own `.then` ever gets a turn). A real ~6s wait to
  // prove the exact budget is too slow for a unit suite, so this proves the
  // FIX (not timing out around the old ~1.5s formula, which is exactly what
  // stalled production on 2026-09-15) by holding past that mark and then
  // aborting, rather than waiting out the full budget.
  const controller = new AbortController();
  const deps = {
    // PLAYLIST_A's PART-TARGET is 0.5s, so the plain formula (3x) would have
    // timed this out at ~1500ms before this change.
    fetchRendition: async () => toFetched(PLAYLIST_A),
    rung: LL_VIDEO_RUNG,
    signal: controller.signal,
  };

  // msn 103 is never satisfied by PLAYLIST_A (live edge 101) and is not too
  // far ahead (101 + 2 = 103), so this holds until aborted or timed out.
  const pending = awaitBlockingReload("rendition-video-real-budget", { msn: 103 }, deps);
  let settled = false;
  pending.then(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 1_800));
  assert.equal(
    settled,
    false,
    "the video rung must still be held at ~1.8s -- the plain formula would already have timed it out by ~1.5s",
  );

  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.kind, "aborted");
});

test("awaitBlockingReload: the video rung's poll loop backs off from the plain cadence to VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS after VIDEO_RUNG_FAST_POLL_WINDOW_MS", async () => {
  resetBlockingReloadStateForTests();
  // Real timers on purpose, same reasoning as the test above -- this proves
  // the actual origin-fetch schedule over the video rung's full real 6s
  // hold, which a fake clock's synchronous-`sleep` semantics cannot race
  // correctly against (see that test's comment).
  const fetchTimestamps = [];
  const deps = {
    // PLAYLIST_A's PART-TARGET is 0.5s, so the fast-window cadence is 500ms.
    fetchRendition: async () => {
      fetchTimestamps.push(Date.now());
      return toFetched(PLAYLIST_A);
    },
    rung: LL_VIDEO_RUNG,
  };

  const start = Date.now();
  // msn 103 is never satisfied by PLAYLIST_A and is not too far ahead, so
  // this holds all the way to the video rung's full 6s budget.
  const outcome = await awaitBlockingReload("rendition-video-backoff-schedule", { msn: 103 }, deps);
  assert.equal(outcome.kind, "timeout");
  assert.ok(
    fetchTimestamps.length >= 4,
    `expected several origin polls over the 6s hold, got ${fetchTimestamps.length}`,
  );

  const gaps = [];
  for (let i = 1; i < fetchTimestamps.length; i += 1) {
    gaps.push({ atMs: fetchTimestamps[i] - start, gapMs: fetchTimestamps[i] - fetchTimestamps[i - 1] });
  }

  // A gap that STARTED comfortably inside the fast window should still be
  // close to the plain 500ms cadence; a gap that started comfortably past it
  // should be close to the 1000ms backoff cadence instead. Generous
  // real-timer slack (this pins a SCHEDULE, not exact milliseconds), and
  // gaps straddling the switchover are excluded rather than asserted either
  // way.
  const fastGaps = gaps.filter((g) => g.atMs < VIDEO_RUNG_FAST_POLL_WINDOW_MS - 150);
  // The very last tick's own wait is deliberately clamped short by
  // `runPollLoop`'s `Math.min(intervalMs, soonestDeadline - now())` so the
  // loop lands close to the 6s deadline instead of overshooting it by a full
  // backoff interval -- excluded here as a genuine, separate behavior, not
  // part of the steady-state backoff cadence this test pins.
  const backoffGaps = gaps.filter(
    (g) => g.atMs > VIDEO_RUNG_FAST_POLL_WINDOW_MS + 250 && g.atMs < VIDEO_RUNG_HOLD_BUDGET_MS - 200,
  );

  assert.ok(fastGaps.length >= 1, "expected at least one poll gap inside the fast window");
  for (const g of fastGaps) {
    assert.ok(
      g.gapMs < (VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS + 500) / 2,
      `expected a fast-window gap near 500ms, got ${g.gapMs}ms at ${g.atMs}ms elapsed`,
    );
  }

  assert.ok(backoffGaps.length >= 1, "expected at least one poll gap after the loop backed off");
  for (const g of backoffGaps) {
    assert.ok(
      g.gapMs >= (VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS + 500) / 2,
      `expected a post-backoff gap near ${VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS}ms, got ${g.gapMs}ms at ${g.atMs}ms elapsed`,
    );
  }
});

test("awaitBlockingReload: the audio rung (LL_AUDIO_RUNG) keeps the plain 3x-part-target formula, unlike the video rung", async () => {
  resetBlockingReloadStateForTests();
  let fetchCalls = 0;
  const deps = {
    fetchRendition: async () => {
      fetchCalls += 1;
      return toFetched(PLAYLIST_A_FAST);
    },
    rung: LL_AUDIO_RUNG,
  };

  const start = Date.now();
  const outcome = await awaitBlockingReload("rendition-audio-budget", { msn: 103 }, deps);
  const elapsed = Date.now() - start;
  assert.equal(outcome.kind, "timeout");

  const expectedTimeoutMs = 30 * 3; // PLAYLIST_A_FAST's PART-TARGET is 0.03s, unaffected by the video budget
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

// `MAX_ACTIVE_POLL_LOOPS` (64) is far smaller than `MAX_POLL_STATE_ENTRIES`
// (500) on purpose -- see that constant's doc comment -- so a map genuinely
// full of 500 SIMULTANEOUSLY ACTIVE loops is not a reachable state any more.
// These two tests fill the map with a mix instead: one loop kept alive for
// the whole test (the survivor) plus enough entries that resolve and go
// idle immediately (awaited one at a time, so no two are ever concurrently
// active) to reach capacity -- still proving `insertPollState` picks an
// IDLE entry to evict and never the active survivor.
test("insertPollState: an active rendition survives eviction pressure at a full map of mostly-idle entries", async () => {
  resetBlockingReloadStateForTests();
  const calls = new Map();

  // Deliberately the REAL clock (no `now`/`sleep` override): a fake clock's
  // `sleep` resolves its deadline via a microtask regardless of the `ms`
  // argument, which would fast-forward this survivor's own hold straight
  // into `cold-timeout` instead of keeping it open for the test's duration.
  // A never-settling fetch against the REAL ~1.5s default deadline stays
  // "active" for as long as this synchronous-ish test actually takes to run
  // (single-digit milliseconds), which is exactly the property this test
  // needs.
  const survivorKey = "capacity-survivor";
  void awaitBlockingReload(survivorKey, { msn: 1 }, { fetchRendition: neverSettlingFetch(calls, survivorKey) });
  assert.equal(calls.get(survivorKey), 1, "the survivor's loop should have started immediately");

  // Fill the rest of the map, one at a time, with renditions whose first
  // fetch already satisfies the request -- each one's loop starts and
  // finishes (back to idle) before the next is even issued, so the
  // survivor is the only loop ever concurrently active here.
  for (let i = 0; i < MAX_POLL_STATE_ENTRIES - 1; i += 1) {
    const key = `capacity-filler-${i}`;
    const outcome = await awaitBlockingReload(key, { msn: 1 }, { fetchRendition: async () => toFetched(PLAYLIST_A) });
    assert.equal(outcome.kind, "available");
  }

  // The map is now completely full (the survivor plus 499 idle fillers).
  // One more distinct key must evict one of the IDLE fillers, never the
  // active survivor.
  const overflow = await awaitBlockingReload("capacity-overflow", { msn: 1 }, {
    fetchRendition: async () => toFetched(PLAYLIST_A),
  });
  assert.equal(overflow.kind, "available", "an idle filler must have been evicted to make room, not the survivor");

  // The survivor must still be the SAME retained state: a second request for
  // its key joins the existing waiter set of the SAME loop rather than
  // starting a fresh one. If it had been evicted, this call would create a
  // brand-new entry with its own loop and call `fetchRendition` again.
  void awaitBlockingReload(survivorKey, { msn: 2 }, { fetchRendition: neverSettlingFetch(calls, survivorKey) });
  assert.equal(calls.get(survivorKey), 1, "the survivor's loop must not have been restarted");
});

// ---------------------------------------------------------------------------
// MAX_ACTIVE_POLL_LOOPS: a ceiling on renditions with a loop actually
// RUNNING, orthogonal to MAX_POLL_STATE_ENTRIES's ceiling on how many are
// merely RETAINED. Farol 2026-09-14: "hundreds of independent sub-second
// origin pollers when traffic spans many renditions."
// ---------------------------------------------------------------------------

test("awaitBlockingReload: MAX_ACTIVE_POLL_LOOPS caps concurrently active loops well below MAX_POLL_STATE_ENTRIES", async () => {
  resetBlockingReloadStateForTests();
  const calls = new Map();

  // MAX_ACTIVE_POLL_LOOPS (64) genuinely concurrent renditions, all issued
  // in the same synchronous burst -- a real traffic spike's shape.
  for (let i = 0; i < MAX_ACTIVE_POLL_LOOPS; i += 1) {
    const key = `loop-cap-filler-${i}`;
    void awaitBlockingReload(key, { msn: 1 }, { fetchRendition: neverSettlingFetch(calls, key) });
  }
  for (let i = 0; i < MAX_ACTIVE_POLL_LOOPS; i += 1) {
    assert.equal(calls.get(`loop-cap-filler-${i}`), 1, `loop-cap-filler-${i} should have started its own loop`);
  }

  // Only 64 of the 500 map slots are used -- this is specifically the
  // active-loop ceiling, not a map-capacity problem.
  const overflow = await awaitBlockingReload(
    "loop-cap-overflow",
    { msn: 1 },
    { fetchRendition: neverSettlingFetch(calls, "loop-cap-overflow") },
  );
  assert.deepEqual(overflow, { kind: "loop-cap-fallback" });
  assert.equal(calls.get("loop-cap-overflow"), undefined, "a loop-cap fallback must never start its own loop");
});

test("handleBlockingReload: MAX_ACTIVE_POLL_LOOPS active renditions fall back to the plain fetch for a new one", async () => {
  resetBlockingReloadStateForTests();
  const calls = new Map();
  const events = [];

  for (let i = 0; i < MAX_ACTIVE_POLL_LOOPS; i += 1) {
    const key = `h-loop-cap-filler-${i}`;
    void awaitBlockingReload(key, { msn: 1 }, { fetchRendition: neverSettlingFetch(calls, key) });
  }

  let plainFetchCalls = 0;
  const response = await handleBlockingReload(
    "h-loop-cap-overflow",
    { msn: 1 },
    async () => {
      // Represents the CALLER's own plain, non-blocking fetch -- this must
      // never be reached, because a loop-cap-fallback outcome is a `null`
      // Response, not a call into the hold machinery's own fetch closure.
      plainFetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    (event, fields) => events.push({ event, fields }),
    { channelId: "chan-1", rung: "720p30" },
  );

  assert.equal(response, null, "the caller must fall back to its own non-blocking path");
  assert.equal(plainFetchCalls, 0, "handleBlockingReload's own fetch closure must not run on a loop-cap fallback");
  assert.ok(
    events.some((e) => e.event === "hlsEdge.blockingReloadLoopCapFallback"),
    "the fallback must be logged",
  );
});

test("awaitBlockingReload: an aborted last waiter on a cold rendition frees its active-loop slot", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  const calls = new Map();
  const abortedKey = "rendition-abort-frees-slot";
  const controller = new AbortController();

  const pending = awaitBlockingReload(abortedKey, { msn: 5 }, {
    // A stalled/dead origin, exactly what Farol's finding describes: before
    // the fix, this never resolving meant nothing could ever notice the
    // waiter set had gone empty.
    fetchRendition: neverSettlingFetch(calls, abortedKey),
    now: clock.now,
    sleep: clock.sleep,
    signal: controller.signal,
  });
  controller.abort();
  assert.deepEqual(await pending, { kind: "aborted" });
  assert.equal(calls.get(abortedKey), 1);

  // Let the abandoned loop's own deadline race (the fake clock resolves it
  // via a microtask, no real delay) finish running and mark the entry idle
  // again -- a real macrotask boundary so every microtask from the burst
  // above has already drained, regardless of exactly how many hops the
  // Promise.race needed internally.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Fill exactly MAX_ACTIVE_POLL_LOOPS brand-new, genuinely concurrent
  // renditions. If the aborted rendition above still occupied a phantom
  // "active" slot (the bug this fixes), one of these would be refused a
  // loop it should otherwise get.
  for (let i = 0; i < MAX_ACTIVE_POLL_LOOPS; i += 1) {
    const key = `rendition-fresh-${i}`;
    void awaitBlockingReload(key, { msn: 1 }, {
      fetchRendition: neverSettlingFetch(calls, key),
      now: clock.now,
      sleep: clock.sleep,
    });
  }
  for (let i = 0; i < MAX_ACTIVE_POLL_LOOPS; i += 1) {
    assert.equal(
      calls.get(`rendition-fresh-${i}`),
      1,
      `rendition-fresh-${i} should have started its own loop -- the aborted rendition must not still be counted active`,
    );
  }
});

// ---------------------------------------------------------------------------
// MAX_WAITERS_PER_RENDITION: a ceiling on waiters piled onto ONE rendition,
// orthogonal to both caps above. Farol 2026-09-14: "one valid viewer
// credential to create an unbounded number of long-lived holds."
// ---------------------------------------------------------------------------

test("awaitBlockingReload: MAX_WAITERS_PER_RENDITION caps waiters on a single rendition", async () => {
  resetBlockingReloadStateForTests();
  const calls = new Map();
  const key = "waiter-cap-rendition";

  // All MAX_WAITERS_PER_RENDITION requests share the SAME rendition key, so
  // this is exactly one active loop -- nowhere near MAX_ACTIVE_POLL_LOOPS.
  for (let i = 0; i < MAX_WAITERS_PER_RENDITION; i += 1) {
    void awaitBlockingReload(key, { msn: i }, { fetchRendition: neverSettlingFetch(calls, key) });
  }
  assert.equal(calls.get(key), 1, "every waiter after the first joins the SAME loop, no extra fetch");

  const overflow = await awaitBlockingReload(
    key,
    { msn: 999_999 },
    { fetchRendition: neverSettlingFetch(calls, key) },
  );
  assert.deepEqual(overflow, { kind: "waiter-cap-fallback" });
});

test("handleBlockingReload: MAX_WAITERS_PER_RENDITION waiters on one rendition fall back to the plain fetch for the next", async () => {
  resetBlockingReloadStateForTests();
  const calls = new Map();
  const events = [];
  const key = "h-waiter-cap-rendition";

  for (let i = 0; i < MAX_WAITERS_PER_RENDITION; i += 1) {
    void awaitBlockingReload(key, { msn: i }, { fetchRendition: neverSettlingFetch(calls, key) });
  }

  let plainFetchCalls = 0;
  const response = await handleBlockingReload(
    key,
    { msn: 999_999 },
    async () => {
      plainFetchCalls += 1;
      return toFetched(PLAYLIST_A);
    },
    (event, fields) => events.push({ event, fields }),
    { channelId: "chan-1", rung: "720p30" },
  );

  assert.equal(response, null, "the caller must fall back to its own non-blocking path");
  assert.equal(plainFetchCalls, 0, "handleBlockingReload's own fetch closure must not run on a waiter-cap fallback");
  assert.ok(
    events.some((e) => e.event === "hlsEdge.blockingWaiterCapHit"),
    "the fallback must be logged",
  );
});

// ---------------------------------------------------------------------------
// Cold-start deadline race: a rendition's very FIRST poll tick (no
// `lastPlaylist` yet) must be bounded exactly like every later one. Farol
// 2026-09-14: "the first origin call stalls, the request can remain open
// until the upstream's much longer timeout (or indefinitely for a
// non-settling fetch)."
// ---------------------------------------------------------------------------

test("awaitBlockingReload: a cold rendition's first tick is bounded by its own deadline, not the origin's", async () => {
  resetBlockingReloadStateForTests();
  const clock = makeClock();
  let fetchCalls = 0;
  const deps = {
    // Never settles -- the "dead origin" case: with the pre-fix code, the
    // very first tick was awaited directly (no race at all) whenever
    // `state.lastPlaylist` was still null, so this would hang forever.
    fetchRendition: async () => {
      fetchCalls += 1;
      return new Promise(() => {});
    },
    now: clock.now,
    sleep: clock.sleep,
  };

  const outcome = await awaitBlockingReload("rendition-cold-timeout", { msn: 5 }, deps);
  assert.deepEqual(outcome, { kind: "cold-timeout" });
  assert.equal(fetchCalls, 1);
});

test("handleBlockingReload: a cold rendition's first tick times out as a 504, logged, not a 200 with an empty body", async () => {
  resetBlockingReloadStateForTests();
  const events = [];
  // No `now`/`sleep` override, matching how `index.ts` actually calls this
  // (real timers) -- the default provisional budget is ~1.5s, same order of
  // magnitude as the existing real-timer `timeout` test just above.
  const response = await handleBlockingReload(
    "rendition-h-cold-timeout",
    { msn: 5 },
    () => new Promise(() => {}),
    (event, fields) => events.push({ event, fields }),
    { channelId: "chan-1", rung: "720p30" },
  );
  assert.equal(response.status, 504);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { error: "Gateway Timeout", reason: "origin-did-not-respond" });
  assert.ok(events.some((e) => e.event === "hlsEdge.blockingReloadColdTimeout"));
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
