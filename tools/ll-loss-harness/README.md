# tools/ll-loss-harness

A fully local, offline test harness that reproduces LL-HLS decode failures
under real packet loss, so a fix can be measured against a deterministic
repro instead of a live watch party. Nothing here touches production, the
production SFU (`sfu.pqp.gg`), the egress box, or any `*.pqp.gg` host — see
"What this cannot reach" below.

## Why

LL-HLS (`docs/plans/LL_HLS.md`) is passthrough of the presenter's H.264: no
decode, no re-encode. Production failures — Chrome viewers dying with
`MEDIA_ERR_DECODE` / VideoToolbox `-12909`, or heavy rebuffering — only show
up under real packet loss on the presenter's uplink. A clean-LAN test
passes every time, which is exactly the trap: the bug is real and it needs
loss to reproduce. This harness injects loss locally and reliably
reproduces the same symptom on a laptop, with no watch party and no human
in front of a browser sharing their screen.

## What it is

```
 rampub (fake presenter, this dir's own Go module)
   --netem loss applied to its OWN egress interface--
   v
 LiveKit (single node, ephemeral keys, docker)
   v
 pqp-remuxd (the REAL tools/pqp-remux/cmd/pqp-remuxd, unmodified, built
             from this repo's own source)
   v
 harness/server.mjs (renders the REAL edge-Worker LL playlist logic --
                      buildLlRenditionPlaylist / buildLlMultivariantPlaylist
                      / parseLlState, imported from tools/hls-edge/src, not
                      reimplemented -- over pqp-remuxd's origin, with real
                      RFC 8216bis blocking-reload semantics)
   v
 harness/run.mjs (stock hls.js, in real headless Google Chrome via
                   Playwright, ~60s, records every hls.js ERROR/LEVEL/FRAG
                   event and the video element's own error code)
   v
 PASS/FAIL verdict
```

`rampub` publishes a synthetic ramp — 20s at 640x360, then a genuine
mid-stream SPS/PPS change to 1280x720 for 40s (`scripts/gen-ramp.sh`) — the
same shape Chrome's `getDisplayMedia` encoder produces whenever a shared
window or the capture surface itself resizes, and the case PRs #656/#657/#658
were about. Packet loss makes it fatal when the lost NAL carries the new
SPS/PPS or the first post-ramp IDR.

## What this cannot reach

- The LiveKit URL is validated against a small allowlist
  (`127.0.0.1` / `localhost` / `::1` / `livekit`, the compose-internal
  service name) in **two independent places** before anything dials it:
  `run.sh`'s `assert_local_host` and every Node script's
  `harness/env.mjs`'s `assertLocalHost` / `assertLocalUrl`. Any `*.pqp.gg`
  value, or anything not on that list, is refused outright. This mirrors
  `tools/watch-party-load`'s `PROD_HOSTS` guard (`src/index.ts`) on
  purpose — same shape, same reasoning: a load/repro harness must never be
  able to reach the real service even by an operator's copy-pasted
  override.
- Every Docker port publish is bound to `127.0.0.1` explicitly
  (`docker-compose.yaml`'s `"127.0.0.1:PORT:PORT"` syntax), not `0.0.0.0` —
  nothing here is reachable from another machine on the LAN, let alone the
  internet.
- LiveKit, `pqp-remuxd` and the publisher all run on one internal
  docker-compose bridge network with no TURN, no external IP discovery,
  and API keys generated fresh by `scripts/gen-keys.sh` on every run
  (`.data/harness.env`, gitignored) — never a production credential.
  `rampub` (`publisher/main.go`) also refuses any `LIVEKIT_URL` containing
  `pqp.gg` as a second, independent lock, the same "second lock" reasoning
  `tools/watch-party-load`'s own comment gives for checking twice.

## Prerequisites

- Docker Desktop (with the `docker compose` v2 plugin) — everything except
  the Chrome viewer runs in containers.
- `ffmpeg` on `PATH` (`brew install ffmpeg`) — generates `ramp.h264`
  locally; not needed inside any container.
- `openssl` on `PATH` (macOS/Linux ship this already) — generates the
  ephemeral keys.
- `go` is **not** required on the host: `rampub` and `pqp-remuxd` are both
  built inside Docker multi-stage builds.
- `pnpm install` already run at the repo root, so
  `node_modules/.pnpm/hls.js@*` and `node_modules/.pnpm/playwright-core@*`
  exist — this harness reuses those installs (`harness/env.mjs` resolves
  whichever version is actually there, so a routine `pnpm install` bump
  does not break it) rather than vendoring its own copies.
- Google Chrome installed at its normal macOS location (`run.mjs` launches
  Playwright with `channel: "chrome"`, the real browser, not the Chromium
  Playwright would otherwise download — the harness exists specifically to
  reproduce a Chrome/VideoToolbox decode failure, so it has to be Chrome).
- macOS via Docker Desktop was what this was built and verified on; any
  Docker host with a Linux-kernel VM under it (Docker Desktop provides
  one) works, because `netem` is a Linux `tc` qdisc.

## What this now asserts (since pqp-remux#700)

This harness was built to *reproduce* the decode-death symptom, and it
did: `./run.sh 30` reliably FAILed with the exact production
`MEDIA_ERR_DECODE` / VideoToolbox `-12909` error (see "Verified results
(2026-09-16)" below). `pqp-remux#700` (merged 2026-09-17, prompted by a
live production repeat of the same symptom the next night) fixed the
cause it reproduces: `h264.Depacketizer.PushRTP` now checks RTP sequence
continuity, discards the access unit a gap lands in, and asks the
publisher for a keyframe at once (`keyframe.Requester.OnLoss`) instead of
waiting for the periodic no-IDR gate. So the harness's job changed from
"prove the bug exists" to "prove the fix stays in place" — it is a
regression loop now, not a one-shot repro.

**Expected outcome today, at any `LOSS_PCT>0`:**

- `./run.sh 0` — PASS, unchanged. Clean path, no loss, nothing to defend.
- `./run.sh 15` / `./run.sh 30` — **PASS** (the player must stay alive: no
  `MEDIA_ERR_DECODE`, live edge held through the tail of the watch
  window), **and** the remuxd log must show the defense actually firing:
  a `pqp-remux: video damage: ...` line (`markDamaged` in `session.go`,
  once per loss episode) and nonzero `lost=+N` / `damage=+N` on the
  periodic `pqp-remux: stats ...` line (`formatStatsLine`, added by
  #700). `run.sh` checks both and prints "remux loss defense: observed"
  or "NOT observed" in its summary.

A `PASS` verdict from hls.js **alone** is not proof of anything at
`LOSS_PCT>0` — `netem` is probabilistic, so a run where it happened not to
drop a packet this time would also PASS, silently, whether or not the fix
is still in the tree. That is why `run.sh` treats "hls.js PASS but no
`video damage:` line and no nonzero lost/damage stat" as an overall FAIL
even though the player never errored: it means this run proved nothing,
which is functionally the same danger as the regression itself going
uncaught. See `run.sh`'s own header comment and the "remux loss defense"
line in its printed summary for exactly what it checked.

**This is what makes it a regression loop**: remove or weaken the
sequence check and one of two things happens, both of which flip `run.sh`
back to a nonzero exit —

1. The decode-death symptom comes back (the original failure mode this
   harness was built to catch), or
2. hls.js happens to survive this particular run's loss pattern anyway
   (LL-HLS's own resilience, or luck), but the remuxd log shows no
   defense fired, which `run.sh` now also treats as red.

## Running it

```bash
cd tools/ll-loss-harness
./run.sh          # LOSS_PCT=0 -- clean path, unaffected by #700
./run.sh 15       # 15% loss -- expect PASS + "remux loss defense: observed"
./run.sh 30       # 30% loss -- the measured production ceiling
                  # (docs/plans/LL_HLS.md); expect PASS + "remux loss
                  # defense: observed". A FAIL here (decode-death, or
                  # PASS with no observed defense) means the #700
                  # sequence check has regressed -- see "Forcing a red
                  # run" below to confirm the loop can still catch that.
```

Each run is self-contained: it clears any containers a previous run left
behind (so a crashed or `KEEP_UP=1` run never leaves stale, mismatched
keys behind — see the comment in `run.sh` above that step), generates
fresh ephemeral keys and `ramp.h264` if missing, builds the two images,
brings up LiveKit + `pqp-remuxd`, starts a remux session, starts the
playlist server, starts the publisher (loss applied per `LOSS_PCT`), runs
the Chrome viewer for `WATCH_SECONDS` (default 60), prints a verdict, and
tears everything down.

Env overrides: `WATCH_SECONDS` (default 60), `CFG` (`default` or `client`,
`harness/page.html`'s two hls.js config presets), `KEEP_UP=1` (skip
teardown — useful with `docker compose logs -f remuxd` while debugging),
`LL_HARNESS_LIVEKIT_URL` (default `ws://livekit:7880`; validated against
the allowlist above before use).

### What PASS/FAIL means

Printed as `VERDICT: PASS (...)` or `VERDICT: FAIL (...)` by
`harness/run.mjs` itself (hls.js/player evidence only), and surfaced
again in `run.sh`'s summary block. `run.sh`'s own **process exit code**
is not always the same as that line: since #700, at `LOSS_PCT>0` it also
requires the remuxd log to show the loss defense firing (see "What this
now asserts" above) and overrides the exit code to 1 if hls.js PASSed but
the remuxd log shows no `video damage:` line / no nonzero `lost=+`/
`damage=+` stat — printed as "remux loss defense: NOT observed" plus an
explicit `overall: FAIL` line, so reading only the top-level exit code
never hides that half of the check.

- **PASS** (`harness/run.mjs`'s own verdict) — no `MEDIA_ERR_DECODE`
  (video element error code 3) anywhere in the run, AND the viewer
  reached "playing" AND held the live edge through the tail of the watch
  window (`currentTime` still advancing, `readyState >= 3`, in the last
  ~8s) — not just an initial buffer fill that then froze.
- **FAIL**, with a reason:
  - `decode-death` — the exact production symptom: a `video:error` with
    code 3, or an hls.js `ERROR` event carrying `mediaErr` starting `3:`.
  - `never-played` — the video element never reached `playing` at all.
  - `stalled-before-edge-held` — it played at some point but the tail
    window shows it frozen or not ready.

Every run's artifacts land in `.data/runs/<run-id>/`: `build.log`,
`session-start.log`, `server.log` (the playlist server's own request log),
`hlsjs.log` (`run.mjs`'s full event dump — error summary, level/tick
history, the 6s of events immediately before any `video:error`),
`remuxd-full.log` and `remuxd-relevant.log` (grepped for parameter-set
changes, discards, demotes, IDR/stall/damage/loss lines).

### Verified results (2026-09-16, this Mac — before pqp-remux#700)

```
./run.sh 0   -> VERDICT: PASS (reached-and-held-live-edge)
./run.sh 30  -> VERDICT: FAIL (decode-death)
               video:error err=3 msg="PipelineStatus::PIPELINE_ERROR_DECODE:
               Error Domain=NSOSStatusErrorDomain Code=-12909 (null)
               (-12909): VTDecompressionOutputCallback"
               remux discard mentions: 57 (vs. 1 at loss=0)
```

That `./run.sh 30` FAIL was the point at the time, not a bug: it was the
same VideoToolbox `-12909` decode death production showed, reproduced
locally and deterministically. `pqp-remux#700` is the fix this repro
exists to measure against — see "What this now asserts" above for what
`./run.sh 30` is expected to report today, and "Forcing a red run" below
for how to get the pre-#700 FAIL back on demand to confirm the loop still
catches it.

## Idle and bursty sources (`SOURCE=idle`)

Loss is one way a presenter breaks LL playback; timing is the other. A
Chrome tab share of a mostly static page sends a frame every 0.3 to 1 s,
nothing at all while the page is still, and a burst when it repaints, and
on 2026-09-21 that shape made `pqp-remux` publish parts up to a second
late. `SOURCE=idle` reproduces it:

```bash
SOURCE=idle WATCH_SECONDS=120 ./run.sh                           # the part deadline on (default grace, 150 ms)
SOURCE=idle WATCH_SECONDS=120 PART_DEADLINE_GRACE_MS=1000 ./run.sh # the pre-deadline timing
```

- `rampub` publishes `.data/idle.h264` (`scripts/gen-idle.sh`: 720p,
  baseline, **one reference frame**, so `internal/skipframe` accepts it) on
  a wall-clock schedule (`PACE=idle-bursty`, `publisher/pace.go`): 3 s at
  30 fps, 7 s at 1.4 fps, a 4 s freeze, a 1 s burst, 5 s of irregular
  gaps, repeated. RTP timestamps follow the schedule, and a keyframe goes
  out every 2 s of wall time, standing in for the PLIs a real encoder
  answers.
- `SOURCE=static` and `SOURCE=mixed` use the cadence the 2026-09-21
  investigation derived from that party (3 s at ~24 fps then static; or 45 s
  active / 30 s static, repeated): static gaps are exponential with a 1 s
  mean clamped to 0.3..3 s, and keyframes come only every 4.1 s, the remux's
  PLI gate. Seeded, so every run sends the same frames.
- `pqp-remuxd` runs with production's `CLOCK_CUT_PARTS=true`, and
  `PART_DEADLINE_GRACE_MS` passes through.
- The playlist server holds blocking reloads the way `tools/hls-edge` does
  (`POLL_MODE=edge`: the origin re-read once per PART-TARGET, once a second
  past 1.5 s, a 6 s budget on video), using the Worker's own constants and
  its own `parseLiveEdge` / `isMsnPartAvailable`.
- The viewer joins once 12 s of media exist, as an audience joins a party
  in progress, so two runs start at comparable distances from the edge.
- `harness/lateness.mjs` polls `state.json` every 10 ms beside the viewer
  and prints `LATENESS video|audio` (p50/p90/p99/max and counts over 250
  and 500 ms): when each part first appeared against where it ends on the
  media timeline, read from its tfdt, plus the inter-arrival of parts at
  the origin (p50/p99/max). Every part's bytes and a
  `parts.json` index land in `.data/runs/<id>/parts/`.
- The summary adds the viewer's `WAITING:` line (stalls after first play,
  and freezes sampled every 100 ms), its live latency, and the remux's own
  counters summed over the run (`deadline`, `late250`, `late500`,
  `lateMaxMs`, `ptsShiftMs`).

**Running two harnesses on one Docker host.** Every host port is
overridable (`LL_HARNESS_LIVEKIT_PORT`, `LL_HARNESS_REMUXD_PORT`,
`LL_HARNESS_PORT`, `PORT`), and `COMPOSE_PROJECT_NAME` separates the
containers. Without both, a second run's opening `down` removes the first
run's containers and its playlist server fails with `EADDRINUSE`.

## Loss injection: exactly what it models

`publisher/entrypoint.sh` runs inside the `publisher` container (granted
`NET_ADMIN` by `docker-compose.yaml`'s `cap_add`) and applies
`tc qdisc add dev <iface> root netem loss <LOSS_PCT>%` to **its own**
default-route interface — i.e. loss on the packets `rampub` **sends**,
before they ever reach LiveKit. That is deliberately the SEND side of the
connection: a presenter's real uplink (Wi-Fi, tethered cellular, a
saturated home upload) is what production loss actually measures 17-30% on
1200-byte packets against (`docs/plans/LL_HLS.md`), and applying `netem`
here — in the publisher's own network namespace, on egress — is the
closest local analogue to that. It says nothing about loss on the other
leg (a viewer's download from the SFU/remux), which is a different problem
this harness does not attempt to reproduce.

`LOSS_PCT=0` (or unset) leaves the qdisc at its kernel default
(`pfifo_fast`) — nothing added, nothing to undo.

### Known limitation

`netem` loss on a container's veth approximates real Wi-Fi/cellular/modem
loss (independent, per-packet drop) but is not identical to it — real
links show bursty loss correlated with fades and interference, and jitter
alongside loss, neither of which plain `netem loss X%` models. If a fix
passes here but a field report still shows the symptom, `netem`'s
`delay`/`loss gemodel` options (not currently wired into this harness) are
the next thing to reach for, not evidence the fix is wrong.

## Layout

| Path | What |
|---|---|
| `run.sh` | The one command: orchestrates everything below |
| `docker-compose.yaml` | livekit + remuxd + publisher (profile `publish`) services |
| `livekit.yaml.tmpl` | Self-contained LiveKit config, keys substituted at run time |
| `remuxd/Dockerfile` | Builds the real `tools/pqp-remux/cmd/pqp-remuxd`, unmodified |
| `publisher/` | `rampub` — a standalone Go module (own `go.mod`), harness-only fake presenter that publishes an H.264 Annex-B file as a LiveKit `SCREEN_SHARE` track; `entrypoint.sh` applies the netem loss before it dials |
| `scripts/gen-keys.sh` | Ephemeral LiveKit + remux-control credentials, written to `.data/harness.env` (gitignored) |
| `scripts/gen-ramp.sh` | Builds `.data/ramp.h264` (the 360p→720p ramp) via `ffmpeg` |
| `harness/env.mjs` | Shared: reads `.data/harness.env`, resolves `hls.js`/`playwright-core` from the repo's own `node_modules/.pnpm` without hardcoding a version, and the local-host allowlist guard |
| `harness/remux-ctl.mjs` | Signed control-API client (`packages/shared/src/hls-remux-control.ts`'s HMAC scheme) — start/stop/list sessions on the harness's `pqp-remuxd` |
| `harness/server.mjs` | Stand-in for `tools/hls-edge`'s Worker: renders the real LL playlist logic over `pqp-remuxd`'s origin, with genuine RFC 8216bis blocking-reload semantics |
| `harness/page.html` / `harness/run.mjs` | The Chrome viewer: stock hls.js, Playwright, the event/verdict logic |

## Forcing a red run

There is no runtime flag to turn the RTP sequence check off — it is not
guarded by anything, on purpose, since #700 exists specifically to make
loss-defense unconditional. To confirm the regression loop actually goes
red (rather than just trusting that it would), build `remuxd` from the
commit **before** #700 landed and point `docker compose` at that image
instead of the one `run.sh` builds from this checkout:

```bash
# 81d33b74 is #700's parent -- the last commit without the sequence check.
git -C ../.. worktree add /tmp/pqp-pre-700 81d33b74
docker build \
  -f remuxd/Dockerfile \
  -t ll-loss-harness-remuxd:pre-700 \
  /tmp/pqp-pre-700

# Run everything else as normal, but stop docker-compose from rebuilding
# remuxd over that tag, and use it instead:
bash scripts/gen-keys.sh
bash scripts/gen-ramp.sh
docker compose build publisher
docker tag ll-loss-harness-remuxd:pre-700 ll-loss-harness-remuxd
docker compose up -d livekit
docker run -d --name pre700-remuxd --network ll-loss-harness_harness \
  --env-file ./.data/harness.env -e CONTROL_LISTEN=:8090 \
  -e LIVEKIT_URL=ws://livekit:7880 -p 127.0.0.1:8090:8090 \
  ll-loss-harness-remuxd:pre-700
# then run the rest of run.sh's steps by hand (session start, playlist
# server, publisher, harness/run.mjs) against that container -- or simply
# diff run.sh's own steps and substitute the `docker run` above for its
# `docker compose up -d livekit remuxd` line for one manual pass.

git -C ../.. worktree remove /tmp/pqp-pre-700
```

Expect `./run.sh 30` against that image to reproduce the original
2026-09-16 result: `VERDICT: FAIL (decode-death)`, no `video damage:`
line in the remuxd log (the pre-#700 binary has no such log line at
all — it predates `markDamaged`), and no `lost=`/`damage=` fields on the
stats line (they were added by #700 too). That is the loop's own proof
that it is still testing something, not just reporting green by default.

## Extending it

- To test a different loss level once: `./run.sh 22`.
- To try both hls.js config presets at a given loss:
  `CFG=client ./run.sh 30`.
- To watch a run interactively: `KEEP_UP=1 ./run.sh 30`, then
  `docker compose logs -f remuxd` in one terminal, and separately load
  `http://127.0.0.1:18081/page?cfg=default` in a real (non-headless)
  browser while the harness's own headless run is still active — the
  playlist server and `pqp-remuxd` will happily serve more than one
  viewer.
- The room name includes the loss percentage and a run id
  (`ll-loss-harness-<pct>-<run-id>`) so consecutive runs never collide,
  and LiveKit's own `room.empty_timeout` (120s) cleans up an abandoned one.
