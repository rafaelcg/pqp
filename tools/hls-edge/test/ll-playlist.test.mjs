import { strict as assert } from "node:assert";
import test from "node:test";

import { parseLiveEdge } from "../src/hls-blocking-reload.js";
import {
  DEFAULT_LL_VIDEO_BANDWIDTH_BPS,
  KEPT_PART_SEGMENTS,
  LL_TOKEN_PLACEHOLDER,
  applyLlRenditionCredential,
  applyLlRenditionToken,
  buildLlMultivariantPlaylist,
  buildLlRenditionPlaylist,
} from "../src/ll-playlist.js";
import { LL_AUDIO_RUNG, LL_VIDEO_RUNG } from "../src/ll-state.js";

const TOKEN = "signed-token-abc";
const BASE_PATH = "/api/voice/hls-playlist/chan_abc123/1757865600000";

/** Escapes a string for embedding literally inside a `RegExp`. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One complete segment with N parts, the first one independent. */
function segment(msn, { partCount = 2, complete = true, offsetSecs = 0 } = {}) {
  const parts = Array.from({ length: partCount }, (_, i) => ({
    index: i,
    durationSecs: 0.5,
    independent: i === 0,
    uri: `part-${msn}.${i}.m4s`,
  }));
  return {
    msn,
    complete,
    durationSecs: complete ? partCount * 0.5 : null,
    uri: complete ? `seg-${msn}.m4s` : null,
    programDateTime: new Date(1757865600000 + offsetSecs * 1000).toISOString(),
    parts,
  };
}

/** Six complete segments (msn 41-46) plus one partial (47) with two parts so far, a preload hint for the third. */
function fixtureState() {
  const segments = [];
  for (let msn = 41; msn <= 46; msn += 1) {
    segments.push(segment(msn, { offsetSecs: (msn - 41) * 4 }));
  }
  segments.push(segment(47, { complete: false, partCount: 2, offsetSecs: 24 }));
  return {
    sessionId: "5a1b2c3d-1234-5678-9abc-1234567890ab",
    channelId: "chan_abc123",
    partTargetMs: 500,
    segmentTargetMs: 4000,
    targetDurationSecs: 4.02,
    mediaSequence: 41,
    video: {
      initUri: "init.mp4",
      segments,
      preloadHint: { msn: 47, part: 2, uri: "part-47.2.m4s" },
    },
    audio: null,
  };
}

test("golden LL media playlist: header tags", () => {
  const state = fixtureState();
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, {
    basePath: BASE_PATH,
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "#EXTM3U");
  assert.equal(lines[1], "#EXT-X-VERSION:9");
  assert.equal(lines[2], `#EXT-X-PQP-SESSION:${state.sessionId}`);
  assert.equal(lines[3], "#EXT-X-TARGETDURATION:5"); // ceil(4.02)
  assert.equal(lines[4], "#EXT-X-PART-INF:PART-TARGET=0.5");
  assert.equal(lines[5], "#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5");
  assert.equal(lines[6], "#EXT-X-MEDIA-SEQUENCE:41");
  assert.match(
    lines[7],
    new RegExp(
      `^#EXT-X-MAP:URI="/api/voice/hls-playlist/chan_abc123/1757865600000/ll/init\\.mp4\\?t=${escapeRegExp(LL_TOKEN_PLACEHOLDER)}"$`,
    ),
  );
});

test("golden LL media playlist: every URI carries the placeholder, never a real token, on the rendition's own rung path", () => {
  const state = fixtureState();
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, {
    basePath: BASE_PATH,
  });
  const uriLines = text
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.ok(uriLines.length > 0);
  const suffix = new RegExp(
    `^/api/voice/hls-playlist/chan_abc123/1757865600000/ll/.+\\?t=${escapeRegExp(LL_TOKEN_PLACEHOLDER)}$`,
  );
  for (const uri of uriLines) {
    assert.match(uri, suffix);
    // This function must NEVER be handed a real token: doing so is exactly
    // the bug a Farol review caught (`ll-playlist.js`'s header) -- a real
    // token embedded here would be shared across every viewer of a warm
    // cache entry or blocking-reload poll loop.
    assert.doesNotMatch(uri, /signed-token/);
  }
});

test("INDEPENDENT placement: only the first part of each kept segment is marked independent", () => {
  const state = fixtureState();
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, {
    basePath: BASE_PATH,
  });
  const partLines = text.split("\n").filter((line) => line.startsWith("#EXT-X-PART:"));
  assert.ok(partLines.length > 0);
  for (const line of partLines) {
    const isFirstPart = /\.0\.m4s/.test(line);
    if (isFirstPart) {
      assert.match(line, /INDEPENDENT=YES/, `expected INDEPENDENT=YES on first part: ${line}`);
    } else {
      assert.doesNotMatch(line, /INDEPENDENT/, `expected no INDEPENDENT attribute on a non-first part: ${line}`);
    }
  }
});

test("parts are pruned beyond the last KEPT_PART_SEGMENTS complete segments, plus the partial one", () => {
  const state = fixtureState();
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, {
    basePath: BASE_PATH,
  });
  // Complete segments are 41..46 (6 of them); KEPT_PART_SEGMENTS = 3 keeps
  // parts for 44, 45, 46 only -- 41, 42, 43 must have NO #EXT-X-PART lines,
  // even though they still get a full #EXTINF + URI entry.
  assert.equal(KEPT_PART_SEGMENTS, 3);
  for (const msn of [41, 42, 43]) {
    assert.doesNotMatch(text, new RegExp(`#EXT-X-PART:[^\\n]*part-${msn}\\.`), `msn ${msn} should have no PART lines`);
    assert.match(text, new RegExp(`#EXTINF:[^\\n]*\\n[^\\n]*seg-${msn}\\.m4s`), `msn ${msn} should still have EXTINF+URI`);
  }
  for (const msn of [44, 45, 46]) {
    assert.match(text, new RegExp(`#EXT-X-PART:[^\\n]*part-${msn}\\.0\\.m4s`), `msn ${msn} should keep PART lines`);
  }
  // The partial segment (47) always keeps its parts, and gets no EXTINF.
  assert.match(text, /#EXT-X-PART:[^\n]*part-47\.0\.m4s/);
  assert.match(text, /#EXT-X-PART:[^\n]*part-47\.1\.m4s/);
  assert.doesNotMatch(text, /seg-47\.m4s/);
});

test("preload hint points at the next part", () => {
  const state = fixtureState();
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, {
    basePath: BASE_PATH,
  });
  const preloadLine = text.split("\n").find((line) => line.startsWith("#EXT-X-PRELOAD-HINT:"));
  assert.ok(preloadLine, "expected a preload hint line");
  assert.match(preloadLine, /TYPE=PART/);
  assert.match(preloadLine, new RegExp(`part-47\\.2\\.m4s\\?t=${escapeRegExp(LL_TOKEN_PLACEHOLDER)}`));
  // Exactly one preload hint, and it is the LAST line before the trailing newline.
  const lines = text.trimEnd().split("\n");
  assert.equal(lines[lines.length - 1], preloadLine);
});

test("no preload hint present -> no #EXT-X-PRELOAD-HINT line at all", () => {
  const state = fixtureState();
  state.video.preloadHint = null;
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, {
    basePath: BASE_PATH,
  });
  assert.doesNotMatch(text, /#EXT-X-PRELOAD-HINT/);
});

test("the rendered playlist is readable by hls-blocking-reload.js's own parseLiveEdge (L2.1 wiring)", () => {
  const state = fixtureState();
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, {
    basePath: BASE_PATH,
  });
  const edge = parseLiveEdge(text);
  // 6 complete segments (41..46) means the newest complete MSN is 46.
  assert.equal(edge.lastCompleteMsn, 46);
  // The partial segment (47) has 2 parts published so far.
  assert.equal(edge.partialMsn, 47);
  assert.equal(edge.partialPartCount, 2);
  assert.equal(edge.partTargetSeconds, 0.5);
});

test("a fully-sealed rendition (no partial segment) has no trailing PART lines and parseLiveEdge sees no partial", () => {
  const state = fixtureState();
  // Drop the partial segment and its preload hint, so every listed segment is complete.
  state.video.segments = state.video.segments.slice(0, -1);
  state.video.preloadHint = null;
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, {
    basePath: BASE_PATH,
  });
  const edge = parseLiveEdge(text);
  assert.equal(edge.lastCompleteMsn, 46);
  assert.equal(edge.partialMsn, null);
  assert.equal(edge.partialPartCount, 0);
});

test("audio rendition uses the ll-audio rung path", () => {
  const state = fixtureState();
  const audioTrack = {
    initUri: "audio-init.mp4",
    segments: [
      {
        msn: 41,
        complete: true,
        durationSecs: 4.0,
        programDateTime: new Date(1757865600000).toISOString(),
        uri: "audio-seg-41.m4s",
        parts: [{ index: 0, durationSecs: 0.5, independent: true, uri: "audio-part-41.0.m4s" }],
      },
    ],
    preloadHint: null,
  };
  const text = buildLlRenditionPlaylist(state, audioTrack, LL_AUDIO_RUNG, {
    basePath: BASE_PATH,
  });
  assert.match(text, new RegExp(`/ll-audio/audio-init\\.mp4\\?t=${escapeRegExp(LL_TOKEN_PLACEHOLDER)}`));
  assert.match(text, new RegExp(`/ll-audio/audio-seg-41\\.m4s\\?t=${escapeRegExp(LL_TOKEN_PLACEHOLDER)}`));
});

test("applyLlRenditionToken stamps a real token into every placeholder occurrence", () => {
  const state = fixtureState();
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, { basePath: BASE_PATH });
  assert.match(text, new RegExp(escapeRegExp(LL_TOKEN_PLACEHOLDER)));

  const stamped = applyLlRenditionToken(text, TOKEN);
  assert.doesNotMatch(stamped, new RegExp(escapeRegExp(LL_TOKEN_PLACEHOLDER)), "no placeholder should survive stamping");
  const uriLines = stamped.split("\n").filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.ok(uriLines.length > 0);
  for (const uri of uriLines) {
    assert.match(uri, /\?t=signed-token-abc$/);
  }
});

test("applyLlRenditionToken is a no-op on text with no placeholder (e.g. a conventional body, or an LL 404)", () => {
  assert.equal(applyLlRenditionToken("plain text, no placeholder here", TOKEN), "plain text, no placeholder here");
  assert.equal(applyLlRenditionToken("Not found", TOKEN), "Not found");
});

test("two viewers sharing the SAME cached/coalesced rendition body each get only their own token stamped in", () => {
  // Simulates index.ts's shared cache / blocking-reload poll loop: ONE
  // rendered body (built once, with the placeholder, exactly as it would be
  // cached or coalesced across concurrent viewers) is stamped independently
  // per viewer. Neither viewer's token may appear in the other's response,
  // and the shared source text itself must stay untouched by either call
  // (stamping never mutates the cached copy in place).
  const state = fixtureState();
  const sharedRenderedBody = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, { basePath: BASE_PATH });

  const aliceToken = "alice-token-111";
  const bobToken = "bob-token-222";
  const aliceResponse = applyLlRenditionToken(sharedRenderedBody, aliceToken);
  const bobResponse = applyLlRenditionToken(sharedRenderedBody, bobToken);

  assert.match(aliceResponse, /\?t=alice-token-111/);
  assert.doesNotMatch(aliceResponse, /bob-token-222/);
  assert.match(bobResponse, /\?t=bob-token-222/);
  assert.doesNotMatch(bobResponse, /alice-token-111/);
  // The shared source text (what a cache entry or poll-loop state would
  // actually hold) is untouched by either viewer's stamping.
  assert.match(sharedRenderedBody, new RegExp(escapeRegExp(LL_TOKEN_PLACEHOLDER)));
});

test("golden multivariant playlist: video only, no audio group", () => {
  const state = fixtureState();
  const text = buildLlMultivariantPlaylist(state, {
    basePath: BASE_PATH,
    token: TOKEN,
    videoCodec: "avc1.640028",
    videoWidth: 1920,
    videoHeight: 1080,
    audioCodec: null,
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "#EXTM3U");
  assert.equal(lines[1], "#EXT-X-VERSION:9");
  assert.equal(lines[2], `#EXT-X-PQP-SESSION:${state.sessionId}`);
  assert.doesNotMatch(text, /EXT-X-MEDIA:TYPE=AUDIO/);
  assert.match(
    text,
    new RegExp(
      `#EXT-X-STREAM-INF:BANDWIDTH=${DEFAULT_LL_VIDEO_BANDWIDTH_BPS},RESOLUTION=1920x1080,CODECS="avc1\\.640028"\\n`,
    ),
  );
  assert.match(text, /\/ll\?t=signed-token-abc\s*$/);
});

test("golden multivariant playlist: video + audio group, CODECS lists both", () => {
  const state = fixtureState();
  state.audio = { initUri: "audio-init.mp4", segments: [segment(41, { partCount: 1 })], preloadHint: null };
  const text = buildLlMultivariantPlaylist(state, {
    basePath: BASE_PATH,
    token: TOKEN,
    videoCodec: "avc1.640028",
    videoWidth: 1280,
    videoHeight: 720,
    audioCodec: "mp4a.40.2",
  });
  assert.match(
    text,
    /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ll-audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="\/api\/voice\/hls-playlist\/chan_abc123\/1757865600000\/ll-audio\?t=signed-token-abc"/,
  );
  assert.match(text, /CODECS="avc1\.640028,mp4a\.40\.2"/);
  assert.match(text, /AUDIO="ll-audio"/);
});

test("golden multivariant playlist: no width/height supplied omits RESOLUTION", () => {
  const state = fixtureState();
  const text = buildLlMultivariantPlaylist(state, {
    basePath: BASE_PATH,
    token: TOKEN,
    videoCodec: "avc1.640028",
    audioCodec: null,
  });
  assert.doesNotMatch(text, /RESOLUTION/);
});

test("applyLlRenditionCredential swaps the WHOLE t=placeholder pair, so a party pass lands under ?pp=", () => {
  // The party-pass viewer's case (`index.ts`'s `stampLlToken`): they may have
  // no `?t=` at all, so stamping "their token" wrote the string `null` into
  // every URI of a playlist that had just been served to them successfully.
  // Harmless while those URIs 404'd anyway; task L2.3 made them real.
  const state = fixtureState();
  const text = buildLlRenditionPlaylist(state, state.video, LL_VIDEO_RUNG, { basePath: BASE_PATH });
  const stamped = applyLlRenditionCredential(text, "pp", "pass/value+with?chars");

  assert.doesNotMatch(stamped, new RegExp(escapeRegExp(LL_TOKEN_PLACEHOLDER)), "no placeholder may survive");
  assert.ok(!stamped.includes("?t="), "the token PARAMETER is replaced too, not just its value");
  assert.match(stamped, /\?pp=pass%2Fvalue%2Bwith%3Fchars/);
});
