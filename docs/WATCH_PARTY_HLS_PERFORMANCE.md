# Watch-party HLS performance — investigation report

Date: 2026-09-10. Trigger: watch parties feel like "~25 fps" on web, and the
Vultr SFU box jumped from ~7% to ~48% CPU with a single watch-party sender.

Follow-up, 2026-09-10 (quality): **`1080p60` is now the default top rung.**
Capture and HLS match the host display (60 Hz) so a 24 fps film looks like
it does on the presenter's screen instead of 3:2 judder at 30. Bitrate
floors went up with it (1080p60 8000 kbit/s, 720p30 3200). The media box
pays more per party (~1.6–2× a 1080p30 encode for the top rung). Operator
rollback: `LIVE_HLS_LADDER=1080p30,720p30,480p30`. `720p60` remains a named
option for a game ladder that should not spend 1080p60.

The this-week client items in §4 (1–6 except `playlistLength`,
which livekit-server-sdk 2.17.0 does not expose) landed earlier the same day:
in-place stall recovery before teardown, ABR seed from the previous estimate,
`capLevelToPlayerSize`, `maxLiveSyncPlaybackRate: 1.5`, jump-to-live one
segment behind the edge, and `getVideoPlaybackQuality` on HLS stats. Item 3
of the TL;DR below is historical — the 2→3-rung default already shipped in
#449.

Method: code read across `client/`, `server/`, `packages/shared/`, `tools/sfu/`,
plus the incident notes in `docs/WATCH_PARTY.md` and the measurements in
`docs/CAPACITY.md`. Claims marked *(verified)* were re-checked against source
while writing this; *(inference)* means the code supports the explanation but
it still needs a measurement to confirm.

## TL;DR

1. **The 48% CPU is explained, and it matches our own measurements.** One watch
   party starts **one software transcode per HLS ladder rung**, and they run on
   the same 4-vCPU Vultr box as the SFU. Measured cost: 0.88 core (1080p30) +
   0.51 core (720p30) + ~0.3 core (480p30, interpolated) ≈ **1.7 of 4 cores ≈
   42%**, plus the ~7% idle baseline ≈ **the 48% observed**. It is the designed
   cost of the ladder landing on the wrong box — not a runaway bug. The fix is
   placement (a separate small egress box, already our standing recommendation
   in `docs/CAPACITY.md`), not flag-tuning.
2. **The "~25 fps" is real and has three stacked causes.** (a) the whole
   pipeline is hard-capped at **30 fps** end to end — capture, publish, and
   every ladder rung — so a 60/120 fps source is decimated at capture;
   (b) episodically, the presenter's uplink starves the top simulcast layer and
   the egress transcodes that starved layer for the entire audience (the
   documented ~20 fps party of 2026-09-09); (c) under CPU contention on the
   box, x264 falls behind realtime and `videorate` pads to a nominal 30 fps
   with uneven pacing *(inference — needs the ffprobe check in §5)*.
3. **A 2→3-rung default-ladder bump is sitting uncommitted** on
   `ios/watch-player-chrome` (raises ladder budget from half to three-quarters
   of the box). Shipping it raises every party's SFU-box cost by ~0.3–0.4 core.
   Decide deliberately, not by accident.

## 1. The pipeline as it exists today *(verified)*

```
host browser ──getDisplayMedia, frameRate {ideal:30, max:30}──▶ LiveKit SFU
  (client/src/lib/screen-capture-audio.ts:325;                    (sfu-pqp,
   publish maxFramerate 30, client/src/lib/livekit-session.ts:92)  Vultr 4 vCPU)
       │ simulcast: 1080p / 720p / 360p layers, ~4 Mbit/s top
       ▼
pqp-api (Fly) ──StartTrackCompositeEgress, ONE PER RUNG──▶ livekit/egress
  (server/src/voice/hls-egress.ts)                            v1.14.1 container,
                                                            SAME Vultr box
       │ GStreamer: decode top layer → videorate 30/1 → scale
       │ → x264enc (veryfast) → AAC → 2 s MPEG-TS segments
       ▼
Cloudflare R2 (private bucket)
       │ playlists proxied+resigned via pqp-api (1 s cache),
       │ segments fetched by viewers DIRECTLY from R2
       ▼
web viewer: hls.js 1.7.2 (client/src/components/voice/hls-watch-player.tsx)
```

- Ladder (all rungs **30 fps**, `server/src/voice/hls-ladder.ts:66-103`):
  1080p30 @ 4500+128 kbit/s, 720p30 @ 1800+128, 480p30 @ 900+96, 360p30 @
  500+96. Default on `origin/main`: `1080p30,720p30`. **Working tree:
  `1080p30,720p30,480p30`** with the ladder budget raised to 3 cores' worth
  (`hls-ladder.ts:113,250`; uncommitted diff).
- The master playlist advertises `FRAME-RATE=30.000` (`hls-ladder.ts:404`).
  "25" appears nowhere in the pipeline — nothing is *configured* below 30 fps.
- Why one egress per rung: `TrackCompositeEgressRequest` carries a single
  `EncodingOptions` for all outputs (`hls-ladder.ts:15-20`). Each rung pays its
  own full-res **decode** + scale + encode.
- Per-viewer cost on the box is zero for HLS viewers (segments come from R2);
  the playlist proxy runs on Fly with a 1 s cache and inflight coalescing
  (`server/src/voice/hls-playlist-proxy.ts:48-72`).

## 2. Symptom A: "~25 fps" on web

### A1. HIGH — 30 fps is a hard ceiling across the whole chain *(verified)*

- Capture: `frameRate: { ideal: 30, max: 30 }`
  (`client/src/lib/screen-capture-audio.ts:325`). A 60/120 fps game or sports
  stream is decimated to 30 **at capture**; nothing downstream can bring it
  back.
- Publish: `VIDEO_MAX_FRAMERATE = 30` (`client/src/lib/livekit-session.ts:92`,
  applied at `:986`); simulcast sub-layers also 30
  (`client/src/lib/video-quality.ts:263-266`).
- Egress: every rung `framerate: 30` (`hls-ladder.ts:66-103`), enforced by
  `videorate` in the pipeline.

Why it matches the report: viewers comparing against Twitch/YouTube (60 fps)
perceive even perfect 30 fps as "not smooth", and 30→60 Hz display resampling
with uneven pacing adds judder on top. **There is no client-side fix.** Going
to 60 means capture at `ideal: 60` for watch-party shares + 60 fps rungs, at
roughly double the encode cost per rung — which is why §3 (box placement)
should land first.

### A2. HIGH — the documented "~20 fps party": starved top simulcast layer reaches the egress *(verified, happened in production)*

`docs/WATCH_PARTY.md:1589-1599` (2026-09-09): the presenter published 1671×1080
with a 4 Mbit/s target; **~2.35 Mbit/s actually arrived**. The egress always
subscribes to the **top** simulcast layer — `SetSubscribed(true)`, no layer
preference, and `TrackCompositeEgressRequest` has no layer field — so every
rung transcoded the starved layer and the whole audience got ~20 fps judder.
The box was idle (load 0.87): **this one is the presenter's uplink, not the
SFU.**

Existing mitigation: the client only raises the publish past 720p when the
*measured* uplink ≥ target × 1.25 headroom, re-sampled every 2 s
(`video-quality.ts:353,398-400`; `client/src/hooks/use-voice.ts:866-908`). But
the estimate itself was ~60% of target in that incident, so 1.25× on a noisy
estimate is thin. Fix direction (publish-side only — LiveKit gives the egress
no layer control): larger headroom, faster sustained-drop reaction (currently
~10 s), or hold 720p whenever the estimate is marginal.

### A3. HIGH *(inference)* — encoder starvation on a contended box reads as low fps

When x264 can't hold realtime, the egress's encoder queue backs up while
`videorate` duplicates frames to keep the nominal 30 fps cadence: the stream
still says "30 fps" but motion arrives unevenly — exactly the "~25 fps" feel.
Given one party already costs ~42% of the box and the SFU/TURN live there too,
contention is plausible during real parties. **Verify before acting**: see §5.

### A4. MED — stall recovery is a full player teardown, and each one re-seeds ABR below the lowest rung *(verified)*

- Watchdog: 8 s of `waiting`, 15 s without the media sequence advancing, or a
  fatal hls.js error → `reconnect` (`client/src/lib/hls-stall.ts:40-44`;
  `hls-watch-player.tsx:509-523`).
- `reconnect` → `setActiveSrc`/`setAttempt` → the attach effect re-runs:
  `hls.destroy()`, brand-new `Hls` instance, manifest refetch, buffer rebuilt
  from zero (~6 s at `liveSyncDurationCount: 3` × 2 s segments)
  (`hls-watch-player.tsx:234-260, 650-665`).
- The new instance starts ABR at hls.js's default `abrEwmaDefaultEstimate`
  (500 kbit/s), **below the lowest default rung** (480p30 ≈ 996 kbit/s) — so
  every reconnect drops the picture to the bottom rung and climbs again.
- hls.js's in-place recovery (`recoverMediaError()` / `startLoad()`) is never
  used: the only ERROR listener feeds the watchdog
  (`hls-watch-player.tsx:612-616`).

On a mediocre link this becomes a repeating cycle of freeze → 8 s → long
rebuffer → low-quality ramp — indistinguishable from "choppy, never smooth".

### A5. MED — `capLevelToPlayerSize` not set *(verified)*

The hls.js config is minimal (`hls-watch-player.tsx:566-609`):
`liveSyncDurationCount: 3`, `enableWorker: true`, manifest retries, `xhrSetup`.
Everything else is library default, including `capLevelToPlayerSize: false`.
Auto ABR can hold the 1080p30 rung (~4.6 Mbit/s avg) no matter how small the
stage pane is; on machines without H.264 decode headroom that means **dropped
frames at the decoder** — real judder that looks like a low-fps stream. The
manual pin (`currentLevel`) still overrides it for a viewer who asks for 1080p
by name.

### A6. LOW-MED — no live-edge catch-up; tiny sliding playlist window *(verified)*

Defaults in force: `maxLiveSyncPlaybackRate: 1`, no `liveMaxLatencyDurationCount`.
Drift (backgrounded tab, recovered stall) is never reclaimed — the only remedy
is the manual "jump to live" badge at a 10 s threshold
(`client/src/lib/hls-live-edge.ts:22`). Compounding: `SegmentedFileOutput`
never sets `playlistLength` (`hls-egress.ts:1839-1854`), so the window is
LiveKit's small default (~6 segments ≈ 12 s) — a viewer who falls behind gets
segments vanishing under the playhead and visible jump cuts.

### A7. LOW — assorted small ones *(verified)*

- Cold-start ABR begins on the worst rung every attach (500 kbit/s seed <
  996 kbit/s floor); stacks with A4.
- `jumpToLive` seeks to the exact `liveSyncPosition`
  (`hls-watch-player.tsx:301-311`) — landing within a segment of the edge risks
  an immediate `waiting` blip, and 8 s of that arms A4. Seek to edge − ~1
  segment.
- **No framerate telemetry on the HLS path**: `setHlsPlaybackStats` carries
  only `{width, height}` (`client/src/lib/hls-playback.ts:84-97`). "Feels like
  25 fps" is currently unverifiable from the client's side — add
  `getVideoPlaybackQuality()` (dropped/total frames) sampling.

## 3. Symptom B: the 7% → 48% SFU CPU spike

### B1. HIGH — it's the ladder's design cost on the wrong box *(verified)*

What runs on `sfu-pqp` (`vhp-4c-8gb-amd`, 4 vCPU / 8 GB, São Paulo): stock
`livekit/livekit-server:v1.13.6` (SFU + built-in TURN), Caddy, and since
2026-09-08 **Redis + `livekit/egress:v1.14.1`** co-located
(`tools/sfu/hls/docker-compose.yaml`; `docs/CAPACITY.md:185-188`). There is no
custom SFU code, no per-packet hotspot; LiveKit itself measured 1.4–2.2% CPU
during transcodes (`docs/CAPACITY.md:201-203`).

The arithmetic, measured on this exact hardware (`docs/CAPACITY.md:195-199`):

| rung | egress container CPU, sustained |
|---|---|
| 1080p30 | 0.88 core |
| 720p30 | 0.51 core |
| 480p30 | ~0.3 core (unmeasured, interpolated) |

- Main's 2-rung ladder: ~1.4 cores ≈ 35% + 7% baseline ≈ **42%**
- Working tree / `LIVE_HLS_LADDER=1080p30,720p30,480p30`: ~1.7 cores ≈ 42% +
  7% ≈ **48–49% — the observed reading**

High-motion content pushes x264 toward the worst case these measurements were
taken at. **Action item: check the production `LIVE_HLS_LADDER` Fly secret** —
if it names 3 rungs, prod is already paying this; if unset, merging the current
branch silently moves prod from 2 to 3 rungs.

### B2. MED — the 480p rung decodes 1080p like every rung *(verified)*

Track Composite has no layer selector (A2), so the cheapest rung still pays a
full 1080p decode before scaling down. The cheap rung is not cheap. Blocked on
LiveKit's egress API; alternatively drop 480p or accept the cost.

### B3. MED — thread oversubscription, no CPU limits, and CPU-kill churn *(verified config; churn is inference)*

Three x264 instances × ~6 auto threads + 3 decoders + the SFU on 4 cores; the
compose overlay sets no `cpus:`/`deploy` limits
(`tools/sfu/hls/docker-compose.yaml`). Egress admission
(`trackCompositeCpuCost = 1`, `maxCpuUtilization = 0.8`) admits 3 rungs on 4
cores regardless of real load, and under sustained pressure the egress service
can kill handlers (`CpuKillGraceSec` default 30 s) — a plausible source of the
restart churn the API monitor then heals. Not root cause; worsens tail behavior.

### B4. LOW — rule out duplicated ladders for this specific incident *(verified the failure mode exists)*

The 2026-09-09 incident had one room transiently running **four transcoders**
(`docs/WATCH_PARTY.md:1288-1330`; fixes shipped: `reapForeignEgresses`,
`stillRunning` stops, `hls-egress.ts:1104-1210`). If the observed spike was
materially above ~50%, or `liveHls.orphansStopped` on `/api/admin/metrics` is
non-zero (`hls-egress.ts:846-853`), a leftover ladder — not the baseline design
— is the story. **That metric belongs at zero; alert on it.**

### B5. The real risk: this box also carries voice

The same 4 cores run the WebRTC SFU and TURN relay. `decideLadder` prices
ladder rungs against the promotion budget (`hls-ladder.ts:327-369`) and refuses
extra rungs when the box is busy — but the **floor rung always starts** and the
budget is priced in Mbit/s, not cores (a StartEgress timeout on a saturated box
was already observed: `docs/CAPACITY.md:246-248`). Past the pin, "egress falls
instead of rising": one busy evening with parties + calls contends, and both
degrade. `docs/CAPACITY.md:185-188` already says it: **a separate small egress
box, not a bigger SFU.**

## 4. Recommendations, in order

**This week (cheap, client-side):**
1. `capLevelToPlayerSize: true` on the hls.js config (A5).
2. Try `recoverMediaError()` / `startLoad()` (or a seek to live edge) before
   the full teardown; reserve teardown for sequence-stuck/404 (A4).
3. Seed ABR on rebuild from the previous instance's `bandwidthEstimate`; raise
   the default estimate toward the middle rung (A4, A7).
4. `maxLiveSyncPlaybackRate: 1.5` and a deliberate `playlistLength` (~10–15) on
   the egress output (A6).
5. `jumpToLive`: seek to `liveSyncPosition − 1 segment` (A7).
6. Add `getVideoPlaybackQuality()` sampling to the HLS stats so the next
   "feels like 25 fps" report comes with dropped-frame numbers (A7).

**Operational (this week):**
7. Check the production `LIVE_HLS_LADDER` secret and `liveHls.orphansStopped`
   (B1, B4). Decide explicitly whether the uncommitted 2→3-rung default bump
   ships, and re-measure before it does.
8. Set container CPU limits for the egress service so a ladder cannot starve
   the SFU (B3).

**Structural (the actual fix for both symptoms):**
9. **Move egress to its own small box** — the standing recommendation in
   `docs/CAPACITY.md:185-188`. This removes A3/B3 contention entirely and frees
   ~1.7 cores for the SFU. Note the stale warning in
   `tools/sfu/hls/docker-compose.yaml` ("do not add this to production") vs the
   documented production reality — reconcile whichever way we choose.
10. Publish-side uplink gating hardening (A2): bigger headroom factor and/or
    faster sustained-drop, since the egress can't be told to take a lower
    layer.
11. Only after 9 lands: evaluate a **60 fps path** (capture `ideal: 60` for
    watch-party shares + 60 fps rungs) — that's what closes the
    "feels like 25 fps" gap against Twitch/YouTube for good (A1).

## 5. How to verify the open points

- **A3 (encoder starvation):** during the next party, `ffprobe -count_frames`
  a few 2 s segments — a healthy rung has exactly 60 frames; consistent 60 with
  judder means pacing, under-60 means starvation. Correlate with per-container
  CPU in Grafana for the window (egress vs livekit split).
- **B1 (which ladder prod runs):** `fly secrets list` / the egress startup logs
  name the rungs; `docker stats` history for the spike window separates egress
  from LiveKit CPU.
- **B4 (orphans):** `liveHls.orphansStopped` on `/api/admin/metrics` — belongs
  at zero.
- **A4/A5 impact after fixing:** the new dropped-frame telemetry (item 6) per
  rendition.

## Appendix: doc drift noticed along the way

- `docs/CAPACITY.md:236` and `hls-egress.ts:243-244` still price/describe "the
  default two-rung ladder"; the working-tree default is three.
- `docs/voice-backends.md:431` says the viewer token is 12 h; code says 1 h
  (`server/src/voice/hls-viewer-token.ts:44`).
- `tools/sfu/hls/docker-compose.yaml:1-2` warns "do not add this to production";
  `docs/CAPACITY.md:37,185-188` documents that production did exactly that.
