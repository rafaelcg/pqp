# Watch party HLS: inconsistent quality

Handoff for a coding agent. Companion (box CPU, 30 fps ceiling, egress placement):
[`docs/WATCH_PARTY_HLS_PERFORMANCE.md`](../WATCH_PARTY_HLS_PERFORMANCE.md).

Trigger: parties transmit ~25–30 fps, drop 720p→480p, show "Held back by your
connection" / "being limited by your connection", stream is choppy / stalled.

## Shipped

Client + a small egress encode/ops change. Remaining: correlate box CPU
(`WATCH_PARTY_HLS_PERFORMANCE.md` §3), then split egress off `sfu-pqp`.

1. `heldForHls` is distinct from `capped`. HLS-held 720 uses
   `HLS_HELD_720_BITRATE` (2.25 Mbps), never `LARGE_ROOM_SCREEN_BITRATE` (1.5).
2. `sampleSenders` reports `publishedScreenPlan.topBitrate`. A healthy link
   sitting on that ceiling reads `setting`, not `bandwidth`.
3. Raise is 1.25× the *current* ceiling, not 6 Mbps against 1080. Drop on
   honest `bandwidth`/`cpu`, unmeasured, or uplink below 2.25 Mbps. 30 s dwell
   between capture-height changes.
4. HLS publish keeps only the 360p sub-layer. A 1080 share already on the
   wire deactivates the 720 mid-rung in place (no new sid).
5. SFU `sampleRoom` fills `paths` from the publisher sender's `getStats()`.
   The gate used to see `uplinkBps === null` on every LiveKit party.
6. ABR seed 2.5 Mbps, `startLevel: -1` (auto).
7. Egress `keyFrameInterval: 2`. Compose `cpus: 2.5` on the egress container.
8. `console.debug("[pqp] hls-uplink", …)` every stats sample while presenting.

Skipped without a measurement: `degradationPreference: "balanced"`. Prod
`LIVE_HLS_LADDER` / `liveHls.orphansStopped` is operator, not code.

## Already landed before this — do not redo

As of `origin/main` 2026-09-10:

- Height never republishes while the HLS pin is on (`screenPlanPinned` in
  [`client/src/lib/livekit-session.ts`](../../client/src/lib/livekit-session.ts);
  #457–#460). Capture height can still change via `applyConstraints`.
- [`clampScreenPlanToCapture`](../../client/src/lib/video-quality.ts): do not
  declare layers taller than the actual capture (480p window advertising 1080).
- Viewer: `capLevelToPlayerSize: true`, `maxLiveSyncPlaybackRate: 1.5`, ABR
  seed from last estimate (default `HLS_ABR_DEFAULT_ESTIMATE_BPS = 1_800_000`),
  jump-to-live one segment behind the edge, `getVideoPlaybackQuality`.

The bugs below are still in the tree.

## What the readout is actually measuring

`OutboundVideoReadout` / `useShareUplinkStrain` read the **presenter's WebRTC
sender stats toward the SFU**. Not the HLS stream.

Every HLS rung is transcoded from that one track. Egress
`SetSubscribed(true)`, no layer preference, always the top layer.
`TrackCompositeEgressRequest` has no layer field. Whatever the presenter's
uplink degrades to is what every viewer gets, upscaled into 1080/720/480.

```
getDisplayMedia 1080p30
  → Chrome H.264 simulcast: top + 720p@1.4M + 360p@450k
  → one uplink, GCC BWE
  → LiveKit SFU (sfu-pqp, 4 vCPU)
  → top layer only → 3× TrackComposite egress (same box)
  → R2 2 s TS segments → hls.js
```

## Root causes (ranked)

### 1. HLS "hold at 720p" silently caps the source at 1.5 Mbps; the readout then blames the connection

[`client/src/lib/video-quality.ts`](../../client/src/lib/video-quality.ts)
`hlsSourceTopHeight` returns 720 when
`uplinkBps === null || uplinkBps < 4M * HLS_SOURCE_UPLINK_HEADROOM` (6 Mbps).
That sets `holdAt720 → capped = true`, and `capped` reuses the large-room
ceiling:

```ts
const topBitrate = capped
  ? Math.min(screenBitrateFor(quality), LARGE_ROOM_SCREEN_BITRATE) // 1_500_000
```

[`currentScreenPlan`](../../client/src/lib/livekit-session.ts) does the same
(`plan.capped ? Math.min(screenMaxBitrate, LARGE_ROOM_SCREEN_BITRATE)`).

Result: HLS source is **720p H.264 at 1.5 Mbps**, then re-encoded by egress at
4.5 Mbps (1080p30) and 1.8 Mbps (720p30). The 720p rung outputs more bits than
its input carries. Soft picture for everyone.

Meanwhile `sampleSenders` reports `ceilingKbps = screenMaxBitrate` (3000 for
Auto, 4000 for 1080p), not the applied 1500. `describeLimitation` sees
target ≈1500 < 0.9 × 3000 → `"bandwidth"` → **"Held back by your connection"
on a healthy link.** `nextSfuStrainStreak` uses `describeLimitation` with no
correction, so the stage banner fires too. The comment in
[`use-share-uplink-strain.ts`](../../client/src/hooks/use-share-uplink-strain.ts)
(~line 186) already names this exact mismatch.

### 2. The raise gate is unreachable, so the presenter is stuck at 720p/1.5M or flaps

`uplinkBps` is `availableOutgoingBitrate`
([`hls-source-quality.ts`](../../client/src/lib/hls-source-quality.ts)).
[`screen-upload-budget.ts`](../../client/src/lib/screen-upload-budget.ts)
already documents that this estimate "only probes a little above what it is
currently sending". A sender capped at 1.5 Mbps will rarely report 6 Mbps, so
the 1080p raise almost never happens.

When it briefly does, `reconcileScreenPlan` calls
`applyConstraints({height:{max:1080}})`, the encoder ramps to 4 Mbps, the BWE
dips, and 3 samples (6 s) later it drops back to 720. Each capture-height
change reconfigures three encoders (keyframes, rate-control reset) → bitrate
burst → more `bandwidth` limitation. This is the "inconsistent".

### 3. Simulcast layers scaled from a 1080 declaration explain the "480p"

Layers are declared from the 1080p capture (`scaleResolutionDownBy` 1 / 1.5 / 3).
When the capture is constrained to 720 lines without republishing (pinned
plan), the encoders produce **720 / 480 / 240**. Under bandwidth pressure
Chrome pauses the top layer; `pickActiveVideoSenderLayer` then shows the 480p
layer and the SFU forwards 480p to the egress → all three rungs are a 480p
upscale.

libwebrtc allocates BWE bottom-up (360p and 720p layers are fed first, top
gets the remainder), so the sub-layers starve the only layer the egress uses.
In a watch party, web viewers are on HLS
(`useHls = Boolean(tile.hlsUrl) && !tile.isSelf`). The sub-layers have no
consumer except possibly native/mobile seats. Verify whether `dynacast`
already pauses them (check per-rid fps in `getSenderStats`).

### 4. Co-located egress contends with the SFU *(inference — correlate first)*

Three x264 transcodes ≈ 1.7 of 4 cores on the same box as the SFU/TURN. No
`cpus:` limit in [`tools/sfu/hls/docker-compose.yaml`](../../tools/sfu/hls/docker-compose.yaml).
SFU scheduling jitter shows up in TWCC → presenter BWE drops → `bandwidth`.
Covered in `WATCH_PARTY_HLS_PERFORMANCE.md` §3.

### 5. Viewer side (secondary)

- `abrEwmaDefaultEstimate` seeds 1.8 Mbps; hls.js applies 0.95 → 1.71 Mbps <
  720p30 peak (1800+128k), so every attach/reconnect starts on 480p and climbs.
- `capLevelToPlayerSize: true` caps a non-fullscreen pane at 480p by design;
  cinema/fullscreen must re-evaluate.
- Live window: `SegmentedFileOutput` has no `playlistLength`; 2 s segments,
  `liveSyncDurationCount 4` / `liveMaxLatencyDurationCount 5`; playlist goes
  API proxy → 60 s presign → R2 fetch → rewrite, 1 s cache. Thin margin;
  stalls when any hop is slow.

## Fixes (in order)

### Client — `video-quality.ts`, `livekit-session.ts`

1. **Split `heldForHls` from `capped`.** When held at 720 by the HLS gate,
   top ceiling = `max(SCREEN_BITRATES["720p"], 720p30 rung kbps × 1.25)` ≈
   2.25–2.5 Mbps, never `LARGE_ROOM_SCREEN_BITRATE`. Update `currentScreenPlan`
   to match. Large-room (no HLS) keeps 1.5 Mbps.
2. **`sampleSenders`:** report `ceilingKbps` from
   `publishedScreenPlan.topBitrate` (the applied ceiling), not
   `screenMaxBitrate`. Kills the false "your connection". Test in
   `livekit-session-stats.test.ts`: held-at-720 on a healthy link reads
   `setting`, not `bandwidth`.
3. **Replace the 6 Mbps absolute gate.** Raise when
   `availableOutgoingBitrate ≥ 1.25 × current target` **and**
   `qualityLimitationReason === "none"` for N samples; drop on sustained
   `bandwidth` (existing 3 samples). Minimum dwell ≥30 s between
   capture-height changes. Alternative worth measuring: start at ladder top
   and only drop.
4. **While `hlsSource.ladderTopHeight !== null`:** publish the screen
   single-layer (`simulcast: false`) or keep only the 360p sub-layer. Verify
   iOS/Android seated viewers use `hlsUrl` before removing all sub-layers.
   Requires a republish (blink) once at party start; keep the pin afterwards.
5. Consider `degradationPreference: "balanced"` for the HLS source; measure
   against `maintain-framerate` with `ffprobe -count_frames` on segments.
6. **Telemetry:** while presenting to an egress, sample every 2 s and log (or
   ship on the roster) `rid`, `frameWidth/Height`, `framesPerSecond`,
   `targetBitrate`, `qualityLimitationReason`, `availableOutgoingBitrate`,
   `encoderImplementation`. Today "feels like 25 fps" has no numbers.

### Viewer — `hls-watch-player.tsx`

7. Seed `abrEwmaDefaultEstimate` ≥ 2.5 Mbps or set `startLevel` to the 720p
   index. Keep the last-estimate carry-over.

### Server/ops — `hls-egress.ts`, `hls-ladder.ts`, `tools/sfu/hls/`

8. Set `keyFrameInterval: 2` explicitly in `rungEncodingOptions`. Set a
   `playlistLength` if the SDK version allows (`livekit-server-sdk` 2.17.0
   does not expose it — see the performance doc).
9. `cpus:` limit on the egress container (e.g. 2.5) so a ladder cannot starve
   the SFU; then move egress to its own box (standing recommendation in
   `docs/CAPACITY.md`).
10. Confirm production `LIVE_HLS_LADDER` and `liveHls.orphansStopped == 0` on
    `/api/admin/metrics`.

## Verify (before and after)

- Presenter: `chrome://webrtc-internals` → outbound-rtp per rid:
  `qualityLimitationReason`, `frameHeight`, `framesPerSecond`, `targetBitrate`;
  candidate-pair `availableOutgoingBitrate`. After 1+2: healthy link reads
  `none`/`setting`, not `bandwidth`. After 3: no height changes within 30 s.
- Box: `docker stats` egress vs livekit during a party; correlate BWE dips
  with egress CPU spikes.
- Segments: `ffprobe -count_frames` on a few 2 s TS files per rung — 60
  frames, stable resolution. SPS resolution changes mid-session = flapping.
- Viewer: `LEVEL_SWITCHED` sequence on attach should start at 720p, not 480p.

## Files

| File | What |
|---|---|
| `client/src/lib/video-quality.ts` | `hlsSourceTopHeight`, `screenSimulcastPlan`, `HLS_SOURCE_UPLINK_HEADROOM` |
| `client/src/lib/livekit-session.ts` | `currentScreenPlan`, `publishScreenVideo`, `reconcileScreenPlan`, `sampleSenders` |
| `client/src/lib/hls-source-quality.ts` | `readPresenterUplinkBps` |
| `client/src/hooks/use-voice.ts` | `refreshHlsSource`, 2 s sampler |
| `client/src/hooks/use-share-uplink-strain.ts` | `nextSfuStrainStreak` |
| `client/src/lib/voice-stats-probe.ts` | `describeLimitation` |
| `client/src/components/voice/hls-watch-player.tsx` | ABR seed |
| `server/src/voice/hls-ladder.ts` | `rungEncodingOptions` |
| `server/src/voice/hls-egress.ts` | `segmentOutput` |
| `tools/sfu/hls/docker-compose.yaml` | egress `cpus:` |

A server or `packages/shared` change is `restarts-api`. Client-only is not.
Items 8–9 are ops / SFU box, not an API restart.
