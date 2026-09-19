# Watch-party HLS: seamless restart (A) and passthrough conventional (B)

Two changes to the watch-party HLS pipeline, each behind a flag that defaults
OFF. Default-off is the rollback and the safe-deploy: merging the code changes
nothing in production until an operator sets the flag.

This document is the design and the staged plan. It is written after a deep
read of the live path and one architectural review, and it corrects the
premise the work started from. **The code in this first PR is only the parts
that are safe to land before the staging H.264-presenter rig exists**: the Go
standard-latency passthrough segmenting tests (mechanism B's foundation) and
this plan. The live-path wiring is scoped below and gated on the rig.

Status: **plan + B segmenting proof landed; live-path wiring not started.**

---

## The two mechanisms in one line each

- **A. Seamless restart** (`LIVE_HLS_SEAMLESS_RESTART`, default off): when an
  HLS egress/session restarts, keep the viewer-facing session identity stable
  (URL, token, `startedAt`) and bridge the media gap with `#EXT-X-DISCONTINUITY`
  so the player continues instead of re-attaching.
- **B. Passthrough conventional** (`LIVE_HLS_PASSTHROUGH`, default off): produce
  a watch party's standard-latency HLS by REPACKAGING the presenter's H.264
  (no decode, no re-encode) on the `pqp-remux` box, instead of the stock
  transcoding LiveKit egress, so a corrupt frame is a brief glitch rather than
  a decode stall. Falls back to the stock egress on VP8 or any failure.

Priority: A is the stated priority, but see the seam finding below, which
changes what "A" should actually be. B is lower risk and attacks the reliability
root cause directly.

---

## The seam finding that changes mechanism A

The work was framed as: on a restart the viewer re-attaches (~40s holding
screen), so keep the identity stable and bridge a ~2s discontinuity instead.
**That premise is wrong against the code, and building the stitch alone would
not deliver a seamless restart.**

A conventional restart today, in `server/src/voice/hls-egress.ts`:

| Stage | Constant | Worst case |
|---|---|---|
| Health monitor notices the dead/stuck primary | `HLS_HEALTH_CHECK_INTERVAL_MS` = 10s poll | up to 10s |
| Stuck-playlist confirmation (the stall half of "ended") | `PLAYLIST_STUCK_MS` = 20s | 20s (skipped when LiveKit reports the egress ended outright) |
| Restart backoff | `RESTART_BACKOFF_BASE_MS` = 2s (then 4s, 8s, capped 15s) | 2s on the first restart |
| Find the screen track again | `TRACK_FIND_ATTEMPTS` = 16 x ~400ms | up to ~6s |
| New egress cold start + first 4s segment in R2 | `PLAYLIST_WAIT_ATTEMPTS` = 45 x ~1s | seconds to ~45s |

So the seam is **~25 to 50s for a stuck-playlist restart, ~15 to 25s for a
clean egress death**, and it is dominated by SERVER-SIDE detection and egress
cold start, not by the client re-attach. The "~40s holding screen" that
watch-party nights show is this gap, not the re-attach.

Three consequences for A:

1. **The holding screen fires regardless of `startedAt` stability.** During the
   seam the proxy serves a FROZEN playlist: the old generation stops advancing
   its `#EXT-X-MEDIA-SEQUENCE` and the new generation's media does not exist yet
   (it is still inside `waitForLivePlaylist`). The client's watchdog
   (`client/src/lib/hls-stall.ts`, conventional `sequenceStuckMs` = 20_000)
   fires `sequence-stuck` at 20s of a frozen sequence and shows "A transmissão
   reiniciou" whether or not the URL changed. The buffer (~3 target durations,
   ~12s) drains well before that. The discontinuity bridge only helps at the
   VERY END of the gap, once the new generation's first segment lands.

2. **What the stitch actually buys** is therefore narrow but real: at the end
   of the gap the player does NOT tear down, re-negotiate the ladder, and
   rebuffer from a cold master (`client/src/components/voice/hls-watch-player.tsx`
   keys re-attach on the URL path `.../<channelId>/<startedAt>` via
   `sessionRef`/`hlsSessionKey`, and `reconnect()` with a stable `startedAt`
   holds rather than re-attaching because `sameHlsSession` is true). It removes
   a few seconds of rebuffer and a ladder renegotiation from a 40s gap and
   turns the holding screen's tail into a continue-across-discontinuity. It
   does NOT make the restart "seamless (~2s)".

3. **The bigger continuity win is in detection latency**, which the stitch does
   not touch: a LiveKit egress-ended webhook instead of the 10s poll, and
   skipping `PLAYLIST_STUCK_MS`'s 20s confirmation on the FIRST restart of a
   session (it exists because a killed egress node is reported ACTIVE forever,
   pitfall 15, so it must stay for repeat restarts). That is a separate, lower
   risk project and is where most of the 40s lives.

**Recommendation for A: measure the seam from production first**
(`voice.hlsEgressDied` to the next `voice.hlsStarted announced=true`, per
channel, over a real party). If the median gap is over ~12s, spend the effort
on detection latency, then add the stitch as the finishing touch. Do not land
the stitch on the live path until that number says the client would ride
through the tail. This session cannot measure it (no prod/staging access, rig
not ready), so A stays a plan.

---

## Mechanism A design (for when it is built)

### The identity split

`startedAt` is the session identity today, and it is ONE number used for two
different jobs:

- **Viewer-facing**: the playlist URL `viewerPlaylistUrl(channelId, startedAt)`,
  the viewer token's `s` claim (`hls-viewer-token.ts`), the `voice-stream`
  frame, and the client's re-attach key.
- **Physical**: the R2 object prefix `live/<channel>/<startedAt>-<rung>` the
  stock egress writes segments and its own media playlist into
  (`hlsObjectPrefix`), and ~17 sites in `hls-egress.ts` plus ~37 in
  `hls-history.ts` that group a session (and a replay) by it.

Seamless restart needs the viewer-facing number stable across a restart and
the physical number to change (a stock egress restart reuses segment filenames
and resets its media sequence to 0, so reusing the prefix would overwrite live
segments). So:

- Introduce a **logical** `startedAt` (viewer-facing, stable) and a **physical**
  `startedAt`/prefix (per egress generation). Today they are equal; keep them
  equal when the flag is off. `LiveHlsStream.startedAt` and `.hlsUrl` carry the
  logical one, so the token and the `voice-stream` frame follow automatically
  (both derive from `stream` in `stampViewerStream`).
- Add `hls_sessions.logical_started_at` (NULL means "same as the physical
  `started_at`", i.e. flag-off behaviour byte-for-byte). A flag-on restart
  records the new physical generation under the SAME `logical_started_at`.

### The proxy stitch (durable base, not per-process)

`renderSignedPlaylist` (`hls-playlist-proxy.ts`) looks a session up by physical
`object_prefix` with `ended_at IS NULL`. Under the split it must resolve the
LOGICAL `startedAt` to the NEWEST live physical generation and serve that,
bridging from the previous generation's frozen tail with one
`#EXT-X-DISCONTINUITY`.

**The one thing that strands viewers, and the rule that prevents it:** the
media-sequence base MUST be durable and shared, never computed from the
per-process `windowHistory`. Today `#EXT-X-MEDIA-SEQUENCE` is the egress's own
number, so every process and both machines emit byte-identical playlists. A
rebase computed in-process diverges across an API restart
(`adoptRunningLiveHlsSession` reconstructs the physical `startedAt` from
`parseHlsObjectPrefix`, not the logical one) and across the second machine
(the keep-warm handover in `hls-playlist-proxy.ts`). A viewer bouncing through
Cloudflare would then get a non-monotonic `#EXT-X-MEDIA-SEQUENCE`: hls.js fatal,
Safari native stuck for the whole film. This is pitfall 12/13 territory for a
flag production would flip.

So write the sequence base and the discontinuity count onto the generation row
at restart time (`hls_sessions.sequence_base`, `hls_sessions.discontinuity_seq`),
and have every process render from the row. `LiveWindowHistory`
(`hls-live-window.ts`) already detects a generation boundary ("newest seq <
held, start over"); extend it to REBASE onto the durable base plus emit one
`#EXT-X-DISCONTINUITY` on the new generation's first segment, rather than
clearing. Conventional segments are MPEG-TS (`hls-ladder.ts`), so there is no
`#EXT-X-MAP` reset to bridge, only the discontinuity.

### What the edge and client already do right

- **Edge** (`tools/hls-edge`): the conventional media-playlist route forwards
  the API's bytes verbatim (2s cache, no SWR) and conventional segments are
  presigned R2 URLs that bypass the edge entirely, so a `#EXT-X-DISCONTINUITY`
  the proxy emits passes through with NO edge change. The edge keys a session
  on `(channelId, startedAt)` only, so a stable logical `startedAt` is "the same
  session" to it. (The LL renderer deliberately strips discontinuity and its
  immutable media cache assumes non-resetting filenames, so if A is ever wanted
  for LL it is a separate, harder problem. A is conventional-path only.)
- **Client**: keys re-attach on the URL's `startedAt`; a stable one means no
  re-attach and `reconnect()`/`sameHlsSession` holds instead of tearing down.
  `GET /live` returns the same logical session, so `sessionOver`
  ("over"/"awaiting") never fires during a seamless restart. The one client
  change worth landing with A is a vitest proving the player continues across a
  media-playlist discontinuity without the holding screen when the session URL
  is unchanged.

### Invariants A must not break (pitfalls 12-16, the lifecycle doc)

- Retention (`hls-cleanup.ts`) deletes by physical `object_prefix` after
  `ended_at` plus a minutes-long grace. A restart stamps the old generation
  `ended_at`, but its tail only needs to survive the ~60s window, far under the
  grace, so retention will not delete an in-window generation. The stitch must
  still degrade gracefully when an old generation's objects are gone (drop it
  off the window).
- The two-driver rule (pitfall 7): every "what is playing here" reader asks
  conventional AND LL. The logical/physical split is conventional-only; keep
  `liveHlsStreamFor ?? llStreamFor` intact.
- The blast radius is `hls-egress.ts` (~17 physical-`startedAt` sites) and
  `hls-history.ts` (~37 replay-grouping sites). Every one must keep using the
  PHYSICAL number; only the four viewer-facing carriers move to logical. This
  is the review surface, and it is large enough that A is its own PR.

---

## Mechanism B design (passthrough conventional)

### Why it is the lower-risk, root-cause change

The stock LiveKit egress DECODES the presenter's H.264 and re-encodes an ABR
ladder; a corrupt frame stalls the decode, the playlist stops for 20s,
`rungHealth` kills and restarts it, and every restart is the 40s gap above. The
`pqp-remux` service (`tools/pqp-remux`, our own Go code) already does H.264
PASSTHROUGH: it repackages access units into CMAF without decoding, drops
damaged frames and requests an IDR (PR #700), and never re-encodes. Passthrough
turns a corrupt frame into a brief glitch, which removes the most common cause
of the fragile restarts A is trying to paper over.

### It is a sizing choice, not a new code path

The remux fragmenter (`internal/pipeline/fragmenter.go`), depacketizer, ring
and conventional playlist (`ring.Playlist()`) are all sizing-agnostic. LL-ness
is purely `PART_MS=500 / SEGMENT_MS=4000 / RING_SEGMENTS=6` plus the edge
rendering LL parts on top. A standard-latency passthrough is the same pipeline
with larger numbers (e.g. 2s parts, 6s segments, a deeper ring) and NO LL part
rendering: `ring.Playlist()` is already a conventional media playlist with
`#EXT-X-TARGETDURATION`, `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-MAP` and one
`#EXTINF` + `seg-<n>.m4s` per sealed segment.

**This PR proves that**: `internal/pipeline/fragmenter_std_latency_test.go`
pins the boundary rules at a 2s-part / 6s-segment profile (parts cut at the
target, a 6s segment closes only on the first IDR at or after 6s and never on a
mid-segment IDR, `SegmentDuration >= PartDuration`), reusing the existing box-
level test helpers. The three sizing-coupled invariants the mode depends on are
covered: `SegmentMS >= PartMS` (`config.Validate`), the elastic
segment-close-on-IDR, and the part cadence (which feeds `partFloorTicks` and the
watchdog's `PART_MS + REORDER_HOLD_MS` stuck threshold).

### The wiring (next PRs, gated on the rig)

1. **Sizing profile + rung**: a standard-latency profile in
   `remuxSessionConfig()` (`hls-remux.ts`) sent in the `StartSessionRequest`
   body, and a DISTINCT rung label (today `rung`/`RUNG` is hard-coded `"ll"` in
   `remux_pipeline.go` and `config.go`) so R2 keys and the playlist front do not
   collide with an LL session.
2. **Mode fork**: `resolveHlsModeForChannel` gains a `passthrough` answer beside
   `ll` and `conventional`, gated by `LIVE_HLS_PASSTHROUGH` (+ an allowlist,
   mirroring `LIVE_HLS_LL_ALLOWLIST`). `reconcileLiveHlsNow` routes it to the
   remux instead of the stock ladder.
3. **Serving**: the standard-latency passthrough playlist is CMAF via the remux
   origin + edge, so it reuses the LL serving seam but without blocking reload /
   LL part tags. Confirm the edge conventional-vs-LL routing
   (`requestsLlMode`, `playlistOriginKindForRung`) sends a passthrough rung down
   a non-LL render.
4. **Fallback, the critical requirement**: VP8 cannot be repackaged into HLS.
   The remux is H.264-only by construction (it subscribes by
   `Source()==SCREEN_SHARE`, not codec; a VP8 source never yields an IDR and the
   watchdog demotes it via the generic `no-video` path). So the SAME demotion
   machinery that LL uses (`sweepLlDemotions` -> `notifyChanged` -> reconcile
   onto the conventional ladder) is the fallback for both VP8 and a passthrough
   that fails to start. Keep the stock-egress ladder path fully intact as the
   demotion target. A demotion is a real re-attach (new `startedAt`); that is
   acceptable and is the existing behaviour.

Single rendition (the presenter's own encoding) is expected; there is no ABR
ladder in this mode.

---

## Flags (both default off)

| Flag | Default | Effect |
|---|---|---|
| `LIVE_HLS_SEAMLESS_RESTART` | off | When on, a restart keeps the logical `startedAt` and the proxy stitches generations with `#EXT-X-DISCONTINUITY`. Off = today's new-`startedAt`-per-restart, byte-for-byte. |
| `LIVE_HLS_PASSTHROUGH` | off | When on (and the channel is allowlisted), a party's conventional stream is produced by the remux repackaging H.264 instead of the stock transcoding egress. Off = stock egress ladder, byte-for-byte. Falls back to the stock egress on VP8 or any start failure whether on or off. |

Neither is wired in this PR, so neither is added to `.env.example` yet (that
file lists live env). They are added to `.env.example` and the CLAUDE.md env
table in the PR that wires each, with default-off stated, per repo convention.

---

## Staging test matrix (needs the H.264 presenter rig)

| Case | Mechanism | What to assert |
|---|---|---|
| Kill the primary egress mid-party, flag on | A | The viewer URL, token and `startedAt` are unchanged; the served playlist gains one `#EXT-X-DISCONTINUITY` and its `#EXT-X-MEDIA-SEQUENCE` never goes backwards; the player continues without a full re-attach. |
| Same, across two API machines + Cloudflare | A | `#EXT-X-MEDIA-SEQUENCE` is identical from both machines (the durable-base check). This is the strand-everyone case; it must pass before the flag is considered. |
| API restart (deploy) mid-party, flag on | A | `adoptRunningLiveHlsSession` restores the logical identity, not just the physical one. |
| H.264 presenter, flag on | B | The stream plays as a single standard-latency rendition; a deliberately corrupted frame is a glitch, not a 20s stall + restart. |
| VP8 presenter, flag on | B | The party demotes to the stock egress ladder and never breaks. |
| Passthrough start failure, flag on | B | Same demotion, no dead party. |

---

## What is landed in this PR

- `tools/pqp-remux/internal/pipeline/fragmenter_std_latency_test.go`: the
  standard-latency passthrough segmenting proof (mechanism B's foundation).
- This document.

No server, client, edge or shared code changes; nothing flag-gated on the live
path; so this PR is not `restarts-api` and cannot affect production.
