# LL-HLS as a second delivery mode: remux, not re-encode

Status: plan, written 2026-09-13. This is `B2.4` of
[`BROADCAST_PIPELINE.md`](./BROADCAST_PIPELINE.md) written out in full, plus the
`B2.1`/`B2.2` measurements that gate it, renumbered `L0.x` to `L3.x` so a PR title
can cite one. Nothing here ships before `B2.3` opens.

**Read it with three others and do not duplicate them.**
[`BROADCAST_PIPELINE.md`](./BROADCAST_PIPELINE.md) owns the claims table, the gate
and the cost of the pipeline we have. [`ALWAYS_ON.md`](./ALWAYS_ON.md) (PR #561)
owns availability, and its Layer 1 is the same Worker this plan extends: A1.2's R2
credentials and A1.3's Durable Object window are prerequisites for `L2.x`, not
parallel work. [`RELOAD_STORM.md`](./RELOAD_STORM.md) (PR #559) owns the Worker
itself, and `A1.1`, merging it, is a hard dependency of everything in `L2`.

The product statement, before the engineering: a watch party puts the audience about
26 to 32 seconds behind the presenter, and most of that is a cushion chosen
deliberately on 2026-09-12 because a film night is not interactive. LL-HLS does not
replace that. It is a **second delivery mode** for the parties where the delay is
the product problem: a live reaction, a match, anything where chat reacts to
something the audience has not seen yet. Default off, per party, with the
conventional ladder still running underneath.

## 1. Architecture

```
 presenter (Chrome, getDisplayMedia): H.264, single layer, capture res (#474/#475)
   v
 LiveKit SFU  sfu-pqp 216.238.114.79 gru
   |  RTP                            |  RTP
   v                                 v
 pqp-remux (NEW)                  livekit/egress 1.14.1      egress box
   Go headless subscriber           TrackComposite           216.238.108.42
   no video decode                  decode + x264            4 vCPU
   CMAF fMP4, 500 ms parts          4 s MPEG-TS segments
   |         \ full segments         |
   v          `--------------------> R2 (ENAM): conventional rungs, DVR, replay
 tmpfs -> Caddy (hls-origin.pqp.gg)
   v
 Cloudflare Worker  hls.pqp.gg  (tools/hls-edge): blocking reload,
   EXT-X-SERVER-CONTROL, EXT-X-PART, EXT-X-PRELOAD-HINT, token check
   v
 viewers (hls.js 1.7, AVPlayer, Media3)
```

### The service: Go, not Node

`pqp-remux` is a Go binary on `livekit/server-sdk-go`. **The Node SDK cannot do the
one thing this service is for:** `@livekit/rtc-node` wraps the Rust client and
surfaces a subscribed video track as decoded frames across an FFI boundary, exactly
the decode this plan exists to avoid, so it would pay 0.5 of a core to save 0.5 of a
core; `server-sdk-go` sits on Pion and hands the track callback a
`*webrtc.TrackRemote`, which is RTP packets. **RTCP needs a handle on the peer
connection:** section 3's fallback sends paced PLIs and Pion exposes `WriteRTCP`
directly, with nothing equivalent reachable from Node. **The pieces exist in Go and
are proven in this shape:** `pion/rtp/codecs`, `Eyevinn/mp4ff` or
`bluenviron/mediacommon`, and `bluenviron/mediamtx` as a production proof of "WebRTC
in, LL-HLS out, no video transcode"; `livekit/egress` is Go too, so the container
and health-port story is the one the box has. The only argument for Node is sharing
`@pqp/shared`, and a remux shares nothing with it.

### What is passthrough and what is not

Video is genuinely copied: depayload H.264 from RTP, box it into CMAF fMP4 parts,
never decode a frame. **Audio is not, and saying otherwise would be dishonest.**
WebRTC carries Opus, Safari and AVPlayer will not reliably play Opus in fMP4, and
today's Track Composite egress also *mixes* the screen audio with the stage
microphones. So `pqp-remux` decodes every stage audio track, mixes PCM and encodes
one AAC-LC stream: 1 to 2 % of a core per track, which sets the CPU floor. No
meaningful latency, an Opus frame being 20 ms.

### Where the parts are served from, and why not R2

**Parts are served from the egress box itself, behind Cloudflare. R2 gets full
segments only, asynchronously, for DVR and replay.** The measurement that decides it
is already in the repo: a 1 KB PUT from the São Paulo box to the live bucket takes
**0.6 to 1.0 s** (`hls-egress.ts:534-545`, measured 2026-09-12). A 500 ms part
cannot be published through a 600 ms write. That single number rules R2 out of the
hot path.

Parts go to a tmpfs and are served by Caddy over HTTP/2 on `hls-origin.pqp.gg`,
Cloudflare-proxied. A part is immutable once closed, so Cloudflare caches it per
colo and the box serves one copy per colo rather than one per viewer. The closed
segment is then PUT to R2 in the background on the existing prefix layout, so
`hls-cleanup.ts`, `keep_replay` and the retention sweep collect it with the party
exactly as today. The bucket stays private and no presigned URL reaches a viewer,
the posture `B1.4` and ALWAYS_ON `A2.5` want for the conventional path too.

### The edge Worker becomes the playlist front

`tools/hls-edge` already validates the viewer token with a faithful port of
`hls-viewer-token.ts` and already has the origin behind a `PlaylistOrigin`
interface. LL-HLS is a third implementation of it plus one genuinely new behaviour:
**blocking playlist reload** (`_HLS_msn` / `_HLS_part`, RFC 8216bis 6.2.5.2), where
the Worker holds a viewer's request open until the requested part exists instead of
letting the viewer poll. That changes the collapsing problem and must be designed
for, not discovered: with a 2 s cache the Worker collapsed N viewers into one origin
fetch per window, and with blocking reload there is no window. It must hold **one**
in-flight origin request per (session, rung, requested part) per colo and resolve
every waiting viewer from it. That is `L2.1`, the task most likely to be wrong.

## 2. The latency budget

Today is the production pipeline: 4 s segments, R2, the 20 s cushion. LL-HLS is 500
ms parts served from the box. Neither is measured end to end yet, which is what
`B0.3` is for; every line says whether it is a repo number or an estimate.

| Span | Today | LL-HLS | Source |
|---|---|---|---|
| Presenter encode and uplink | 80 to 150 ms (est) | same | `B0.3` T1-T3, from `sfu-stats.ts` |
| SFU forward to the egress box | 1 to 3 ms | same | both boxes in Vultr `gru` |
| Video processing | decode + x264, ~100 ms (est) | none, copy, under 5 ms | `B2.4`'s premise |
| Container close | 4 s segment: 0 to 4000, mean 2000 | 500 ms part: 0 to 500, mean 250 | `LIVE_HLS_SEGMENT_SECONDS`=4 |
| Publish to where a viewer can reach it | R2 PUT 600 to 1000 ms, then two serialised playlist PUTs of 600 to 1000 ms each before the segment is listed | tmpfs write, served by Caddy: under 5 ms | `hls-egress.ts:534-545`, measured |
| Playlist discovery | poll every 4 s plus up to 2 s of edge cache: 0 to 6000, mean 3000 | blocking reload, the request is already open: 0 | `RELOAD_STORM.md`, RFC 8216bis |
| Byte fetch | segment from R2 through a cache miss, ~200 ms | part (~200 KB) from a warm colo, 20 to 60 ms | R2 under 200 ms, 2026-09-12 |
| Player hold-back | `liveSyncDurationCount` 5 x 4 s = **20 000 ms** | `PART-HOLD-BACK` 3 x 500 ms = **1500 ms** | `hls-live-edge.ts:25-38`; RFC 8216bis 4.4.3.8 |
| **Total, p50** | **~26 s** | **~2.0 s** | |
| **Total, p95** | **~32 s** | **~3.5 s** | |

The target is **2 to 4 s**, and the honest reading of the table is that **the
cushion is 20 of today's 26 seconds**. LL-HLS is worth building only because that
cushion cannot simply be lowered on the conventional path: it is 5 segments of slack
against a 60 s window, and 2026-09-12 measured seventeen window misses in four
minutes when it was tighter. A 1.5 s hold-back is safe only because a part arrives
every 500 ms, so three parts of slack is three chances to recover inside a second
and a half instead of one inside twenty. If the part target falls back to 1 s
(section 3), the container-close and hold-back lines roughly double: p50 ~3.5 s, p95
~5.5 s. Better than 26, outside "2 to 4", and the go-live copy must say so rather
than ship a different promise.

## 3. Keyframes, which is the whole question

An HLS **part** may begin on any frame. An HLS **segment** must begin on an IDR. At
500 ms parts and a 4 s segment target that is one IDR every eight parts. Under
WebRTC the publisher owns the keyframe cadence, and Chromium's screen-share encoder
emits IDRs on scene change and on request, not on a clock we choose.

### The knobs that actually exist

`L0.1` verifies all four against the pinned versions, because pitfalls 9 and 12 are
both "the knob we believed in was not the knob that ran". Going in:

| Lever | Where | Expectation to verify |
|---|---|---|
| Publisher keyframe interval from JS | `livekit-client` `TrackPublishOptions` / `VideoEncoding` | **Does not exist.** `VideoEncoding` is `{maxBitrate, maxFramerate, priority}`; `RTCRtpEncodingParameters` has no GOP field. |
| Server-side key frame request | `livekit-server-sdk` `RoomServiceClient` | **Does not exist.** No `SendKeyFrame` / `RequestKeyFrame` on the REST surface (pinned `^2.17.0`). |
| Subscriber RTCP PLI | Pion, under `server-sdk-go` | **Exists, and is the only lever.** `PeerConnection.WriteRTCP` with an `rtcp.PictureLossIndication` for the track's SSRC. |
| PLI throttle | LiveKit SFU config `rtc.pli_throttle` | **Exists, and we set nothing today.** `tools/sfu/livekit.yaml.tmpl` has no block, so the build default floors whatever we ask for. Ours to change. |

`contentHint` changes the resolution-versus-framerate trade, not the GOP.

### The two measurements: `L0.2` (`B2.1`) and `L0.3` (`B2.2`)

Subscribe headlessly to a live party with a throwaway Go binary and log every IDR
arrival for ten minutes, one run each across three content types: a **film** (long
static shots, slow pans, few cuts), a **game** (constant motion, frequent cuts), and
a **mostly static desktop** (near-zero motion). Report the **distribution**, not the
mean: p50, p95, p99 and max inter-IDR per run, the count of intervals above 4, 8 and
12 s, and the raw timestamps on the PR.

`L0.3` asks what forcing that cadence costs. A PLI does not produce a private
keyframe. The SFU forwards it to the publisher, the publisher emits an IDR, and
**every seated WebRTC viewer pays for it**: an IDR is several times a P-frame, so a
paced PLI is a periodic bitrate spike on a track whose uplink is already what
`WATCH_PARTY_UPLINK_QUALITY.md` worries about. Measure one control run against one
run with a PLI paced at the segment target, same content and duration. Record seated
`RTCInboundRtpStreamStats` bitrate, `freezeCount`, `totalFreezesDuration`,
`framesDropped`, and the presenter's outbound bitrate and `qualityLimitationReason`.

### The decision rule

Let `S` be the segment target (4 s) and `P` the part target (500 ms).

- **Branch A, free.** `L0.2` shows p95 inter-IDR at or under `S` and p99 at or under
  1.5 x `S`, on **all three** content types. Segment boundaries are then
  **elastic**: close on the first IDR at or after `S`, so duration floats between 4
  and 6 s and `EXT-X-TARGETDURATION` is the observed p99 rounded up. **No PLI at
  all.** Ship.
- **Branch B, paid but cheap.** p95 inter-IDR between `S` and 3 x `S`. The remux
  sends **one PLI only when no IDR has arrived within 1.5 x `S`**, at most one
  every 6 s, paid only by content that was not already producing keyframes. Ship
  **only if** `L0.3` shows the seated room within noise: no measurable increase in
  `freezeCount`, seated bitrate within 5 % of control.
- **Branch C, stop.** p95 inter-IDR above 3 x `S` on any content type, **or** `L0.3`
  showing the seated room measurably worse under branch B pacing. **Do not build
  it.** Write the reading into this file, close LL-HLS, and the watch party keeps
  the cushion it has.

If IDRs arrive *more* often than `S` (likely for the game run) that is branch A with
no elasticity needed. `L0.3` runs only in branch B: A does not need it, C does not
deserve it.

## 4. Mode selection

**Per party, default off.** The setup surface
(`client/src/components/watch-party/watch-party-panel.tsx`, the `watch-party-setup`
panel) grows a toggle beside the existing picture and audio checks, in the same
pre-flight the host reads after the `HlsHostAckSheet` and before "Ir ao vivo". Copy,
to be reviewed:

> **Latência baixa** (experimental). A plateia vê com 2 a 4 segundos de atraso
> em vez de 20. Em conexões ruins, trava mais.

It is a property of the **session**, not the server: a host who wants it for a match
and not for a film should not change a setting twice. It is stored on the
`hls_sessions` row, stated in the go-live summary, and while live the stage carries
a "baixa latência" badge.

**The audience needs no signal.** hls.js 1.7 enables `lowLatencyMode` from
`EXT-X-SERVER-CONTROL`, and AVPlayer and Media3 read it natively. The client work is
not "turn LL on", it is **stop overriding it**. Web: `hlsLivePlayerConfig()` pins
`liveSyncDurationCount` to 5, which on an LL manifest fights `PART-HOLD-BACK`, so it
must defer to the manifest when one is present. iOS: `WatchLiveEdge.swift:118-128`
clamps `recommendedTimeOffsetFromLive` to a 1 to 8 s band **precisely because** a
configured hold-back makes the divide-by-three inference meaningless, so under LL
that clamp fires on a correct reading; the file already names LL-HLS as the case it
guards against, and that guard becomes a branch. Android: `HlsLiveEdge.kt` and
`HlsWatchdog.kt` get the same treatment.

**Fallback is a rendition, not a reload.** The conventional ladder keeps running for
the whole rollout, so the master playlist lists the LL rung beside the 720p30 rung
and a failure is an ordinary ABR switch: no new session, no torn-down player. Plus
one explicit rule: **two part-load errors inside 10 s pin the player to a
conventional rung for the rest of the session.** A viewer who cannot hold the edge
should stop trying, not oscillate.

**Recordings are unaffected.** The LL rung PUTs the same full 4 s segments to R2 on
the same prefix layout, and its `hls_sessions` row carries `rung = 'll'` as the
microphone archive carries `rung = 'mic'`, so retention, `keep_replay` and
`hls-cleanup.ts` collect it with the party unchanged.

## 5. Failure modes and the watchdog

The existing rules (claim 9, which the audit says do not touch): 10 s monitor tick,
15 s fresh grace, `PLAYLIST_STUCK_MS` 20 s, 3 restarts per 5 min then a 5 min
cooldown, backoff 2/4/8 capped at 15 s, `reapForeignEgresses`,
`adoptLiveHlsSession`. Where they do **not** map is the dangerous part.

**Liveness is a different question.** There is no LiveKit egress id and no
`ListEgress`, so `stillRunning` gets a second implementation reading `GET /healthz`
on the remux (loopback only, never through Caddy), answering per session
`{sessionId, channelId, subscribed, lastPartAtMs, lastIdrAtMs, openSegmentMs,
partsWritten, bytesServed}`. Strictly better than LiveKit's, since pitfall 15 exists
because a killed egress node reports ACTIVE forever.

**The stall detector is faster, the restart cap is not.** 20 s is forty parts, an
eternity at this cadence, so the LL path uses `PART_STUCK_MS = 3000` (six parts)
with the cap still at 3 per 5 min. A faster detector on the same cap means the LL
path gives up sooner, which is what we want: giving up is a rendition switch, not an
outage. **One restart, then demote:** a first stall restarts the remux session, a
second inside the same window **demotes the channel to the conventional ladder for
the rest of the session** and logs `voice.hlsLlDemoted` rather than retrying to the
cap. The conventional rungs are already running, so demotion costs the audience one
ABR switch.

**When the presenter's keyframes stop**, parts keep flowing (parts need no IDR) but
no segment can close. In order: keep appending to the open segment; at 1.5 x `S`
with no IDR send one PLI (branch B only); at 3 x `S` with still no IDR, **stop the
LL rung and demote**. Never close a segment on a non-IDR boundary: that is a
player-dependent failure that looks like a corrupt stream, and a viewer would find
it before we did.

**Both sweeps get a case for their own rows**, pitfall 13's lesson, which this plan
may not re-learn. The remux tears down any session in its map whose channel the API
has not heartbeat about for 60 s; the API tears down any session `/healthz` reports
that it does not hold. Neither touches the other's rows, and the grace exists so an
API deploy does not reap a healthy session. **Adoption across a deploy is free**, as
it is for the egress: the remux is a separate process on a separate box, so a
restart never touches it, and on boot the API reads `/healthz` and adopts any
session with a live `hls_sessions` row.

**How the box budget counts a remux.** CPU is nearly free: passthrough under 0.02
core, audio mix and AAC about 0.05 for a busy stage, muxing and HTTP about 0.03, so
**0.1 core** against the 0.51 a 720p30 rung costs today. **Memory**: parts and the
live window in tmpfs, about 24 MB per session at 3.2 Mbit/s over 60 s, budget 64 MB
with DVR buffering, so three sessions is under 200 MB of 8 GB. **Bandwidth**: the
box now serves what it used to hand to R2, and Cloudflare caches an immutable part
per colo, so a Brazilian audience on three or four colos costs roughly **13 Mbit/s
per session**, not one copy per viewer. So `LIVE_HLS_MAX_SESSIONS` keeps working if
a remux is charged a fraction of a rung: add `HLS_REMUX_MBPS = HLS_RUNG_MBPS * 0.2`
beside `HLS_CAMERA_MBPS`, an estimate until `L3.2` measures it.

## 6. Rollout

**The flag is `LIVE_HLS_LL`, default `off`**, read per request the way
`LIVE_HLS_ENABLED` is, with `LIVE_HLS_LL_SERVER_ALLOWLIST` mirroring
`LIVE_HLS_SERVER_ALLOWLIST` for the first single-server party. Off means the toggle
is not rendered at all, not rendered and refused.

**Staging first**, with the harness. `tools/watch-party-load/src/hls-audience.ts`
polls the playlist the way hls.js 1.7 does and needs a parts mode: blocking reloads
with `_HLS_msn`/`_HLS_part`, part fetches instead of segment fetches. Its
`assertSafeUrl` production lock stays as it is.

**The benchmark protocol**, on staging before any real party: one presenter at
**1080p60** (the worst case the publish path allows, not the 720p30 the ladder
encodes); **300 to 500 viewers** from a Vultr box in `gru`, ramped over 60 s, never
from the presenter's machine and never from a laptop (the 2026-09-12 lesson); twenty
minutes. Measure egress box CPU per process, part publish latency (close to
servable), playlist age at the Worker when a held response resolved, viewer latency
p50 and p95 from `EXT-X-PROGRAM-DATE-TIME` (settled by `B0.2`), stalls and rebuffer
seconds per viewer, and demotions. **Pass** is: viewer latency p95 at or under 4 s
(5.5 s on a 1 s part target, stated as such), stalls per viewer-hour no worse than a
conventional run on the same rig, no demotion from an undeliberate cause, and box
CPU under 1.5 of 4 cores with the conventional ladder alongside.

**Then one real party**, flag on for the host's server only, conventional rungs
beside it, a named operator watching `voice.hlsLlDemoted` and `B0.6`'s
`liveHls.latency` panel, and a paragraph in `docs/EVENT_RUNBOOK.md`. If it demotes,
that is the design working.

## 7. The tasks

Agent-days at the solo-maintainer-and-agents pace. Each names its acceptance test.

### L0: measurements, and the gate (1.5 to 2.5 days)

**L0.1 Verify the knobs** (0.5 d). Read the pinned `livekit-client`,
`livekit-server-sdk`, `server-sdk-go` and our own `livekit.yaml.tmpl` for the four
rows of section 3's table. *Accepted when* each row cites a version and a symbol, or
says "absent in `<version>`".

**L0.2 IDR cadence, three content types** (`B2.1`, 0.5 d), run and reported as
section 3 specifies. *Accepted when* the decision rule is resolved to a named branch
in this file, with the raw timestamps on the PR.

**L0.3 The cost of a paced PLI** (`B2.2`, 1 d), only in branch B, run as section 3
specifies. *Accepted when* it answers yes or no on the seated room.

**L0.4 Part-origin latency probe** (0.5 d). From a `gru` client, 100 samples each of
a 200 KB object through tmpfs plus Cloudflare against the same object through R2.
*Accepted when* section 2's "publish" row stops being an estimate.

**L0.5 The gate** (`B2.3`, a paragraph). All of: `B0.3` p95 encode-to-paint over
ten seconds, `L0.2`/`L0.3` in branch A or B, and a stated product reason for 2 to
4 s. Any one failing stops the plan here, written down either way.

### L1: the service (8 days)

**L1.1 `pqp-remux` skeleton** (1 d). Go on `server-sdk-go`, a hidden subscriber to
the presenter's screen video and the stage audio, `GET /healthz` on loopback, no
output, a container beside the egress in `tools/sfu/hls/docker-compose.yaml`.
*Accepted when* it holds a live staging party for ten minutes with rising packet
counts and no leak.

**L1.2 H.264 passthrough to CMAF** (2 d). Depayload, box into fMP4 parts at the part
target, close segments on section 3's branch rule, tmpfs, Caddy. *Accepted when*
`ffprobe` plays it, extracted NAL units match the published stream byte for byte,
and a test over a captured sample proves every segment starts on an IDR.

**L1.3 Audio: mix and AAC** (1.5 d). Decode every stage Opus track, mix, encode one
AAC-LC stream into the same parts. *Accepted when* sync drift stays under 40 ms over
30 minutes and a speaker joining or leaving produces no gap or click.

**L1.4 R2 writer for full segments** (0.5 d). Async PUT of each closed segment on
the existing prefix layout, never on the hot path. *Accepted when* `hls-cleanup.ts`
and `keep_replay` collect a finished LL session identically to a conventional one,
pinned by a test.

**L1.5 API control plane** (1.5 d). Start, stop and adopt; an `hls_sessions` row
with `rung = 'll'`; `HLS_REMUX_MBPS` in the box budget; the `LIVE_HLS_LL` flag and
allowlist. *Accepted when* the flag on brings up both the remux and the conventional
ladder, and the flag off changes nothing at all.

**L1.6 The watchdog** (1.5 d). `PART_STUCK_MS`, one restart then demote, the
keyframe-stall ladder from section 5, both directions of the reaping sweep,
`voice.hlsLlDemoted` and the `liveHls.remux` counters. *Accepted when* stopping the
remux container mid-party demotes inside 5 s with no player rebuild, and a killed
API does not reap a healthy remux session.

### L2: the edge and the players (6.5 days)

Every task here depends on `A1.1` (PR #559 merged), and `L2.3` also on `A1.2`.

**L2.1 Blocking playlist reload in the Worker** (2 d). `_HLS_msn`/`_HLS_part`
parsing, one in-flight origin request per (session, rung, part) per colo with every
waiting viewer resolved from it, and a hard timeout falling back to a non-blocking
answer. *Accepted when* 300 simulated viewers produce at most one origin request per
part per colo in the origin's own log, and no viewer waits longer than the part
target plus one RTT.

**L2.2 The LL playlist body** (1 d). `EXT-X-SERVER-CONTROL` with `CAN-BLOCK-RELOAD`
and `PART-HOLD-BACK`, `EXT-X-PART-INF`, `EXT-X-PART` and `EXT-X-PRELOAD-HINT`; token
check unchanged. *Accepted when* hls.js, AVPlayer and Media3 each play it and
`mediastreamvalidator` passes with no LL error.

**L2.3 Part bytes through the Worker** (1 d). Proxy
`/{session}/{rung}/{seq}.{n}.m4s` from the box, `Cache-Control: public,
max-age=31536000, immutable`, Cache API keyed on the path and never the token.
*Accepted when* two viewers in one colo produce one origin fetch per part.

**L2.4 The three players stop overriding the manifest** (2 d). Web
`hlsLivePlayerConfig`, iOS `WatchLiveEdge`, Android `HlsLiveEdge` / `HlsWatchdog`,
plus the two-errors-in-10 s pin rule. *Accepted when* each player sits at the
manifest's hold-back on an LL manifest and every existing number is unchanged on a
conventional one, pinned by the existing tests.

**L2.5 Presenter UI** (0.5 d). The toggle, the go-live summary line, the live badge,
i18n. *Accepted when* the toggle is absent with `LIVE_HLS_LL` off and the mode on
the stage matches the `hls_sessions` row.

### L3: rollout (2.75 days plus a party)

**L3.1 Extend the load harness for parts** (1 d). Blocking reloads, part fetches,
per-viewer latency from PDT. *Accepted when* a 300-viewer staging run produces
section 6's metrics in the existing JSON output shape. **L3.2 The staging
benchmark** (1 d). *Accepted when* section 6's pass criteria are met, or written
down as not met. **L3.3 One real party** (0.5 d plus the party), flag on for one
server. *Accepted when* latency p95, stalls and demotions are recorded. **L3.4 Write
the reading back into this file** (0.25 d): every estimate in section 2 replaced
with a measurement or marked as one.

**Total: roughly 17 agent-days after the gate**, with `L0` at 1.5 to 2.5 in front of
it. A large number for a second delivery mode, and `BROADCAST_PIPELINE.md` §4 says
why it is honest: the current media path took two months and fifteen numbered
pitfalls, and this is a second one to keep working on four clients.

## 8. What it costs

**Nothing, at first.** `pqp-remux` runs on the egress box that already exists
($48/mo, `vhp-4c-8gb-amd`), beside the LiveKit egress that already runs there; the
SFU box ($48/mo), the Workers plan ($5/mo, already paid for `pqp-admin`) and R2
(about $0 at a 10 minute retention with free egress) are all unchanged. `B3.1` put
the numbers down: one party is about 0.8 of 4 cores, `LIVE_HLS_MAX_SESSIONS` is 3,
and a remux adds 0.1 of a core.

**Bandwidth is the constraint that arrives first, not CPU.** A second box is needed
when the egress box sustains above about 200 Mbit/s (roughly five concurrent LL
sessions across four colos) or `voice.hlsSessionsCapped` goes non-zero. The shape is
`B3.2`'s and does not change: snapshot plus reserved IP, created before a party and
destroyed after, $48/mo standing or about 27 cents for a four-hour film night. Build
it on a reading, not on a feeling.

## 9. What this is not doing

- **WebRTC to every viewer.** Lowest latency there is, wrong trade: a connection per
  viewer on the SFU is the cost model the watch party exists to escape.
- **SRT ingest.** `StreamProtocol.SRT` out of LiveKit egress into FFmpeg is the
  named fallback if a subscriber proves impractical, and it is **strictly worse**:
  it adds a decode and an encode rather than removing one. A hand-off, not a plan.
- **GPU.** `B3.3` settled it: no GPU plan in Vultr `sao`, cheapest anywhere is
  $43/mo outside Brazil, LiveKit egress has no GPU path (livekit/egress#170, open
  since November 2022), and this plan's premise is that the video is never encoded.
- **Multi-region.** The audience is Brazilian and everything stays in `gru`.
- **Lowering the conventional cushion.** Not here, not as a side effect; `B1.1` owns
  any change to it. And not **replacing** the conventional ladder either: the LL
  rung runs beside it for the whole of this plan, and retiring the other path is a
  decision for after a real party that this document does not pre-authorise.
