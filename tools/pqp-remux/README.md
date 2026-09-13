# pqp-remux

A headless, hidden LiveKit subscriber that turns a watch party presenter's
screen-share H.264 into CMAF (fragmented MP4) parts and segments for LL-HLS,
without decoding or re-encoding a single frame. This is `L1.1` and `L1.2` of
[`docs/plans/LL_HLS.md`](../../docs/plans/LL_HLS.md) on `main` — read that
file's "1. Architecture" and "3. Keyframes" sections first; this README does
not repeat the reasoning, only the interface.

## What it does today

1. Joins a LiveKit room as a **hidden** (`Hidden: true`), subscribe-only
   participant — it never publishes anything (`internal/subscriber`).
2. Finds the presenter's screen-share video track (`Source ==
   SCREEN_SHARE`) and, if present, its screen-share audio track.
3. Depayloads the H.264 RTP stream (single NAL, STAP-A, FU-A) into access
   units, in AVCC form, with SPS/PPS/IDR detection (`internal/h264`,
   `internal/nal`).
4. Boxes those access units into CMAF: one init segment (`ftyp`+`moov` with
   an `avcC` built from the SPS/PPS), then `moof`+`mdat` fragments cut at
   `PART_MS`, with segments closed elastically on the first IDR at or after
   `SEGMENT_MS` (`internal/cmaf`, `internal/pipeline`).
5. Keeps the last `RING_SEGMENTS` segments (and every part in them) in
   memory and serves them over plain HTTP for local testing
   (`internal/ring`, `internal/serve`).
6. Optionally paces RTCP PLIs to ask the publisher for a keyframe when one
   hasn't arrived in a while (`internal/keyframe`), gated per L0.1's
   findings (see below).
7. Doubles as the `L0.2` keyframe-cadence logger via `-idr-log`.

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
| `LISTEN` | `:8089` | HTTP address for the local test surface |
| `PART_MS` | `500` | CMAF part target (plan §2/§6) |
| `SEGMENT_MS` | `4000` | CMAF segment target (plan §2/§6); segments close elastically on the first IDR at or after this, never before |
| `RING_SEGMENTS` | `6` | How many sealed segments (plus the live one) stay in memory |
| `KEYFRAME_POLICY` | `natural` | `natural` (never send a PLI) or `pli` (paced, gated requests). **`L0.2` has not chosen a branch yet** — this defaults to `natural` on purpose |
| `PLI_GATE_FACTOR` | `1.5` | In `pli` mode, wait this many × `SEGMENT_MS` with no IDR before asking for one |
| `PLI_PACE_MS` | `500` | Minimum spacing between repeated PLI requests while still waiting for an IDR. **Floored at 500ms** regardless of a lower value: `L0.1` found the SFU's own `rtc.pli_throttle` (Low tier) defaults to 500ms for a single-layer publish (our screen share always is), so asking faster only wastes RTCP, it does not get more keyframes |

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
connection, no real capture, is needed to run the suite. Notably:

- `internal/h264`: RTP → access-unit reassembly (single NAL, STAP-A, FU-A),
  timestamp unwrap across a 32-bit wraparound.
- `internal/nal`: the Exp-Golomb SPS parser, round-tripped against a
  bit-writer built in the test file, for both baseline and a High-profile
  stream with an all-identity scaling matrix.
- `internal/cmaf`: box-level structural assertions — `ftyp`/`moov` shape,
  `avcC` bytes matching the input SPS/PPS byte for byte, `trun`
  `sample_flags` per sample, `mfhd` sequence numbers and `tfdt` base decode
  times increasing monotonically across fragments, `mdat` matching the
  concatenated sample data byte for byte.
- `internal/pipeline`: the part/segment boundary policy itself — parts cut
  at the target duration, a segment does **not** close on a non-IDR frame
  even past its target (elastic "Branch A"), and does close on the next
  real IDR, with the resulting fragment's first sample verified sync at the
  box level.
- `internal/keyframe`: the gate/pace state machine against a fake clock, the
  500ms SFU-throttle floor, and the natural-policy no-op path.
- `internal/ring`, `internal/serve`: eviction, sealed-vs-open segments, the
  playlist body, and every HTTP route including the 404/503 edges.

CI: `.github/workflows/pqp-remux.yml`, its own workflow (not a job inside
the root `ci.yml`, since that workflow's trigger filter applies to all its
jobs at once) filtered to `tools/pqp-remux/**`, running `make vet`, `make
test` and `make fmtcheck` on `go.mod`'s pinned Go version.

## Not yet

- **Audio (`L1.3`)**: the screen-share audio track is found and its packets
  are counted/logged (`Session.HandleAudioPacket`), but never decoded,
  mixed or muxed into the output. No audio track exists in the init segment
  or any fragment yet.
- **R2 writer (`L1.4`)**: closed segments are kept in the in-memory ring
  only; nothing is written to object storage for DVR/replay.
- **API control plane (`L1.5`)**: no `hls_sessions` row, no `LIVE_HLS_LL`
  flag, no start/stop/adopt lifecycle — this binary is started and stopped
  by hand (or by a load-testing harness), not by `pqp-api`.
- **Watchdog (`L1.6`)**: `/healthz` reports raw counters
  (`subscribed`, `partsWritten`, `bytesServed`, `lastPartAtMs`,
  `lastIdrAtMs`) but nothing consumes them yet — no `PART_STUCK_MS` stall
  detector, no restart-then-demote ladder, no `voice.hlsLlDemoted`.
- **LL playlist tags / blocking reload (`L2.x`)**: `GET /playlist.m3u8` is a
  conventional media playlist listing sealed segments. There is no
  `EXT-X-SERVER-CONTROL`, `EXT-X-PART`, `EXT-X-PRELOAD-HINT`, and no
  blocking-reload support; that is entirely the edge Worker's job in `L2.1`
  and `L2.2`.
- **Production serving surface**: `internal/serve` is explicitly a local
  test surface (task description, item 4) — one process, everything on one
  `LISTEN` address including `/healthz`. The plan's production shape (parts
  from tmpfs behind Caddy, `/healthz` on loopback only, never proxied) is
  `L1.4`/`L1.5`'s wiring, not this task's.
- **A container image / compose entry**: the plan's `L1.1` acceptance test
  mentions "a container beside the egress in
  `tools/sfu/hls/docker-compose.yaml`" — not added here, since this PR does
  not touch anything under `tools/sfu/` (kept out of scope on purpose, see
  the PR description).
