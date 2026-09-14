import { strict as assert } from "node:assert";
import test from "node:test";

import {
  LL_AUDIO_RUNG,
  LL_VIDEO_RUNG,
  parseLlState,
  playlistOriginKindForRung,
  trackForRung,
} from "../src/ll-state.js";

/** A minimal, valid state.json body: two complete segments, one partial, no audio. */
function fixtureState(overrides = {}) {
  return {
    sessionId: "5a1b2c3d-1234-5678-9abc-1234567890ab",
    channelId: "chan_abc123",
    partTargetMs: 500,
    segmentTargetMs: 4000,
    targetDurationSecs: 4.5,
    mediaSequence: 41,
    video: {
      initUri: "init.mp4",
      segments: [
        {
          msn: 41,
          complete: true,
          durationSecs: 4.016,
          programDateTime: "2026-09-14T18:03:21.114Z",
          uri: "seg-41.m4s",
          parts: [
            { index: 0, durationSecs: 0.501, independent: true, uri: "part-41.0.m4s" },
            { index: 1, durationSecs: 0.498, independent: false, uri: "part-41.1.m4s" },
          ],
        },
        {
          msn: 42,
          complete: true,
          durationSecs: 4.0,
          programDateTime: "2026-09-14T18:03:25.130Z",
          uri: "seg-42.m4s",
          parts: [{ index: 0, durationSecs: 0.5, independent: true, uri: "part-42.0.m4s" }],
        },
        {
          msn: 43,
          complete: false,
          programDateTime: "2026-09-14T18:03:29.130Z",
          parts: [{ index: 0, durationSecs: 0.502, independent: true, uri: "part-43.0.m4s" }],
        },
      ],
      preloadHint: { msn: 43, part: 1, uri: "part-43.1.m4s" },
    },
    audio: null,
    ...overrides,
  };
}

test("parses a well-formed fixture", () => {
  const state = parseLlState(fixtureState());
  assert.ok(state);
  assert.equal(state.sessionId, "5a1b2c3d-1234-5678-9abc-1234567890ab");
  assert.equal(state.video.segments.length, 3);
  assert.equal(state.video.segments[2].complete, false);
  assert.equal(state.video.preloadHint.uri, "part-43.1.m4s");
  assert.equal(state.audio, null);
});

test("rejects a non-object", () => {
  assert.equal(parseLlState(null), null);
  assert.equal(parseLlState("not json"), null);
  assert.equal(parseLlState(42), null);
});

test("rejects an empty segments array", () => {
  const raw = fixtureState();
  raw.video.segments = [];
  assert.equal(parseLlState(raw), null);
});

test("rejects an incomplete segment anywhere but last", () => {
  const raw = fixtureState();
  raw.video.segments[0].complete = false;
  delete raw.video.segments[0].uri;
  assert.equal(parseLlState(raw), null);
});

test("rejects a complete segment missing its duration or uri", () => {
  const missingDuration = fixtureState();
  delete missingDuration.video.segments[0].durationSecs;
  assert.equal(parseLlState(missingDuration), null);

  const missingUri = fixtureState();
  delete missingUri.video.segments[0].uri;
  assert.equal(parseLlState(missingUri), null);
});

test("rejects an incomplete segment that claims a uri", () => {
  const raw = fixtureState();
  raw.video.segments[2].uri = "seg-43.m4s";
  assert.equal(parseLlState(raw), null);
});

test("rejects a part missing independent/uri/durationSecs", () => {
  const raw = fixtureState();
  delete raw.video.segments[0].parts[0].independent;
  assert.equal(parseLlState(raw), null);
});

test("rejects a bad programDateTime", () => {
  const raw = fixtureState();
  raw.video.segments[0].programDateTime = "not a date";
  assert.equal(parseLlState(raw), null);
});

test("preloadHint may be null, and a malformed one is rejected", () => {
  const nullHint = fixtureState();
  nullHint.video.preloadHint = null;
  assert.ok(parseLlState(nullHint));

  const badHint = fixtureState();
  badHint.video.preloadHint = { msn: 43 }; // missing part/uri
  assert.equal(parseLlState(badHint), null);
});

test("accepts a state with an audio track and trackForRung resolves both rungs", () => {
  const raw = fixtureState({
    audio: {
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
    },
  });
  const state = parseLlState(raw);
  assert.ok(state);
  assert.equal(trackForRung(state, LL_VIDEO_RUNG), state.video);
  assert.equal(trackForRung(state, LL_AUDIO_RUNG), state.audio);
  assert.equal(trackForRung(state, "720p30"), null);
});

test("a malformed audio track fails the whole document, not just the audio half", () => {
  const raw = fixtureState({ audio: { initUri: "audio-init.mp4", segments: [] } });
  assert.equal(parseLlState(raw), null);
});

test("rejects non-positive partTargetMs/segmentTargetMs/targetDurationSecs", () => {
  for (const field of ["partTargetMs", "segmentTargetMs", "targetDurationSecs"]) {
    const raw = fixtureState({ [field]: 0 });
    assert.equal(parseLlState(raw), null, `field ${field}`);
  }
});

test("rejects a sessionId that is not shaped like a UUID -- unescaped into playlist text and used as a request path segment", () => {
  for (const badId of ["not-a-uuid", "5a1b2c3d\n#EXT-X-DISCONTINUITY", "../../evil", ""]) {
    const raw = fixtureState({ sessionId: badId });
    assert.equal(parseLlState(raw), null, `sessionId ${JSON.stringify(badId)}`);
  }
});

test("rejects an otherwise-valid sessionId/uri with a trailing newline appended -- \"value\\n\" must not slip past the $ anchor", () => {
  const validSessionId = "5a1b2c3d-1234-5678-9abc-1234567890ab";
  for (const suffix of ["\n", "\r\n", "\r", "\n\n"]) {
    const raw = fixtureState({ sessionId: validSessionId + suffix });
    assert.equal(parseLlState(raw), null, `sessionId with suffix ${JSON.stringify(suffix)}`);
  }

  const validUri = "seg-41.m4s";
  for (const suffix of ["\n", "\r\n", "\r", "\n\n"]) {
    const raw = fixtureState();
    raw.video.segments[0].uri = validUri + suffix;
    assert.equal(parseLlState(raw), null, `uri with suffix ${JSON.stringify(suffix)}`);
  }
});

test("rejects a uri containing path separators, .., or control characters (playlist injection / origin-fetch escape)", () => {
  for (const badUri of ["../../secret", "a/b.m4s", "seg 41.m4s", "seg\n41.m4s", "http://evil.example/x", ""]) {
    const badInitUri = fixtureState();
    badInitUri.video.initUri = badUri;
    assert.equal(parseLlState(badInitUri), null, `initUri ${JSON.stringify(badUri)}`);

    const badSegmentUri = fixtureState();
    badSegmentUri.video.segments[0].uri = badUri;
    assert.equal(parseLlState(badSegmentUri), null, `segment uri ${JSON.stringify(badUri)}`);

    const badPartUri = fixtureState();
    badPartUri.video.segments[0].parts[0].uri = badUri;
    assert.equal(parseLlState(badPartUri), null, `part uri ${JSON.stringify(badUri)}`);
  }
});

test("rejects non-contiguous or duplicate segment MSNs", () => {
  const gap = fixtureState();
  gap.video.segments[1].msn = 45; // was 42, leaves a gap after 41
  assert.equal(parseLlState(gap), null);

  const duplicate = fixtureState();
  duplicate.video.segments[1].msn = 41; // duplicates segment 0's msn
  assert.equal(parseLlState(duplicate), null);

  const outOfOrder = fixtureState();
  outOfOrder.video.segments.reverse();
  assert.equal(parseLlState(outOfOrder), null);
});

test("rejects mediaSequence that does not match the video track's oldest segment MSN", () => {
  const raw = fixtureState({ mediaSequence: 40 }); // fixture's first video segment is msn 41
  assert.equal(parseLlState(raw), null);
});

test("rejects a complete segment whose duration exceeds the rendered target duration by more than the jitter tolerance", () => {
  const raw = fixtureState({ targetDurationSecs: 1 }); // segment 0 claims durationSecs 4.016, way past 1 + 0.5
  assert.equal(parseLlState(raw), null);
});

test("accepts a segment slightly past a whole-second targetDurationSecs -- ordinary encoder jitter, not a malformed snapshot", () => {
  // The exact shape RFC 8216bis players already tolerate: a 2.0s target
  // renders EXT-X-TARGETDURATION:2, and a real segment landing at 2.04s
  // (a few ms of encoder/keyframe jitter) still renders a legal EXTINF.
  // Comparing the segment's raw duration against the RAW targetDurationSecs
  // (rather than the rendered, ceiling'd value, with a small allowance for
  // this exact kind of jitter) rejected this legitimate snapshot outright.
  const raw = fixtureState({ targetDurationSecs: 2 });
  raw.video.segments[0].durationSecs = 2.04;
  // segments[1] and the live segment/parts must stay internally consistent
  // (contiguous MSNs, preloadHint placement) -- only segment 0's duration
  // is under test here, so shrink the others to fit comfortably under the
  // same target too.
  raw.video.segments[1].durationSecs = 2.0;
  assert.ok(parseLlState(raw));
});

test("still rejects a segment many multiples of the target -- the tolerance does not swallow a genuinely malformed duration", () => {
  const raw = fixtureState({ targetDurationSecs: 2 });
  raw.video.segments[0].durationSecs = 20; // 10x the target, not encoder jitter
  assert.equal(parseLlState(raw), null);
});

test("rejects a live segment with zero parts and no preload hint -- nothing published, nothing scheduled", () => {
  const raw = fixtureState();
  raw.video.segments[2].parts = [];
  raw.video.preloadHint = null;
  assert.equal(parseLlState(raw), null);

  // The same zero-part live segment IS accepted once a preload hint names
  // the very next part.
  const withHint = fixtureState();
  withHint.video.segments[2].parts = [];
  withHint.video.preloadHint = { msn: 43, part: 0, uri: "part-43.0.m4s" };
  assert.ok(parseLlState(withHint));
});

test("rejects a preload hint that re-announces an already-published part", () => {
  const raw = fixtureState();
  // segments[2] (msn 43) already has part index 0 published -- a hint for
  // {msn: 43, part: 0} re-announces it instead of naming the next one.
  raw.video.preloadHint = { msn: 43, part: 0, uri: "part-43.0.m4s" };
  assert.equal(parseLlState(raw), null);
});

test("rejects a preload hint pointing at the wrong segment once the live one is sealed", () => {
  const raw = fixtureState();
  raw.video.segments[2].complete = true;
  raw.video.segments[2].durationSecs = 4.0;
  raw.video.segments[2].uri = "seg-43.m4s";
  // Now that msn 43 is sealed, a valid hint must be {msn: 44, part: 0} --
  // this one still points at the old live edge.
  raw.video.preloadHint = { msn: 43, part: 1, uri: "part-43.1.m4s" };
  assert.equal(parseLlState(raw), null);

  const correct = fixtureState();
  correct.video.segments[2].complete = true;
  correct.video.segments[2].durationSecs = 4.0;
  correct.video.segments[2].uri = "seg-43.m4s";
  correct.video.preloadHint = { msn: 44, part: 0, uri: "part-44.0.m4s" };
  assert.ok(parseLlState(correct));
});

test("playlistOriginKindForRung: only the two LL rung names route to the LL origin", () => {
  assert.equal(playlistOriginKindForRung(LL_VIDEO_RUNG), "ll");
  assert.equal(playlistOriginKindForRung(LL_AUDIO_RUNG), "ll");
  // Every conventional rendition name in this codebase, plus garbage — all
  // of them must stay on "api", the SAME origin and code path they always
  // used. This is the property behind "conventional sessions are untouched
  // byte-for-byte" (docs/plans/LL_HLS.md task L2.2).
  for (const rung of ["720p30", "1080p60", "audio", "ll2", "ll-audio2", "", "LL", "LL-AUDIO"]) {
    assert.equal(playlistOriginKindForRung(rung), "api", `expected "api" for rung ${JSON.stringify(rung)}`);
  }
});
