# The broadcast pipeline: an external review, audited, turned into tasks

Status: plan, written 2026-09-13. An outside architecture review of the
watch-party HLS pipeline arrived with thirteen claims and a recommendation to
fork broadcast off into its own service. Section 1 audits every claim against
the code as it stands today. Sections 2 to 5 are the work, numbered `B0.1`,
`B1.2` style so a PR title can cite one.

**Read this with two others and do not duplicate them.**
[`ALWAYS_ON.md`](./ALWAYS_ON.md) (branch `docs/always-on`, PR #561) owns
*availability*: two processes, the edge Worker reading R2 directly, the
offline shell, the database. [`RELOAD_STORM.md`](./RELOAD_STORM.md) (branch
`feat/hls-edge-playlists`, PR #559) owns *playlist load*: the Worker at
`hls.pqp.gg` that collapses per-viewer polling into one origin fetch per rung.
This document owns *the picture itself*: how long a frame takes to reach a
viewer, what it costs to encode, and whether that is worth changing. Where the
three touch, this one defers: `B1.4` is explicitly the segment-bytes half of
A1.2's Worker credentials, and nothing here re-plans A1.3 or A1.4.

The prior art the reviewer was reading is
[`WATCH_PARTY_HLS_PERFORMANCE.md`](../WATCH_PARTY_HLS_PERFORMANCE.md)
(2026-09-10). Several of its facts were true that day and are not true now.
That is the single largest source of error in the review, and `B0.1` exists to
stop it happening a third time.

## 1. Correcting the record

| # | The claim | Status | Evidence |
|---|---|---|---|
| 1 | Transcoder runs on the SFU box | **Wrong in production, right about our docs** | Owner: since 2026-09-12 egress is a dedicated 4 vCPU Vultr box (`216.238.108.42`, container `pqp-egress-prod`, `/opt/sfu/hls/egress.prod.yaml`). Not one repo file says so: `216.238.108.42`, `pqp-egress-prod` and `egress.prod.yaml` return zero hits. Every doc still says co-located: `docs/CAPACITY.md:185-188`, `docs/WATCH_PARTY.md:2497`, `WATCH_PARTY_HLS_PERFORMANCE.md:59-64`. The reviewer read the docs correctly. See `B0.1`. |
| 2 | One decode+encode per rendition, one Track Composite egress per rung | **True as mechanism, wrong on scale** | One `startTrackCompositeEgress` per rung (`hls-egress.ts:3028`, loop at `:3394-3421`), camera its own call (`:3189`); `TrackCompositeEgressRequest` carries one `EncodingOptions` for all outputs (`hls-ladder.ts:15-20`), so each rung pays a full-res decode. **But the default ladder is ONE rung since #478** (`DEFAULT_LADDER = "720p30"`, `hls-ladder.ts:190`). Costs 0.88 / 0.51 are real and ours (`hls-ladder.ts:459-461`, `docs/CAPACITY.md:197-198`) but were measured 2026-09-09 at 4500/1800 kbps; the ladder now encodes 6500/3200, so they understate. The "480p30 = 0.3" the review quotes does not exist: `0.3` is the unmeasured estimate for the 360p30 **camera** rung (`hls-ladder.ts:465`). |
| 3 | 2 s segments, 8-12 s glass to glass, player ~20 s behind | **Stale on segments, right on 20 s, wrong about why** | Code default 2 s (`hls-egress.ts:531`); **production is 4 s since #495** (`docs/WATCH_PARTY.md:1762`, client assumes it at `hls-playback.ts:25`). The ~20 s is `liveSyncDurationCount 5 x 4 s`, deliberate, chosen 2026-09-12 after measurement and called "a YouTube-style cushion, not a race to the edge" (`hls-playback.ts:17-23`). Proxy window 15 segments = **60 s** in production, not the 30 s its own comment says (`hls-live-window.ts:38-39`, stale). "8-12 s glass to glass" is not a number this repo has ever measured. See `B0.3`. |
| 4 | Stall recovery destroys the hls.js instance | **Partially true** | A soft step exists first: `recoverMediaError()` then `startLoad(-1)` plus a live-edge seek, once, for `fatal`/`stall` (`hls-stall.ts:120-129`, `hls-watch-player.tsx:768-786`). `swapAudioCodec` is never called anywhere. But `sequence-stuck` skips recovery entirely, and `reconnect()` is a full rebuild in **every** branch, because the effect is keyed `[activeSrc, attempt]` (`hls-watch-player.tsx:994`) and every branch mutates one of them, including "same session, fresher token only" (`:437`). Five remaining triggers listed in `B1.3`. #450 does not exist in this repo's history. |
| 5 | `maxLiveSyncPlaybackRate` fixed at 1 | **True, and it is a deliberate rollback** | `hls-watch-player.tsx:851`, with the reason above it: 1.5 "sped playback up (and pitched music) whenever the playhead drifted past the sync point, which on the old 10 s window was most of the time". Only occurrence of `playbackRate` in `client/src`. So the review's fix was already tried and reverted. `B1.1` is why a curve is not the same proposal. |
| 6 | Live window fragile | **Partially true, and the Worker does not close it** | 15 segments, in-process `Map` (`hls-playlist-proxy.ts:73`), 1 s render cache (`:151`). A restart does not corrupt anything: the window drops to the egress's five and regrows (`hls-live-window.ts:31-35`). The real fragility is the one ALWAYS_ON's Layer 0 creates: two API processes means a viewer's poll can land on one with no history and watch the window shrink mid-party. #559's Worker caches the origin's rendered body and **carries no window of its own** (`tools/hls-edge/README.md`); that is ALWAYS_ON A1.3, not built. |
| 7 | R2 good, segments lack CDN caching headers | **True, and low priority** | Segment URIs are per-viewer SigV4 presigned GETs against the raw R2 S3 endpoint (`hls-playlist-proxy.ts:563-572`), TTL 900 s quantized into signing buckets (`hls-egress.ts:505`). No custom domain: `LIVE_HLS_PUBLIC_BASE_URL` is deliberately unset (`docs/WATCH_PARTY.md:2495`). Nothing sets `Cache-Control`: the `S3Upload` passed to egress carries credentials and nothing else (`hls-egress.ts:2719-2735`), and `presignGet` supports only a content-disposition override (`lib/s3.ts:495-511`). The S3 API endpoint is not CDN-cached, so every viewer fetches every segment from the bucket. Low priority because R2 answered under 200 ms in the 2026-09-12 measurement and has never been the bottleneck. `B1.4`. |
| 8 | 60-minute tokens in the playback loop | **Partially true, refresh is reactive not absent** | `HLS_VIEWER_TOKEN_TTL_MS = 60 * 60 * 1000` (`hls-viewer-token.ts:44`). The `p` purpose claim from #543 is shipped (`:49-83`). #527's refresh exists but only fires **through the stall watchdog**: `reconnect()` adopts a fresher token (`hls-watch-player.tsx:437`), and `sameHlsSession` deliberately ignores restamped tokens pushed over WS (`hls-playback.ts:67-93`, avoiding pitfall 16's rebuffer-every-30 s). So a party past 60 minutes takes one real interruption, self-healing within the watchdog window. `B1.5`. |
| 9 | Egress watchdog is good | **True** | 10 s tick (`HLS_HEALTH_CHECK_INTERVAL_MS`, `hls-egress.ts:104`), 15 s fresh grace (`:106`), 20 s playlist-stuck (`PLAYLIST_STUCK_MS`, `:117`), 3 restarts per 5 min then a 5 min cooldown (`:119-122`), backoff 2/4/8 capped 15 s (`:123-124`, `:1521-1524`), `rungHealth`/`stillRunning` telling LiveKit's "ended" from a stalled output (`:1658-1701`), `reapForeignEgresses` (`:1732`, arrived in **#433**, not #526), `adoptLiveHlsSession` (`:2145-2224`). Do not touch it. |
| 10 | No state machine, no end-to-end telemetry | **Wrong on server telemetry, true on the rest** | 62 distinct `voice.hls*` events and 16 `liveHls.*` counters (`services/metrics.ts:980-1001`). What is genuinely missing: no session id threaded through the logs (`voice.hlsStarted` logs channelId and egressIds, never the `hls_sessions.id`), no typed lifecycle (state is inferred from which of `ended_at`/`cleaned_at` is null, `schema.sql:3774-3816`), and **zero client playback telemetry**: `sampleVideoPlaybackQuality` feeds an on-screen overlay and is never sent anywhere (`hls-playback.ts:134`, `hls-watch-player.tsx:707-712`). All of Layer B0. |
| 11 | Encoder eats a starved top simulcast layer | **The layer half is fixed; the starvation half is open by design** | Simulcast is off for an HLS share (`video-quality.ts:575-578`, consumed `livekit-session.ts:1370-1374`, #474), pinned at capture resolution with `maintain-resolution` (`video-quality.ts:590-611`, #475), raise-gated on a sustained uplink reading (#453), ladder sized from capture height not LiveKit's declared layer (#461). There is no layer left to pick wrong. What remains: a weak uplink starves the one layer there is, and there is no server lever, because `startTrackCompositeEgress` takes a track id and no quality field (`hls-egress.ts:2021-2029`; `docs/WATCH_PARTY.md:2187`). Mitigation is a 720p publish ceiling plus a host warning. No API exists to select otherwise. |
| 12 | LL-HLS needs a custom encoder path | **True, and cheaper than the review thinks** | `SegmentedFileProtocol` is `{DEFAULT, HLS_PROTOCOL}` and `SegmentedFileOutput` has no fMP4, CMAF, partial-segment or part-target field (livekit/protocol `livekit_egress.proto`). `StreamProtocol` does carry `RTMP`, `SRT` and `WEBSOCKET`, so a hand-off exists. Section 4 sizes it, and finds a cheaper door than the review's. |
| 13 | Hardware encoding | **Not available where we run, and not needed** | Vultr's plans API: **zero GPU plans list `sao`**. Cheapest anywhere is `vcg-a16-2c-8g-2vram` at $43/mo in ewr/atl/fra/sjc/sgp/blr. `sao`'s own region options do not include GPU at all. LiveKit egress has no GPU path either (livekit/egress#170, open since Nov 2022, no maintainer answer). Section 5. |

Three corrections matter more than the rest. **The default ladder is one rung**,
so "one decode per rendition" costs us one decode, and the review's headline
saving is worth about 0.5 of a core. **The 20 s cushion is a product decision
made after measurement**, not a bug, so any proposal to shrink it is re-opening
a decision rather than fixing a defect. And **the presenter already publishes
single-layer H.264 pinned at capture resolution** (`livekit-session.ts:1404`),
which nobody has yet noticed is the precondition for encoding nothing at all.

## 2. Layer B0: measure first

Nothing below B0 should ship before B0 does. Every number in the review, ours
included, is either a synthetic bench from 2026-09-09 or an estimate, and the
one quantity the whole argument turns on, how long a frame actually takes, has
never been measured on this product once.

**B0.1 - Write down what production is, and date it.** Update
`docs/CAPACITY.md:185-188`, `docs/WATCH_PARTY.md:2497` and
`WATCH_PARTY_HLS_PERFORMANCE.md:59-64` with the dedicated egress box: host,
plan, vCPU, container name, config path, and which of LiveKit / TURN / Redis
stayed on `sfu-pqp` (`216.238.114.79`). Reconcile
`tools/sfu/hls/docker-compose.yaml`, whose header still says "do not add this
to production" about a thing production has been running since 2026-09-08.
Record production's `LIVE_HLS_LADDER` and `LIVE_HLS_SEGMENT_SECONDS`, which
`liveHls.ladder` on `/api/admin/metrics` already reports and
`WATCH_PARTY_HLS_PERFORMANCE.md:213` has had as an open action item for three
days. Fix the two stale comments this audit found: `hls-live-window.ts:38-39`
("15 x 2 s = 30 s", it is 60 s) and the "default two-rung ladder" in
`docs/WATCH_PARTY.md:2627`. Half a day, and it is what stops the next review
being wrong about claim 1.

**B0.2 - Find out whether the egress writes `EXT-X-PROGRAM-DATE-TIME`.**
Everything else in B0 is cheap if it does and awkward if it does not. Our
proxy already preserves the tag when it is there
(`SEGMENT_TAG_PREFIXES`, `hls-live-window.ts:89`); LiveKit builds playlists
with grafov/m3u8, which supports it. Fetch one rung's `.m3u8` off a live party
and look. **If present**, a viewer can compute wall-clock latency with no new
server work at all. **If absent**, the proxy synthesises one: it knows the
wall clock at which it first saw each media sequence, so it emits its own PDT
on the oldest entry it has ever seen and lets `#EXTINF` carry the rest. Either
way the client ends up with a wall clock on the media timeline. Half a day.

**B0.3 - The T0..T8 chain, mapped to what we can honestly stamp.** The review
asks for nine timestamps. Four are real stamps, and the rest are an estimate,
and the plan says which is which rather than presenting an estimate as a
measurement.

| Span | What it is | How we get it |
|---|---|---|
| T0-T1 | drawn on the presenter's display, to captured | **Not stampable.** `VideoFrameCallbackMetadata.captureTime` is not populated for `getDisplayMedia` in Chromium. Folded into the estimate below. |
| T1-T3 | captured, encoded, through the SFU | **Estimated**, not stamped: presenter `RTCOutboundRtpStreamStats` plus half the RTT we already sample in `sfu-stats.ts`. Label it an estimate in the panel. |
| T4-T5 | egress decodes, encodes, PUTs the segment | **Stamped** by PDT (B0.2): the wall clock of the segment's first sample. |
| T5-T6 | in the bucket, to listed in the playlist a viewer polls | **Stamped exactly.** `LiveWindowHistory` already holds one entry per media sequence; add `firstSeenAt` when an entry is first merged. This is the span that goes wrong quietly, and it is the one nothing watches today. |
| T6-T7 | listed, to fetched by the viewer | **Stamped** client-side from hls.js `FRAG_LOADED` (`frag.stats.loading.start/end`). |
| T7-T8 | fetched, to painted | **Stamped** client-side by `requestVideoFrameCallback` against `video.currentTime` and the fragment's PDT. |

So: **T4 to T8 is measured exactly**, and is the part we can act on. T0 to T4
is an estimate carried alongside it and never added into a number we call
measured. Report both, separately, and never a single "glass to glass" figure
that silently mixes them. One and a half days.

**B0.4 - A `stream_id` through every line.** `hls_sessions.id` is already a
UUID (`schema.sql:3774-3816`) and already unique per session. Thread it
through every `voice.hls*` payload that has a session in scope, starting with
`voice.hlsStarted` (`hls-egress.ts:3506-3526`), which today logs `channelId`
and `egressIds` and leaves the reader stitching on a time window. Put it in
the playlist too, as `#EXT-X-SESSION-DATA`, so a client telemetry row names
the same session the server logs do. Do **not** add a status enum to
`hls_sessions`: state inferred from `ended_at`/`cleaned_at` nullability is
load-bearing in `hls-cleanup.ts` and in the boot reconcile, and a second
source of truth for the same thing is how pitfall 12 happened. Half a day.

**B0.5 - Client playback telemetry, sampled not streamed.** One `POST
/api/voice/hls-telemetry` carrying, per viewer per 30 s: `stream_id`, rung,
time to first frame, rebuffer count and seconds since the last report, the
PDT-derived latency from B0.3, dropped/total frames (already computed and
thrown away at `hls-playback.ts:134`), and the player's own live-edge
distance. Sample it: one in N viewers, N falling as the audience grows, so a
600-viewer party costs the API a handful of writes a minute and not 600. This
is the only new **write** path in B0, it lands on the pool ALWAYS_ON A3 is
trying to protect, and it must be droppable under load: a 503 from this
endpoint is a no-op the client never retries. One day.

**B0.6 - The panel.** Add a `liveHls.latency` block beside the existing
`liveHls` object in `services/metrics.ts:980-1001`, carrying p50 and p95 of
each measured span from B0.3 per rung, the oldest `firstSeenAt` gap, and the
count of viewers reporting. Render it in `tools/admin-dashboard/site/`
alongside the `liveHls` counters that are already there. Half a day.

**Acceptance for B0:** during one live party, the dashboard shows, per rung,
p50 and p95 for encode-to-paint, broken into its four measured spans, with the
capture-to-encode estimate shown separately and labelled as an estimate. No
task below may be argued for without pointing at this panel.

## 3. Layer B1: cheap wins inside the pipeline we have

All of these live in the current architecture. None needs a new service.

**B1.1 - A latency-aware catch-up curve, not a flat multiplier.** The flat
`maxLiveSyncPlaybackRate: 1.5` was shipped and reverted for a good reason
(`hls-watch-player.tsx:848-850`): against the old 10 s window the playhead was
past the sync point most of the time, so 1.5x was not catch-up, it was the
normal playback speed, and it pitched the music. The curve is a different
proposal: 1.0x inside the cushion, ramping to at most 1.2x only past it, so it
engages on a viewer who fell behind and never on one who is where the design
wants them. Set `maxLiveSyncPlaybackRate: 1.2` and drive the rate from
distance in `hls-live-edge.ts`, beside the existing `isBehindLive` /
`BEHIND_LIVE_THRESHOLD_SECONDS` logic (`hls-playback.ts:247-254`) that already
decides when to offer the jump-to-live button. Ship it only after B0.3 can
show what fraction of viewers are actually outside the cushion: if that number
is near zero, this task is not worth its risk and should be dropped rather
than shipped. One day, gated on a B0 reading.

**B1.2 - A longer DVR window at the origin.** `LIVE_HLS_WINDOW_SEGMENTS` is
already the knob and already 15 (60 s in production). The objects are in the
bucket until the session ends (`hls-cleanup.ts` only deletes finished
sessions), so a wider window costs memory in one `Map` and nothing else, and
`MAX_LIVE_WINDOW_SEGMENTS` is 120. Raise it once B0.3 reports the p95 of the
T5-T6 span and the real distribution of how far behind viewers sit. This is an
operator change, not a deploy. Half a day, mostly reading the panel.

**B1.3 - Never rebuild the player unless it is unrecoverable.** The five
remaining triggers, all reached through `reconnect()` because the effect is
keyed `[activeSrc, attempt]` (`hls-watch-player.tsx:994`):
1. `:380` a genuinely new session (different `startedAt`). **Keep.** A new
   egress session is a new media timeline; rebuilding is correct.
2. `:433` reconnect found a different session. **Keep**, same reason.
3. `:437` same session, fresher `?t=` only. **Remove.** Swap the token into
   the loader via `xhrSetup` or a `url` rewrite on the existing instance. No
   media timeline changed; there is no reason to drop the buffer.
4. `:439` API unreachable or URL unchanged, bump `attempt`. **Remove for the
   URL-unchanged case.** If nothing changed, retry the fetch on a backoff and
   leave the player alone.
5. `:789` the watchdog returning `"reconnect"`, which is every
   `sequence-stuck` tick. **Narrow.** `sequence-stuck` means the egress is not
   advancing, which a client rebuild cannot fix and which the server-side
   watchdog (claim 9) is already restarting. Let the player hold its buffer
   and keep polling; rebuild only once the playlist advances onto a sequence
   the player cannot reach from where it sits.
   Plus `:449` the manual "try again" on `phase === "dead"`, which should stay
   a rebuild because it is a person saying so.
   One and a half days, and every removed trigger needs a test in
   `hls-stall.test.ts` asserting the instance identity survives.

**B1.4 - Segments through the Worker, cached at the edge.** This is the
segment-bytes half of ALWAYS_ON **A1.2** (the Worker's own read-only R2
credentials) and must land after **A1.1**. Today each viewer fetches each
segment from the raw R2 S3 endpoint on a URL signed for them alone, so no two
viewers ever share a cache entry and Cloudflare never sees the request. With
A1.2's credentials in hand the Worker serves `/{stream_id}/{rung}/{seq}.ts`
itself from the R2 binding, validated by the same viewer token it already
checks for playlists, and returns `Cache-Control: public, max-age=31536000,
immutable` with the Cache API keyed on the path and **not** the token. A
segment is immutable by construction, so one colo fetch serves every viewer in
that city. Keep the bucket private: no custom domain, no `r2.dev`, no
presigned URL in a viewer's hands, which also satisfies ALWAYS_ON A2.5. The
playlist rewriter (`hls-playlist-proxy.ts:563-572`) stops signing and starts
emitting Worker paths. **Rank this low.** R2 answered under 200 ms in the
2026-09-12 measurement and segments have never been a bottleneck; the real
prizes are one stable URL per segment instead of one per viewer, and no signed
credential on the client. Two days, after A1.1.

**B1.5 - A token that lasts the party, checked at the edge.** Today the TTL is
60 minutes and the refresh is reactive, so a three-hour film takes two
interruptions that self-heal through the stall watchdog. This is the same
question ALWAYS_ON **A1.5** asks and it should be answered once, here, with
the numbers B0 provides: a party-lifetime token minted at session start with
the same HMAC shape and the same `p` purpose claim (`hls-viewer-token.ts`),
bounded by the session rather than by a clock, so it dies when the party does.
The revocation cost is real and is the reason A1.5 says "spec it, do not build
it blind": the Worker's playlist cache already lets a kicked viewer ride a
warm rung (`tools/hls-edge/README.md` says so), and a longer token widens that
window. The resolution is that revocation belongs to `hls-revocation.ts` and
the Worker should consult it, not that the token should stay short. Spec
inside this document's scope; build under A1.5. One day to spec.

**B1.6 - Source health selection: there is no API, so do not plan one.**
Claim 11's remaining half has no server-side lever. `TrackCompositeEgressRequest`
takes a track id and no quality field, and simulcast is deliberately off for
an HLS share, so there is no second layer to fall back to even in principle.
The only real work here is making the existing host-side warning land earlier,
which `WATCH_PARTY_UPLINK_QUALITY.md` already owns. **No task. Closed as
already-handled-elsewhere**, recorded here so the next review does not
re-open it.

## 4. Layer B2: the fork, and a cheaper door into it

The review is right that LL-HLS means leaving LiveKit egress.
`SegmentedFileProtocol` is `{DEFAULT_SEGMENTED_FILE_PROTOCOL, HLS_PROTOCOL}`
and `SegmentedFileOutput` has no field for fMP4, CMAF, partial segments or a
part target. There is no configuration that gets us there.

Where the review is wrong is the shape of the fork. It proposes one decode
feeding N encodes, which is the right answer when N is large. **N is one.** So
priced as the review prices it, a new service, new failure modes and the
watchdog in claim 9 reimplemented buys us 0.5 of a core and the latency.

The cheaper door is a fact none of the docs connect. The presenter publishes
**H.264** (`livekit-session.ts:1404`, chosen for hardware encode on Macs),
**single layer** (`video-quality.ts:575-578`, #474), **pinned at capture
resolution** with `maintain-resolution` (`video-quality.ts:590-611`, #475).
That is already a clean, single, hardware-encoded H.264 elementary stream. A
headless LiveKit subscriber can take its RTP and **remux it into CMAF parts
without decoding anything**. Not one decode for N renditions: **zero decodes
and zero encodes** for the only rendition production ships. The 0.51 core
becomes something closer to 0.05, and the latency becomes the segment part
duration.

**One thing decides whether this works, and it is measurable this week.** HLS
segments must begin on an IDR. Under WebRTC the publisher owns the keyframe
cadence, and Chromium's screen-share encoder emits IDRs on scene change and on
request, not on a clock we choose. If the published stream carries usable IDRs
at or near a part boundary, passthrough works. If it does not, we must request
them, and a PLI every two seconds degrades the same track for everyone seated
in the room watching over WebRTC. That trade is the gate.

**B2.1 - Measure the published keyframe cadence.** On a live party, subscribe
headlessly and log IDR arrival times for ten minutes across three content
types: a film, a game, a mostly-static desktop. Report the distribution, not
the mean. Half a day, and it decides everything after it.

**B2.2 - Measure what a forced keyframe cadence costs the seated room.**
Request keyframes at a 2 s cadence on the same track and measure the seated
viewers' bitrate and quality against a control run. If the cost is invisible,
passthrough is available unconditionally. One day.

**B2.3 - The gate.** Proceed to B2.4 only if **all** of: B0.3 shows measured
encode-to-paint p95 above 10 s; B2.1 or B2.2 shows IDRs available at part
cadence without hurting the seated room; and there is a stated product reason
to want 2 to 4 s, which a film night does not obviously have and a live
reaction stream does. Any one failing means stop, and say so in this document.

**B2.4 - Build it, if the gate opens.** A small service beside the egress box:
a LiveKit subscriber (Go or Rust SDK) that depayloads H.264 to fMP4 parts,
writes an LL-HLS playlist with `EXT-X-PART` and `EXT-X-PRELOAD-HINT`, and PUTs
to the same bucket under the same prefix layout. Lower rungs, if we ever want
them back, are one decode feeding K encodes off the same subscriber, which is
the review's architecture arriving as a later option rather than a
precondition. Clients already support it: hls.js has had `lowLatencyMode`
since 1.0 and we ship 1.7.2, iOS AVPlayer supports LL-HLS natively, Android
Media3 does too. The hand-off if a subscriber proves impractical is
`StreamProtocol.SRT` out of LiveKit egress into FFmpeg, but note honestly that
this costs an **extra** decode and encode hop rather than saving one, and is
strictly worse than passthrough. Four to six days. **Do not start it before
B2.3.**

**What it costs even when it works**, stated plainly so the gate is honest: a
second service with its own crash, restart and adoption semantics; the claim-9
watchdog reimplemented against a pipeline that reports health differently;
`adoptLiveHlsSession`'s across-a-deploy inheritance rewritten; and a second
media path to keep working on four clients. The current one took two months
and fifteen numbered pitfalls to get right.

## 5. Layer B3: encoder scaling

**B3.1 - Right-size the one box first.** One party today is 0.51 core for the
720p30 rung plus roughly 0.2 to 0.3 for the camera, call it 0.8 of 4 cores.
`LIVE_HLS_MAX_SESSIONS` is 3, which is about 1.8 cores, so the dedicated
4 vCPU box has headroom it did not have when this all ran beside the SFU. The
upgrade step, if B0.6 ever shows sustained pressure, is `vhp-8c-16gb-amd`,
4 vCPU to 8 for $48 more a month. Do it on a reading, not on a feeling.

**B3.2 - A second egress box on demand, not standing.** The postmortem's §A10
already proposes this shape: snapshot plus reserved IP, created before a
party, destroyed after. At $48/mo a 4 vCPU box is about $0.066 an hour, so a
four-hour film night is 27 cents. Worth building only once a single box has
actually refused a party, which `voice.hlsSessionsCapped` will say.

**B3.3 - Hardware encoding: no.** Vultr lists **no GPU plan in `sao`**; the
region's own options do not include GPU. The cheapest GPU anywhere on Vultr is
$43/mo (A16, 2 GB VRAM) in ewr, atl, fra, sjc, sgp or blr, all of which mean
moving the encoder out of Brazil and adding roughly 110 ms each way between
the SFU and the thing encoding its output, against a plan whose entire premise
is that everything stays in `gru`. LiveKit egress has no GPU path either
(livekit/egress#170, open since November 2022). And x264 covers the load with
room to spare per B3.1. Revisit only if B2.4 ships and a real ladder comes
back with it.

## 6. What this costs

| Item | Today | After | Delta |
|---|---|---|---|
| SFU box `sfu-pqp` (`vhp-4c-8gb-amd`) | $48/mo | $48/mo | 0 |
| Egress box, dedicated 4 vCPU | $48/mo | $48/mo | 0 |
| B3.1 upgrade to `vhp-8c-16gb-amd`, only on a reading | - | $96/mo | +$48/mo |
| B3.2 second box, on demand, 4 h party | - | ~$0.27/party | negligible |
| R2 storage and egress (10 min retention, egress free) | ~$0 | ~$0 | 0 |
| Cloudflare Workers (already paid for `pqp-admin`) | $5/mo | $5/mo | 0 |
| B0 telemetry writes | - | within the pool budget, sampled | 0 |
| GPU box (B3.3, rejected) | - | $43/mo **and out of Brazil** | not taken |

B0 and B1 are engineering time and no new money. B2.4 is four to six agent-days
and no new money until it needs its own box.

## 7. What not to do

- **No multi-region.** Same reasoning `ALWAYS_ON.md` closes with: the audience
  is Brazilian and everything stays in `gru` on purpose.
- **No GPU, now or soon.** B3.3. It is not sold where we run.
- **Do not add a status enum to `hls_sessions`.** B0.4. A second source of
  truth for a lifetime the cleanup path already reads is pitfall 12's shape.
- **Do not touch the egress watchdog.** Claim 9 is the one thing the review
  and this audit agree is right.
- **Do not re-ship a flat `maxLiveSyncPlaybackRate` above 1.** It was tried and
  reverted for a reason that is written down. B1.1 is a curve or it is nothing.
- **Do not shrink the 20 s cushion because it sounds large.** It was chosen on
  2026-09-12 after a measured rig found seventeen window misses in four
  minutes. A watch party is not interactive. Change it only against B0.3.
- **Do not start B2.4 before B2.3.** The whole value of B0 is that this one
  decision gets made on numbers.

## 8. Order of work

1. **B0.1** docs, **B0.2** PDT probe. Half a day each, no dependencies, and
   B0.2 shapes everything after it.
2. **B0.3** the stamps, **B0.4** the `stream_id`. Two days, parallel.
3. **B0.5** client telemetry, **B0.6** the panel. One and a half days.
4. **B1.3** stop rebuilding the player. One and a half days, no dependency on
   B0, the clearest defect in the audit, and the one a viewer feels.
5. **B1.2** widen the window, on a B0.6 reading. Half a day.
6. **B1.1** the catch-up curve, gated on B0.3 saying it is worth it. One day,
   or dropped.
7. **B2.1** and **B2.2** the keyframe measurements. One and a half days. These
   can run any time after B0.1 and should run early, because they are cheap
   and they decide a large question.
8. **B1.5** spec the party-lifetime token, hand to ALWAYS_ON A1.5. One day.
9. **B1.4** segments through the Worker, after ALWAYS_ON A1.1 and A1.2. Two
   days, low priority.
10. **B2.3** the gate. A decision, written into this file either way.
11. **B2.4** only if the gate opens. Four to six days.
12. **B3.1** / **B3.2** on a reading, not on a schedule.

Roughly 9 to 11 agent-days through B2.3, plus 4 to 6 more only if the gate
opens. B0 is 4 of those days and nothing else should start without it.
