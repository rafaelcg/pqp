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

### L0.1 result (2026-09-14)

Verified from the pinned source, not from memory. Versions read: `livekit-client@2.21.0`
and `livekit-server-sdk@2.17.0` (both pinned in this repo's `pnpm-lock.yaml`, read from
the installed `node_modules`); `livekit/livekit-server:v1.13.6` and
`livekit/egress:v1.14.1` (both pinned in `tools/sfu/docker-compose.yaml` /
`tools/sfu/hls/docker-compose.yaml`, source read via a shallow clone of
`github.com/livekit/livekit` at tag `v1.13.6` and `github.com/livekit/egress` at tag
`v1.14.1`); `github.com/livekit/server-sdk-go` at upstream HEAD (commit `857a0104`,
2026-09-11) — **not yet pinned in this repo**, since `tools/pqp-remux` does not exist
yet, so this row is "what the SDK offers today," not "what we've vendored"; and
Chromium's WebRTC stack (`chromium.googlesource.com/external/webrtc`, read at HEAD
2026-09-14) plus the public W3C WebRTC spec and MDN's `RTCRtpSender.setParameters`
reference, for the part of the question no LiveKit version changes.

| Knob | Exists? | Where | What it controls | Default | Reachable from our stack without patching |
|---|---|---|---|---|---|
| Publisher keyframe interval from JS | **No** | `livekit-client@2.21.0`, `dist/src/room/track/options.d.ts:300-304`: `VideoEncoding { maxBitrate, maxFramerate, priority }`. Same file: `degradationPreference` (L86, `RTCDegradationPreference`) trades resolution against framerate under bandwidth pressure, not GOP; `contentHint` (L219, `'detail'\|'text'\|'motion'`) is the same trade from the capture side; `scalabilityMode` (L72) is SVC-only (`L3T3_KEY` default) and **disables simulcast** when set, irrelevant to H.264. No `keyFrame`/`keyframe`/`GOP`/`IDR` symbol anywhere in `dist/src/**/*.d.ts` or the built bundle. | N/A | **No.** Also absent one layer down: the W3C WebRTC spec's `RTCRtpEncodingParameters` (what `RTCRtpSender.setParameters` actually accepts in Chromium) and MDN's own property list for it — `active, codec, channels, clockRate, mimeType, sdpFmtpLine, dtx, maxBitrate, maxFramerate, priority, rid, scaleResolutionDownBy, transactionId, degradationPreference` — carry no keyframe/GOP/IDR field at all. There is no page-JS workaround outside `livekit-client` either. |
| Server-side key frame request | **No** | `livekit-server-sdk@2.17.0` (`server/package.json`), `dist/RoomServiceClient.d.ts`: full method surface is `createRoom, listRooms, deleteRoom, updateRoomMetadata, listParticipants, getParticipant, removeParticipant, forwardParticipant, moveParticipant, mutePublishedTrack, updateParticipant, updateSubscriptions, sendData`. No `SendKeyFrame` / `RequestKeyFrame` / anything RTCP-shaped. | N/A | No |
| Subscriber RTCP PLI | **Yes, and it is the only lever that reaches the publisher** | `server-sdk-go` (v2, HEAD, unpinned): `(*RemoteParticipant).WritePLI(ssrc webrtc.SSRC)` in `remoteparticipant.go:165`, which calls a `PLIWriter` closure wired in `room.go:692-699` — `subscriber.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{SenderSSRC: ssrc, MediaSSRC: ssrc}})`, `pc` being a Pion `webrtc.PeerConnection`. Confirms the plan's premise: this is a public method on the exact type `pqp-remux` will hold for its subscription, no library patch needed. | N/A (explicit call) | Yes, once `pqp-remux` links `server-sdk-go` and calls it with the screen-share track's SSRC. |
| PLI throttle | **Yes, and we set nothing today** | `livekit-server:v1.13.6`: config field `pkg/config/config.go:141` (`PLIThrottle sfu.PLIThrottleConfig \`yaml:"pli_throttle,omitempty"\``); struct and default at `pkg/sfu/receiver_base.go:53-64` (`DefaultPLIThrottleConfig{LowQuality: 500ms, MidQuality: 1s, HighQuality: 1s}`); applied per publisher spatial layer in `pkg/sfu/receiver_base.go:727-739` (`layer==0 → LowQuality`, `1 → MidQuality`, `2 → HighQuality`) and enforced in `pkg/sfu/buffer/buffer_base.go:654-672` (`SendPLI` calls `rtpStats.CheckAndUpdatePli(pliThrottle, force)` before forwarding). `tools/sfu/livekit.yaml.tmpl` has no `pli_throttle:` block under `rtc:` — read directly, confirmed absent — so production runs on the compiled-in default. | 500 ms at layer 0. **Our screen share is single-layer, non-simulcast (section 1), which registers as layer 0** — so the floor that actually applies to us is the 500 ms `LowQuality` value, not 1 s. | Yes: add an `rtc.pli_throttle` block to `tools/sfu/livekit.yaml.tmpl` and redeploy per `docs/plans/SELF_HOSTED_LIVEKIT.md` §7. No source patch, no code in `livekit-server` to change. |

Two things the plan's four rows didn't ask for, found while verifying them, that change how L0.2/L0.3 should be read:

**The SFU already requests one keyframe per subscribe, and again per layer switch — it just isn't periodic.** `DownTrack.postKeyFrameRequestEvent()` (`pkg/sfu/downtrack.go`) fires on first bind (`OnBindAndConnected`, ~line 2631, comment reads "kick off PLI request if allocation is pending") and on `SetMaxSpatialLayer` / `AllocateOptimal` / `ProvisionalAllocateCommit` / `AllocateNextHigher`. The `keyFrameRequester()` goroutine (lines 938-982) then retries at `min(max(2×RTT, 200ms), 1000ms)` until `forwarder.CheckSync()` reports the layer locked, then goes silent. Consequence for `L0.2`: a fresh `pqp-remux` subscription should see its first IDR arrive within roughly one RTT to one second of subscribing, for free — but this mechanism produces **no ongoing cadence** once locked, so it cannot substitute for whatever `L0.2` finds the publisher does (or doesn't do) on its own afterward.

**The existing conventional egress avoids this whole problem in a way `pqp-remux` structurally cannot.** `livekit/egress:v1.14.1`, `pkg/pipeline/builder/segment.go`, builds the HLS segmenter on GStreamer's `splitmuxsink`: `max-size-time` is set to `SegmentDuration` seconds (our `hlsSegmentSeconds()`, `server/src/voice/hls-egress.ts:530-554` — code default 2 s, production runs `LIVE_HLS_SEGMENT_SECONDS=4` per section 2's table) and `send-keyframe-requests` is set to `true`. Per GStreamer's own `splitmuxsink` docs, `max-size-time` is a ceiling, not an exact cut: "the minimum file size is 1 GOP... limits may be overrun if the distance between any 2 keyframes is larger than the limits" — `splitmuxsink` **never cuts mid-GOP**, confirming the plan's own decision rule (branch elasticity) is not a novel idea but the standard behavior of the muxer element underneath the format egress already uses. `send-keyframe-requests: true` additionally sends a GStreamer force-key-unit event **upstream inside the pipeline** near each boundary — which reaches the local `x264enc` egress runs, because that path re-encodes (section 1: "decode + x264"). That is the mechanism, and it is real, sourced, and already running for every watch party today. It has no equivalent for `pqp-remux`: there is no local encoder to hand a force-key-unit event to, because the video is copied, never decoded (section 1). The only way left to make an IDR appear is the network round trip to the actual publisher — row 3 of the table above, paced by row 4. This is the concrete, source-grounded reason the plan's hypothesis ("only subscriber PLI paced by `rtc.pli_throttle`") is correct: it isn't that we haven't found a better lever yet, it's that the lever the conventional pipeline already relies on for exactly this problem requires an encoder in the loop, and this plan's whole premise (section 1, "no video decode") removes it on purpose.

**Chromium's H.264 encoder default, verified and why it doesn't change the above.** `webrtc::VideoEncoder::GetDefaultH264Settings()` (`api/video_codecs/video_encoder.cc:52-61`, the WebRTC source Chromium vendors) sets `keyFrameInterval = 3000`, a **frame count** per the comment at `h264_encoder_impl.cc:556` ("number of frames"), fed into OpenH264's `SEncParamExt.uiIntraPeriod` at `h264_encoder_impl.cc:557`. `media/engine/webrtc_video_engine.cc:496-500` constructs the encoder's settings from exactly this default and overrides only `frameDroppingOn` — nothing in the pinned `livekit-client`, nothing in our code, and nothing reachable from page JS (see row 1) ever touches `keyFrameInterval`. At 3000 frames this is 100 s at 30 fps and several minutes at the lower rates screen-share often runs at: an upper bound so distant it does not compete with a 4 s or 500 ms target. The IDR cadence `L0.2` will actually observe on a real presenter comes from OpenH264's own scene-change heuristic (not verified in numeric terms here — that's what `L0.2`'s content-type runs measure directly) and from `ForceIntraFrame(true)` (`h264_encoder_impl.cc:461-464`), which fires only in response to an incoming PLI/FIR — the same external trigger as row 3, not a clock. **Unverified and flagged as such:** this default lives in the OpenH264 *software* encoder path inside libwebrtc; this read did not confirm whether Chromium's browser process routes a `getDisplayMedia` H.264 capture through this exact code path on every OS, or through a platform hardware encoder (VideoToolbox, Media Foundation, VA-API) with its own, unverified keyframe-interval default. The conclusion below does not depend on which one runs, since neither is reachable from our stack either way — but if `L0.2`'s three content-type runs show materially different behavior across presenter operating systems, this is the first place to look.

**Conclusion.** Every row confirms the plan's hypothesis rather than merely failing to contradict it: there is no publisher-side, server-RPC-side, SFU-config-generator, or browser-platform-side way to schedule an H.264 keyframe on our own clock, at any layer of the pinned stack (`livekit-client@2.21.0`, `livekit-server-sdk@2.17.0`, `livekit-server:v1.13.6`, and the public Web Platform surface Chromium exposes). **Subscriber RTCP PLI via `server-sdk-go`'s `WritePLI`, paced by the SFU's `rtc.pli_throttle` (500 ms at the layer a single non-simulcast screen-share track occupies), is the only lever `pqp-remux` will have** — not by elimination among options we didn't fully check, but structurally: the one mechanism that lets the *existing* pipeline dodge this problem (asking a local re-encoder for a keyframe) requires an encoder in the process, and this plan's entire premise is not having one. For `L0.2`: measure natural cadence with **zero** PLI sent by `pqp-remux` first (branch A candidate, and the SFU's own subscribe-time and layer-switch requests mean the first IDR of each run should arrive promptly without our help, which does not need to be logged as if we caused it). For `L0.3`, if branch B is reached: the pacing ceiling from the SFU is a 500 ms floor per publisher, well under the plan's proposed "at most one every 6 s," so the throttle will not interfere with the proposed pacing — the open question `L0.3` exists to answer is entirely about the *cost* of a forced IDR on the seated room, not about whether the SFU will let us ask for one.

**What the `L0.2`/`L0.3` logger (`pqp-remux --idr-log`) needs, concretely, from the above:**

- Link `server-sdk-go` (the module read here; pin an exact version/commit when vendoring, since it is not yet pinned anywhere in this repo) and connect as a headless `RemoteParticipant` subscriber to the presenter's screen-share video track only (no audio decode needed for this measurement).
- Depacketize the subscribed track's RTP (H.264, single layer) far enough to read NAL unit type from each frame's first NAL — logging every arrival where `nal_unit_type == 5` (IDR) is the whole of `L0.2`; no decode needed, matching this plan's own "no video decode" premise.
- Run `L0.2` (branch-A measurement) with **no call** to `WritePLI` at all — the command needs a mode that only subscribes and logs, e.g. `pqp-remux --idr-log --room <room> --identity pqp-remux-l02-probe --content-type film|game|desktop --duration 600s --out idr-log-<content-type>-<timestamp>.jsonl`, one ten-minute run per content type per section 3.
- Log per event: wall-clock arrival time (`time.Now()`, not RTP timestamp, since the metric is real inter-arrival time), the track SSRC, and a monotonically increasing sequence number for gap detection; write one JSON line per IDR so the raw timestamps the plan asks to be posted on the PR are just the file, not a derived summary.
- For `L0.3` (branch B only, run second): the same binary needs a `--pli-interval <duration>` flag that calls `RemoteParticipant.WritePLI(ssrc)` once per interval **only when no IDR has been logged within 1.5× the segment target** (the plan's branch B rule, section 3) — not on a bare fixed timer, so the tool doesn't itself invent a periodic-PLI behavior the plan explicitly didn't ask for. A companion `--control` run (same content, same duration, flag absent) is what `L0.3`'s comparison needs; both runs should log the presenter's `RTCOutboundRtpStreamStats`/`qualityLimitationReason` where obtainable, or, if that requires reading the *publisher's* browser stats (which a Go headless subscriber cannot do), that half of `L0.3` needs a separate stats collector on the presenter's client and this logger only needs to emit accurate timestamps the presenter-side capture can be lined up against.

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

**What the first real party actually found (2026-09-14, 21:50 UTC, two API
machines, `VOICE_REGISTRY=postgres`, `CLUSTER_BUS=postgres`).** All three of
the rules above were written down and none of them had a caller.
`pqp-remuxd` logged `demoting (idr-gap-exceeded)` fourteen seconds in and
closed its LiveKit subscription; the API kept the row open with `mode='ll'`,
kept handing viewers the LL playlist (the edge Worker logged
`hlsEdge.llStateFetchFailed` twelve times), never started the conventional
ladder, and the audience had no picture until an unrelated restart.
`llDemoted` was declared, reported on the dashboard and incremented by
nothing — pitfall 12's shape, in a counter invented for exactly this
incident. It has a writer now: `sweepLlDemotions` in
`server/src/voice/hls-remux.ts` polls `GET /sessions` on the health monitor's
tick, treats `demoted: true`, `state: "demoted"` and "not listed at all"
alike, stops the session, ends the row with the box's own reason, logs
`voice.hlsLlDemoted`, and hands the channel back to `hls-egress.ts` to
reconcile onto the rungs. A control API that cannot be reached demotes
nothing, and neither does a channel whose row this process no longer owns:
the sweep re-claims the row before it stops anything, because `llRooms` is
process memory and a stale entry acted on after another machine took the
party over would kill the new owner's stream through the one path with no
claim in front of it. **And the fallback sticks**: the demotion clears the party's
`low_latency_requested` (logged as `voice.hlsLlRequestCleared`) and memoes the
channel for the same five minutes the box's own `DEMOTE_WINDOW_MS` uses, so
the next reconcile cannot start a second LL session on top of the one just
given up on. That write is scoped to the party the session
RECORDED (`hls_sessions.watch_party_session_id`, written at start, which is
the one moment "the party that asked" and "the party that is live" are
certainly the same), never to the channel, so a cleanup that runs late cannot
clear a newer party's request.

**A NULL attribution is unknown, not "no party".** The column is NULL for two
different reasons a row cannot tell apart: the session genuinely started with
no live party, or the SELECT that would have recorded one failed. Reading it
as the first was the last hole in the fallback: the demotion found nothing to
clear, said so, and `low_latency_requested` stayed true until the memo lapsed.
A demotion whose party is unknown is re-attributed at cleanup time, bounded by
the session's own start (a party live before the session began could have
asked for it; one created afterwards emphatically could not), and after three
empty attempts it fails closed by clearing whatever party is live, logged as
`voice.hlsLlRequestClearUnattributed`.

**A demotion is three writes and is not done until all three are.** Stopping
the box session and ending the row, clearing the party's request, and getting
the conventional ladder started: each can fail on its own, and doing them once
and hoping is how the durable half is lost to a database blip, after which the
five-minute memo expires and a reconcile starts LL into the same failure
again. They are a per-channel entry in a bounded queue
(`pendingLlDemotionCount`, cap 64, exponential backoff to a minute, abandoned
after 30 minutes with a log), re-run from the health tick until each lands.
Every step is idempotent by construction and every retry re-asks the ownership
question, so a cleanup that resumes after this process's heartbeat lapsed
cannot touch a row the other machine has since taken. The next `goLive` writes the column again
AND clears the memo, which is what makes a demotion last the party and not a
minute longer.

**Adoption is free, but only if exactly one machine does it.** The same night,
machine B booted first, resumed the existing remux session
(`voice.hlsLlStartFoundExisting` + `voice.hlsLlStarted`), and machine A booted
three seconds later and stopped it (`voice.hlsLlOrphanStopped reason=no-row`),
leaving B with `llSessions=1` for a session that no longer existed. Two
causes. The conventional boot sweep read LL rows at all: it decides a row's
fate by whether LiveKit lists its `egress_id`, an LL row has none, so it fell
straight into "end it" — `reconcileStaleHlsSessions` now excludes `mode='ll'`
outright, because the only sweep entitled to judge those rows is the one that
asks the box holding them. And LL adoption stamped ownership AFTER putting
every row in `llRooms`, which is a read-then-act across two machines:
`claimHlsSessionRow` (`hls-ownership.ts`) is a heartbeat-aware compare-and-set
run BEFORE a session is started, resumed or adopted, and the loser of that
UPDATE neither adopts nor stops — it is not an orphan, it has a driver.
`adoptLlHlsSessions` writes its own `voice_instances` heartbeat first and
ABORTS THE PASS if that write fails, or two machines booting inside one TTL
would each read the other as dead and take the row back in turn: "could not
say I am alive" is not "I am alive". A row another process wrote in the last 60 s (the window
between `startLlSession`'s INSERT and its POST) is left alone whatever the
heartbeats say, which is this section's own grace, now enforced.

**The mode re-check has to run where the transcode is.** Every path into
`pushLiveHls` reads this process's own maps, so on the machine a viewer's
frame happened to land on — about half of them, with no session affinity —
the whole call is a no-op, the mode branch included. An instance that does not
hold the channel (`liveHlsOwnsChannel`: `rooms` or `llRooms`) now publishes a
`voice.hlsReconcile` intent on the cluster bus, throttled per channel and only
when its own `hlsAudience` says the other machine has a party here, so an
ordinary LiveKit voice room's joins and leaves publish nothing. The owner runs
its own local reconcile; nobody else acts on it, and with one machine nothing
is published at all. The relaying instance still runs its own local path
afterwards, deliberately: a channel NOBODY owns yet is the ordinary case for a
share about to start, and the machine holding the presenter is the one that
has to start it. `voice.cluster.hlsReconcileRelayed` /
`hlsReconcileApplied` are the two counters that say it runs.

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

**The host switch shipped** (2026-09-14), in the options panel
(`watch-party-options.tsx`) rather than the setup-surface checklist §4
sketched: "Baixa latência (beta)", host-only, present only when
`GET /api/live-hls/config`'s `lowLatency.available` says this server may ask
at all. It saves the preference like any other option (`options.lowLatency`);
`handleWatchPartyGoLive` is the one place that reaches the server with it, on
every "Ir ao vivo", which is also the only moment `resolveHlsMode` is ever
asked -- so a change made while already live shows its own note
("vale a partir da próxima transmissão") rather than doing nothing silently.

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

**The first one (2026-09-14) demoted and the design did not work**, because
nothing on the API side was reading the verdict — see §5. Before the next
party: `liveHls.llDemoted` must be able to move (it is the proof the poll
runs at all), and on two machines `voice.cluster.hlsReconcileRelayed` and
`hlsReconcileApplied` must both be non-zero within a minute of a party with
viewers on both, a `relayed` climbing beside an `applied` that stays at zero
being the same pitfall-12 shape one more time.

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

**Status, 2026-09-15.** `L2.1` and `L2.2` shipped in PR #583: the Worker parses
`_HLS_msn`/`_HLS_part`, holds one poll loop per rendition, and renders the LL
playlist itself from a `state.json` document it fetches from the remux. The
producer half of that document did not exist, and a live party at 08:01 UTC found
out the expensive way: the API selected LL mode, `pqp-remuxd` started the session
and answered 200 on `playlist.m3u8`, `init.mp4` and `audio-playlist.m3u8`, and every
viewer stalled, because the Worker asks for `GET {LL_ORIGIN_BASE}/s/:id/state.json`
FIRST and got a 404 (`hlsEdge.llStateFetchFailed` on every probe). **That endpoint
now exists** (`tools/pqp-remux/internal/llstate`, served by `internal/serve` and
mounted per session by `internal/control` behind the existing `X-Pqp-Origin-Key`
gate), for both the video rendition and the audio twin, cross-checked against the
Worker's own `parseLlState` by a committed golden file. What is left in `L2` before
a viewer can actually play an LL session is `L2.3`: the Worker does not yet proxy
the part and segment bytes its own playlists point at
(`/{basePath}/{rung}/{name}`), so those URIs still 404 from the edge.

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
