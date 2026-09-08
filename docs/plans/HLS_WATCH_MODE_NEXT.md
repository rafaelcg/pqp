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
| `LIVE_HLS_PUBLIC_BASE_URL` | none | Public base URL for the HLS bucket |
| `LIVE_HLS_S3_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_ENDPOINT` / `_REGION` / `_FORCE_PATH_STYLE` | none | Separate bucket from attachment `S3_*`, deliberately not reused |

## Known gaps (as reported by the agents who built these branches)

- Native-HLS fallback (Safari without hls.js) cannot attach the Bearer header
  a signed playlist proxy needs, so signed URLs and native fallback don't mix
  cleanly yet.
- Four secondary screen-share call sites are not gated by the host
  acknowledgment sheet, only the primary one.
- The call stage unmounts on channel change, which kills an active
  Picture-in-Picture session rather than handing it off.
- A viewer only learns a stream is live after joining the room; there's no
  out-of-room "live now" signal.
- The egress compose overlay's `user: "0:0"` makes egress exit silently on a
  fresh box (reported by the egress branch's author; not exercised by this
  merge's test run).
- `server/src/voice/hls-egress.ts` hardcodes `EncodingOptionsPreset.H264_1080P_30`
  (see the comment at the `startTrackCompositeEgress` call site); it is not
  configurable per room or server size yet.

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
