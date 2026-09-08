# Bandwidth harness: does the screen-share budget react to a real link?

A manual, on-demand check for `client/src/lib/screen-upload-budget.ts`. Not
part of `pnpm e2e` or CI — it builds and runs five Docker containers and takes
a minute or so, which is a lot to ask of every PR for a check that only this
one file needs. Run it by hand after touching the budget controller.

## What it proves that a unit test cannot

`screen-upload-budget.test.ts` and `peer-connection-tuning.test.ts` prove the
controller does the right arithmetic given a stats reading. They cannot prove
the browser and the kernel hand it a stats reading that means what the
comments say it means — that is exactly the kind of claim a mocked test
cannot check by construction. This harness runs three **real** Chromium
processes in three **real** containers, joins a **real** mesh voice call
between them over the app's own WebSocket signalling, shares a screen for
real, and caps one container's real upload with the Linux kernel (`tc
netem`) — then reads the same `window.pqpVoiceStats` console tool a developer
would use on a live call.

## Running it

```bash
cd client/e2e/bandwidth
docker compose up -d --build   # postgres, the app, and three browsers
node run.mjs                   # seeds a room, joins, shares, shapes, reports
docker compose down -v         # tear down when done
```

`run.mjs` prints one line every 3 seconds — the sender's ceiling and actual
rate, and both viewers' received size and rate — with a marker on the row
where the link was shaped, followed by a PASS/FAIL line. Override the shaped
rate with `SHARE_RATE=1mbit node run.mjs` (anything `tc`'s `rate` accepts).

## What it actually found (2026-09-08, `SHARE_RATE=3mbit`)

A 3-person mesh call (one sharer, two viewers), default "Auto" quality. The
share ran unshaped for 9 seconds, then the sharer's container was capped to
3 Mbit — a link that, split two ways, can carry about 1500 kbps a copy.

```
screen only  (SHARE_RATE=3mbit) : ceiling -> 1494 kbps a copy, paths [1729,1608]
screen only  (SHARE_RATE=1mbit) : ceiling ->  500 kbps a copy, paths [536,413]

WITH_CAMERA=true 3mbit CAMERA_ORDER=before : screen 1019.. + camera .. a copy
WITH_CAMERA=true 3mbit CAMERA_ORDER=after  : screen 1064 + camera 532 = 1596  (x2 = 3192)
WITH_CAMERA=true 1mbit                     : screen  369 + camera 185 =  554  (x2 = 1108)
```

`WITH_CAMERA=true` turns the sharer's camera on, before the share by default or
after it with `CAMERA_ORDER=after`. **Run both.** The ordering that broke in
review was camera-on-during-a-share: nothing retuned the screen on that edge, so
it kept the whole share and the pair asked for 133 % of it, and the
camera-first run is the one ordering that does not show it. So
the run exercises two video senders dividing one uplink instead of one sender
owning it. The two ceilings come out at the 2:1 ratio of their chosen ladders
(an Auto screen is 3 Mbps, an Auto camera 1.5), and their sum times the viewer
count is the shaped link. Before `meshCameraBitrate` existed the camera took
its full chosen ceiling per viewer no matter the room, so the same 3 Mbit run
would have asked for about 2994 kbps a copy, nearly double the link.

Two copies of each ceiling is 2988 and 1000 kbps, which is the shaped link in
both cases. The `paths[...]` figures are the per-path `availableOutgoingBitrate`
the controller reads: they are the same order as each other here, so both count
as sharing one link rather than one being dropped as an outlier. That column
exists because the ceiling alone cannot say *why* the controller chose it, and
that is the question two rejected models turned on.

Run this before changing the controller. Both rejected models passed their unit
tests and failed here. That is the
whole design working end to end on a link no test double produced: the
asymmetric AIMD controller, the real `availableOutgoingBitrate` reading, and
the resample-every-2s loop in `peer-connection-manager.ts`.

The starting ceiling of 3000 rather than the un-shaped default's 2500 is not
a bug: the controller had already raised once in the few seconds before
shaping, because a Docker bridge network genuinely has more than 5 Mbps of
headroom to offer — which is itself a small confirmation that the raise path
also fires on a real link, not only in the unit tests.

## Two Chromium gotchas this harness exists to not rediscover

1. **CDP does not cross a container boundary.** The first version of this
   harness tried to drive three Chromiums from one host script over the
   Chrome DevTools Protocol. Chrome's `--remote-debugging-port` socket binds
   to its own loopback interface regardless of
   `--remote-debugging-address=0.0.0.0`, so nothing outside that container —
   another container, or the host through a published port — can ever reach
   it. The fix is architectural, not a flag: each container runs its own
   Node script and calls `chromium.launch()` on its own local browser, and
   the three containers coordinate through files in a bind-mounted directory
   (`/run/coord`) instead of a network protocol.
2. **A bare Docker service name breaks two things at once, in different
   directions.** Navigating to `http://app:3001` (the compose DNS name)
   fails outright with `net::ERR_SSL_PROTOCOL_ERROR` — some Chromium
   heuristic (HTTPS-first-mode and relatives; `--disable-features=` did not
   change it) tries to upgrade a hostname it does not recognise as local.
   Navigating by the container's raw IP avoids that, but trades it for a
   second problem: `getDisplayMedia` requires a secure context, and Chromium
   only treats `localhost`/`127.0.0.1` as secure by default, not an
   arbitrary container IP — so without
   `--unsafely-treat-insecure-origin-as-secure=<that IP>:3001` the share
   button renders as "Share your screen (unavailable on this device)".
   `run.mjs` resolves the IP once via `dns.lookup("app")` and uses it for
   both the navigation and that flag.

## Files

| File | Role |
|---|---|
| `docker-compose.yml` | postgres + the app (dev auth bypass baked in) + three browser containers |
| `Dockerfile.app` | The root Dockerfile, plus `VITE_DEV_AUTH_BYPASS=true` baked into the client build — `VITE_*` is compile-time, so no env var at runtime can turn it on |
| `Dockerfile.browser` | The Playwright image, `iproute2` for `tc`, `playwright-core` for `run.mjs` to drive its own local browser |
| `run.mjs` | Dual-mode: the host orchestrator with no env var set, the in-container agent with `PQP_HARNESS_ROLE=sharer\|viewer1\|viewer2` |
