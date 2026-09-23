# pqp-remux

A headless, hidden LiveKit subscriber that turns a watch party presenter's
screen-share H.264 into CMAF (fragmented MP4) parts and segments for LL-HLS —
video passthrough, no decode or re-encode of a single frame — and mixes every
stage microphone plus the screen's own audio into one AAC-LC track alongside
it. This is `L1.1` through `L1.4`, plus `L1.6`'s Go-side control API and
watchdog, of [`docs/plans/LL_HLS.md`](../../docs/plans/LL_HLS.md) on `main` —
read that file's "1. Architecture" and "3. Keyframes" sections first; this
README does not repeat the reasoning, only the interface.

Two binaries live here now: `cmd/pqp-remux` is the single-session process
described by "What it does today" below (one `ROOM`, set by hand or a load
harness); `cmd/pqp-remuxd` is the `L1.6` **control-plane supervisor** that
holds N of that same pipeline in one process, driven over HTTP by
`pqp-api` — see "Control API (`L1.6`)".

## What it does today

1. Joins a LiveKit room as a **hidden** (`Hidden: true`), subscribe-only
   participant — it never publishes anything (`internal/subscriber`).
2. Finds the presenter's screen-share video track (`Source ==
   SCREEN_SHARE`), its screen-share audio track if present, and every stage
   participant's microphone (`Source == MICROPHONE`, any identity).
3. Depayloads the H.264 RTP stream (single NAL, STAP-A, FU-A) into access
   units, in AVCC form, with SPS/PPS/IDR detection (`internal/h264`,
   `internal/nal`).
4. Boxes those access units into CMAF: one init segment (`ftyp`+`moov` with
   an `avcC` built from the SPS/PPS), then `moof`+`mdat` fragments cut at
   `PART_MS`, with segments closed elastically on the first IDR at or after
   `SEGMENT_MS` (`internal/cmaf`, `internal/pipeline`).
5. Decodes every stage audio source's Opus, mixes them to one 48kHz stereo
   PCM stream on a shared wall-clock-anchored timeline, encodes AAC-LC, and
   boxes that into its **own** CMAF init segment and fragments — a second,
   independent rendition alongside the video passthrough, not a second track
   muxed into the same `moof` (`internal/audiomix`, `internal/aacenc`,
   `internal/cmaf`'s `BuildAudioInitSegment`, `internal/pipeline`'s
   `AudioFragmenter`). See "Audio: mix and AAC" below.
6. Keeps the last `RING_SEGMENTS` segments (and every part in them) of each
   rendition in memory and serves them over plain HTTP for local testing
   (`internal/ring`, `internal/serve`).
7. Asynchronously PUTs each closed segment (and each rendition's init
   segment) to the same R2/S3-compatible bucket and key layout the
   conventional HLS egress already writes into, so the existing retention
   sweep and `keep_replay` collect an LL session's objects the same way
   (`internal/r2`). See "R2 writer" below.
8. Optionally paces RTCP PLIs to ask the publisher for a keyframe when one
   hasn't arrived in a while (`internal/keyframe`), gated per L0.1's
   findings (see below).
9. Doubles as the `L0.2` keyframe-cadence logger via `-idr-log`.

Audio is **selected and logged only** — see "Not yet" below.

## The muxer: hand-rolled, not a library

`internal/cmaf` builds every ISOBMFF box itself (`box`/`fullBox` helpers,
then `ftyp`/`moov`/`moof`/`mdat` on top) instead of using a general-purpose
MP4 library such as `Eyevinn/mp4ff`. Reasons, in order of weight:

- **The muxer's whole job is atypical of what those libraries are built
  for.** A CMAF *part* is a fragment inside a segment that need not start
  on an IDR; a CMAF *segment* is the first fragment after a boundary that
  must. Getting `tfhd`'s `default-base-is-moof` flag, `trun`'s per-sample
  `sample_flags` (sync vs. non-sync), and `tfdt`'s 64-bit base decode time
  right for that shape is the entire task, not incidental plumbing a
  library would hide usefully.
- **It's small.** `box.go` + `init.go` + `fragment.go` is under 400 lines,
  fully covered by tests that inspect the actual bytes (box sizes,
  `mfhd` sequence numbers, `tfdt` monotonicity, `avcC` content byte for
  byte) rather than trusting a dependency's own claims about itself.
- **No decode path to accidentally trigger.** Passthrough means the sample
  bytes a library would otherwise "help" with (transcoding, remuxing between
  containers) must never be touched; writing the boxes by hand makes that
  true by construction instead of by careful API usage.
- **One more version to pin and audit is not free**, and `mp4ff`'s fMP4
  writer is oriented at authoring from decoded/encoded frames with duration
  metadata computed up front, not at re-boxing a live RTP access-unit
  stream sample by sample as it arrives.

If audio muxing (`L1.3`) or a second video rendition ever needs box types
this file doesn't have yet, extending `internal/cmaf` in the same style is
expected to stay cheaper than adopting a library at that point too.

## Config

Read by `internal/config`.

| Var | Default | Meaning |
|---|---|---|
| `LIVEKIT_URL` | — (required) | e.g. `wss://sfu.pqp.gg` |
| `LIVEKIT_API_KEY` | — (required) | |
| `LIVEKIT_API_SECRET` | — (required) | |
| `ROOM` | — (required) | LiveKit room name to subscribe to |
| `LISTEN` | `127.0.0.1:8089` | HTTP address for the local test surface. **Loopback by default on purpose**: none of `internal/serve`'s routes authenticate a caller (see its package doc comment), so binding every interface by default would turn a forgotten override into an unauthenticated media-disclosure endpoint. Set it to a non-loopback address only deliberately, and only with a real access-control layer in front of it |
| `PART_MS` | `500` | CMAF part target (plan §2/§6) — **both renditions**. Audio batches whole AAC frames until it is reached, so an audio part is `PART_MS` rounded up to the next 21.3ms frame (512ms at the default). It used to be one part per AAC frame, ~48/s; see `internal/pipeline.AudioConfig` |
| `SEGMENT_MS` | `4000` | CMAF segment target (plan §2/§6); segments close elastically on the first IDR at or after this, never before |
| `RING_SEGMENTS` | `6` | How many sealed segments (plus the live one) of the **video** track stay in memory. The audio ring gets `ring.AudioSegments(RING_SEGMENTS)` — deeper, because audio segments close on schedule while video's close elastically, so the same segment count is a shorter window in seconds |
| `KEYFRAME_POLICY` | `natural` | `natural` (never send a PLI) or `pli` (paced, gated requests). **`L0.2` has not chosen a branch yet** — this defaults to `natural` on purpose |
| `PLI_GATE_FACTOR` | `1.0` | In `pli` mode, wait this many × `SEGMENT_MS` with no IDR before asking for one. A factor above 1 pushes the earliest possible segment boundary past `SEGMENT_MS`, because a segment closes on the first IDR at or after the target |
| `PLI_PACE_MS` | `500` | Minimum spacing between repeated PLI requests while still waiting for an IDR. **Floored at 500ms** regardless of a lower value: `L0.1` found the SFU's own `rtc.pli_throttle` (Low tier) defaults to 500ms for a single-layer publish (our screen share always is), so asking faster only wastes RTCP, it does not get more keyframes |
| `CLOCK_CUT_PARTS` | `false` | **Off by default; deploying the binary changes nothing until it is set.** Cut every part at exactly `PART_MS` instead of on whichever access unit arrives after the target has passed, filling the rest of a long frame gap with synthesized frames that repeat the picture already on screen (`internal/skipframe`). It exists because `PART-TARGET` is a promise: AVPlayer refuses a playlist outright, as a fatal parse error, when a partial segment runs longer than it, or when a non-terminal one is shorter than 85% of it — and a part is otherwise exactly as long as the frame it holds. Measured against the live stream on 2026-09-17: parts of 0.667s, 1.1s and 2.25s beside the usual 0.5s. The synthesizer refuses any stream it cannot write a correct slice for (CABAC, several slice groups, weighted prediction, field coding, `pic_order_cnt_type` other than 2, more than one reference frame), and such a session keeps today's behaviour exactly; the stats line's `repeats=`/`cuts=` counters say which way it went |
| `REORDER_HOLD_MS` | `300` | How long a video RTP packet waits for the one in front of it before the gap is handed to the depacketizer. Roughly one publisher-to-SFU round trip, which is when a NACKed retransmission lands. **`0` turns holding off entirely**: every gap goes straight through, the behaviour before the buffer existed, and the rollback if the hold ever costs more than it buys. Bounded at 1000; past that it is a jitter buffer wearing this knob's name. The buffer can add at most `REORDER_HOLD_MS` plus one 100ms monitor tick to the pipeline (`internal/session`'s `reorderDelayBound`), and `PART_STUCK_MS` is sized against exactly that sum (see `internal/control`'s `partStuckThreshold`). Read by BOTH binaries: `pqp-remuxd` loads its own copy, because production runs that one |
| `PART_DEADLINE_GRACE_MS` | `150` | With `CLOCK_CUT_PARTS` on: how long past the wall instant a part's end maps to the monitor waits for a frame before cutting that part with repeat frames anyway. Parts are then published on the beat whatever the source does, instead of on the next frame (up to a second late on a quiet tab). Never fills past a frame whose first packet has arrived, and never while the reorder buffer is holding packets. Bounded 0..10000. **A value at or above the idle allowance (1000 at the default `PART_MS`) is the exact pre-deadline timing, and the rollback.** Inert with `CLOCK_CUT_PARTS` off. Read by BOTH binaries. See "The part deadline" below |
| `AAC_BITRATE_KBPS` | `128` | Target AAC-LC bitrate `internal/aacenc` asks ffmpeg's native encoder for |
| `FFMPEG_PATH` | `ffmpeg` (via `PATH`) | Override the ffmpeg binary `internal/aacenc` shells out to |
| `CHANNEL_ID` | `ROOM`'s value | The R2 key layout's `channelId` segment. Defaults to `ROOM` because `server/src/voice/hls-egress.ts`'s own `roomName` **is** the channel id (one LiveKit room per voice channel) — this exists only to override that in a test or a future topology where that stops holding |
| `STARTED_AT_MS` | this process's own start time | The R2 key layout's `startedAt` segment. A stand-in for the `hls_sessions.started_at` value `L1.5`'s API control plane will eventually own and pass in |
| `RUNG` | `ll` | The R2 key layout's rung segment, matching the plan's own choice (`docs/plans/LL_HLS.md` §4/§6: "its `hls_sessions` row carries `rung = 'll'`") |
| `LIVE_HLS_S3_ENDPOINT` / `_BUCKET` / `_REGION` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_FORCE_PATH_STYLE` | — (optional; `_REGION` defaults to `auto`) | Exactly the same names and shape as the server's own `LIVE_HLS_S3_*` (`server/src/voice/hls-egress.ts`'s `liveHlsStorageConfig()`), read by `internal/r2`. Any one missing besides region/path-style means the R2 writer is off — the same "not configured, not an error" shape as everywhere else this bucket is read. An unset `_REGION` does **not** disable it: `r2.Config.SigningRegion()` falls back to R2's own `auto` convention, so a deployment that only ever set the other four still signs correctly instead of passing "configured" and then failing every PUT |
| `R2_UPLOAD_QUEUE_DEPTH` | `64` | Bounded async upload queue depth (`internal/r2.Writer`); a full queue drops the newest item and counts it rather than blocking the part/segment pipeline |
| `R2_UPLOAD_MAX_RETRIES` | `3` | Additional attempts a failed upload gets (so the default is up to 4 total attempts) before it is counted `Failed` and dropped |

Flags (only used with `-idr-log`, see below): `-idr-log <path>` (`-` for
stdout), `-duration <go duration>`.

## Keyframes: only one lever, and it's gated

`docs/plans/LL_HLS.md` "L0.1 result" (PR #577) verified there is no
publisher-side GOP control reachable from this service and no
`RoomServiceClient` keyframe RPC — the **only** lever is
`RemoteParticipant.WritePLI(ssrc)` on the subscriber's own peer connection
(`server-sdk-go` → Pion `PeerConnection.WriteRTCP`), which is what
`subscriber.Session.RequestKeyframe` calls. `internal/keyframe.Gater` is
pure decision logic (no timer, no RTCP) with the three rules that fell out
of L0.1:

1. Never fire under `natural`.
2. Under `pli`, wait `PLI_GATE_FACTOR × SEGMENT_MS` since the last IDR
   before asking — a keyframe request is a bitrate spike every seated
   WebRTC viewer pays for, so it's asked for only when the elastic segment
   boundary (branch A) would otherwise miss its target by a lot.
3. Once asking, don't ask again faster than `PLI_PACE_MS` (floored at
   500ms) — the SFU throttles anyway, so anything faster is wasted, and
   `OnIDR` resets the pacer clean on every real IDR so back-off always
   restarts from actual content, not from our own last guess.

## `-idr-log`: the `L0.2` cadence logger

```
LIVEKIT_URL=wss://... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... ROOM=party-1 \
  ./pqp-remux -idr-log idr-log.csv -duration 10m
```

This mode is **passive by construction**: it never constructs a
`keyframe.Requester` at all (see `runIDRLog` in `cmd/pqp-remux/main.go`), so
`KEYFRAME_POLICY` is irrelevant to it — zero PLIs are sent, regardless of
what's set in the environment. It writes one CSV line per IDR,
`ts_ms,pts,size_bytes,interval_ms` (`ts_ms` is milliseconds since the first
IDR; `interval_ms` is milliseconds since the *previous* IDR), then on
`-duration` elapsing prints one summary line to stderr:

```
idr-log: n=118 p50=3980ms p95=4210ms p99=8100ms max=11950ms over4s=42 over8s=3 over12s=0
```

The very first IDR's arrival gap is **excluded** from that summary
(`internal/idrlog`, `Logger.OnIDR`'s doc comment): `L0.1` found the SFU
sends a keyframe request on every subscribe, so the first IDR arrives fast
for a reason that has nothing to do with the publisher's steady-state
cadence, and counting it would bias the distribution optimistic. It is
still logged, with `interval_ms=0`, so the raw CSV keeps every row for a
manual read.

## Audio: mix and AAC

`L1.3`. `internal/subscriber` finds the presenter's screen-share audio track
and every stage participant's microphone (any `Source == MICROPHONE`
publication — LiveKit's own `SPEAK` grant is what gates who can publish one
at all, so every mic this process ever sees already is a stage speaker; see
`isScreenShareVideo`'s doc comment for the same reasoning applied to the
screen share). Each is handed to `internal/session`, which:

1. Decodes it (`internal/audiomix.Source`, one per publication) and places
   its PCM on a shared 48kHz sample timeline, anchored **once** to a
   wall-clock epoch (`Session`'s own construction time in practice — close
   enough to the video track's true first-packet arrival that treating them
   as the same instant is a documented approximation) and after that driven
   entirely by each source's own RTP timestamps, never the wall clock again.
   That is what "derive both from the RTP timestamps against one wall-clock
   anchor" (the plan's own words for this task) means in code.
2. Mixes every active source with a sum-and-soft-clip curve
   (`internal/audiomix.Mixer.Pull`, `tanh`) at a cadence corrected against
   wall-clock elapsed time on every tick (`framesElapsed` in
   `internal/session`), so scheduler jitter never accumulates into
   audio/video drift.
3. Encodes the mix to AAC-LC via a long-lived `ffmpeg` subprocess
   (`internal/aacenc`), parses its ADTS output back into raw access units.
4. Muxes those into their **own** CMAF init segment and fragments
   (`internal/cmaf`'s `BuildAudioInitSegment`, `internal/pipeline`'s
   `AudioFragmenter`) — a second, independent rendition, not a second track
   inside the video muxer's `moof`. See "Muxing: two renditions, not two
   tracks" below for why.

A participant joining or leaving the stage is not a special case: their
`audiomix.Source` starts or stops contributing non-zero samples at exactly
the position their real audio does (or doesn't); see
`internal/audiomix.Mixer`'s own doc comment and tests for why no gap-closing
or fade logic was needed to get "no gap or click" (the plan's acceptance
bar).

### Codec choices and their CPU cost

**Decode: `github.com/pion/opus`**, a pure-Go RFC 6716 implementation (MIT),
not a cgo binding (`hraban/opus`). No cgo means no `libopus-dev` system
dependency on every box this ever runs on — the shared SFU box today, a
future dedicated remux box tomorrow — for a workload nowhere near
CPU-bound: the plan's own floor for this whole task is "audio mix and AAC
about 0.05 of a core for a busy stage" (`docs/plans/LL_HLS.md` §5) against a
4 vCPU budget. Measured locally (Apple M-series, **not** the production
box — a production number needs a live party, which this sandboxed PR could
not reach): decoding a 30s, 64kbps stereo Opus stream 50 times over ran at
roughly **870x real time**, i.e. about **0.1% of one core per decoded
track**. An order of magnitude under the plan's floor, so decode speed was
never the constraint that would have justified paying for cgo. See
`internal/audiomix`'s package doc comment for the full reasoning and the
quality sanity-check (`internal/audiomix/mixer_test.go`'s fixture round-trip:
no NaN, no clipping, a peak amplitude matching the source).

**Encode: shell out to a long-lived `ffmpeg` subprocess** (`internal/aacenc`),
not a Go AAC encoder library — there isn't a maintained pure-Go AAC-LC
encoder to reach for; the handful of FAAC-derived options are abandoned cgo
wrappers, and a from-scratch MDCT+TNS+quantization+Huffman encoder is a
project of its own, not what this task budgets for. ffmpeg's native `aac`
encoder is already an ordinary system package (`apt-get install ffmpeg`, one
line in the box's provisioning — see the CI workflow, which now installs it
explicitly). Measured locally: encoding 30s of 48kHz stereo PCM to AAC-LC at
128kbps took **0.26s of user CPU** (`/usr/bin/time -l ffmpeg -f f32le ... -c:a
aac -b:a 128k -f adts`), i.e. roughly **0.87% of one core**. Comfortably
inside the plan's 0.05-core budget for the *whole* audio path, and this is
one shared encode per party regardless of audience size.

**A known, accepted approximation**: `internal/aacenc.PrimingSamples`
documents ffmpeg's native AAC-LC encoder's own one-frame (1024-sample,
~21.3ms) encoder delay, but this implementation does **not** shift the audio
track's `tfdt` to compensate for it (doing so would require a negative base
decode time, which CMAF's unsigned `tfdt` cannot represent for the first
fragment). The audio track's first AAC frame is labeled as covering samples
`[0, 1024)` when its true content is delayed by that much. This is a fixed,
non-accumulating offset (not drift), estimated at ~21ms — under the plan's
40ms budget on its own, but worth tightening in `L2.x` if the two other
approximations above (the epoch, the mixer pacer's own catch-up rounding)
ever combine to get close to it. `internal/aacenc.PrimingSamples`'s own doc
comment names what would fix it precisely (reading the encoder's own delay
metadata) if that day comes.

### Muxing: two renditions, not two tracks

`internal/cmaf`'s existing muxer (`BuildFragment`, `buildMoof`) is built for
exactly one track per CMAF stream (`TrackID` is a package constant). Adding
a second `traf` to the same `moof` for audio was the other option the task
description allowed ("mux the AAC as a second track in the same CMAF
parts/segments... or as a separate audio rendition with its own init/parts
... either is valid LL-HLS"); this went with the separate rendition because:

- **The two tracks' natural cadences don't share a divisor.** Video parts
  cut at `PART_MS` (500ms) and segments close *elastically* on the next IDR
  at or after `SEGMENT_MS`; AAC-LC frames are a fixed 1024 samples
  (~21.3ms at 48kHz), which does not evenly divide either target. Keeping
  them in lockstep inside one fragment would mean either padding/splitting
  AAC frames to fit a video boundary (re-introducing exactly the kind of
  boxing complexity `internal/cmaf`'s README already avoided by hand-rolling
  instead of adopting a library) or accepting an audio boundary that
  wanders relative to its own frame grain.
- **Every AAC-LC frame is independently decodable** (no B-frames, no GOP),
  so the audio segment boundary needs no IDR-wait at all — `AudioFragmenter`
  closes exactly on schedule (the first frame boundary at or after the
  target, within 21.3ms of it). Sharing one `moof`/segment-boundary decision
  with video would import video's "wait for an IDR" rule into a track that
  has no such constraint, for no benefit.
- **Independent cadences are not "no cadence".** The audio track still cuts
  parts at `PART_MS`, batching whole AAC frames until the target is reached.
  Reading "independent" as "whatever the caller pushes at" is what shipped
  one CMAF part per 21.3ms frame — roughly 48 parts per second of ~114
  bytes each — and stalled every viewer of the first end-to-end LL session
  on 2026-09-15. `internal/pipeline.AudioConfig`'s doc comment carries the
  measurements.
- **Independent failure domains.** If `ffmpeg` isn't available, is slow to
  start, or the mix has no active source yet, video passthrough must not
  care — see `Session.EnableAudio`'s doc comment: a failure there is logged
  and the process keeps serving video only. A shared fragment would couple
  the two tracks' error handling together.
- **This is what LL-HLS already expects**: a multivariant playlist listing
  an audio rendition group referenced by the video variant is the standard
  shape a player like hls.js already knows how to play; `L2.x`'s playlist
  work does not need to invent anything new here.

If a genuinely single-file multi-track CMAF stream is ever wanted (e.g. for
a player that cannot handle an audio rendition group), extending
`internal/cmaf`'s hand-rolled boxes to a second `traf`/`trak` in the same
style is expected to stay cheaper than adopting a library for it, per the
same reasoning the README already gives for the video muxer.

## R2 writer

`L1.4`. `internal/r2` asynchronously PUTs each closed segment (video and, once
audio is enabled, its own) plus each rendition's init segment, to the same
S3-compatible bucket and key layout the conventional egress uses
(`server/src/voice/hls-egress.ts`'s `hlsObjectPrefix`:
`live/<channelId>/<startedAt>-<rung>`) — see `r2.ObjectPrefix`, kept
byte-for-byte identical on purpose, so `hls-cleanup.ts`'s retention sweep and
`keep_replay` find and delete an LL session's objects the same LIKE-prefix
way they find a conventional rendition's. Object names underneath that
shared prefix (`video-init.mp4`, `video-seg-<n>.m4s`, `audio-init.mp4`,
`audio-seg-<n>.m4s`) are this task's own choice — the sweep only matches on
the outer prefix, not what's nested under it — and may be revisited once
`L1.5`'s API control plane defines the real `hls_sessions` row shape for an
LL rendition; until then, `CHANNEL_ID`/`STARTED_AT_MS`/`RUNG` (see Config)
stand in for what that row will eventually own. `ROOM` doubles as the
channel id by default because `hls-egress.ts`'s own `roomName` already is one
(one LiveKit room per voice channel).

**SigV4, hand-rolled, not `aws-sdk-go-v2`** (`internal/r2/sigv4.go`): the same
choice `server/src/lib/s3.ts` already made on the Node side (its own
`signRequest` is hand-written, not the AWS JS SDK), for the same reason
`internal/cmaf`'s README gives for not adopting a general-purpose MP4
library — this package's whole job is one HTTP verb (PUT) against one
stable, well-documented algorithm, and a multi-hundred-package SDK is a lot
of dependency for that. Verified against a real local MinIO container during
development (`internal/r2/uploader_test.go`'s `TestS3UploaderPutObjectAgainstRealMinIO`,
opt-in via `R2_TEST_MINIO_*` env vars, skipped otherwise) — a genuine
signed-PUT-then-GET round trip, plus a deliberately-wrong-secret rejection
check, not just "the in-memory fake was called correctly."

**Bounded, retried, never on the hot path**: `r2.Writer` is an async queue
(`R2_UPLOAD_QUEUE_DEPTH`) with capped exponential-backoff retry
(`R2_UPLOAD_MAX_RETRIES`); `Enqueue` never blocks past the queue being full —
a full queue drops the newest item and counts it (`Writer.Dropped`) rather
than applying backpressure to the part/segment pipeline, per the task's own
"never block the part pipeline on an upload." `Writer.Uploaded` /
`.Failed` / `.Dropped` are exposed on `GET /healthz` once `L1.6`'s watchdog
wants them (already surfaced today as `r2Uploaded`/`r2Failed`/`r2Dropped`).

**`Close` is bounded too**: a dead bucket cannot make process shutdown hang
for the tens of minutes a full queue's worth of retries would otherwise take
(`QueueDepth × (1+MaxRetries)` attempts, each up to `uploadTimeout` plus
backoff). Past `CloseDeadline` (default 10s), `Close` cancels every
in-flight and queued attempt and counts what never got a real try as
`Dropped`, not `Failed`.

**Parts are never uploaded** (only closed segments and each rendition's init
segment) — per the plan §1: parts are served from the box itself.

**Replay playlists** (`internal/r2.VodIndex`): the session also PUTs
`video.m3u8`, `audio.m3u8` and `master.m3u8` under the same prefix, on its
first segment, then at most every 30 s while live (each write is the whole
session, so one per segment would upload bytes growing with the square of the
show's length), and always once more on close. Plain HLS media playlists over the WHOLE session (never trimmed to the
ring), `#EXT-X-PLAYLIST-TYPE:EVENT` while live and `VOD` plus
`#EXT-X-ENDLIST` once the session closes, one `#EXT-X-MAP` per init with an
`#EXT-X-DISCONTINUITY` ahead of every change. They go through the same
`r2.Writer` as the segments, so a slow bucket drops a playlist PUT rather
than blocking anything, and the next write replaces the whole playlist
anyway. The index belongs to the control-plane session, not the pipeline, so
a watchdog restart appends to it, and the init generation is carried across
the restart like the segment index is, so the replacement never overwrites
`video-init.mp4`. `pqp-api` serves these back through the signed replay route
(`server/src/voice/hls-history.ts`). The prefix's `<startedAt>` is the one the
API sends in `startedAtMs` on `POST /sessions`, so it matches
`hls_sessions.object_prefix` exactly; a request without it (an older API)
falls back to this box's own clock.

**Shutdown order matters, and got it wrong once** (Farol caught it):
`cmd/pqp-remux/main.go`'s `runServer` registers the R2 writer's `Close`
*before* the session's, specifically so it executes *last* — defers run
last-registered-first, so registration order (`r2Writer`, `sess`, `cancel`,
`sub`) becomes execution order `sub.Close` → `cancel` → `sess.Close` →
`r2Writer.Close`. Getting this backwards (the writer closing before
`Session.Close` had a chance to flush and enqueue the final video and audio
segments) silently dropped a party's last few segments from R2 every time.

## Keep-alive: a static source still publishes

Everything in `internal/pipeline` is access-unit driven, and has to be:
only the NEXT access unit can say how long the previous one lasted, so a
part closes when a frame arrives past the part target, never on a timer.
That is correct and stays correct — right up until the publisher stops
sending frames.

**A Chrome tab share of a page that is not repainting sends none.** Not a
low frame rate: none, plus a low-rate refresh. So no part closes, the
playlist stops advancing, and a viewer's video buffer ends at the last
published part while the freeze is still going. On 2026-09-15 that also
tripped the control plane's 3s `PART_STUCK_MS` twice on one production
session and demoted the party off the LL rung.

`Fragmenter.IdleFlush` (driven by `Session.RunMonitor`'s 100 ms tick, via
`idleTick`) publishes the held access unit early, once the source has been
quiet for a whole **idle allowance** — two part targets, floored at a
second (`videoIdleAfter`). **Nothing is invented and nothing is
duplicated**: the ordinary path would have given that same access unit a
duration of `next.PTS - held.PTS` anyway — for a five-second freeze, a
five-second sample — and this only emits it sooner, so the buffer covers
the freeze instead of ending at the start of it. When frames resume, the
next part begins exactly where the flushed one ended, so the timeline
neither rewinds (a `tfdt` going backwards is a corrupt stream) nor gains a
hole. A segment still closes only on an IDR at or past the segment
target — the keep-alive never closes one.

**A last resort, not a cadence, and why that matters.** The first version
of this fired on the PART target and re-derived `ptsOffset` on resume so
the frame that ended the gap landed exactly on the guess. That hides the
gap by throwing the gap away. A Chrome tab share of a nearly static page
sends about **1.4 frames a second**, so its frame gaps sit between the
500 ms part target and the allowance: every single one of them was
published early with a guessed ~0.5 s duration and the rest of the second
was deleted. Production, 2026-09-15 15:10–15:15 UTC: the video timeline
advanced **29.0 s of media in 53.8 s of wall clock** (ratio 0.54) beside
audio at 0.98, every part was a keep-alive (`parts=74 keepalive=74`), and
the viewer's blocking playlist reloads timed out for good after 40 s.

The rules that replace it, all of them in service of one property — **media
time tracks the wall clock, whatever the frame rate**:

- **The publisher's clock is the timeline.** `ptsOffset` is only ever
  RAISED, never lowered, and only far enough to stop an access unit landing
  behind media already published (a frame delivered after a latency spike,
  a publisher clock that stepped back). Raising it shifts the timeline
  forward by a constant, which costs nothing; lowering it is what stole
  time.
- **A quiet source's part waits for the frame that really ends the gap**
  and carries that frame's true duration, so **parts may run longer than
  `PART_MS`** — about a second on a static tab. (Unless `CLOCK_CUT_PARTS`
  is on, which is exactly what it changes.) `state.json` reports the
  real figure in `partTargetMs` (the configured `PART_MS` raised to cover
  the longest listed part, and bounded by `SEGMENT_MS`), because
  `PART-TARGET` is a promise about the maximum and the edge Worker times
  its blocking playlist reloads at three of them. The ceiling is there
  because every part duration descends from the **publisher's** own
  access-unit timestamps: two frames stamped an hour apart would otherwise
  become every viewer's blocking-reload deadline. A part is never usefully
  longer than a segment, and understating a genuinely absurd one is the
  safe direction to be wrong in.
- **A keep-alive pays itself back.** The frame that ends the quiet spell is
  published where the flush ended, and its own duration runs to the
  *following* frame's true instant — so the wall time the flush could not
  know about is published rather than erased, and the timeline is exactly
  on the publisher's clock again from that frame on.

`timelineRatio` on the stats line is that property, measured: media
published over wall clock passed, per track. It belongs at `1.00`.

**The limit, stated plainly, with `CLOCK_CUT_PARTS` off.** One part per
quiet episode. Past that the video timeline is HELD at the last frame
while the **audio** track — paced off the wall clock by `runAudioPacer`,
so it never goes idle — keeps producing parts at `PART_MS`. Publishing
more video than that would mean emitting a coded frame the publisher
never sent twice, which is safe only for an IDR (a P-frame applied to its
own output is not the picture it codes) and is not something this
pipeline did until `internal/skipframe` existed.

**With `CLOCK_CUT_PARTS=true` that limit is gone**, because the thing it
was waiting for now exists: a frame that says "the picture did not
change" is neither a guess nor a re-send of a coded frame. A freeze then
produces one part per `PART_MS` for **up to a minute**, every part
exactly the target, and `partTargetMs` stops climbing with the worst gap
the session ever had. The minute is a cap, not a cadence: a segment
closes only on an IDR and a frozen source sends neither frames nor IDRs,
so filling forever would mean an open segment collecting two parts a
second, every one of them listed in every playlist the edge serves. Past
it the old behaviour returns — the timeline holds, one long part is
published, and the frame that ends the freeze pays the time back. What is published is a P slice whose every
macroblock is `P_Skip`, which copies the previous picture with a zero
motion vector and no residual — bit-exact, verified against ffmpeg with
`-err_detect explode` and `framemd5` on a real capture
(`internal/skipframe`'s bitstream test). Under
`KEYFRAME_POLICY=pli` a quiet source is by definition past the gate
window, so the requester is already asking for a keyframe throughout; if
the browser answers, ordinary frames resume and the question does not
arise.

`keepAliveParts` on the watchdog's detail line counts them. A session
whose parts are ALL keep-alives is a frozen picture, which is a real thing
to want to see and is invisible from `partsWritten` alone.

### The part deadline: a part on the beat, not on the next frame

Clock cutting bounds how LONG a part is. It did not bound WHEN it is
published: a part still closed when the next frame arrived past its end, or
when `IdleFlush` fired after a whole idle allowance (a second). A Chrome tab
share of a mostly static page sends a frame every 0.3 to 1 s, so its gaps
almost never reach the allowance, and a part whose end the wall clock had
long passed sat unpublished until the next frame: **up to a second late**.
The 2026-09-21 party measured that, and the late parts lined up with viewer
stall bursts (r=0.70); resolution changes did not. The edge answers a
blocking playlist reload the moment the part exists, and times its own
polling in part targets (fast for 1.5 s, then once a second), so a late
part is a player waiting, and a very late one pushes the edge onto its slow
poll.

`deadlineTick` (`internal/session`, on the same 100 ms monitor tick, before
`idleTick`) cuts every part whose end mapped to the wall clock passed more
than `PART_DEADLINE_GRACE_MS` ago, filling the rest of the gap with repeat
frames (`pipeline.Fragmenter.DeadlineCut`). The mapping is the fragmenter's
anchor, the last real access unit it accepted, paired with when that access
unit arrived. Every part it cuts is exactly `PART_MS` long and opens on a
repeat frame, the shape `IdleFlush`'s clock-cut branch already produces, so
`PART-TARGET`, the 85% floor, segment boundaries (IDR only) and the timeline
are all unchanged. It is inert without a repeater, which keeps a stream
`internal/skipframe` refuses exactly as it was: there is no honest short
part without one.

**The cost, and what bounds it.** A repeat frame published at an instant the
publisher really sent a frame for makes that frame land behind media already
published; the `synthAhead` rule then raises `ptsOffset`, which shifts video
later against audio for the rest of the session. So the deadline declines
whenever a frame is known to be on its way:

- an access unit is being reassembled (`h264.Depacketizer.OpenAccessUnitPTS`,
  true from the first FU-A fragment): the fill stops one tick short of its
  timestamp, so a keyframe paced out over half a second lands where the
  publisher stamped it;
- the reorder buffer is holding packets behind a hole: the missing packet
  may belong to a frame older than any held, so it waits (at most
  `REORDER_HOLD_MS`);
- otherwise the grace covers the next frame's delivery jitter.

`ptsShiftMs=` on the stats line is the resulting shift, as a level. It
belongs near zero; a number that climbs across a session means the grace is
too short for this presenter's uplink.

Measured with `tools/ll-loss-harness`'s paced source (`SOURCE=idle`: 30 fps,
then 1.4 fps, a 4 s freeze, a burst, an irregular few frames a second), part
publication lateness over 120 s, from `state.json` alone: see the PR that
added this for the before/after numbers. `deadline=` counts the parts it
cut; `late250=`/`late500=`/`lateMaxMs=` measure lateness from inside.

## Observability: one line every few seconds

`Session.RunMonitor` writes one stats line per session per five seconds,
always on, whichever binary is running (`session=<id>` under `pqp-remuxd`,
`room=<name>` under the single-session `pqp-remux`). It exists because the
2026-09-15 service log for a five-minute stalled session held fourteen
depacketize warnings and nothing else, and four different explanations fit
it equally well: no RTP arriving at all, RTP arriving with nothing coming
out of the depacketizer, parts produced with the watchdog measuring the
wrong thing, or the S3 path blocking. Each of those now has its own
signature on one line:

```
pqp-remux: stats session=<id> window=5s subscribed=true
  | video pkts=+1200 (240.0/s) frames=+150 (30.0/s) idr=+2 drops=+7
    markerless=+0 parts=+10 (2.0/s) segs=+1 keepalive=+0 repeats=+0
    cuts=+10 idle=false deadline=+0 late250=+0 late500=+0 lateMaxMs=40
    ptsShiftMs=0
    lastPkt=8ms lastFrame=12ms lastIdr=1.9s lastPart=210ms openSeg=2100ms
    timelineRatio=1.00
  | audio pkts=+250 frames=+234 parts=+10 (2.0/s) segs=+1 timelineRatio=1.00
    dead=false restarts=0
  | pli sent=+0 total=4 unanswered=0 lastPli=1m12s
  | r2 ok=+11 fail=+0 drop=+0 queued=0 inflight=1 lastMs=87 maxMs=940
```

`late250=`/`late500=` count video parts published more than 250/500 ms
after the wall instant their end maps to, and `lateMaxMs=` is the worst in
the window: the delay a blocking playlist reload waited out. With clock-cut
parts on and the deadline at its default, `lateMaxMs` sits under the grace
plus a tick (about 250). `ptsShiftMs` is a level, not a delta (see "The part
deadline").

Read it as: **packets but no frames** is the depacketizer; **frames but no
parts** is the muxer; **neither** is a quiet source (and `idle=true` says
so outright); **parts flowing with `r2 queued` climbing and `lastMs` high**
is the bucket; **`timelineRatio` below 1.00 on one track and at it on the
other** is the timeline itself losing time, which no count on this line can
show (2026-09-15: 0.54 on video, 0.98 on audio, everything else healthy).
`maxMs` is a high-water mark and deliberately never reset —
"did this bucket ever go slow" is a different question from "is it slow
now", which `lastMs` already answers.

`markerless=` is the odd one out on that line: it is not a fault. It counts
access units closed by the next packet's RTP timestamp instead of by a
marker packet, and delivered. A reading above zero with `damage=+0` and
`lost=+0` beside it is a healthy stream from a publisher that does not
always set the marker bit, which is legal (RFC 6184 section 5.1) and which
a real Chrome screen share did eight times in fifteen minutes on a clean
London box on 2026-09-17. Those eight used to be counted as damage:
discarded, and answered with a PLI. See `internal/h264`'s `Push`.

Three state changes log immediately rather than waiting for the next
window: the source going quiet and coming back (`video source idle` /
`video source resumed`), every PLI written and the IDR that answers it
(`keyframe: PLI sent (no IDR for 4s, gate 4s, 1 in this episode, ...)` /
`keyframe: IDR after 3 PLI(s), 1.4s after the first request`, the second
only ever logged when this process actually asked — a publisher supplying
its own keyframes logs nothing), and each watchdog verdict with its full
detail. Depacketize errors are rate limited to one line per second
carrying the suppressed count: at the 27% large-packet loss the
2026-09-15 presenter's uplink measured, unconditional logging is a flood,
and a flood hides the one line that matters exactly as well as silence
does.

## Control API (`L1.6`)

`cmd/pqp-remuxd` (`internal/control`) is the supervisor
`packages/shared/src/hls-remux-control.ts` (`L1.5`, PR #580) describes from
`pqp-api`'s side: "a small HTTP surface a supervisor on the egress box
exposes, fronting one `pqp-remux` subscriber per session." One process, N
sessions, each a real `session.Session` + `subscriber.Session` pair built
and torn down on demand (`internal/control.NewRemuxPipeline` — the exact
same construction `cmd/pqp-remux/main.go`'s `runServer` uses for the
single-session binary, refactored to run more than once per process
lifetime) — never a subprocess, never a container per session.

### Routes

| Route | Signed? | What |
|---|---|---|
| `POST /sessions` | yes | Start a session. Body: `sessionId`, `room`, `channelId`, `partMs`, `segmentMs`, `ringSegments`, `keyframePolicy`, `pliPaceMs`, `pliGateFactor` — one field per `pqp-remux` config knob (see Config above). 201 with the session's info, or 409 with the SAME info if `sessionId` already names a session (idempotent retry). |
| `DELETE /sessions/:id` | yes | Stop a session. 204 always, including "already gone" — stopping is idempotent. |
| `GET /sessions` | yes | Every session this process currently holds. |
| `GET /s/:id/*` | origin key (see below) | That session's media: `init.mp4`, `playlist.m3u8`, `state.json` (see below), `part-N.m4s`, `seg-N.m4s` and their `audio-*` twins — the exact route shapes `internal/serve.Server` already answers, mounted per session under one prefix so `L2.3`'s edge Worker has one origin path shape regardless of how many sessions are live. Never HMAC-signed like `/sessions` (a viewer's player cannot produce that signature, and does not need to reach this route through anything but the edge Worker in a real deployment) — see "Access control" below for what actually gates it. |

#### `GET /s/:id/state.json`

The document `tools/hls-edge` reads **before it can render an LL playlist at
all**. That Worker renders the low-latency playlist itself
(`EXT-X-SERVER-CONTROL`, `EXT-X-PART-INF`, `EXT-X-PART`,
`EXT-X-PRELOAD-HINT`) rather than forwarding text this box wrote — `GET
/playlist.m3u8` here is, and stays, a conventional playlist of sealed
segments — so it needs the numbers those tags encode: which segments and
parts exist, how long each is, which part starts on an IDR, and the name of
the part that has not been written yet. `internal/llstate` renders exactly
that from the live ring (both renditions: video, and the audio twin under
its `audio-` names), `internal/serve` serves it at `/state.json`, and the
contract it answers is the module doc comment of
`tools/hls-edge/src/ll-state.js`, whose `parseLlState` is its validator.

Three things worth knowing before changing it:

- **The URIs are the ones this binary actually serves.** A part is
  `part-<global CMAF sequence>.m4s` (`part-9.m4s`), a segment is
  `seg-<index>.m4s`, and the audio twin is the same with an `audio-`
  prefix — the names `internal/serve.Server` routes on. A part's `index`
  field is its position within its own segment, which is a different number
  and is what the preload hint's arithmetic uses on the Worker's side.
- **`Cache-Control: no-store`, on the 404 too.** The document changes every
  part (~500 ms) and the Worker's blocking-reload hold re-reads it in a loop
  precisely to notice; a cached copy anywhere in between is a viewer frozen
  at whatever edge the cache captured. The Worker does its own in-flight
  de-duplication (one fetch per session per instant, however many viewers
  are waiting), which is where the saving belongs.
- **404 before the first part, not 503.** The Worker reads a 404 as "this
  session is conventional, re-probe in a few seconds" and anything else as
  an error it logs per probe. "No part has landed yet" is the ordinary first
  second of every session.

- **A watchdog restart resumes part numbering, not just segment
  numbering.** Segment indices have been carried across a restart since
  PR #584, because re-using one overwrote an already-uploaded R2 object.
  Part sequence numbers were not, and it did not matter while a part's name
  never left this process. It matters now: the edge Worker advertises
  `part-<seq>.m4s` to players and caches those bytes by path, with the
  viewer token deliberately dropped from the key, so a replacement pipeline
  numbering from 1 again would publish names whose bytes are already cached
  from its predecessor. `restart` sets `StartVideoPartSeq`/
  `StartAudioPartSeq` alongside the two segment indices
  (`internal/pipeline`'s `SetStartSequence`), pinned by
  `TestManagedSession_RestartNeverReusesPartName`.

Blocking reload (`_HLS_msn`/`_HLS_part`) is **not** implemented here and is
not meant to be: those directives never reach this box.
`LlPlaylistOrigin` builds the origin URL from the session id alone and
attaches no query string, and the hold lives entirely in the Worker's own
poll loop, which re-fetches this document and re-renders until the requested
msn/part appears. What this endpoint owes the hold is freshness, which is
what rendering from the live ring per request, uncached, buys.

Why it exists now: on **2026-09-15 at 08:01 UTC** a live party had the API
select LL mode, this box start the session and answer 200 on
`playlist.m3u8`, `init.mp4` and `audio-playlist.m3u8` — and every viewer
stalled, because the Worker asks for `state.json` first and got a 404.
Media on disk is not media a player can find.

`ringSegments` is bounded (`2`..`60`, `internal/control/types.go`'s
`minRingSegments`/`maxRingSegments`) rather than merely "a positive
integer": a session's ring lives entirely in this process's memory, so an
unbounded caller-supplied value is a memory-DoS knob, not a real DVR-window
choice.

`GET /sessions`'s response carries the ten fields
`remuxSessionInfoSchema` in `hls-remux-control.ts` names
(`sessionId`, `room`, `channelId`, `subscribed`, `startedAtMs`,
`lastPartAtMs`, `lastIdrAtMs`, `openSegmentMs`, `partsWritten`,
`bytesServed` — `lastPartAtMs`/`lastIdrAtMs`/`openSegmentMs` are absolute
Unix milliseconds or `null`, matching `startedAtMs`'s own units, NOT the
elapsed-since-start convention `internal/serve`'s local-test `/healthz`
uses) plus a handful more this task's own description asks for
(`state`, `demoted`, `demotedReason`, `audioHealth`, `lastIdrAgeMs`) that
the TS schema has not grown yet. That schema is a plain `z.object({...})`
with no `.strict()`, so `pqp-api`'s own `.parse()` call silently strips
whatever it does not name (Zod's documented default) — returning the extra
fields today is forward-compatible, not a contract violation.

### Signing

Every `/sessions` route (never the media routes) is HMAC-signed as
`hls-remux-control.ts`'s own doc comment specifies, EXTENDED with a nonce
(Farol review, PR #584 — not yet reflected in that file itself, see below):
`X-Pqp-Remux-Timestamp` (unix ms), `X-Pqp-Remux-Nonce` (a per-request random
value the caller generates) and `X-Pqp-Remux-Signature` (lowercase hex
HMAC-SHA256) over

```
${METHOD}\n${path}\n${timestampMs}\n${nonce}\n${rawBody}
```

verified with a constant-time compare (`crypto/hmac.Equal` on the decoded
bytes, never a string `==`), a 60s clock-skew window, AND a bounded
in-memory replay cache (`internal/control/nonce_cache.go`) that remembers
every nonce a valid signature was ever accepted for, for 2× the skew window
(120s) — a captured, still-fresh request now fails on its **second** use,
not merely once the skew window eventually closes. The nonce check runs
only after the signature itself verifies, so a forged request can never
pollute the cache. A request that fails either check never reaches a
handler at all: no session lookup, no registry mutation.

**This is a breaking change to the wire contract the TS side
(`server/src/voice/hls-remux.ts`, PR #580) has not picked up yet**: every
request from an unpatched client is refused as "missing nonce" until it
sends `X-Pqp-Remux-Nonce` as part of the signed payload, in the exact
position above (any sufficiently random per-request string — a UUID or 16+
bytes of hex both work). See the PR description and the follow-up comment
left on #580.

### Watchdog and the demotion contract

`docs/plans/LL_HLS.md` §5. Each session runs its own watchdog goroutine
(`internal/control/watchdog.go`'s `evaluateWatchdog`, pure — no clock, no
IO — driven by `managed_session.go`'s ticker), which:

0. **Waiting is not stalled.** No part has EVER been produced yet (a
   presenter who has not clicked "share screen", or a room just joined) is
   `StateWaiting`, governed by its own, much longer `FIRST_PART_TIMEOUT_MS`
   (default 60s) — `PART_STUCK_MS`'s 3s would otherwise demote the ordinary
   "nobody has started sharing yet" case almost immediately (Farol review,
   PR #584). Past that timeout with still nothing at all → demote, reason
   `no-video`, no restart attempt (there is nothing to restart into; the
   pipeline is already doing the one thing it can). Every rule below only
   applies once at least one part has arrived.
1. **Restarts once, then demotes.** No NEW part for `PART_STUCK_MS` (default
   3000ms, "six parts" per the plan) → rebuild this session's pipeline: the
   OLD pipeline is closed FIRST, and only then is its replacement built
   (new subscription to the same room, same config), so a real gap —
   however long the replacement's own subscriber takes to connect — is
   the price of a correctness guarantee below, not an accident (Farol
   review round 2, PR #584: an earlier revision built the replacement
   before closing the old one to avoid that gap, and that was the bug —
   see below). A second stall within `DEMOTE_WINDOW_MS` (default 5
   minutes) of that restart → **demote**: the pipeline is closed and the
   session is marked `demoted` for good. A stall further apart than that
   window is a fresh episode and gets its own restart. **The replacement
   pipeline's video and audio segment counters continue from the old
   pipeline's own FINAL index, plus one** (`PipelineConfig.
   StartVideoSegmentIndex`/`StartAudioSegmentIndex`,
   `session.Session.SetStartSegmentIndex`) — never reset to 0 — so its R2
   object keys (`internal/r2.ObjectPrefix`) never collide with (and
   silently overwrite) whatever the stalled predecessor already uploaded.
   "Plus one" specifically because the OLD pipeline's own teardown
   independently finalizes and uploads whatever segment was still open on
   it (`session.Session.Finish`/`Close`); reserving that exact index for
   the replacement is what makes the two pipelines' key ranges disjoint.
   Reading that final index requires the old pipeline to actually BE
   final first — closing it before reading `Health()` (and before
   building the replacement) is what makes "plus one" a value nothing can
   invalidate out from under it, rather than a snapshot a rollover mid-
   factory-call can race. Pinned by
   `TestManagedSession_RestartNeverReusesR2Key` (an in-memory-S3-backed
   regression test) and
   `TestManagedSession_RestartNeverReusesR2Key_SealsDuringTeardown` (the
   same, but the old pipeline's own teardown seals one more segment on its
   way down).
1-bis. **A quiet source is not a stall, and never restarts or demotes.**
   Between step 0 and every rule below sits one question the watchdog used
   to not ask: *is the publisher still sending?* A Chrome **tab** share
   sends NO video frames at all while the page is not repainting — a
   paused film, a slide, a scoreboard between goals — and only a low-rate
   refresh in between. No frames means no access units, which means no
   part boundary (every one of those is decided by the arrival of the
   NEXT access unit, `internal/pipeline`), which means `lastPartAt` stops
   moving and looks exactly like a wedged muxer. On 2026-09-15 a
   production session resolved that ambiguity the wrong way twice —
   `restarting (part-stuck)` at 42s, `demoting (part-stuck-second-stall)`
   four minutes later — for a share that was working perfectly.
   `sourceIdle` (`watchdog.go`) reads the RTP stream itself: **both** no
   completed frame **and** no RTP packet for longer than `PART_STUCK_MS`
   is a quiet source → one `video-source-idle` log line per quiet
   episode and nothing else. Packets arriving with no
   frames coming out (loss, a wedged access unit), or frames coming out
   with no parts published (a real muxer bug), both fall through to the
   ladder unchanged — which is exactly why the rule needs both clocks and
   not one. Restarting would not help a quiet publisher anyway
   (reconnecting to the same room to receive the same silence is not a
   fix) and demoting would hand the audience a conventional ladder showing
   the same frozen picture off the same source.
   **The forgiveness is bounded, by `VIDEO_IDLE_MAX_MS` (default 2
   minutes, `0` for unbounded).** "No RTP at all" has a second cause that
   looks identical from this end and is *not* benign: our own receive path
   dying quietly — an ICE or DTLS failure that never surfaces as a
   track-ended event — which is precisely the case a restart fixes, since
   a restart builds a brand new subscriber connection. Past the bound the
   ordinary ladder runs, with its own reasons (`source-idle-too-long`,
   then `source-idle-too-long-second-stall`) so the log never claims a
   part stalled when nothing was arriving. That restart is self-correcting
   for the benign case too: a fresh subscription gets a keyframe from the
   SFU immediately, so a merely-quiet publisher resumes producing parts on
   the new pipeline instead of being demoted, while one that is really
   gone hits the new pipeline's own `FIRST_PART_TIMEOUT_MS` and demotes
   with `no-video`. Meanwhile the media side keeps the
   playlist alive rather than freezing it — see **Keep-alive: a static
   source still publishes** below.
1-ter. **The clocks restart when the source comes back, not when it went
   quiet.** #626 shipped rule 1-bis and half an hour later this watchdog
   demoted a party anyway — on the tick *after* the silence ended.
   Production, 2026-09-15: `video-source-idle` at 15:23:05
   (`lastFrame=3.006s`), and at 15:23:07 `demoting
   (part-stuck-second-stall)` with `lastFrame=45ms lastIdr=84ms
   lastPart=4.448s`. Frames were back, with a fresh keyframe, and the
   ladder ran on a `lastPart` age accumulated **entirely inside the
   silence it had just forgiven**. A part boundary needs the arrival of
   the NEXT access unit, so "frames present, no part yet" is the normal
   state for one frame interval after every quiet episode — 700 ms at the
   1.4 frames/s a static tab produces. `watchdogState.idleEndedAt` records
   when the source came back, and both the part-stuck clock and the IDR-gap
   clock are measured from the later of that and their own last event. It
   is a restart of the clock, not an exemption: a source that is genuinely
   sending and genuinely publishing nothing still reaches the ladder
   `PART_STUCK_MS` after the silence ended. **A decoded frame is what ends
   the episode, never a packet** — RTP back with nothing coming out of the
   depacketizer is exactly the "packets but no frames" case above, and it
   keeps being judged on its own clocks.
2. **The IDR-gap ladder takes precedence and skips the restart entirely.**
   No IDR for more than 2× the segment target → log once per gap (rate
   limited; resets the moment a real IDR arrives). Past 3× with still no
   IDR → demote immediately, no restart attempt at all: restarting the SAME
   subscription to the SAME room does nothing for a publisher that has
   simply stopped sending keyframes, and a segment can never close on a
   non-IDR boundary (plan §5, "never close a segment on a non-IDR
   boundary").
3. **Audio-dead propagation.** `session.Session.Health().AudioDead` (`L1.3`'s
   own one-restart-then-give-up ladder for the AAC encoder subprocess) is
   surfaced on `GET /sessions`'s `audioHealth.dead` — never a reason to
   demote the video rung, matching `internal/session`'s own "video
   passthrough is unaffected" rule throughout.

**Demoted is terminal and reported, not silently dropped**: a demoted
session's pipeline is closed (no more LiveKit subscription, no more CPU),
but it stays on `GET /sessions` with `demoted: true` and a `demotedReason`
until an explicit `DELETE` removes it — so `pqp-api` can notice on its next
poll and flip the party to the conventional ladder, incrementing
`liveHls.llDemoted` on its side (that counter and the poll loop that would
read this response are `L1.5`'s own file, `server/src/voice/hls-remux.ts`,
tracked on a separate branch — see "Not yet" below). Every restart and
every demotion is logged with its `reason` (`pqp-remux: control: session
<id>: restarting (part-stuck)` / `demoting (idr-gap-exceeded)` and so on),
pitfall 15's rule in the root `CLAUDE.md`: a state change with no reason in
the log is exactly what cost an afternoon there.

**Every verdict now carries its numbers.** `restarting (part-stuck)` on
its own cannot tell "the publisher stopped sending" from "the publisher is
sending and nothing comes out" from "frames come out and nothing is
published" — three different bugs with three different fixes, and the
2026-09-15 log contained no other information at all. `stallDetail`
(`watchdog.go`) appends every clock and counter to each restart, demote
and warning line:

```
pqp-remux: control: session <id>: restarting (part-stuck): lastPart=3.2s
  lastFrame=3.3s lastPkt=20ms lastIdr=4s parts=412 keepalive=2
  audioParts=610 segIdx=9 pkts=98000 frames=1203 idrs=11 drops=4100
  pli=8 unanswered=2 r2 ok=120 fail=0 drop=0 queued=0 inflight=0
  lastMs=87 maxMs=940 openSeg=3200ms audioDead=false audioRestarts=0
```

`never` is a real answer and a load-bearing one: `lastFrame=never` (nothing
was ever depacketized) and `lastFrame=12.4s` (it worked and then stopped)
are different incidents.

**A killed API never reaps a healthy session**: `pqp-remuxd` has no idea
whether anything is polling `GET /sessions` at all, so a session simply
keeps running (and, if it stalls, keeps working through the exact same
ladder above) regardless of whether `pqp-api` is up, down, or mid-restart.
Adoption across an API restart is `pqp-api`'s own job on reconnect (list,
match against its `hls_sessions` rows) — this box has nothing to do
differently either way.

### Access control

Nothing under `GET /s/:id/*` authenticates a *viewer* — the signing above
authenticates `pqp-api`'s own control calls, not a browser's playlist/part
requests. A real per-viewer access control layer in front of the media
routes is `L2.x`'s job (the edge Worker and its own token check), not this
package's.

What DOES gate `/s/:id/*` today is two independent things, and Farol's
review of the first version of this task (PR #584) found the first one was
missing entirely:

- **`MEDIA_ORIGIN_KEY`** (`X-Pqp-Origin-Key` header, `server.go`'s
  `withOriginKey`, constant-time compared via `crypto/subtle`): the seam
  L2.3's edge Worker is meant to use, a static shared value the Worker
  attaches when proxying — the same shape a CDN-to-origin auth header
  takes, and distinct from `/sessions`' own per-request HMAC (a viewer's
  player still never sees or produces either credential). Checked before
  the registry is ever consulted: an unknown session id with no key is
  refused the same way a known one is, never leaking which is true to an
  unauthenticated caller.
- **`CONTROL_LISTEN`'s loopback-by-default binding.** With no
  `MEDIA_ORIGIN_KEY` set, this is the ONLY thing protecting the media
  routes, which is why `LoadGlobalConfig` **refuses to start** if
  `CONTROL_LISTEN` is bound beyond loopback (`internal/control.
  isLoopbackAddr`: `localhost` or a literal loopback IP, nothing else)
  with no `MEDIA_ORIGIN_KEY` — a box configured to listen on a routable
  address with nothing here would disclose a live presenter's media to
  anyone who can reach the port. The default (`127.0.0.1:8090`) needs no
  key, and setting one is optional, but the fix is that the two can no
  longer silently combine into an open box.

### Env (control-plane specific)

In addition to `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`,
`LIVE_HLS_S3_*`, `AAC_BITRATE_KBPS`, `FFMPEG_PATH` and
`R2_UPLOAD_QUEUE_DEPTH` / `R2_UPLOAD_MAX_RETRIES` (read exactly as
documented in Config above — `pqp-remuxd` shares those names with
`pqp-remux` on purpose, so one box's env covers both binaries) —
`internal/control.LoadGlobalConfig`:

| Var | Default | Meaning |
|---|---|---|
| `CONTROL_LISTEN` | `127.0.0.1:8090` | HTTP address for both the signed `/sessions` routes and the `/s/:id/*` media routes. **Loopback by default on purpose** — see "Access control" above. Refused at startup if bound beyond loopback with no `MEDIA_ORIGIN_KEY`. |
| `REMUX_CONTROL_SECRET` | — (required) | The shared HMAC secret. `pqp-remuxd` refuses to start without it — an unsigned control API on a box that can disclose a live presenter's media is not a mode this binary offers. Matches `pqp-api`'s `LIVE_HLS_REMUX_CONTROL_SECRET`. |
| `MEDIA_ORIGIN_KEY` | — (optional; required with a non-loopback `CONTROL_LISTEN`) | Gates `/s/:id/*` via the `X-Pqp-Origin-Key` header — see "Access control" above. Empty (the default, loopback-only posture) leaves those routes unauthenticated. |
| `FIRST_PART_TIMEOUT_MS` | `60000` (60s) | No part has EVER arrived for this long → demote, reason `no-video`. Governs the "waiting for a presenter" phase, deliberately separate from and much longer than `PART_STUCK_MS` — see "Watchdog" above. |
| `PART_STUCK_MS` | `3000` | Once at least one part has arrived: no NEW part for this long → restart the session's pipeline once. `docs/plans/LL_HLS.md` §5's own number ("six parts"). **Sized against the reorder buffer since 2026-09-17**: the effective threshold is this value or twice `PART_MS + REORDER_HOLD_MS + 100ms`, whichever is larger, because a part boundary needs the NEXT access unit and the reorder buffer can delay that. At the defaults the derived floor is 1800ms, so this value still wins and nothing changes; lowering this or raising `REORDER_HOLD_MS` can no longer produce a watchdog that restarts healthy sessions. See `internal/control.WatchdogConfig.partStuckThreshold`. |
| `REORDER_HOLD_MS` | `300` | How long a video RTP packet waits for the one in front of it before the gap is handed to the depacketizer. Roughly one publisher-to-SFU round trip, which is when a NACKed retransmission lands. **`0` turns holding off entirely**: every gap goes straight through, the behaviour before the buffer existed, and the rollback if the hold ever costs more than it buys. Bounded at 1000; past that it is a jitter buffer wearing this knob's name. The buffer can add at most `REORDER_HOLD_MS` plus one 100ms monitor tick to the pipeline (`internal/session`'s `reorderDelayBound`), and `PART_STUCK_MS` is sized against exactly that sum (see `internal/control`'s `partStuckThreshold`). Read by BOTH binaries: `pqp-remuxd` loads its own copy, because production runs that one |
| `PART_DEADLINE_GRACE_MS` | `150` | With `CLOCK_CUT_PARTS` on: how long past the wall instant a part's end maps to the monitor waits for a frame before cutting that part with repeat frames anyway. Parts are then published on the beat whatever the source does, instead of on the next frame (up to a second late on a quiet tab). Never fills past a frame whose first packet has arrived, and never while the reorder buffer is holding packets. Bounded 0..10000. **A value at or above the idle allowance (1000 at the default `PART_MS`) is the exact pre-deadline timing, and the rollback.** Inert with `CLOCK_CUT_PARTS` off. Read by BOTH binaries. See "The part deadline" below |
| `VIDEO_IDLE_MAX_MS` | `120000` (2 min) | How long a source sending NO RTP at all is forgiven before the restart-then-demote ladder is allowed to run on it anyway; `0` forgives forever. Exists because "no RTP" has two causes that look identical from this end — a publisher genuinely sending nothing (a static tab share, benign) and our own receive path having died quietly with no track-ended event (recoverable, and only by a restart). Far longer than any tab-capture refresh gap, short enough to recover a dead receiver while a party is still worth saving. See "Watchdog and the demotion contract", step 1-bis. **`0` is the only supported way to say "never"** — a large number is not, and one past 24 hours is refused at startup along with the three timers above it: these are millisecond values, and a count typed in the wrong unit wraps `time.Duration` into a tiny or negative bound, which restarts a quiet source on the first quiet tick instead of forgiving it (Farol review, PR #626). `evaluateWatchdog`'s own `msDuration` saturates as well, so neither a validated nor a hand-built `WatchdogConfig` can wrap. |
| `DEMOTE_WINDOW_MS` | `300000` (5 min) | A second stall within this long of the last restart demotes instead of restarting again; further apart, it's a fresh episode. Sized after the conventional path's own "3 restarts per 5 min then a 5 min cooldown" family (`CLAUDE.md` pitfall 15) — there is no measured number for this specific ladder in the plan text, so this is `L1.6`'s own considered default, not a specified one. |

`RUNG` is **not** read here: every session this binary ever runs is the
low-latency rendition, `rung = "ll"`, fixed in code
(`internal/control/remux_pipeline.go`) — unlike `pqp-remux`'s own `RUNG`
env var, which exists as an override for a test or a future topology, this
binary has no other rung to produce.

### Shutdown

`cmd/pqp-remuxd/main.go`: on `SIGINT`/`SIGTERM`, `http.Server.Shutdown` is
given `shutdownTimeout` (10s) to let in-flight requests finish on their
own; if that deadline passes first (Farol review, PR #584), `Shutdown`'s
own error is logged and `http.Server.Close` is called to forcibly abort
whatever is still holding a connection open (a stuck or unusually slow
media response) — a shutdown must complete on its own bound regardless of
what a client is doing, and a request must never be left racing
`registry.StopAll()`, which runs only after the HTTP server has
genuinely stopped serving. `registry.StopAll` then tears down every live
session (unsubscribe from LiveKit, stop encoders, flush R2 queues) so a
killed supervisor never leaks a subprocess or an open subscription.

## Try it against staging

```
source ~/.config/pqp/staging-sfu-livekit.env
source ~/.config/pqp/staging-sfu-instance.env  # for the URL
ROOM=<a real staging room name> LIVEKIT_URL="$LIVEKIT_URL" \
  LIVEKIT_API_KEY="$LIVEKIT_API_KEY" LIVEKIT_API_SECRET="$LIVEKIT_API_SECRET" \
  go run ./cmd/pqp-remux
```

Then, with a watch party actually running in that room:

```
curl http://localhost:8089/healthz
curl http://localhost:8089/playlist.m3u8
ffprobe http://localhost:8089/init.mp4   # or feed init.mp4 + a seg-N.m4s to ffprobe as one input

# Audio, once at least one stage source (screen-share audio or a mic) has
# spoken:
curl http://localhost:8089/audio-playlist.m3u8
ffprobe http://localhost:8089/audio-init.mp4
```

Never point this at `sfu.pqp.gg` (production). A live smoke test is
optional — `make test` is what CI and the acceptance bar for this PR run.

## Deploying `pqp-remuxd`

By hand, and only while no LL session is live: a restart kills every session
on the box and its viewers see 502/404 until the API demotes them.

```
cd tools/pqp-remux
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o out/pqp-remuxd ./cmd/pqp-remuxd
# on the egress box: confirm nothing is live (0 means idle)
journalctl -u pqp-remux --since "2 min ago" | grep -c "stats session"
# copy out/pqp-remuxd over, keep the old binary, swap, restart
cp /usr/local/bin/pqp-remuxd /usr/local/bin/pqp-remuxd.prev
install -m 0755 /tmp/pqp-remuxd /usr/local/bin/pqp-remuxd
systemctl restart pqp-remux.service
```

Rollback is the same swap with `pqp-remuxd.prev`. The API side of a contract
change is always written to be deployable first (an older box ignores a
field it does not know).

## Testing

```
make vet
make test      # go test ./... -race -count=1
make fmtcheck
```

Everything is exercised with synthetic input — hand-built RTP packets, a
bit-level SPS/PPS encoder in the test files themselves (so fixtures are
derived from named field values, never hand-typed magic bytes), and
synthetic access units feeding the fragmenter directly. No LiveKit
connection, no real capture, is needed to run the suite. `L1.3`/`L1.4`'s own
tests additionally exercise **real** subprocesses and a real bucket where
that is the only way to actually verify the thing (a hand-rolled SigV4
signer, an ADTS parser, an AAC-LC `esds`): ffmpeg (both to generate Opus test
tone fixtures and, in `internal/aacenc`, to encode), and an opt-in local
MinIO container for `internal/r2`. Those tests skip cleanly (never fail) when
ffmpeg or `R2_TEST_MINIO_*` aren't available, matching this repo's
`TEST_DATABASE_URL`/`E2E_DATABASE_URL` convention of opt-in-against-real-
infrastructure rather than assumed-present. Notably:

- `internal/h264`: RTP → access-unit reassembly (single NAL, STAP-A, FU-A),
  timestamp unwrap across a 32-bit wraparound, a missing marker packet
  closing the access unit on the timestamp change and DELIVERING it rather
  than merging it into the next one (and, when that access unit ends
  mid-NAL, discarding it instead and asking for a keyframe), and an access
  unit bounded at `maxAccessUnitBytes` rather than growing forever when no
  boundary ever arrives.
- `internal/nal`: the Exp-Golomb SPS parser, round-tripped against a
  bit-writer built in the test file, for both baseline and a High-profile
  stream with an all-identity scaling matrix; `unescapeRBSP` directly,
  including consecutive emulation-prevention sequences and a genuine
  `0x03` immediately following a stripped one.
- `internal/cmaf`: box-level structural assertions — `ftyp`/`moov` shape,
  `avcC` bytes matching the input SPS/PPS byte for byte (chroma format and
  bit depth included, for a 4:2:2/10-bit stream, not just the 4:2:0/8-bit
  default), `trun` `sample_flags` per sample, `mfhd` sequence numbers and
  `tfdt` base decode times increasing monotonically across fragments,
  `mdat` matching the concatenated sample data byte for byte.
- `internal/pipeline`: the part/segment boundary policy itself — parts cut
  at the target duration, a segment does **not** close on a non-IDR frame
  even past its target (elastic "Branch A"), and does close on the next
  real IDR, with the resulting fragment's first sample verified sync at the
  box level.
- `internal/keyframe`: the gate/pace state machine against a fake clock, the
  500ms SFU-throttle floor, the natural-policy no-op path, and concurrent
  `OnIDR`/tick calls under `-race`.
- `internal/session`: a trailing partial fragment is flushed and published
  when the track ends, and nothing is ever published before a valid init
  segment exists; `TestSessionAudioPipelineEndToEnd` runs screen-share audio
  through a real Opus decode, mix, real `ffmpeg` AAC encode, CMAF muxing and
  an in-memory R2 fake end to end, and asserts the video counters stay at
  zero throughout (audio never touches the video path); `framesElapsed`'s
  own tests simulate 30 minutes of pacer ticks and assert the emitted frame
  count never diverges from wall-clock-implied elapsed time by more than one
  frame — the property the plan's 40ms/30-minute sync bar rests on at the
  pacing layer. A fake `remuxEncoder` (no real `ffmpeg`, `newEncoderFunc` as
  the seam) proves the recovery ladder end to end: a `WriteSamples` failure
  restarts the encoder exactly once and recovers if the replacement is
  healthy, or marks `AudioDead` (with `AudioRestarts == 1`, never more) if
  it isn't; `readEncoderFrames`'s own shutdown edges are pinned directly —
  `Frames()` closing while `Errs()` stays open and empty exits cleanly, and
  `Errs()` closing first never drops or stalls delivery of frames still
  arriving on `Frames()`. `TestSession_R2UploadHappensOnlyAfterSegmentSeals`
  checks, from inside a recording uploader with a live reference to the
  ring, that every segment upload happens only once the ring's own
  `Playlist()` already lists it sealed, and that no rollover segment is
  ever uploaded twice.
- `internal/audiomix`: a real Opus fixture (`testdata/tone.opus`, generated
  by `ffmpeg -c:a libopus`, committed under 25KB) decoded and placed on the
  timeline at the expected anchor, silence before/after a source's write
  head, two sources summed and soft-clipped staying in range, and a removed
  source never replaying stale audio once it would otherwise have looped
  back around the ring.
- `internal/aacenc`: an ADTS parser cross-checked against both hand-built
  fixtures and a byte sequence a real `ffmpeg -f adts` run produced, plus a
  real-subprocess round trip (a synthesized sine tone in, real AAC frames
  out, clean `Close`).
- `internal/cmaf`: box-level structural assertions — `ftyp`/`moov` shape,
  `avcC` bytes matching the input SPS/PPS byte for byte (chroma format and
  bit depth included, for a 4:2:2/10-bit stream, not just the 4:2:0/8-bit
  default), `trun` `sample_flags` per sample, `mfhd` sequence numbers and
  `tfdt` base decode times increasing monotonically across fragments,
  `mdat` matching the concatenated sample data byte for byte; the audio
  init segment's `esds`/`AudioSpecificConfig` bytes checked against values
  independently computed from ISO/IEC 14496-3 Table 1.6.3, **and** the whole
  segment round-tripped through a real `ffprobe` as an independent parser.
- `internal/pipeline`: the video part/segment boundary policy — parts cut
  at the target duration, a segment does **not** close on a non-IDR frame
  even past its target (elastic "Branch A"), and does close on the next
  real IDR, with the resulting fragment's first sample verified sync at the
  box level; the audio fragmenter's on-schedule (no IDR-wait) segment cuts
  and monotonic sequence numbers. With a repeater set (`CLOCK_CUT_PARTS`):
  no part longer than the target and no non-terminal part under 85% of it
  through a two-second stall and through a five-second freeze published by
  the keep-alive, each part starting exactly where the previous one ended,
  the timeline still tracking the wall clock at 0.2, 1.4 and 30 fps, the
  resume after a freeze never rewinding, and a stream the synthesizer
  refuses falling back to the long, honest part it always produced.
- The part deadline: `internal/pipeline`'s `DeadlineCut` tests (inert
  without a repeater, one exact-target part per passed boundary, never past
  a frame already arriving, a frame later than every bound shifting the
  timeline rather than rewinding it, never closing a segment);
  `internal/session`'s deadline tests replaying an idle-then-bursty source
  against the production monitor cadence, asserting every part is published
  within grace plus a tick (and that the rollback grace reproduces the
  second-late parts), every part within `PART-TARGET` and the 85% floor, a
  timeline with no hole and `ptsShiftMs` zero, and the two cases it must
  decline (an access unit mid-reassembly, a reorder buffer holding);
  `internal/h264`'s `OpenAccessUnitPTS` across FU-A fragments and a damaged
  AU.
- `internal/skipframe`: the synthesized repeat frame, read back field by
  field (`first_mb_in_slice`, `slice_type`, `frame_num`, the marking and
  reference-list flags, `mb_skip_run` covering every macroblock), the
  `frame_num` renumbering of real slices around inserted frames including
  a wrap at `MaxFrameNum`, every refusal in `New` provoked on its own, and
  the two ways synthesis stops itself mid-session (the publisher's
  parameter sets changing, a slice carrying reference marking commands).
  **And the check no unit test can make**: a real capture and an
  ffmpeg-encoded stream both decoded with `-err_detect explode` after
  repeat frames are inserted into them, asserting zero decoder
  diagnostics, every inserted frame's `framemd5` identical to the frame
  before it, and every real frame's `framemd5` unchanged by the
  insertion. It skips when ffmpeg is not on `PATH`.
- `internal/r2`: the upload queue/retry/counter state machine against an
  in-memory fake (success, transient-then-succeeds, gives-up-after-max-
  retries, a full queue drops rather than blocks, concurrent `Enqueue`
  under `-race`), and — opt-in, see above — the real SigV4 signer against a
  real MinIO container, including a deliberately wrong secret being
  rejected.
- `internal/keyframe`: the gate/pace state machine against a fake clock, the
  500ms SFU-throttle floor, the natural-policy no-op path, and concurrent
  `OnIDR`/tick calls under `-race`.
- `internal/config`: `PART_MS`/`SEGMENT_MS` convert to 90kHz ticks without
  overflowing for any value `Validate` accepts; the new audio/R2 fields'
  defaults, overrides and validation.
- `internal/ring`, `internal/serve`: eviction, sealed-vs-open segments, the
  playlist body, and every HTTP route including the 404/503 edges, on both
  the video ring and (once `SetAudioRing` is called) the audio ring.
- `internal/control` (`L1.6`): signature accept/reject — a valid signature,
  a lowercase method, a wrong secret, a timestamp on either side of the 60s
  skew window (including the edge case exactly at the boundary), a replayed
  body under an otherwise-valid signature, missing headers, malformed hex;
  `evaluateWatchdog` (pure, a fake clock, no goroutine) — a healthy tick is
  a no-op, a first stall restarts, a second stall inside `DEMOTE_WINDOW_MS`
  demotes, a stall long after the window restarts again as a fresh episode,
  the IDR-gap warning logs once per gap and resets on a real IDR, an
  exceeded IDR gap demotes outright with **no** restart attempt even while
  parts are still flowing fine (precedence over the part-stuck ladder), and
  both references fall back to the pipeline's own start time when nothing
  has ever arrived at all; a full integration test drives the REAL watchdog
  goroutine against a fake `Pipeline` end to end (restart, then demote,
  within a handful of real ticks, and a demoted session staying demoted
  with nothing further disturbing it); `Registry` — idempotent `StartOrGet`
  (a retried start builds no second pipeline), a failed factory registers
  nothing and a later retry is unblocked, idempotent `Stop` (including on
  an id that never existed), N concurrently-started sessions are fully
  isolated from each other (stopping one never touches another's `Get`),
  and a genuinely concurrent pair of identical-sessionId starts still
  builds exactly one pipeline; `Server`'s HTTP handlers — unsigned/
  wrongly-signed control requests are 401 before touching the registry, an
  invalid `StartSessionRequest` body is 400, `POST /sessions` is 201 then
  409 on a retry, `DELETE` is 204 whether or not the session existed, the
  unsigned `/s/:id/*` media routes proxy to the right session and count
  `bytesServed`, an unknown session id is 404 and a demoted one is 503, and
  `GET /sessions`'s response is checked field-by-field against
  `remuxSessionInfoSchema`'s own ten names (transcribed directly from
  `hls-remux-control.ts`, since that file has no literal JSON example to
  copy) with the nullable fields round-tripped through a Go mirror of the
  TS-inferred type to prove they are JSON `null`, not zero, before anything
  has happened yet.
- `internal/control`, Farol's second round (PR #584): the nonce is checked
  end to end at the `Server` level — a fresh nonce succeeds, the identical
  nonce replayed is rejected even though its own signature is independently
  valid, and a different nonce is unaffected by another's use
  (`TestServer_RejectsReplayedNonce`) — plus `verifySignature` on its own
  rejecting a missing or oversized nonce; `MEDIA_ORIGIN_KEY` gating —
  missing, wrong, and correct header values, and that an unknown session id
  is refused on the header alone before the registry is ever consulted
  (`TestServer_MediaRoute_RequiresOriginKeyWhenConfigured`), with the
  no-key-configured posture pinned unchanged
  (`TestServer_MediaRoute_NoOriginKeyConfiguredStaysOpen`);
  `LoadGlobalConfig` refusing a non-loopback `CONTROL_LISTEN` with no
  `MEDIA_ORIGIN_KEY` (and accepting it once one is set), a loopback
  `CONTROL_LISTEN` in several spellings never requiring one, and
  `isLoopbackAddr` itself table-tested; `evaluateWatchdog`'s waiting-vs-
  stalled split — no part yet is a no-op well past `PART_STUCK_MS` but
  within `FIRST_PART_TIMEOUT_MS`, and demotes with reason `no-video` once
  that timeout passes with nothing at all; a defensive-fallback case for
  the (impossible in practice, per `internal/pipeline.Fragmenter`'s own
  invariant) combination of a part with no recorded IDR; and
  `TestManagedSession_RestartNeverReusesR2Key`, a full
  `session.Session` + `r2.Writer`-backed regression test (a real
  in-memory-S3 fake, built with no LiveKit connection at all via a
  test-only `Pipeline` wrapping a real `Session`) proving a watchdog
  restart's replacement pipeline never re-uploads a segment key its
  predecessor already used. `internal/pipeline` and `internal/session`
  each gained their own direct unit test for `SetStartSegmentIndex`
  (`TestFragmenter_SetStartSegmentIndexAppliesToFirstSegment`,
  `TestAudioFragmenterSetStartSegmentIndexAppliesToFirstSegment`,
  `TestSession_SetStartSegmentIndex`) below the integration level.

CI: `.github/workflows/pqp-remux.yml`, its own workflow (not a job inside
the root `ci.yml`, since that workflow's trigger filter applies to all its
jobs at once) filtered to `tools/pqp-remux/**`, running `make vet`, `make
test` and `make fmtcheck` on `go.mod`'s pinned Go version, with an explicit
`apt-get install ffmpeg` step ahead of them (see "Codec choices" above for
why ffmpeg is a real, not incidental, dependency of this module now).

## Not yet

- **`pqp-api` actually driving this (`L1.5`)**: this PR's own scope is
  `tools/pqp-remux/` only (see the PR description), so the TS/API side of
  the control plane — `server/src/voice/hls-remux.ts`, the `hls_sessions`
  row, the `LIVE_HLS_LL` flag, `llDemoted`/`llHlsActivity()` — lives on a
  separate branch (PR #580, `L1.5`) and is not part of this diff. What
  `L1.6` adds here (the `pqp-remuxd` binary, `internal/control`'s HTTP
  contract, session management and watchdog — see "Control API" above) is
  the Go side that branch's own doc comments describe calling; the two are
  written to the same wire contract (`hls-remux-control.ts`) but are not
  wired together by this PR. `pqp-api`'s own periodic polling of
  `GET /sessions` to notice a `demoted: true` session and flip the party to
  conventional — the other half of "report it on GET /sessions so the API
  flips the party" — is that branch's job too, not this one's: today
  nothing calls `GET /sessions` except an operator or a test. **The nonce
  requirement above (Farol's second review) makes this coordination
  mandatory, not optional**: #580's own `hls-remux.ts` signs requests with
  the ORIGINAL four-part payload (no nonce), so as written it cannot
  successfully call this binary's `/sessions` routes at all until it adds
  `X-Pqp-Remux-Nonce` in the position `signaturePayload` now defines. A
  follow-up comment naming this is on #580; until it lands, the two
  branches must not be merged and pointed at each other.
  `cmd/pqp-remux`'s single-session mode is unaffected either way; it is
  still started and stopped by hand (or a load-testing harness), never by
  `pqp-api`, and `CHANNEL_ID` / `STARTED_AT_MS` / `RUNG` (see Config) are
  still its own env-driven stand-in for what a control-plane-managed
  session's `PipelineConfig` now carries instead.
- **Watchdog, single-session binary**: `cmd/pqp-remux`'s own `/healthz`
  (unchanged by this task) reports raw counters
  (`subscribed`, `partsWritten`, `bytesWritten`, `lastPartAtMs`,
  `lastIdrAtMs`, and now `audioPartsWritten`, `audioBytesWritten`,
  `audioDead`, `audioRestarts`, `r2Uploaded`, `r2Failed`, `r2Dropped`) but
  nothing external consumes them yet — no `PART_STUCK_MS` stall detector, no
  restart-then-demote ladder, no `voice.hlsLlDemoted`. `bytesWritten`/
  `audioBytesWritten` count bytes written into the ring, not bytes an HTTP
  client has actually read; naming them that way (rather than
  `bytesServed`) is deliberate, not a placeholder. One piece of `L1.6`'s own
  job is already done for the audio subprocess specifically, scoped tightly
  to what this task's own failure mode needs: a `WriteSamples` failure
  (`internal/session.recoverAudioEncoder`) closes the broken `ffmpeg`,
  waits for its reader goroutine to fully drain (so a restarted encoder's
  reader can never race the old one writing into the same
  `AudioFragmenter`), and starts exactly **one** replacement subprocess
  before giving up; giving up sets `audioDead` rather than leaving a broken
  pipe reporting as healthy — the pitfall-15 shape (see `CLAUDE.md`) applied
  to this task's own subprocess. Video passthrough is never affected either
  way. `Session.Close` and a restart in flight are mutually exclusive
  (`audioMu`, held across `recoverAudioEncoder`'s entire body): shutdown
  either fully precedes a restart attempt (which then sees the session is
  already closed and refuses to spawn a replacement at all) or blocks until
  an already-in-flight restart finishes and closes *that* encoder, so a
  replacement `ffmpeg` can never outlive the session it was replacing an
  encoder for. The recovery ladder also runs for an **unexpected** exit
  (a crash, a kill, ffmpeg quitting on its own), not only a `WriteSamples`
  failure: `aacenc.Encoder`'s own reader distinguishes "this shutdown was
  intentional" from everything else and reports the latter on `Errs()`,
  which `readEncoderFrames` turns into the same `recoverAudioEncoder` call
  a write failure triggers — an unrequested ffmpeg exit used to close
  `Frames()` silently and look exactly like a clean, successful end of the
  audio track. "Intentional" covers **two** paths: an explicit `Close()`
  call (sets `intentionalClose`), and — since `internal/session`'s own
  shutdown cancels `ctx` *before* calling `Close()` (see `Session.Close`'s
  doc comment) — `ctx` being cancelled, checked directly (`ctx.Err() !=
  nil`) rather than via a second flag set by a separately racing
  goroutine: `context.CancelFunc` closes `ctx`'s `Done` channel
  synchronously, strictly before `exec.CommandContext`'s own asynchronous
  kill-the-process machinery ever runs, so any code path that could
  observe "the process died because ctx was cancelled" already has
  `ctx.Err() != nil` by construction, not by timing luck. (An earlier
  version of this fix used a watcher goroutine racing to set a flag
  instead, which Farol correctly flagged as still leaving a window —
  checking `ctx` directly has none.) Missing intentional-ctx-cancellation
  handling at all was the original finding: without it, an ordinary
  session shutdown could observe its own ctx-triggered kill as an
  "unexpected exit" and misfire a restart mid-teardown. `Encoder.Close`
  is deadlock-free regardless of whether anything is still reading
  `Frames()` — its frame-delivery loop only ever blocks up to a bounded
  stall timeout (2s) waiting for channel room, not on `Close` having been
  called, which matters because `Close` routinely runs *while* a
  legitimate consumer is still draining the encoder's final output
  (`Session.Close`'s own segment flush): tying the bailout to `Close`
  itself, an earlier version of this fix, risked dropping exactly those
  final frames. When the stall timeout *does* fire (a consumer that has
  genuinely stopped, not merely fallen behind), the reader also kills the
  ffmpeg process before returning — without that, `cmd.Wait()` right
  after has nothing to wake it up if `Close` was never called either
  (exactly the "consumer stopped, nothing else happened" case), and every
  later `Close` waiting on the same signal would hang forever too; a
  second Farol finding on the first version of this fix. `Close` always
  waits for the process's own exit and its ADTS reader to fully finish
  before returning, so no two generations' readers can ever race each
  other into the CMAF muxer.
- **The session ending closes the audio track's last segment too**:
  before this, only a mid-session roll-over ever called
  `uploadAudioSegment` — audio shorter than one `SEGMENT_MS` target (or
  simply the tail after the last full segment) never triggered a "next
  segment" fragment and so never got a final upload at all.
  `Session.Close` now uploads whatever segment is still open once the
  encoder has been drained (bounded by `audioCloseFlushDeadline`, 5s, for
  the same "shutdown must complete" reason `r2.Writer.Close` is bounded),
  the audio-side counterpart to `Finish`'s existing video handling.
- **A/V sync is not independently measured over a real 30-minute session**:
  `internal/session`'s `framesElapsed` tests prove the pacing layer itself
  cannot drift, and "Codec choices" above documents every known,
  non-accumulating offset (the epoch approximation, the AAC encoder's
  priming delay) with an estimate for each, but nothing in this PR runs a
  real 30-minute party and measures the two tracks' actual presentation
  timestamps against each other end to end — that needs a live room, which
  a sandboxed PR could not reach. `L1.5`/staging is the natural place for
  that measurement.
- **Presenter authorization for video** (unchanged from `L1.1`/`L1.2`):
  `internal/subscriber` binds to the first track it sees with `Source ==
  SCREEN_SHARE` and ignores every screen share after that (logged, not
  silently dropped) — it does not check the publishing participant's
  identity. This matches how the conventional Track Composite egress already
  works (`pickHlsSharer` in `hls-egress.ts`: sharing state, not a
  server-held identity, is the authorization signal throughout pqp's
  screen-share code), so it is a deliberate consistency choice, not an
  oversight. **Microphones are different on purpose**: any participant's
  `Source == MICROPHONE` track is mixed in, with no single-presenter
  restriction, because LiveKit's own `SPEAK` grant (not this process) is
  what already decided who may publish one. A designated-presenter concept
  for the screen share, if one is ever needed, belongs in `L1.5`'s API
  control plane, which is what would tell this process which room and which
  participant to expect in the first place.
- **LL playlist tags / blocking reload (`L2.x`)**: `GET /playlist.m3u8` is a
  conventional media playlist listing sealed segments. There is no
  `EXT-X-SERVER-CONTROL`, `EXT-X-PART`, `EXT-X-PRELOAD-HINT`, and no
  blocking-reload support; that is entirely the edge Worker's job in `L2.1`
  and `L2.2`. What this box now provides is the *input* to that rendering,
  `GET /s/:id/state.json` (see "Control API" above) — structured state, not
  playlist text, and still no `_HLS_msn`/`_HLS_part` hold of its own.
- **Production serving surface**: `internal/serve` (the single-session
  binary's own `LISTEN`) is still explicitly a local test surface, unchanged
  by this task. `pqp-remuxd`'s `/s/:id/*` (see "Control API" above) is
  closer to the production shape in ONE sense — one process serving every
  live session's parts and playlists behind one listener — but it is still
  serving straight out of each session's in-memory ring over plain HTTP,
  not tmpfs files behind Caddy the way the plan's §1 architecture diagram
  draws it. Whether `pqp-remuxd` ends up sitting behind Caddy as-is, or
  parts move to tmpfs for Caddy to serve directly, is `L2.x`'s call once the
  edge Worker's own proxying needs are concrete.
- **A container image / compose entry for `pqp-remuxd`**: the plan's `L1.1`
  acceptance test mentions "a container beside the egress in
  `tools/sfu/hls/docker-compose.yaml`" for the single-session binary, and
  that was already out of scope there; the same is true here for
  `pqp-remuxd` — nothing under `tools/sfu/` is touched by this PR (kept out
  of scope on purpose, see the PR description).
