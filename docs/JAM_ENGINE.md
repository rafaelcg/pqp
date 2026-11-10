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
| video object | `upload.video` | WebM (VP9/VP8 + Opus) or MP4 on Safari; its own audio is never played |
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
handled server-side.

The encoder is hand-written (`flac.ts`, about 400 lines) because no browser
encodes FLAC (WebCodecs offers Opus and AAC) and the libFLAC ports are 300 kB
or more of wasm for what is, here, the easy 90 % of the format. It is
verified bit-exact against ffmpeg's decoder in the unit tests (skipped where
ffmpeg is missing) and against all three browsers above.

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
  takes in Playwright's Chromium, while WebM never did. The camera is
  therefore recorded as WebM on Chrome. Re-test MP4 on real Chrome before
  switching back.
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
- A WebM camera file does NOT play in AVFoundation; until Chrome records MP4
  reliably, iOS needs a server-side transcode of WebM videos (or plays the
  audio without the picture).
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
