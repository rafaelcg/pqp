# Encoder benchmark rig

What the dedicated watch-party egress box can actually encode, in about ten
minutes, so `docs/plans/BROADCAST_PIPELINE.md`'s B3.1 upgrade decision
("Right-size the one box first ... Do it on a reading, not a feeling") is
made from a real number instead of a guess.

`bench.sh` runs host `ffmpeg -c:v libx264` against a synthetic worst-case
source, matching the encoding options `server/src/voice/hls-egress.ts` and
`server/src/voice/hls-ladder.ts` ask LiveKit's egress for (preset `veryfast`,
H.264 Main, the same bitrates per rung, a 2 s keyframe interval, 4 s
segments). Read the long comment at the top of `bench.sh` for exactly what it
matches and why it doesn't run the real `livekit/egress` container. Four
profiles: `720p30`, `1080p30`, `1080p60`, and `compound` (the production
default rung, `720p30`, plus the presenter's camera rung and a voice-only
leg, all running at once -- a watch party where the host also has their
camera up).

## Running it against the real egress box

**Only with Rafael present, only in a quiet slot with no watch party live.**
This rig saturates CPU on purpose -- that is the point of the measurement --
and the box is shared with whatever real transcode is running. Pitfall 15 in
the root `CLAUDE.md` is what a busy egress box with something unexpected
running on it looks like from the outside (a stalling stream, no obvious
cause); do not be the unexpected thing. Before starting:

1. Check the operator dashboard shows zero active watch parties on this box
   (`liveHls` / `voice.hlsActiveSessions`). If anything is live, stop.
2. Say out loud (or in the QG) that a benchmark is about to peg the egress
   box's CPU for a few minutes.
3. SSH to the egress box (`216.238.108.42`, container `pqp-egress-prod` per
   `docs/plans/BROADCAST_PIPELINE.md`'s B0.1 finding -- Rafael has the
   access). Docker is already there; it runs the egress container.
4. Copy `bench.sh` over (`scp tools/egress-bench/bench.sh <box>:~/`) or clone
   the repo. No other file in this directory is needed on the box.
5. Run:

   ```bash
   ./bench.sh --profile all --cpus 3.5
   ```

   `--cpus` is this rig's own default guess for a 4 vCPU box with a little
   headroom left for the OS -- it is NOT a number read from a committed
   compose file (the production box's compose isn't in this repo; see the
   note in `bench.sh`'s header). If you know the box's real container CPU
   limit (check `docker inspect pqp-egress-prod --format '{{.HostConfig.NanoCpus}}'`
   or whatever the box's actual compose says), pass that instead.
6. It pulls `jrottenberg/ffmpeg:6.1-ubuntu2204` once (needs network egress
   from the box) and runs each profile inside one container capped with
   `docker --cpus`, back to back. About 4 minutes at the default 60 s
   duration for four profiles, or `--quick` (15 s) for a faster look when
   you just want a sanity read.
7. Read `results.md` in the printed output directory. Send Rafael the table.
8. `rm -rf` the results directory and disconnect. Nothing here is meant to
   live on the box.

Do not run this against `api.pqp.gg`, `sfu-pqp`, or anything else in
production. It only ever touches whatever local Docker/ffmpeg it's invoked
on.

## Running it on a throwaway box instead

Safer for a first look, and fine to run without Rafael watching. Spin up a
Vultr (or Linode) instance in `gru` on the **same plan** as the real egress
box (today: `vhp-4c-8gb-amd`, 4 vCPU / 8 GB -- see `docs/CAPACITY.md`'s
timeline table for the plan name production actually runs, since it may have
changed by the time you read this), then:

```bash
apt-get update && apt-get install -y docker.io ffmpeg
git clone <this repo> && cd pqp/tools/egress-bench
./bench.sh --profile all --cpus 3.5
```

A throwaway box gives the same CPU generation and vCPU count as the real one
without any risk to a live party. It is the default recommendation for
anything beyond a quick gut check. Destroy the instance when done -- this is
a `B3.2`-shaped one-off, not a standing box.

## Reading the output

`results.json` and `results.md` land in `results/<timestamp>/` (or wherever
`--out` points). Per profile:

- **min realtime factor** -- source seconds encoded per wall-clock second,
  the slowest of the profile's concurrent legs. Below 1.0x the box cannot
  keep up with the stream at all. This rig's PASS line is >= 1.15x, a margin
  chosen to leave headroom, not a number copied from the plan.
- **cpu avg / p95** -- percent of the whole container's `--cpus` budget used,
  sampled every second with `docker stats --no-stream` (the same tool
  `docs/CAPACITY.md`'s own encoder measurement used).
- **steal** -- percent of host CPU time stolen by the hypervisor during the
  run, from `/proc/stat` (Linux only). High steal on a run that otherwise
  looks fine is a noisy-neighbour problem, not an encoder problem -- worth
  knowing before blaming the ladder for it.
- **verdict** -- `PASS`, `FAIL`, or `INDETERMINATE` when no CPU cap was
  actually applied (for example `--limiter none`, which is what a Mac
  falls back to automatically). An INDETERMINATE run is not evidence either
  way and should not be quoted as one.

The synthetic source (two blended infinite generators plus temporal noise,
see `bench.sh`'s header) is close to worst case on purpose, the same way
`docs/CAPACITY.md` already describes its own full-frame-motion measurement:
"read as an upper bound." Real screen content, especially film, is mostly
static between frames and will cost less than these numbers say. If you have
a real downloaded clip handy, `--source-file path/to/clip.mp4` swaps it in
and probably narrows the estimate.

## What a result should trigger

Read straight from `docs/plans/BROADCAST_PIPELINE.md` section 5:

- **`720p30` (the production default rung) FAILs, or `compound` FAILs** with
  the box's real CPU cap applied: that is the reading B3.1 is waiting for.
  Upgrade the dedicated egress box from its current plan to
  `vhp-8c-16gb-amd` (4 vCPU to 8, +$48/mo). Do this on this reading, not
  before it and not instead of getting it.
- **`1080p30` or `1080p60` FAIL while `720p30` PASSes**: expected today --
  the production ladder ships `720p30` only (`DEFAULT_LADDER` in
  `server/src/voice/hls-ladder.ts`) precisely because 1080p tiled HLS cost
  more than this box comfortably carries. Not a trigger for anything by
  itself; it is what LL_HLS.md's own gate (`B2.1`/`B2.2`) is measuring
  before any wider ladder ships.
- **Everything PASSes with real headroom to spare, and a second concurrent
  party is what's actually needed** (a big night, or `voice.hlsSessionsCapped`
  going non-zero on the dashboard): that's `B3.2`, a second egress box
  brought up on demand before the event and destroyed after (snapshot +
  reserved IP, about $0.27 for a four-hour film night per
  `BROADCAST_PIPELINE.md` section 5) -- not the standing upgrade.
- **Do not chase GPU encoding.** `B3.3` in the same section already rules it
  out: no GPU plan in Vultr's `sao` region, and the nearest one moves the
  encoder out of Brazil.

## Flags

```
--profile NAME       720p30 | 1080p30 | 1080p60 | compound | all (default: all)
--cpus N              CPU cap for the whole profile (default: 3.5)
--limiter MODE        docker | taskset | none | auto (default: auto)
--docker-image IMAGE  image used by --limiter docker (default:
                       jrottenberg/ffmpeg:6.1-ubuntu2204)
--duration SECONDS    source length per leg (default: 60)
--quick                shorthand for --duration 15
--segment-seconds N    HLS segment length (default: 4, matches production;
                       code default is 2 -- see hlsSegmentSeconds())
--source-file PATH     use a real clip instead of the synthetic generator
--out DIR              output directory (default: ./results/<timestamp>)
--dry-run              validate the environment and print commands only
```

## Local sanity check (not a box result)

```bash
brew install ffmpeg   # already has libx264 on this Mac, checked 2026-09-14
./bench.sh --quick --profile 720p30 --limiter none
./bench.sh --quick --profile compound --limiter none
./bench.sh --dry-run --profile all --limiter docker
```

These prove the pipeline runs, the parser reads its own output, and the
docker/taskset command construction is correct -- nothing more. `--limiter
none` applies no CPU cap, so a fast laptop reports a large, meaningless
realtime factor and the verdict is always `INDETERMINATE`. Never quote a
number from this Mac as a box result.
