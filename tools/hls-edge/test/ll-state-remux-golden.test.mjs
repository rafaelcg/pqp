import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseLiveEdge, isMsnPartAvailable, isMsnTooFarAhead } from "../src/hls-blocking-reload.js";
import { buildLlRenditionPlaylist, buildLlMultivariantPlaylist } from "../src/ll-playlist.js";
import { LL_AUDIO_RUNG, LL_VIDEO_RUNG, parseLlState, trackForRung } from "../src/ll-state.js";

/**
 * THE CROSS-CHECK. Every other test in this directory feeds `parseLlState`
 * a fixture THIS repository's Worker half wrote — which proves the parser
 * is self-consistent and proves nothing at all about the producer. This one
 * reads the golden file `tools/pqp-remux`'s own renderer emits
 * (`internal/llstate`'s `TestGolden`, regenerated with `go test
 * ./internal/llstate -update-golden`) and asserts the Worker can parse it
 * and render playable LL playlists from it.
 *
 * It exists because of 2026-09-15 08:01 UTC: the remux served parts,
 * segments and `init.mp4` correctly and 404'd `state.json`, so this
 * Worker's `fetchState` threw `hlsEdge.llStateFetchFailed` and no viewer
 * ever got a playlist. The endpoint that closed that gap is now on the
 * other side of this file; if either side changes its idea of the contract,
 * this test fails rather than a live party.
 */
const GOLDEN_PATH = fileURLToPath(
  new URL("../../pqp-remux/internal/llstate/testdata/state-golden.json", import.meta.url),
);

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));

test("the remux's own state.json golden parses", () => {
  const state = parseLlState(golden);
  assert.ok(state, "parseLlState rejected the document pqp-remuxd actually serves");
  assert.equal(state.sessionId, golden.sessionId);
  assert.equal(state.mediaSequence, state.video.segments[0].msn);
  assert.ok(state.audio, "the golden carries an audio twin");
});

test("its video rendition renders a valid LL playlist", () => {
  const state = parseLlState(golden);
  const track = trackForRung(state, LL_VIDEO_RUNG);
  const text = buildLlRenditionPlaylist(state, track, LL_VIDEO_RUNG, { basePath: "/api/voice/hls-playlist/chan_abc123/1789000000000" });

  assert.match(text, /^#EXTM3U\n/);
  assert.match(text, /#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES/);
  assert.match(text, /#EXT-X-PART-INF:PART-TARGET=0\.5/);
  assert.match(text, /#EXT-X-MEDIA-SEQUENCE:41\n/);
  assert.match(text, /#EXT-X-TARGETDURATION:2\n/);
  // The names are the ones the box actually serves: a global CMAF
  // sequence number per part, a segment index per segment.
  assert.match(text, /#EXT-X-MAP:URI="[^"]*\/ll\/init\.mp4\?/);
  // The first part of a segment is the one that starts on an IDR, and
  // says so; the ones after it must not claim independence.
  assert.match(text, /#EXT-X-PART:DURATION=0\.5,URI="[^"]*\/ll\/part-9\.m4s\?[^"]*",INDEPENDENT=YES\n/);
  assert.match(text, /#EXT-X-PART:DURATION=0\.5,URI="[^"]*\/ll\/part-10\.m4s\?[^"]*"\n/);
  assert.match(text, /#EXTINF:2,\n[^\n]*\/ll\/seg-41\.m4s\?/);
  assert.match(text, /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="[^"]*\/ll\/part-11\.m4s\?/);
  // The open segment gets parts and never an EXTINF.
  assert.equal(text.match(/#EXTINF:/g).length, 2);
});

test("its audio twin renders under the audio- names the box serves", () => {
  const state = parseLlState(golden);
  const track = trackForRung(state, LL_AUDIO_RUNG);
  const text = buildLlRenditionPlaylist(state, track, LL_AUDIO_RUNG, { basePath: "/api/voice/hls-playlist/chan_abc123/1789000000000" });

  assert.match(text, /#EXT-X-MAP:URI="[^"]*\/ll-audio\/audio-init\.mp4\?/);
  assert.match(text, /#EXT-X-PART:DURATION=0\.5,URI="[^"]*\/ll-audio\/audio-part-5\.m4s\?[^"]*",INDEPENDENT=YES\n/);
  assert.match(text, /\/ll-audio\/audio-seg-42\.m4s\?/);
  assert.match(text, /#EXT-X-PRELOAD-HINT:TYPE=PART,URI="[^"]*\/ll-audio\/audio-part-6\.m4s\?/);
  // Every audio part is independent (RFC 8216bis's recommendation, and
  // internal/llstate's per-track override).
  assert.equal(text.match(/#EXT-X-PART:/g).length, text.match(/INDEPENDENT=YES/g).length);
});

test("its master playlist names both renditions", () => {
  const state = parseLlState(golden);
  const text = buildLlMultivariantPlaylist(state, {
    basePath: "/api/voice/hls-playlist/chan_abc123/1789000000000",
    token: "tok",
    videoCodec: "avc1.640028",
    videoWidth: 1920,
    videoHeight: 1080,
    audioCodec: "mp4a.40.2",
  });
  assert.match(text, /#EXT-X-MEDIA:TYPE=AUDIO/);
  assert.match(text, /#EXT-X-STREAM-INF:[^\n]*CODECS="avc1\.640028,mp4a\.40\.2"/);
  assert.match(text, /\/ll\?t=tok/);
});

// L2.1's blocking hold reads its live edge off the RENDERED playlist, not
// off state.json (the `_HLS_msn`/`_HLS_part` directives never reach the
// remux: `LlPlaylistOrigin` builds the origin URL from the session id
// alone). So the numbers the remux publishes have to survive the round
// trip through the renderer and back out through `parseLiveEdge`, or a
// hold waits for a part the playlist already lists.
test("the blocking-reload hold reads the same live edge back out", () => {
  const state = parseLlState(golden);
  const track = trackForRung(state, LL_VIDEO_RUNG);
  const text = buildLlRenditionPlaylist(state, track, LL_VIDEO_RUNG, { basePath: "/b" });
  const edge = parseLiveEdge(text);

  assert.equal(edge.lastCompleteMsn, 42);
  assert.equal(edge.partialMsn, 43);
  assert.equal(edge.partialPartCount, 2);
  assert.equal(edge.partTargetSeconds, 0.5);

  // Already published: served immediately.
  assert.equal(isMsnPartAvailable(edge, { msn: 42 }), true);
  assert.equal(isMsnPartAvailable(edge, { msn: 43, part: 1 }), true);
  // The part state.json points its preload hint at is exactly the one a
  // player will block on, and it is not available yet.
  assert.equal(state.video.preloadHint.msn, 43);
  assert.equal(state.video.preloadHint.part, 2);
  assert.equal(isMsnPartAvailable(edge, { msn: 43, part: 2 }), false);
  // ...and it is a legal thing to ask for, not "too far ahead".
  assert.equal(isMsnTooFarAhead(edge, { msn: 43, part: 2 }), false);
});
