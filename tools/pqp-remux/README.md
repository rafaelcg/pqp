# pqp-remux

A headless, hidden LiveKit subscriber that turns a watch party presenter's
screen-share H.264 into CMAF (fragmented MP4) parts and segments for LL-HLS —
video passthrough, no decode or re-encode of a single frame — and mixes every
stage microphone plus the screen's own audio into one AAC-LC track alongside
it. This is `L1.1` through `L1.4` of
[`docs/plans/LL_HLS.md`](../../docs/plans/LL_HLS.md) on `main` — read that
file's "1. Architecture" and "3. Keyframes" sections first; this README does
not repeat the reasoning, only the interface.

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
| `PART_MS` | `500` | CMAF part target (plan §2/§6) |
| `SEGMENT_MS` | `4000` | CMAF segment target (plan §2/§6); segments close elastically on the first IDR at or after this, never before |
| `RING_SEGMENTS` | `6` | How many sealed segments (plus the live one) stay in memory |
| `KEYFRAME_POLICY` | `natural` | `natural` (never send a PLI) or `pli` (paced, gated requests). **`L0.2` has not chosen a branch yet** — this defaults to `natural` on purpose |
| `PLI_GATE_FACTOR` | `1.5` | In `pli` mode, wait this many × `SEGMENT_MS` with no IDR before asking for one |
| `PLI_PACE_MS` | `500` | Minimum spacing between repeated PLI requests while still waiting for an IDR. **Floored at 500ms** regardless of a lower value: `L0.1` found the SFU's own `rtc.pli_throttle` (Low tier) defaults to 500ms for a single-layer publish (our screen share always is), so asking faster only wastes RTCP, it does not get more keyframes |
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
  closes exactly on schedule. Sharing one `moof`/segment-boundary decision
  with video would import video's "wait for an IDR" rule into a track that
  has no such constraint, for no benefit.
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

**Shutdown order matters, and got it wrong once** (Farol caught it):
`cmd/pqp-remux/main.go`'s `runServer` registers the R2 writer's `Close`
*before* the session's, specifically so it executes *last* — defers run
last-registered-first, so registration order (`r2Writer`, `sess`, `cancel`,
`sub`) becomes execution order `sub.Close` → `cancel` → `sess.Close` →
`r2Writer.Close`. Getting this backwards (the writer closing before
`Session.Close` had a chance to flush and enqueue the final video and audio
segments) silently dropped a party's last few segments from R2 every time.

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
  timestamp unwrap across a 32-bit wraparound, a lost marker packet
  discarding the stale access unit rather than merging it into the next
  one, and an access unit bounded at `maxAccessUnitBytes` rather than
  growing forever when a marker never arrives.
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
  and monotonic sequence numbers.
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

CI: `.github/workflows/pqp-remux.yml`, its own workflow (not a job inside
the root `ci.yml`, since that workflow's trigger filter applies to all its
jobs at once) filtered to `tools/pqp-remux/**`, running `make vet`, `make
test` and `make fmtcheck` on `go.mod`'s pinned Go version, with an explicit
`apt-get install ffmpeg` step ahead of them (see "Codec choices" above for
why ffmpeg is a real, not incidental, dependency of this module now).

## Not yet

- **API control plane (`L1.5`)**: no `hls_sessions` row, no `LIVE_HLS_LL`
  flag, no start/stop/adopt lifecycle — this binary is started and stopped
  by hand (or by a load-testing harness), not by `pqp-api`. `CHANNEL_ID` /
  `STARTED_AT_MS` / `RUNG` (see Config) are this task's stand-in for what
  that row will eventually own, read from the environment rather than
  assigned by the API.
- **Watchdog (`L1.6`)**: `/healthz` reports raw counters
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
  audio track. "Intentional" covers **two** paths, both of which mark the
  same `intentionalClose` flag before anything downstream can observe the
  resulting exit: an explicit `Close()` call, and — since
  `internal/session`'s own shutdown cancels `ctx` *before* calling
  `Close()` (see `Session.Close`'s doc comment) — a dedicated goroutine
  that watches that same `ctx` and marks the flag the instant it's
  cancelled. Missing the second path was a real Farol finding: without it,
  an ordinary session shutdown could observe its own ctx-triggered kill as
  an "unexpected exit" and misfire a restart mid-teardown. `Encoder.Close`
  is deadlock-free regardless of whether anything is still reading
  `Frames()` — its frame-delivery loop only ever blocks up to a bounded
  stall timeout (2s) waiting for channel room, not on `Close` having been
  called, which matters because `Close` routinely runs *while* a
  legitimate consumer is still draining the encoder's final output
  (`Session.Close`'s own segment flush): tying the bailout to `Close`
  itself, an earlier version of this fix, risked dropping exactly those
  final frames. `Close` always waits for the process's own exit and its
  ADTS reader to fully finish before returning, so no two generations'
  readers can ever race each other into the CMAF muxer.
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
  and `L2.2`.
- **Production serving surface**: `internal/serve` is explicitly a local
  test surface (task description, item 4) — one process, everything on one
  `LISTEN` address including `/healthz`. The plan's production shape (parts
  from tmpfs behind Caddy, `/healthz` on loopback only, never proxied) is
  `L1.5`'s wiring, not this task's — `L1.4`'s own part is only the R2 writer
  (done, see above), which is independent of how parts themselves get to a
  viewer.
- **A container image / compose entry**: the plan's `L1.1` acceptance test
  mentions "a container beside the egress in
  `tools/sfu/hls/docker-compose.yaml`" — not added here, since this PR does
  not touch anything under `tools/sfu/` (kept out of scope on purpose, see
  the PR description).
