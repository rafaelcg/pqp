# HLS watch mode: next batch

`feat/hls-watch-mode-next`, built on the `fix/hls-watch-mode-loading` snapshot
(commit `aad59718` plus the loading fix `85cdd2ef`). Four more commits landed
on top, cherry-picked in this order, each kept as its own commit:

## Commit groups

**`b614702f` HLS egress follows a republished screen track.** When the
presenter stops and restarts their share (or reconnects), the egress used to
keep recording the stale track and go silent. The server now compares the
SFU's current video track id against the one egress was started with and
restarts egress when they diverge.

**`01660e98` Picture-in-Picture, Media Session, live-edge skip.** Adds native
PiP for the watch player, OS media-session metadata (title/artwork, play/pause
from the lock screen), and a "jump to live" control when the viewer has
drifted behind the live edge.

**`e3e0452f` Cinema layout for watch parties.** Full-bleed stage layout for
HLS watch mode, a presence line showing who's watching, and a stage overlay
for people on the call. Built on top of the PiP commit above (same content,
cherry-picked cleanly here since it's an identical patch).

**`275676a2` Retention sweep, signed playlist URLs, host acknowledgment.**
Server-side cleanup job that deletes a finished session's HLS objects after
a retention window (or after a longer replay window when the host asked to
keep it), a signed/proxied playlist URL path so viewers don't need direct
bucket access, and a one-time acknowledgment sheet a host must confirm before
going live (streaming responsibility / no pirated content).

## Config introduced

| Var | Default | Notes |
|---|---|---|
| `LIVE_HLS_ENABLED` | off | Master switch, gates everything below |
| `LIVE_HLS_RETENTION_MINUTES` | `10` | How long a finished session's objects live once nobody asked to keep it |
| `LIVE_HLS_REPLAY_HOURS` | `24` | How long objects live when `keep_replay = true` |
| `LIVE_HLS_URL_TTL_SECONDS` | `900` | TTL for presigned segment URLs and playlist-proxy access |
| `LIVE_HLS_SIGNED_URLS` | `true` | Set `false` to hand viewers the raw public bucket URL instead of a signed/proxied one |
| `LIVE_HLS_DELAY_SECONDS` | `10` | Broadcast delay baked into the player |
| `LIVE_HLS_PUBLIC_BASE_URL` | none | Public base URL for the HLS bucket. Only required with `LIVE_HLS_SIGNED_URLS=false`; signed mode (production) reads the private bucket through presigned URLs and never needs it |
| `LIVE_HLS_S3_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_ENDPOINT` / `_REGION` / `_FORCE_PATH_STYLE` | none | Separate bucket from attachment `S3_*`, deliberately not reused |

## Known gaps (as reported by the agents who built these branches)

- Native-HLS fallback (Safari without hls.js, iOS) cannot attach the Bearer
  header, so the playlist proxy also accepts the per-viewer `?t=` token
  (`hls-viewer-token.ts`, minted per recipient when the stream frame is
  sent). The header-less branch lives in `handleApi` ahead of the Bearer
  resolution and runs the same channel-access check.
- ~~Four secondary screen-share call sites are not gated by the host
  acknowledgment sheet, only the primary one.~~ Fixed: every start in
  `App.tsx` goes through `gateScreenShareStart` (`client/src/lib/screen-share-gate.ts`),
  and `screen-share-gate.test.ts` scans `App.tsx` so a fifth direct call
  fails the suite.
- The call stage unmounts on channel change, which kills an active
  Picture-in-Picture session rather than handing it off.
- A viewer only learns a stream is live after joining the room; there's no
  out-of-room "live now" signal.
- The egress compose overlay no longer sets `user: "0:0"`; instead
  `/opt/sfu/hls/egress.yaml` must be mode 0644 so the image's non-root user
  can read it (`tools/sfu/hls/docker-compose.yaml`, `egress.yaml.tmpl`).
  This is the configuration that runs on staging.
- The egress encoding is `LIVE_HLS_PRESET` (`720p30` default, `1080p30`),
  read per session start (`liveHlsPreset()` in `hls-egress.ts`). It is still
  one value per deployment, not per room or server size.

## Egress health and stalls (added 2026-09-08)

A local-stack QA pass found that killing the egress mid-share froze every
viewer on the last frame, with no copy and no recovery, and left a
`playlistReady=false` room entry forever. Both halves are handled now.

Server (`hls-egress.ts`): a monitor polls every 10 s. `ListEgress` by id
answers the clean cases; **it is not enough on its own**, because a killed
egress node never writes a final status and LiveKit keeps reporting that id
`EGRESS_ACTIVE` indefinitely (v1.13.6 / egress v1.14.1, verified). So the
monitor also reads the live playlist and treats 20 s without a moving
`EXT-X-MEDIA-SEQUENCE` (or segment count) as dead. A death, a `StartEgress`
that throws, and a session whose playlist never went live all go through one
restart path: backoff 2 s, 4 s, 8 s (capped at 15 s), at most three restarts
per channel in five minutes, then the channel is marked failed, viewers get
`stream: null` and no egress starts for it until the share stops. Stopping
the share clears the budget. `reconcileLiveHls` is serialised per channel,
since the monitor and the room can now both drive it.

Client (`lib/hls-stall.ts` + `hls-watch-player.tsx`): a watchdog on hls.js
`ERROR` (fatal and non-fatal), `waiting`/`stalled` longer than 8 s, and
`EXT-X-MEDIA-SEQUENCE` unchanged for 15 s. A reconnect refetches the source
from `GET /api/channels/:id/live`, because a restarted egress has a new
playlist URL; the overlay says "A transmissão travou, reconectando". After
three reconnects it shows "A transmissão caiu" with a retry button. A fresh
`voice-stream` frame heals the player without a click.

## Retention leftovers (added 2026-09-08)

- The egress writes its manifest at `live/<channel>/<egressId>.json`, beside
  the session prefix rather than under it, so a prefix listing never saw it
  and one JSON per session leaked forever. `hls_sessions.egress_id` records
  the id and the sweep deletes the manifest by name.
- A session live when the API died kept `ended_at NULL` forever, so
  retention never ran on it. `reconcileStaleHlsSessions()` runs at boot (API
  process only): it stops any egress LiveKit still runs for those channels
  and ends every open row.

## Findings

- **Egress paints black when the presenter's video pauses for about 2 s.**
  Seen on staging: a presenter-side stall of roughly one segment length
  leaves the HLS output black until frames resume, rather than holding the
  last frame. The presenter-side cause is unconfirmed (tab throttling,
  capture source change and encoder starvation are all candidates). With
  egress debug logging on (`log_level: debug` in `egress.yaml`) the
  transition is visible in the egress log at the moment the video track goes
  quiet, so that is the place to correlate against the presenter's timeline.

## Device QA list

- Desktop Chrome/Edge: hls.js path, PiP enter/exit, media-session lock-screen
  controls, jump-to-live after drifting behind.
- Safari desktop and iOS Safari: native HLS fallback, PiP (iOS uses the
  Safari presentation-mode API path, not the standard PiP API).
- iOS app (LiveKit rooms only, per the existing resume behavior): confirm the
  watch player survives an API restart the same way voice does.
- Android: confirm PiP and media session at all, since the gap list above
  doesn't distinguish platforms and Android PiP semantics differ from iOS.
- Cinema layout: multi-tile stage with 1, 2, and 5+ people on the call, host
  vs non-host viewer, mobile viewport.
- Host acknowledgment sheet: appears once per host per stream start on the
  primary screen-share path; confirm (and file separately) that the four
  secondary call sites still bypass it.
- Retention sweep: a stream ended without `keep_replay` disappears after
  `LIVE_HLS_RETENTION_MINUTES`; one with `keep_replay` survives past that and
  disappears after `LIVE_HLS_REPLAY_HOURS`.
