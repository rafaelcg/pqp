# Jam audio engine

The client half of **jam**: in a `jam` channel each post is a song made of
stems recorded by different people at different times. This engine plays the
stems in sync, records a new stem over them, and places the take on the song
by itself, so nobody has to cut or nudge anything. The manual tools (scrubber,
gain, trims, a nudge) exist and are never required.

Code: `client/src/lib/jam/` (entry `index.ts`). Bench: `/qa/jam` (dev auth
bypass only, like `/qa/ui`). The product screens that use it are described in
`docs/JAM_WEB.md`.

## The API

```ts
import { JamEngine, prepareStemUpload } from "@/lib/jam";

const engine = await JamEngine.create();          // one AudioContext, latencyHint "interactive"
await engine.player.loadStem("guitar", url, { offsetMs: 0, trimStartMs: 0, trimEndMs: 0, gain: 1 });
engine.player.subscribe(({ state, positionMs, durationMs, loop }) => drawPlayhead(positionMs));
await engine.player.play();                        // also pause(), stop(), seek(ms), setLoop({startMs,endMs}|null)
engine.player.updateStem("guitar", { gain: 0.8, muted: false, solo: false, offsetMs: 12, trimStartMs: 0 });
const detach = engine.player.attachVideo("guitar", videoEl);   // muted <video> locked to the audio clock

await engine.openInput({ deviceId });             // after a click; raw track, no speech processing
const status = await engine.latency();            // { current, estimate, stored, devices, key, output }
if (status.output.suitability === "bluetooth") warn(status.output.reason);
if (status.current.method === "estimate") await engine.calibrate("loopback");   // or "tap-along"
await engine.setManualLatency(23.5);              // a typed round trip beats any measurement (null clears)
engine.onDevicesChanged((s) => showLatency(s));   // plug, unplug, default output switched

const rec = await engine.record({
  fromMs: engine.player.positionMs(),
  countIn: { bars: 1, beatsPerBar: 4, bpm: 120 }, // bars: 0, 1 or 2
  metronome: null,                                // or { bpm, beatsPerBar } to click during the take
  camera: null,                                   // or a getUserMedia video stream
});
const take = await rec.stop();                    // already placed: take.offsetMs, take.trimStartMs
engine.addTake("bass", take);                     // hear it in the mix immediately
const upload = await prepareStemUpload(take);     // { audio: Blob (FLAC), video, offsetMs, trimStartMs,
                                                  //   trimEndMs, durationMs, sampleRate, gain, peaks }
const mix = await engine.exportMix("flac");       // offline render of the current mix
```

Lower-level pieces are exported too (`JamPlayer`, `JamInput`,
`calibrateLoopback`, `calibrateTapAlong`, `estimateFromReported`,
`LatencyStore`, `startRecording`, `renderMixdown`, `encodeFlac`,
`computePeaks`, `tapTempo`, `decideVideo`).

### Mapping onto the server's track

| Server field | Engine | Meaning |
|---|---|---|
| audio object | `upload.audio` | FLAC, 16-bit, mono, at the recording context's rate (48 kHz in practice) |
| video object | `upload.video` | WebM (VP9/VP8 + Opus) or MP4 on Safari; its own audio is never played. The server adds an MP4 copy for iOS (see "Camera video formats and the MP4 copy") |
| `offset_ms` | `offsetMs` | song time of the buffer's FIRST sample. May be negative. Always a whole number of ms (see below) |
| `trim_start_ms` | `trimStartMs` | ms hidden at the buffer's head, measured from the buffer's start |
| `trim_end_ms` | `trimEndMs` | ms hidden at the buffer's TAIL, measured back from the buffer's end (0 = untrimmed) |
| `duration_ms` | `durationMs` | the whole buffer, untrimmed |
| `gain` | `gain` | linear, 1 = unity |
| `peaks` | `peaks` | at most 400 numbers 0..1 over the WHOLE buffer (absolute, not normalised), so trims are drawn as overlays and need no new peaks |

If the server ends up defining `trim_end_ms` as an absolute end position
instead, the conversion is `trim_end = duration - end`; everything else here
is unaffected.

Moving a trim never moves the audio; moving `offset_ms` (a nudge) moves all of
it. Nothing is re-rendered, ever.

One `offset_ms` places the audio and the video: a take recorded with a camera
is cut (or padded with silence) so its sample 0 is the video's first frame.
A separate `video_offset_ms` is therefore not needed.

## The latency model

One AudioContext plays the backing and runs the capture worklet, so playback
and capture are stamped in the same unit, context sample frames.

- Backing song time `S` leaves the graph at frame `F0 + (S - from) * sr`.
- The player hears it `L_out` later (context buffer, OS mixer, DAC, Bluetooth).
- They play along; their note reaches the worklet `L_in` later (ADC, OS, the
  browser's input buffer).

Only the round trip `L = L_out + L_in` matters, and it is exactly what a
loopback measures. The take's first captured sample, stamped `Fc0`, belongs at
song time `from + (Fc0 - F0) / sr - L` (`placement.ts`). The engine then drops
fewer than 48 leading samples so the offset is a whole millisecond: exact at
48 kHz, under one sample at 44.1 kHz, and safe whether the server stores an
integer or a float.

Three ways to know `L`, best first, each labelled with a confidence:

1. **Loopback** (`calibrate("loopback")`): ten 10 ms down-sweeps (8 kHz to
   1 kHz) 600 ms apart, played straight to the destination; each is found in
   the capture by normalised cross-correlation, taking the EARLIEST strong peak
   (a wall can be louder than the direct sound) with a 0.5 ms guard against the
   correlation's own sidelobes, polarity ignored, sub-sample by parabola.
   Median of the inliers. `high` = at least half heard, all within 0.25 ms of
   each other; `medium` = within 1 ms; fewer than half heard is `low` and is
   not stored. Needs the microphone to hear the output: speakers,
   or a headphone cup held against the mic. Measures the exact path a take
   uses.
2. **Tap-along** (`calibrate("tap-along")`): twelve clicks at 100 BPM; the
   player claps, taps the mic or hits muted strings on each. Onsets are
   detected, the first two taps ignored, median kept. Never better than
   `medium` (6 ms spread), because it measures a human too, including their
   habit of playing slightly ahead of the beat, which is arguably the thing to
   compensate. It is the only measurement possible with headphones plus a
   direct-input interface. If the taps line up to the sample it says so: the
   mic is hearing the clicks and loopback is the better tool.
3. **Estimate**: `baseLatency + outputLatency + input`, where input is
   `MediaStreamTrack.stats.latency` (Chrome 125+, milliseconds), else
   `getSettings().latency`, else an assumed 10 ms. Always `low`. Free, instant,
   and not to be trusted for a take you care about (see the numbers below).

A result is stored per **device pair** in `localStorage` (per viewer, every
access wrapped; losing it costs a re-run). The key is input id and label,
output id and label (Chrome's default output label names the real device,
"Default - AirPods Pro", which is what catches a silent default switch), and
the sample rate. Only `high` and `medium` results are stored. A stored result
is also treated as **stale** when the browser's reported output latency moves
by more than 8 ms from what it was at calibration time (the output path
changed under the same ids). `engine.latency().current` picks manual, then
loopback, then tap-along, then the estimate.

**Bluetooth** is flagged (`output.suitability === "bluetooth"`) from the
output's label or a reported output latency above 100 ms. Playback is not
blocked; recording over it will not line up, because Bluetooth adds 100 to
300 ms that changes between sessions.

## What was measured, and how

Everything below was measured on 2026-11-09 on one macOS laptop. Numbers
from fake devices say nothing about real hardware latency.

**Placement and playback, end to end in Chromium** (`e2e/jam/jam.spec.ts`,
fake microphone playing a sweep every second, Playwright's Chromium, 48 kHz):

| What | Tolerance asserted | Measured |
|---|---|---|
| Each recorded sweep's song time vs the backing beat, after FLAC and `decodeAudioData` | 0.05 ms | -0.021 ms (one sample), 7 of 7 sweeps |
| Take vs backing at the master bus in real-time playback | 1.5 samples | -1.1 samples (23 µs) |
| Backing beats vs their scheduled frames in real-time playback | 1 sample | 0 to 0.1 sample |
| Loop region played over several seams: beat-to-beat interval | 1 sample of 24000 | exactly 24000, every seam |
| FLAC round trip (integers back as encoded) | 0.001 LSB | exact |
| Calibration spread over 6 pulses | `high` | 0.000 ms |
| Camera take: the file's own audio found in the final take, vs sample 0 | 10 ms | -0.23 ms |
| Camera take: MediaRecorder's `start` event as a guess of the video's time zero | none | off by 106 ms |

The one-sample residual is the calibration's sub-sample peak estimate plus the
whole-millisecond rounding (at most half a sample). The 106 ms is why the
video is aligned by its content and not by a timestamp.

The same pipeline is also simulated in Node with the real worklet logic and a
virtual clock, a 39.02 ms round trip, a louder-than-direct wall reflection,
hiss and a two-input interface (`pipeline.test.ts`): notes land within
0.02 ms.

**Upload format** (`e2e/jam/formats.spec.ts`): a sweep every second, encoded
by ffmpeg (and by our encoder), decoded by each browser's `decodeAudioData`
on a 48 kHz context. Shift is how far the sweeps moved.

| File | Chromium | Firefox | WebKit (Playwright build) |
|---|---|---|---|
| WAV 16-bit, 48 kHz | 0 | 0 | 0 |
| FLAC, ours, 48 kHz | 0, exact integers | 0, exact | 0, exact |
| FLAC, ours, 44.1 kHz (resampled on decode) | 0 | 0 | 0 |
| Opus in Ogg / WebM, 128k | 0 | 0 | 0 |
| AAC in M4A (ffmpeg, edit list), 192k | 0 | 0 | **decode failed** |
| MP3 (LAME header), 192k | 0 | 0 | **+576 samples (12 ms) at 48 kHz, +13 ms at 44.1 kHz**, length +1536 |

"Exact integers": Chrome maps 16-bit to float as `v / 32767` for positive
samples and `v / 32768` for negative ones; Firefox and WebKit divide both by
32768. That is a 0.003 % gain difference and moves nothing in time.

**Size**, one minute of synthetic plucked strings with gaps (mono, 48 kHz;
synthetic, not a real recording):

| Format | Bytes per minute | Five minutes |
|---|---|---|
| WAV 16-bit | 5.76 MB | 28.8 MB |
| **FLAC, ours (fixed predictors)** | **3.10 MB** | **15.5 MB** |
| FLAC, ffmpeg `-compression_level 5` / 8 | 2.85 / 2.84 MB | 14.2 MB |
| Opus 128k | 0.98 MB | 4.9 MB |
| AAC 192k | 1.44 MB | 7.2 MB |

Our encoder took 98 ms per minute of audio in Node. A real bass or guitar
part with rests compresses better than continuous playing, since silence
costs a few bytes per block.

**Decision: FLAC, 16-bit, mono.** It is the only format that moved by zero in
every browser by construction rather than by luck: Opus measured zero
everywhere, but MP3 moved 12 ms in WebKit and AAC did not decode there at all,
so a lossy choice is a per-browser bet that has to be re-measured on every
browser update and on the native apps. FLAC costs about three times Opus. If
size becomes the problem, the path is: keep FLAC as the uploaded source of
truth and have the server make an Opus copy for streaming, with its priming
handled server-side. That is now built: see "The listening copy" below.

The encoder is hand-written (`flac.ts`, about 400 lines) because no browser
encodes FLAC (WebCodecs offers Opus and AAC) and the libFLAC ports are 300 kB
or more of wasm for what is, here, the easy 90 % of the format. It is
verified bit-exact against ffmpeg's decoder in the unit tests (skipped where
ffmpeg is missing) and against all three browsers above.

## Camera video formats and the MP4 copy

Chrome records the camera as WebM (VP9/VP8 + Opus), Safari as MP4 (H.264 +
AAC). iOS and Safari cannot play WebM, so every camera video recorded in
Chrome was blank on an iPhone. Two parts, both measured.

**Why Chrome still records WebM.** The engine places the video by finding the
file's DECODED audio inside the take (`alignVideoAudio`) and calling that the
video's time zero. That is right only when the file's decoded audio and its
picture agree on time zero. `e2e/jam/av-skew.spec.ts` records one scene (a
canvas that flashes, a click, both at the same AudioContext instant) as WebM
and as MP4 and reads the files back with ffmpeg:

| Playwright's Chromium 151, macOS, 2026-11-12 | audio onset minus flash |
|---|---|
| WebM (VP8 + Opus), 6 takes in two runs | about -14 and -9 ms (the rig's own half frame) |
| MP4 (H.264 + AAC), 6 takes in two runs | about +27 and +19 ms |

So Chrome's MP4 has its sound 28 to 41 ms later against its picture than the
WebM has: AAC's encoder priming (44 ms with this encoder) is in the file's
audio, and the fragmented MP4 has no edit list to say so. Aligned by content,
that file puts the picture about a frame early, and our own zero check cannot
see it (it measures the file against itself: -0.2 ms for WebM, -0.9 ms for
MP4). The priming belongs to the platform's AAC encoder (AudioToolbox, Media
Foundation, ffmpeg), so it cannot be a constant to subtract. Hence
`VIDEO_MIME_PREFERENCE` puts WebM first and MP4 is for browsers that record
nothing else (Safari; whether its MP4 carries the priming in an edit list, as
Apple's muxers do, is not measured; the rig is Chromium's today). A forced
MP4 take is still pinned by `jam.spec.ts` (the file is an MP4, the content
method lands, quality 1.0), and `startVideoRecording` drops a recorder that
fails as it starts for the next type. Not measured: Windows and Linux encoders,
and Safari itself.

**The copy for iOS** is made by the worker from the WebM, where the time zero
can be carried over exactly: `server/src/speech/video-transcode.ts`; the job and
its rules are in `docs/JAM.md` ("The MP4 copy of a camera video"). The test
generates a WebM with a flash and a click (once with the audio starting 120 ms
after the picture), converts it and finds both again: the same frame, the same
sample to within the lossy encoder's smear, the same duration. An 80 ms audio
shift makes it fail.

**The content method's flake.** `jam.spec.ts` failed once on main CI on
2026-11-11 with `method: "timestamp"`, `quality: 0`, the timestamp guess 107 ms
late. The excerpt used to be the earliest loudest window that fitted the take
BY THE GUESS. A fake microphone with a bar of sound once a second makes many
windows equally loud, so the earliest sat a few ms into the take; with the
guess late, the true position was BEFORE the take's first sample, the needle
hung off the haystack, the correlation collapsed to about zero and the
alignment fell back to the very guess that was wrong. Whether it happened
depended on where the camera's start fell against the take's start and on
which windows the codec's noise made loudest, hence a pass on re-run. It is a
unit test now (`misc.test.ts`: the bar at 40 phases, all failing on the old
code, none on the new). The excerpt must fit the take with
the search window to spare, and the alignment carries a `reason` (`short`,
`no-window`, `no-match`, `weak`, `decode-failed`) so a fallback explains itself
in the e2e output. It did not reproduce under CPU load on a laptop (6 of 6
passed), which fits: it is phase, not load.

## The listening copy (Opus), for the public site and the in-app public view

Public playback downloaded every stem as FLAC before the first sound. Our own
FLAC is 3.1 to 4.5 MB per stem-minute (2.4 Mbps for five stems, more than Fast 3G
carries), so a three minute, five stem song is about 54 MB: 44 s on a good 4G link
and 4.5 minutes on Fast 3G. This section is the fix, the evidence for it, and what
it does not do. It is behind the runtime flag `jam_audio_copy` (global, default off,
`docs/FEATURE_FLAGS.md`).

### What it is

A worker-made **Opus copy of each FLAC stem, 64 kbps per channel, in Ogg**, offered
to LISTENERS only. The FLAC stays the source of truth: the studio records against
it (`syncJamStems` without `listen`), and every export is made from it. The copy is
derived, one per track, written beside the original (`<id>.listen.ogg`), never
replaces it, and is deleted with it.

- **Job and storage**: the MP4 copy's pattern (`docs/JAM.md` §"The MP4 copy of a
  camera video"): `speech_jobs` kind `jam_audio_copy` keyed by `track_id`, claimed by
  a process whose ffmpeg has libopus (the `worker` image) and only with the flag on,
  one at a time in a lane of its own, reserve key, upload, confirm type last, nothing
  between BEGIN and COMMIT touches the network. Code: `server/src/services/jam-audio-copy.ts`
  (job, enqueue, backfill), `server/src/speech/audio-copy.ts` (ffmpeg and the checks),
  `server/src/services/jam-audio-copy-metrics.ts` (`jamAudioCopy` on the metrics).
- **Only lossless originals** (`audio/flac`, what the web recorder sends). A phone's
  AAC, Opus or MP3 is already at most 1.4 MB per minute, and decoders disagree about
  the delay of those formats (WebKit moved an MP3 by 12 ms, above), so an ffmpeg-made
  copy could land where the browser's own decode of the original does not.
- **The contract**: `audioSources` lives on `jamListenTrackSchema` (`jamTrackSchema`
  plus the list), which `jamSongDetailResponseSchema` and the public track use, and
  NOT on `jamTrackSchema`, the shape the phones check field by field
  (`JamContractTest`): a phone that does not use a copy has no reason to carry the
  field, and its decoder skips the unknown key.
- **The backfill is bounded reads, never a ranking of the backlog**, and it is for
  history: a track recorded from now on queues its own job in its insert. Three
  `LIMIT`ed, index-backed reads a pass: a catch-up of public tracks published since
  the last pass (keyset over `idx_jam_public_tracks_backfill`, so a song made public
  while the walks are partway down their backlog is not left behind), then a public
  walk and a rest walk over `idx_jam_tracks_audio_copy_pending`, which is partial on
  "no copy yet" so a finished stem leaves it. Each walk's cursor only moves down, a
  row is looked at once, a walk that reaches its end stays done (restarting after six
  hours, or when the flag blinks off and on), and a cursor moves only after its batch
  was enqueued, so a failed read or INSERT repeats the same stems. On 400,000 tracks
  a pass reads a handful of index entries (0.05 to 0.2 ms); a finished catalogue's
  walk covers only what failed (3,000 leftover rows: 4 to 8 ms, once).
- **The client chooses from data**, with no rebuild: a track with `audioSources`
  (copy first, original last) loads from the copy; without it, from the FLAC. See
  `client/src/lib/jam-listen-copy.ts`, `syncJamStems(..., { listen: true })` in
  `client/src/lib/jam-session.ts`, `client/src/jam-site/player.ts` and, in the app,
  `client/src/hooks/use-jam-playback.ts`: see "Who loads what" below.

#### Who loads what

Every caller of `syncJamStems`, and the file each one gets:

| Caller | Asks | Loads |
|---|---|---|
| The public site's player (`jam-site/player.ts`) | `listen` | the copy where the track offers one, else the FLAC |
| The song panel (`useJamPlayback`), in a channel or in the in-app public view | `listen`, and `originals` = the viewer's own parts | the copy where offered, per stem back to the FLAC; the viewer's own parts always the FLAC |
| A card's play button in a conversation (`jam-chat-player.ts`) | `listen` | the copy where the read offers one (a recipient outside the song's channel), else the FLAC |
| The studio (`use-jam-studio.ts`, three calls) | nothing | the FLAC, always |

Why the panel keeps the viewer's own parts on the FLAC: the panel lets the author
adjust a recording (gain, offset, trim, `TrackAdjust`) and the public read hands a
non-member their own part with `audioSources` like every other. Adjusting is work on
the recording itself, so it hears the file it will be saved against. The copy is
sample-aligned and equal in length, but the rule costs one stem's bytes and needs no
argument about tolerances.

A member of the song's channel is never offered a copy by the server, so for them
`listen` changes nothing and the panel loads the FLAC as before; likewise with the
flag off. The decision is in the data, which is why the panel and the card can ask to
listen unconditionally.

**From listening to recording.** The studio opens over the same engine and the same
book (`jam-session.ts`). Its mount sync has no `listen`, so every stem heard from a
copy is replaced by the original, and `startRecording` awaits another sync before it
opens the take, so recording never starts against a copy. The panel stays mounted
behind the studio; its own later syncs (a part arriving) do not put a stem back on a
copy, because a listening sync accepts what is already loaded. Pinned in
`use-jam-playback-listen.test.tsx`, which also fails if a studio call ever passes
`listen`.

### Alignment: the encoder's delay is declared, compensated and checked

The engine places a stem by milliseconds and trims in sample frames against a
decoded `AudioBuffer`, so a copy that starts one encoder look-ahead late (6.5 ms for
libopus) or ends a frame short puts one part of a song out of step with the others.
Three things keep it exact:

1. **The delay is declared in the file.** The `OpusHead` packet carries `pre-skip`
   (312 samples at 48 kHz) and every decoder drops exactly that many samples; the
   Ogg muxer states the END through the last page's granule position. Nothing in our
   command line trims, pads or shifts (no `-ss`, `apad`, `shortest`, `atrim`).
2. **Every copy is checked before it is offered.** The job reads the FLAC's STREAMINFO
   and the copy's `OpusHead` and last granule position and refuses a copy whose
   decoded length differs from the original's by more than one millisecond, or whose
   channel count changed (`copyLengthProblem`). ffmpeg is exact to the sample at 48
   kHz and to one sample after resampling 44.1, 32 and 22.05 kHz (measured), so the
   tolerance has two orders of magnitude of room and is still far under the 312
   samples an undeclared delay would add. A refusal is a `failed` job, logged as
   `jamAudioCopy.failed ... reason=length-mismatch`, counted, and the stem plays from
   its FLAC.
3. **Measured in the decoders that will play it**, with a click track (decaying noise
   bursts at positions on no frame boundary, one INSIDE the pre-skip, at 48 kHz and
   44.1 kHz), three stems mixed from the FLACs and from the copies, the onsets of the
   two mixes compared (centroid of each burst):

| Decoder | Worst onset error, copy minus FLAC | Decoded length |
|---|---|---|
| ffmpeg (`speech/audio-copy.test.ts`, in CI with ffmpeg) | 1.5 samples (0.03 ms) | equal to the sample |
| Chromium 151 `decodeAudioData` | 2.1 samples (0.044 ms) | equal |
| Firefox 153 `decodeAudioData` | 1.5 samples (0.031 ms) | equal |
| WebKit 26.5 (Playwright, macOS) `decodeAudioData` | 2.1 samples (0.044 ms) | equal |

   The test has a control: the same comparison on a mix shifted by 312 samples fails
   by about 312. `client/e2e/jam/formats.spec.ts` also measures the worker's own copy
   (its real command line) with the engine rig's sweep pulses in Chromium: 0 samples
   shift and 0 length change at 48 kHz and at 44.1 kHz.

**Not measured, and why it matters**: real iOS Safari and Safari before 18 (Ogg Opus
support is recent there), Android Chrome, real music. The client therefore asks the
browser first (`canPlayType('audio/ogg; codecs="opus"')`, an empty answer means the
FLAC with no wasted bytes), and falls back to the FLAC per stem on a 404 or on a
decode error, which also stops that page trying copies again. A phone or browser
that cannot decode the copy costs one failed download at most, never a silent song.

### Bitrate: 64 kbps per channel, by measurement

Stems are summed, so artefacts add. Five synthetic stems (bass, a distorted guitar
with strong harmonics, keys with tremolo, drums with broadband hats and a snare,
a vocal with vibrato and breath), each with a -58 dBFS noise floor like a recorded
take, 60 s, mixed from the decoded copies and compared with the mix of the originals
(`ffmpeg -c:a libopus -vbr on -application audio -compression_level 10`):

| Opus per stem | MB per stem-minute | 5-stem mix: peak vs original (0.934) | Mix 1/3-octave envelope error | Tonal stems' SNR | Mix SNR* |
|---|---|---|---|---|---|
| 32 kbps | 0.30 | **1.448 (clips)** | 1.18 dB | 21 to 31 dB | 14.2 dB |
| 48 kbps | 0.43 | 1.007 (touches full scale) | 0.92 dB | 24 to 33 dB | 16.7 dB |
| **64 kbps (chosen)** | **0.55** | **0.928** | **0.75 dB** | **26 to 35 dB** | **17.7 dB** |
| 96 kbps | 0.80 | 0.907 | 0.54 dB | 28 to 38 dB | 18.8 dB |
| 128 kbps | 1.04 | 0.902 | 0.43 dB | 29 to 39 dB | 19.2 dB |

\* Waveform SNR of the mix, dominated by the noise-like parts (the noise floor, the
hats, the snare), which a perceptual codec reproduces by envelope and not by
waveform on purpose; the drums' own SNR is 7 dB at 64 kbps and sounds like drums.
The envelope error is the number that speaks for those parts. No listening test was
possible; these are measurements, not a verdict.

64 kbps is the lowest rate at which the sum of five decoded stems did not overshoot
the sum of the originals (32 and 48 kbps overshoot and would clip at the output),
and its spectral envelope stays within 0.75 dB; 96 kbps buys 0.2 dB more for 45 %
more bytes on a link where bytes are the whole problem. The bitrate is one constant
(`LISTEN_COPY_BITRATE_PER_CHANNEL`); changing it needs a new copy of every track, so
decide it before the backfill, not after.

### What it buys: time to first sound, measured

Local rig (2026-11-27): the built jam site, a real API and worker process, MinIO,
headless Chromium throttled through CDP, pressing play on a public song and timing
the press to the transport playing. Fast 3G is 1.6 Mbps down with 150 ms latency
(the launch test's profile), good 4G is 9 Mbps with 60 ms. The audio is
synthesised with numpy (no downloaded music), 48 kHz mono, encoded to FLAC by the
product's own encoder (`client/src/lib/jam/flac.ts`), with a -58 dBFS noise floor,
broadband hats and a snare, so it is on the heavy side of real stems.

| Song | Network | Flag off: first sound, bytes | Flag on: first sound, bytes | Faster |
|---|---|---|---|---|
| "Roda de sábado": 10 parts of 28 s, 17.2 MB of FLAC | Fast 3G | 82.4 s, 16.4 MB | **12.7 s, 2.5 MB** | 6.5x |
| | good 4G | 14.8 s, 16.4 MB | **2.5 s, 2.5 MB** | 6.0x |
| "Canção longa": 5 stems of 3 min, 55.5 MB of FLAC | Fast 3G | 264.9 s (4 min 25 s), 52.9 MB | **40.0 s, 7.9 MB** | 6.6x |
| | good 4G | 47.3 s, 52.9 MB | **7.4 s, 7.9 MB** | 6.4x |

Bytes are the transferred audio, from CDP's `encodedDataLength`. Copy over
original, over all 15 stems the worker made: 10.8 MB against 72.7 MB, 14.9 %. The
launch test's 91 s for the ten parts is the first row's 82 s here, in a different
harness. The first sound after the flag goes on is **bytes over bandwidth**: the
copies are a sixth of the size and the time follows. Also checked in the same rig:
with two copies broken on purpose (one deleted, one overwritten with bytes that are
not audio) the song still played, 12.6 s on 4G, two of its ten stems fetched as FLAC
after the copy failed; and with the flag turned off again from the dashboard route
the next read had no `audioSources` and the page fetched ten FLACs, 14.8 s, 16.4 MB,
the baseline to the digit.

**The target is not met on the slowest link for a real song**: 40 s to the first
sound of a three minute, five stem song on Fast 3G, against 265 s. It is a 6.6x
improvement and makes the song playable on a phone link, not instant. Getting under
10 s there needs the first sound to come before the last byte; see below.

Storage: the copies add about 15 % to what the stems already take in the bucket.
Worker cost: about 1 s of ffmpeg per three minute stem on this laptop (Opus encodes
at well over 100 times real time), one stem at a time.

### What it does not do, and what was left out on purpose

- **No progressive start.** The engine holds a stem as ONE `AudioBuffer`, decoded
  from the whole file (`JamPlayer.decode`, `addStem`), and has no way to extend a
  stem's buffer under a running transport: `addStem` replaces the slot and
  `restartIfPlaying` re-anchors every source with a 60 ms lead, an audible gap. So
  "begin when enough of every stem is buffered" cannot be done without changing
  `lib/jam/player.ts`, and the alignment guarantee above is about whole files. It
  is not impossible, and the evidence is worth keeping: on 2026-11, Chromium 151,
  Firefox 153 and WebKit 26.5 all decoded an Ogg Opus copy cut at 60 % of its bytes
  (a prefix of the decoded samples), so a partial download can be played. What a
  follow-up needs is an engine call that swaps a stem's buffer for a longer one at a
  frame, on the same source timing (start the new source at the frame where the old
  one is, stop the old one on the same frame: identical samples, so sample-exact),
  and a loader that decodes the first N seconds of every stem together. That is an
  engine change with its own sample-accuracy tests, in the file this change left
  alone. At 64 kbps five stems are 0.3 Mbps, a fifth of what Fast 3G carries, so the
  tail would arrive faster than it plays.
- **No mono preview mix** (scoped, not built). A server-made mono mix of the public
  tracks, played by an `<audio>` element while the stems download, would give a first
  sound in about 2 to 3 s on Fast 3G. It needs a second implementation of placement
  on the server (`offsetMs`, the trims and `gain` in ffmpeg, pinned by a test that
  renders both), a job per SONG rather than per track, and an invalidation rule: the
  public set changes whenever a take is accepted, hidden, removed or its consent is
  withdrawn, and a derived file that still contains a withdrawn take is a privacy
  hole, so a read would offer the preview only when it was built from exactly the
  current public track set. The partial-decode route above reaches the same first
  sound with none of that, which is why it is the recommended next step.
- **Channel and studio reads are unchanged.** A member of the channel reads the
  whole song with no `audioSources`, and the studio never asks for one. The in-app
  public view's server read carries the list and the app now uses it (the song panel
  and the conversation card pass `listen`; see "Who loads what").
- **Phones.** `ios/` and `android/` ignore `audioSources` and keep playing
  `audioUrl`: correct and unchanged. Android can prefer an `opus` entry and fall back
  to `audioUrl`; iOS needs a second copy in CAF or an Opus decoder, see
  `docs/JAM_PUBLIC.md`.

### Rolling it out

1. Merge. This is `restarts-api` (a schema change, a new job kind, a changed read)
   and needs a **worker image** deploy (`<sha>-worker`): the API image has no ffmpeg
   and never makes a copy. Deploy the API first, then the worker, so the kind exists
   before anything can claim it. Nothing changes for anybody: the flag is off.
2. Confirm the worker can do it: its boot log has no `libopus` complaint and
   `GET /api/admin/metrics` → `jamAudioCopy` is present with `enabled: false`.
3. Turn it on: controles → interruptores → `jam_audio_copy`, or `PUT
   /api/admin/flags { key: "jam_audio_copy", enabled: true }`. Do it when no big
   watch party is live (the worker's one lane is small, but be conservative).
4. Watch `jamAudioCopy`: `waiting` falls by about five a minute (the default rate,
   `JAM_AUDIO_COPY_BACKFILL_PER_MINUTE`; the first stems done are the public songs'),
   `withCopy` rises, `failed` stays 0, `queue.oldestQueuedSeconds` stays small,
   `bytes.copy / bytes.original` is about 0.17. Each failure is also logged
   `jamAudioCopy.failed trackId=... reason=...`.
5. Open a public song on jam.pqp.gg with the network panel open: the stems are
   `.listen.ogg`, and it plays. Do the same in Safari. Then open it in the app
   (`/app/jam/<id>`, signed in as somebody who is not in its channel): the same
   `.listen.ogg` requests on open, and "Mandar minha parte" fetches the `.flac`s.
6. To stop the backfill: set the flag off (everything stops: no enqueue, no claim,
   no offer); to pause only the backfill and keep new tracks queueing, set
   `JAM_AUDIO_COPY_BACKFILL_PER_MINUTE=0` on the worker. Copies already made stay in
   the bucket; turning the flag on again does not make them twice.
7. If the bitrate is to change, decide it before step 3: it needs a new copy of every
   track.

## Per-browser caveats

**Chrome** (and Electron, which is Chrome; its permission handler already
grants `media`)

- `outputLatency` reads 0 for a moment after the context starts and the real
  value a few hundred ms later (0 then 24 ms in headless Chromium). The engine
  ignores staleness until it is non-zero.
- `getSettings().latency` has been reported as a fixed 0.01 regardless of the
  device (Jeff Kaufman, 2021); the fake device here also said 0.01.
  `track.stats.latency` is in milliseconds (the spec types it
  DOMHighResTimeStamp) and said 0.64 ms for the fake device.
- MediaRecorder's MP4 output came back EMPTY in about half of a run of short
  takes on 2026-11-09. Cause found on 2026-11-12: Chromium's MP4 recorder
  fails at start (`Internal Error`) when it is given `audioBitsPerSecond`
  with a 44.1 kHz stereo microphone; without that option it records. Fixed
  (`startOne` in `video-take.ts`). The camera is still recorded as WebM on
  Chrome, for a different reason: see "Camera video formats and the MP4 copy".
- `voiceIsolation: false` is requested; older builds ignore it.
- The int16 to float mapping above.

**Firefox**

- `outputLatency` exists (since 70); it was reported as implausibly low (less
  than half the real round trip) in 2021. Not re-measured here.
- No `track.stats`, so the estimate assumes 10 ms of input latency.
- MediaRecorder records WebM only.
- The context is created at the default rate on purpose: Firefox refuses to
  connect a microphone to a context created at a different rate.

**Safari / WebKit**

- `outputLatency` only since Safari 18.4.
- macOS Voice Isolation (Control Center) cannot be turned off by a page; if
  the person enabled it, the instrument goes through it.
- MediaRecorder records MP4 only, which is fine for the native players.
- MP3 is not decoded gaplessly (above). AAC failed to decode in Playwright's
  WebKit build, which lacks some system codecs; real Safari probably decodes
  it. Neither matters with FLAC.
- AudioWorklet exists since 14.1; `decodeAudioData` decodes FLAC.

**Native iOS and Android** (playback only, at first)

- FLAC plays on iOS 11+ (AVFoundation) and on Android (MediaExtractor,
  ExoPlayer).
- A WebM camera file does NOT play in AVFoundation, so the worker makes an
  H.264 + AAC MP4 copy and the track read offers it first (`videoUrl`, and
  `videoSources`); see "Camera video formats and the MP4 copy". No phone client
  change was needed.
- Sample-accurate multi-stem playback is native work of its own
  (`AVAudioPlayerNode.scheduleBuffer(at:)` with one shared `AVAudioTime`;
  Oboe or a single ExoPlayer with a mixing processor on Android). The rule to
  port is `planSegment` in `timeline.ts`: every stem placed by one rounding of
  its offset against one start frame.

## Not done, on purpose

- **Punch-in re-record.** The server stores one audio object per track, so a
  punch is a re-render of the old take with a crossfaded region (a splice,
  then a new upload), plus muting the replaced stem during the region. Not
  cheap enough for this pass; it is a contained follow-up on top of
  `startRecording`.
- **Loops while recording**: a take is always a straight run (the loop is
  ignored for it).
- Stereo stems (a take is mono; `chooseMono` keeps the live side of a
  two-input interface or averages a real pair), LPC in the FLAC encoder (about
  9 % smaller files), FLAC's MD5 (left as "not computed", which the format
  allows).
- Aligning a camera take decodes the whole camera file's audio
  (`decodeAudioData` cannot decode a slice of a WebM or MP4). A five-minute
  take costs about 60 to 120 MB of decoded audio for a moment at stop. Fine
  for desktop; a streaming demuxer (WebCodecs) is the fix if phones ever
  record video.
- Software monitoring exists (`input.setMonitor`) but is off by default: it
  comes back a full round trip late. An interface's direct monitoring is the
  right tool.

## Ten minutes with a real guitar (for the owner)

Open `/qa/jam` on a dev build (`VITE_DEV_AUTH_BYPASS=true`). Each step names
what to report back.

1. **Engine and output.** Click "Start audio engine". Note the log line
   (sample rate, baseLatency, outputLatency). Then "Open input" with the
   interface or mic, and check the settings line says
   `echoCancellation=false, noiseSuppression=false, autoGainControl=false`.
   Report any `true`.
2. **Loopback on speakers.** With speakers (or a headphone cup held against
   the mic), "Calibrate: loopback". Report the number, the confidence and the
   spread, and the estimate shown under it. The gap between the two is the
   most useful number we do not have.
3. **Repeatability.** Run the loopback three more times. Report the spread of
   the four results (we expect under 1 ms apart).
4. **The take lands.** "Add click track", Play once to hear it, Stop. Record
   with a one-bar count-in and play eight bars of muted string hits exactly on
   the click. Stop, Play from 0 with the click and the take. Report whether
   the hits sit on the clicks or flam; if they flam, nudge until they do and
   report the nudge in ms (that is our error).
5. **Real music.** Load two or three stems (any audio files), record a part
   over them, play it back. Report whether it feels in time without touching
   anything.
6. **Headphones and DI.** Switch to wired headphones and the guitar straight
   into the interface. Check the device change shows up in the log. Run
   "Calibrate: tap along", hitting muted strings on each click. Report the
   number and the spread, then repeat step 4 with it.
7. **Bluetooth.** Connect Bluetooth headphones. Report whether the red
   Bluetooth warning appears and what the estimate says.
8. **Camera.** Tick "camera", record a short take, play it back. Report
   whether the picture is in time with the sound (a frame or two late is the
   expected residual: the camera's own latency is not measured).
9. **Other browsers.** Repeat steps 2 and 4 in Firefox and Safari, and in the
   desktop app if you can. Report the loopback number in each.
10. **Download.** "download FLAC" on a take, open it in any audio editor, and
    check it is the take with nothing chopped.
