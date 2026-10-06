# Share fast-start rig: how a viewer's screen share starts on the SFU

Measures what a viewer joining an SFU call sees in the first seconds of
somebody's screen share, and what the presenter's share does as the room
grows. Built for `share_fast_start_quality` after the 4 Oct 2026 film night
(40 people, LiveKit in São Paulo), whose chat said "144p" and "30px" for the
first two minutes and then "melhorou".

Everything is real except the network and the content: LiveKit 1.13.6 (the
version production runs) in Docker with the production config's room settings,
the product's own `connectLiveKit` in headless Google Chrome for the presenter
and for every viewer, the stage's own element sizing (`h-full w-full`
`object-contain`, bound with `bindRemoteVideo`) in a 1280x720 box.

```bash
# the regression (about 2 minutes): flag on, asserts the fixed behaviour
pnpm --filter @pqp/client e2e:share-fast-start

# one scenario by hand, numbers in results/<name>.json
node e2e/share-fast-start/run.mjs --idle 22 --viewers 3 --warm 10 --watch 20 --fast 1
node e2e/share-fast-start/table.mjs e2e/share-fast-start/results/*.json

# does a height ceiling rescale a display capture? (no LiveKit needed)
node e2e/share-fast-start/constraint-probe.mjs
```

Needs Docker, ffmpeg, Google Chrome and the `lk` CLI. Keep `--fill` (real
`lk load-test` subscribers) small: 25 of them held Docker's VM at 100 % CPU and
the SFU starved, which made the throttled runs meaningless. `--idle` (`lk room
join`, no media) gives the presenter a film-night-sized room for its plan at
almost no cost.

## Knobs

| Option | What it does |
|---|---|
| `--idle N` | N participants that neither publish nor subscribe. Above 20 the presenter's plan is the large-room one (360p + 720p top at 1.5 Mbit/s) |
| `--viewers N` | measured viewers (one Chrome context each) |
| `--shape RATE` | the first viewer joins through TURN and its downlink is shaped (`tc netem` on the relay to server hop inside the container, so TURN's own setup is never shaped) |
| `--impair delay_30ms_12ms_distribution_normal_loss_1%` | netem words for that link, `_` for spaces |
| `--shape-presenter RATE` | the presenter's uplink, the same way |
| `--src display` | the presenter shares Chrome's fake display device through `getDisplayMedia` with the product's options, instead of the clip. The clip is `captureStream()` of a 1080p `testsrc2` with grain (costs bits like a film) but does not behave like a display capture under `applyConstraints` |
| `--together 1` | viewers are in before the share starts |
| `--grow N --grow-after S` | N more subscribers arrive S seconds after the viewers |
| `--fast 1` | `share_fast_start_quality` on, in the presenter and the viewers |

## What it found (2026-10-05, M5 Max, Chrome 154)

Times are from the moment the viewer's page starts joining. "720p from first
picture" means the first decoded frame is already the stage's layer.

### 1. Joining a running share: no two-minute ramp in the SFU

| Scenario (large room, 24 to 27 people) | flag off | flag on |
|---|---|---|
| Clean link, 18 joins (six runs of three) | first picture 0.36 to 0.56 s for 16, 1.65 s for 2. **5 of 18 started on the 360p copy** and **7 of 18 reached 720p only at 1.64 to 1.75 s**; the other 11 by 0.58 to 0.72 s | first picture 0.50 to 0.63 s, **18 of 18 at 720p from the first picture**, 720p by 0.66 to 0.83 s (9 of the 18 on the final build) |
| Viewer at 5 Mbit/s | 720p from 0.57 s | 720p from 0.57 s |
| Viewer at 2 Mbit/s | 720p from 0.62 s | 720p from 0.62 s |
| Viewer at 3 Mbit/s, 40 ms ±25 ms jitter, 2 % loss | 720p from 0.99 s, held | (not run) |
| Viewer at 1.2 Mbit/s (below the 720p layer) | 720p, then 360p at 5.5 s and held | the same, 360p at 5.0 s |
| Steady rate per viewer | 1.50 Mbit/s | 1.50 Mbit/s |

Why the 360p start: LiveKit binds an adaptive-stream subscriber at the LOW layer
until the subscriber's first `UpdateTrackSettings` (`SubscribedTrack.Bound`),
and the forwarder latches on the first keyframe at or under that. The client
sent its first settings from `TrackSubscribed`, after the bind. Moving up then
waits for a keyframe of the higher layer (PLI throttle 1 s) and its sender
report. The flag sends the settings when the publication is first known (join
response, or the share being published), before the bind.

On a link that can carry the layer the SFU never held a viewer low for more
than about a second, at any of these rates, with one viewer or six joining at
once. A link that cannot carry it sits on 360p, which is the allocator doing its
job.

### 2. The room crossing twenty republished the share for everyone

`reconcileScreenPlan` unpublished and republished the share whenever the room
crossed `LARGE_ROOM_PARTICIPANTS` (20) in either direction, with no hysteresis.
Six viewers joining a room of 17:

| | flag off | flag on |
|---|---|---|
| Viewers whose share was taken away (new track sid, 2x2 blank frame, a new subscription) | **6 of 6** | 0 of 6 |

A film night crosses that line while people are still arriving, and again every
time the count dips to 20 and back. Each crossing restarts every subscription
and the presenter's encoders. With the flag only the top layer's ceiling moves,
in place (`setParameters`), to what the plan says for the new size.

### 3. The large-room 720p cap never reached the capture

`constrainScreenCapture` lays `height: { max: 720 }` over the capture's own
constraints, which still carry the `width: { max: 1920 }` the share was opened
with. `constraint-probe.mjs`, Chrome's fake display device:

| `applyConstraints` | settings and frames |
|---|---|
| what the session sends: `{ frameRate, width: { max: 1920 }, height: { max: 720 } }` | **1920x1080** (no error) |
| `{ height: { max: 720 } }` | 1280x720 |
| `{ frameRate, width: { max: 1280 }, height: { max: 720 } }` (the fix) | 1280x720 |

So in every room over twenty the "720p at 1.5 Mbit/s" top layer was a 1080p
capture squeezed into 1.5 Mbit/s. In the rig (large room, `--src display`)
viewers received 1920x1080 frames with the flag off and 1280x720 with it on; on
the film clip the encoder of the squeezed 1080p layer kept switching its own
output between 1080 and 720 lines every 20 s or so. The flag scales the width
ceiling to the height (`screen-capture-ceiling.ts`). It is never applied to a
watch party's source; the same constraint is how the watch party's 720p hold is
applied, which is worth checking separately.

### What the rig could not show

- A two-minute ramp. Nothing here took longer than 1.7 s to reach the stage's
  layer on any link of 1.8 Mbit/s or more, or with a presenter uplink of
  2 Mbit/s (720p at 3.7 s from the share starting).
- LiveKit's probe back-off on a congested viewer link (3 s base, times 1.5 up to
  120 s, `pkg/sfu/ccutils/probe_regulator.go`). It needs a link that is
  congested at join and then recovers, which tc on a laptop does not produce
  faithfully. Per viewer, not the whole room.
- A presenter whose software H.264 encoder (OpenH264, Constrained Baseline,
  `docs/DESKTOP.md` share-lag notes) is CPU-starved, which adapts resolution down
  fast and up slowly. That would blur everybody at once and recover on its own,
  which matches the chat better than anything per viewer. It needs a real
  Windows presenter.
- Real Wi-Fi and mobile links, real 40-person rooms, iOS and Android (both use
  `adaptiveStream: false` and do not have the bind-at-LOW start).

### Bandwidth

Unchanged per viewer: 1.50 Mbit/s steady in every large-room scenario, flag off
and on (the same layers and the same 1.5 Mbit/s top ceiling). Share video for a
40-viewer, 2-hour night is 1.5 Mbit/s x 40 x 7,200 s = 54 GB either way. The
in-place crossing keeps a share that started small on its three layers, so a
fullscreen viewer on a large screen can get the 1080p layer, still capped at
1.5 Mbit/s; dynacast pauses it when nobody asks.
