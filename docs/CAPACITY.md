# Capacity: what pqp's voice stack measurably carries

The durable record of the load tests. Every number here was read off a run's
own files, carries the run's label, and an extrapolation is called one. When a
new run lands, append a section under [Results](#4-results-one-section-per-run)
and a row to the run index; do not rewrite an old section, correct it in place
with a dated note.

Written 2026-09-07 from the runs of that afternoon (UTC 18:44 to 20:12). The
method, the rigs and the safety rules live in [`STAGING.md`](./STAGING.md) and
the two harness READMEs; this document is the numbers and what they mean.
Companion state: [`HANDOVER-2026-09-07.md`](./HANDOVER-2026-09-07.md). Media
path and SFU box: [`voice-backends.md`](./voice-backends.md) and
[`plans/SELF_HOSTED_LIVEKIT.md`](./plans/SELF_HOSTED_LIVEKIT.md).

## 1. Summary

Production's media server is one 2 vCPU Vultr box running LiveKit 1.13.6 with
a **single UDP media port**. On an isolated 4 vCPU copy of that exact
configuration, one 720p screen share to 499 viewers did not work: the single
socket dropped 137,200 inbound packets, egress stalled at about 266 Mbit/s
against the roughly 840 the room needs, and not one receiver sustained a
watchable picture (run A1). The same box with **four UDP mux ports**
(`udp_port: 7882-7885`) carried 468 viewers at 29.7 fps with zero packet
loss, 837 Mbit/s steady at 69% CPU, zero socket drops (run A2). The API join
path was never the limit at 500 (pool peaked at 18 of 40, CPU under 30%, no
rate limiting, no backpressure) and on its own it stops fitting the client's
12 s join budget at about 650 to 674 people already in the room (control A).
A ceiling ladder on the same 4 vCPU box with four ports (ladder E, `lk
load-test` subscribers that do not decode) carried 500 subscribers clean at
860 Mbit/s and 59% CPU and collapsed at the next step, 600 (26.6% loss, CPU
81 to 84%, socket drops back), so **the 4 vCPU plan's ceiling at 720p /
1.5 Mbps sits between 500 and 600 viewers**: 500 is measured, and the margin
above it is one step, not a factor.
So, today, before any change: a watch party on production's SFU is not
expected to carry 500 viewers. **After the port change**, extrapolated and not
yet measured (ladder F, on a 2 vCPU box, is pending), the production 2 vCPU
box should carry roughly **250 to 300** viewers at 720p / 1.5 Mbps if two
cores behave like half of four, or roughly 95 to 110 at an explicit 1080p /
4 Mbps share (the 300 to 400 and 140 to 150 quoted earlier on 2026-09-07 were
arithmetic on A2 alone; ladder E shows CPU stops being linear above about 60%,
section 5). **500 at 720p needs the 4 vCPU plan** (`vhp-4c-8gb-amd`, about
$48 a month list price against the $36 the current box costs), and 500 is
where that plan's measured margin ends. The port change has **not** been
applied to production as of this writing.

## 2. Production topology and the one recommended change

### What runs today (2026-09-07)

| | |
|---|---|
| Box | Vultr `sfu-pqp`, plan `vhp-2c-4gb-amd` (2 vCPU, 4 GB, 2 NIC queues), São Paulo, $36 a month, 5 TB transfer included |
| LiveKit | `livekit/livekit-server:v1.13.6`, image tag pinned, `network_mode: host` (`tools/sfu/docker-compose.yaml`) |
| Media | one UDP mux port, `rtc.udp_port: 7882`; ICE over TCP on 7881 (`tools/sfu/livekit.yaml.tmpl`) |
| TURN | LiveKit's embedded TURN **on the same box**: TLS 5349, UDP 3478, relay range 30000 to 40000/udp |
| Signalling and RoomService | Caddy on 443 in front of LiveKit 7880, `sfu.pqp.gg`; the API reaches RoomService over HTTPS |
| Limits | no `limit:` block. LiveKit 1.13.6 applies no default track or byte cap (see the guard below) |
| Idle weekday load, measured 2026-09-07 15:36 BRT (operator reading on the box, not in a run folder) | 10 participants, 3 screen shares: 6.5% of two cores inside the guest, 12% in Vultr's hypervisor view; busiest hour 12 Mbit/s; about 760 GB a month projected against 5 TB included; retransmits 0.016% |

The 5 TB and the $36 are from `plans/SELF_HOSTED_LIVEKIT.md`; the 2 NIC
queues and the idle reading are from the operator's session on the box.

### The change, not yet applied to production

```yaml
rtc:
  udp_port: 7882-7885     # was 7882; one UDP socket per port, spread over the NIC queues
limit:
  num_tracks: -1          # guard for a future image bump, see below
  bytes_per_sec: -1
```

With it, on the box and in the Vultr firewall group (both, the plan requires
both to agree): `ufw allow 7883:7885/udp`. Apply it in a quiet hour: the
LiveKit restart ends every room on the SFU. Make the same edit to
`tools/sfu/livekit.yaml.tmpl` and `tools/sfu/install.sh` in the same change,
otherwise a rebuild of the box silently reverts to one port.

**Why four ports.** A1 to A2 is the whole argument: identical room, identical
box, the only change was `7882` to `7882-7885`, and the run went from 0 of
499 receivers sustaining video to 468 of 468 decoding at 30 fps with zero
socket drops. LiveKit's own guidance is at least as many mux ports as vCPUs;
production has 2 vCPUs and 2 NIC queues, the 4 vCPU plan has 4 of each, so
four ports is right for both and costs nothing on the smaller box.

**Why the `limit` guard.** LiveKit 1.13.6 ships no default for
`limit.num_tracks` or `limit.bytes_per_sec`. Newer releases default
`num_tracks` to 400 per CPU (operator's reading of the release notes; verify
against the release you are bumping to). Every viewer subscribes to two tracks
(the share's video and its audio), so 2 vCPUs times 400 is 800 tracks, about
400 viewers, after which the server refuses subscriptions with nothing in our
logs to say why. Setting `-1` now means a future image bump cannot install a
ceiling under a party.

## 3. Methodology

### The two rigs

| Rig | Measures | Where |
|---|---|---|
| `server/scripts/load-fanout.ts` | The API join path: cold-browser HTTP bootstrap (about twenty requests), app WebSocket, `welcome`, roster and presence fan-out. `--mode join` ramps arrivals until joins stop fitting the client's 12 s `JOIN_TIMEOUT_MS` and reports the answer as an occupancy. No media | README beside it; runbook in `docs/STAGING.md` |
| `tools/watch-party-load` | Media delivery: one presenter and N receivers that each do a light HTTP bootstrap (six requests), app socket, `welcome`, `POST /api/voice/token`, a native LiveKit connection, subscribe to the real tracks and decode frames. Refuses production and the production SFU by name (PR #337) | `tools/watch-party-load/README.md` |

The two rigs' `welcomeMs` are not comparable: the media rig's bootstrap is
deliberately light. Quote API join capacity from the fan-out rig only.

### Isolation

- API: `pqp-api-staging` on its own Postgres cluster (`pqp-db-staging`),
  sized to production for the runs: `performance-2x` / 4 GB, `PG_POOL_MAX=40`,
  fly-proxy `soft_limit 1000 / hard_limit 2000` through an uncommitted config
  deploy, the two address-keyed limiters lifted (`RATE_LIMIT_ANON_*`,
  `RATE_LIMIT_SOCKET_*`), per-identity limiters at their defaults. Image
  `53099a94` for every run, which predates PR #344, so in registry mode the
  server sent whole `voice-roster` frames and no deltas.
- SFU: a throwaway Vultr `vhp-4c-8gb-amd` (4 vCPU, twice production) built
  from `tools/sfu/install.sh` under sslip.io names with a fresh key pair, so
  the production key pair was never on it. `LIVEKIT_*` on staging pointed at
  it for the runs. UDP buffer sysctls at the Ubuntu defaults
  (`net.core.rmem_max` and `wmem_max` 212,992) in A1 and A2 alike
  (`meta.json`).
- Generators: four Vultr `vhp-12c-24gb-amd` in São Paulo, links measured at
  23 Gbit/s to each other and to the SFU. Their firewalls denied `api.pqp.gg`
  and `sfu.pqp.gg`, and the harness refuses both by name.
- Production was not touched by any run.

### The shape of a media run (A-series)

Presenter first, alone in its own process so decoders never starve its
encoder; then 499 receivers over 90 s (about 5.5 a second, 12 concurrent joins
per process, four processes per generator), 20% of them "legacy" sockets with
no `caps` and no `permessage-deflate`; then a 600 s hold. The presenter is
deterministic full-frame 720p30 motion at a 1.5 Mbps video ceiling plus
64 kbps audio, one layer, no simulcast. That is what a share looks like in a
room above `LARGE_ROOM_PARTICIPANTS` (20) unless the presenter picks 1080p by
name (`client/src/lib/video-quality.ts`: auto 3 Mbps, 720p 2 Mbps, 1080p
4 Mbps, large room held to 720p at 1.5 Mbps).

Sampled once a second: the SFU (`/proc/stat`, `/proc/net/dev`,
`/proc/net/snmp` UDP errors, LiveKit's `:6789/metrics` every 5 s), every
generator (CPU split including steal, node CPU, UDP errors), and the API
machine (`/proc` through `fly ssh`, `/ready` every 2 s for the pool,
`/api/admin/metrics` every 30 s, the log stream for `backpressureDrop`,
`heartbeatTerminate`, 429 and 4429).

### What is real

- Each receiver is a native WebRTC peer (LiveKit's Node SDK), subscribed to
  the real tracks, counting RTP bytes, loss, freezes and decoded frames.
- SFU egress and CPU are read from the host, not from the receivers.
- The API path is the real staging deployment on production's machine size,
  including token minting and the voice registry.

### What is not

- **Generators are not browsers.** No compositor, no audio playback, no
  adaptive-stream element sizing, none of the real client's reconnect logic,
  and a six-request bootstrap instead of a cold browser's twenty.
- **The receivers sit in one datacenter** on 23 Gbit/s links: no NAT, no
  TURN, no lossy last mile, no phones on cellular. Production viewers will be
  worse off individually; the SFU-side numbers do not depend on that.
- **Receiver decode CPU is spent on the generators.** When a generator runs
  hot, receiver-side freeze and sustained-receipt figures degrade for reasons
  that have nothing to do with the SFU. The README's gate is 70% of one core
  per allocated vCPU; A2 broke it on three of four boxes.
- **The presenter is one synthetic 1.5 Mbps layer.** No cameras, no audio
  publishers, no simulcast rungs. A small room's auto share is 3 Mbps and an
  explicit 1080p is 4 Mbps; the extrapolation in section 5 scales for that.
- **Staging's database is smaller than production** (Basic plan, shared x2 /
  1 GB) and the API image predates #344.
- **Ladder subscribers are not the media rig's receivers.** `lk load-test`
  subscribers take the RTP and count it; they do not decode, so a ladder step
  costs the tester box far less than the same count in A2. The tester box
  (generator `d`, 12 vCPU) was not sampled during ladder E, so a tester-side
  contribution to the collapse step cannot be excluded from the files; the
  SFU's own counters at that step (section 4) are what point at the SFU.

## 4. Results, one section per run

### Run index

| Run | UTC start | SFU config | Load | One line |
|---|---|---|---|---|
| Control A `controlA` | 2026-09-07 18:53 | none (API only) | 1,200 arrivals from one generator, ramp 4/s +4 every 20 s | Joins stop fitting 12 s at 650 to 674 already in the room; pool 40/40 with a queue of 616; 93% of bytes were whole rosters |
| Control C0 `wpcal-96d` | 2026-09-07 18:44 | single port `7882` | 96 participants, one generator | Clean: 95 of 95 sustained at 29.7 fps, 0% loss, SFU 16% CPU, 168 Mbit/s |
| A1 `wpa1-single` | 2026-09-07 18:56 | single port `7882` (production's) | 500 participants, four generators | Broken: 0 of 499 sustained, median 1.2 fps, 58% loss, 137,200 socket receive drops, egress stuck near 266 Mbit/s |
| A2 `wpa2-fourport` | 2026-09-07 19:19 | four ports `7882-7885` | 469 participants (one shard crashed), four generators | Carried: 468 of 468 decoding, 29.7 fps, 0% loss, 837 Mbit/s at 69% CPU, zero socket drops |
| Ladder E `ladder4c-720` | 2026-09-07 19:42 | four ports `7882-7885`, 4 vCPU | `lk load-test` subscribers stepped 200 to 800, 180 s a step, 720p presenter | 500 clean at 860 Mbit/s and 59% CPU; 600 collapsed (26.6% loss, 81% CPU); ceiling between 500 and 600 |

Raw files: `/tmp/pqp-loadtest/runs/<run>/` on the operator's Mac at the time
of writing (`summary.md`, `meta.json`, `reports/`, `samples/`). They are not
in the repository; if they move, update this line.

### Control A: API join path only (`controlA`)

`load-fanout.ts --mode join` from generator `d`, ramp 4/s plus 4/s every
20 s, cap 1,200 clients, budget 12,000 ms, every welcomed socket staying in
the room. Staging as in section 3, image `53099a94`.

| | control A |
|---|---|
| Arrivals | 1,200 attempted, 1,083 reached `welcome`, 117 timed out (no other failure cause) |
| Time to welcome, whole run | p50 1,526 ms, p90 7,648 ms, p99 11,382 ms, max 11,970 ms |
| At 475 to 524 in the room | p50 1.8 to 1.9 s, p90 2.2 to 2.3 s, none over budget |
| At 575 to 599 | p90 5.9 s, none over budget |
| **Ceiling** | **650 to 674 already in the room**: p90 18.9 s, 45 over budget, 64 failed |
| API machine | CPU p50 71%, p95 97%, peak 100% of 2 vCPU; egress peak 366 Mbit/s |
| Pool | 40/40 saturated in 47 of 189 samples; process high-water busy 40, queued 616 |
| Log signals | 32 `ws.backpressureDrop` lines (up to 1,001 frames dropped in one), 0 `heartbeatTerminate`, 0 rate-limit closes |
| On the wire | 2,428.7 MB (5.43x compression, 1,083 of 1,083 sockets compressed); peak 346.9 Mbit/s |
| What filled it | `voice-roster` 66,502 frames, 12,210.7 MB of 13,186.1 MB payload (93%), **192,533 bytes each**; `presence-update` 476.9 MB at 67,197 bytes; `welcome` 182,475 bytes each |
| Harness | 76% of one core, 1,200 sockets held |

Reading. The join path's own ceiling sits above 500 on production's machine
size and pool. What it burns is CPU and pool on whole-roster keyframes: with
`VOICE_REGISTRY=postgres` this image produced no `voice-roster-delta` at all
(`registryOn() ? null : foldRoomEvents(events)`); PR #344, merged after these
runs, diffs the rows instead. From that PR's measurement at 500 participants:
a `voice-roster` snapshot with real avatar URLs is 220,878 bytes and a
one-join `voice-roster-delta` is 580 bytes. Rerun control A on an image with
#344 before quoting a new API ceiling.

For the record, the previous week's API-only figure of about 350 in a room
(`HANDOVER-2026-09-07.md`) was a floor: one laptop on a 703 Mbit/s link
saturated its own downlink. Control A is the first distributed measurement
and it is roughly twice that.

### Control C0: 96 receivers, single port (`wpcal-96d`)

The calibration run before A1: same rig, one generator (`a`, three
processes), 96 participants, 30 s arrival window, 90 s hold, SFU on the single
port.

| | C0 |
|---|---|
| Receivers decoding within 45 s | 95 of 95 |
| Sustained receipt over the hold | 95 of 95 (100%) |
| Decoded fps, p5 / p50 | 29.6 / 29.7 at 720 lines |
| Packet loss, median / p95 | 0.000% / 0.010%; 0 freezes, 0 PLIs, 46 NACKs |
| Welcome, socket open, p50 / p95 / p99 | 33 / 41 / 69 ms; token 31 / 38 ms; LiveKit connect 104 / 275 ms |
| SFU | CPU 16% p50, 19% peak of 4 vCPU; egress 168 Mbit/s p50, 179 peak; 0 socket drops; 858 MB |
| Generator `a` | 76% p95 of the whole 12 vCPU VM, node processes 121 to 124% of one core each |
| API | CPU 16% peak; pool 15 of 40; no queue |

Reading. The single port is fine at 95 receivers and 168 Mbit/s. This is
the shape of a healthy run, and it is what A1 was expected to look like at
five times the size.

### Run A1: 500 in one room, single UDP port (`wpa1-single`)

Production's SFU configuration on the 4 vCPU test box. 500 participants: one
presenter, 499 receivers (100 legacy), 17 shards over four generators, 90 s
arrival window, 600 s hold. `meta.json`: `udp_port:7882`, no `limit` block,
buffers 212,992, harness `ea0646d8`, API `53099a94`.

| | A1 |
|---|---|
| Joined | 499 of 499, zero join failures, zero retries |
| Welcome, socket open, p50 / p95 / p99 | 39 / 66 / 320 ms (with bootstrap 152 / 778 / 1,223 ms) |
| Token mint / LiveKit connect, p50 / p95 | 31 / 52 ms; 93 / 155 ms |
| First frame from own arrival, p50 / p95 / p99 | 765 / 1,439 / 2,101 ms, for the 270 that ever got one |
| **Receivers that never decoded a frame** | **229** (`first-frame-abandoned`) |
| **Sustained receipt over the hold** | **0 of 499** |
| Decoded fps over the hold, p5 / p50 | 0.1 / 1.2 |
| Packet loss, median / p95 | **58.133% / 59.372%**; 194 receivers froze; 626,801 PLIs; 20,389,411 NACKs |
| Unexpected LiveKit disconnects | 0 |
| Presenter | 30.2 fps source, 1.35 Mbit/s sent, single layer at a 1.50 Mbps ceiling |
| Aggregate received at generators | 273.0 Mbit/s |
| **SFU egress over the 600 s hold** | **p50 266 Mbit/s** (p10 252, p90 289, p95 323); whole-run p95 314, peak 459 |
| SFU CPU over the hold | p50 68% (p10 64, p95 75), peak 82% of 4 vCPU |
| **SFU UDP receive-buffer drops** | **137,200** `RcvbufErrors` (`/proc/net/snmp`), all in the hold, in 286 of its 592 seconds: median 467 a second, p90 849, peak 1,389 |
| SFU NIC drops / memory | 0 rx, 0 tx; 2,062 MB peak |
| LiveKit log lines (operator's `docker logs` reading, not in the run folder) | 851 "could not get packet from bucket", 405 ICE candidate-pair switches |
| Generators | own CPU p95 19 to 27% of each 12 vCPU VM, steal 0%, no UDP errors, node processes 43 to 52% of one core; all under the 70% gate |
| API machine | CPU 32% peak, 16% p95 of 2 vCPU; egress 74 Mbit/s peak; pool 16 of 40 peak, queue 0, 0 of 533 samples at max; Postgres p95 8 ms |
| API log signals | 0 `backpressureDrop`, 0 `heartbeatTerminate`, 0 rate-limit closes |
| App socket bytes per receiver over the run | legacy 1,810 KB on the wire vs modern 308 KB; `voice-roster` payload 1,475 vs 1,619 KB; deltas 0 (image predates #344) |

Reading. Everybody joined and everybody connected; the API was idle by its
own standards. Then the single socket fell over. `RcvbufErrors` are inbound
packets the kernel discarded because one UDP socket's receive buffer was
full: one port means one socket, one buffer (212,992 bytes) and one reader
for the presenter's media and the RTCP of 499 receivers alike. Once the
presenter's packets are dropped at the socket every subscriber misses them
and asks for retransmission (20 million NACKs), which is more inbound on the
same socket. Egress flattened at about a third of what the same room drew in
A2, with the CPU at 68%, so neither CPU nor the NIC was the wall; the socket
was. **On production's single-port configuration, this room does not
work.**

### Run A2: the same room, four UDP mux ports (`wpa2-fourport`)

Identical to A1 in every respect but `rtc.udp_port: 7882-7885`
(`meta.json`: `udp_port:7882-7885`, no `limit` block, buffers 212,992, same
harness and API image). One generator process (shard 6 on `b`, 31 receivers)
died during the arrival window in the native rtc-node layer (a segfault,
per the operator; the process left no report), so the hold ran with
**468 receivers, 94% of the intended load**. Read every receiver-side figure
against 468, and against the generator CPU below.

| | A2 |
|---|---|
| Joined | 468 of 468 (16 of 17 shards reported), zero join failures, zero retries |
| Welcome, socket open, p50 / p95 / p99 | 37 / 69 / 333 ms (with bootstrap 155 / 568 / 825 ms) |
| Token mint / LiveKit connect, p50 / p95 | 31 / 48 ms; 99 / 266 ms |
| First frame from own arrival, p50 / p95 / p99 | 811 / 1,366 / 1,646 ms |
| **Receivers that never decoded a frame** | **0**; 468 of 468 decoding within 45 s |
| Sustained receipt over the hold | 337 of 468 (72.0%), see the reading |
| **Decoded fps over the hold, p5 / p50** | **29.4 / 29.7** at 720 lines |
| **Packet loss, median / p95** | **0.000% / 0.001%**; 131 receivers with a non-zero freeze count; 0 PLIs; 1,606 NACKs |
| Unexpected LiveKit disconnects | 0 |
| Presenter | 30.0 fps source, 1.35 Mbit/s sent, single layer at a 1.50 Mbps ceiling |
| Aggregate received at generators | 762.6 Mbit/s |
| **SFU egress over the 600 s hold** | **p50 837 Mbit/s** (p25 806, p75 846, p95 864); whole-run p95 858, peak 959 |
| **SFU CPU over the hold** | **p50 69%** (p25 65, p75 73, p95 76), peak 81% of 4 vCPU |
| **SFU UDP receive-buffer drops** | **0** new (`RcvbufErrors` flat at A1's 137,200 for the whole run) |
| SFU NIC drops / memory | 0 rx, 0 tx; 1,912 MB peak |
| LiveKit `livekit_participant_total` peak | 475 (A1 saw 500) |
| Generators | own CPU p95 **94% (`a`), 88% (`c`), 87% (`d`)**, 67% (`b`, three processes after the crash); node processes 147 to 160% of one core each, event-loop lag up to 599 ms; `b` logged 22,334 UDP receive drops of its own; steal 0% |
| API machine | CPU 27% peak, 15% p95 of 2 vCPU; egress 78 Mbit/s peak; pool 18 of 40 peak, queue 0, 0 of 532 samples at max; Postgres p95 7 ms, max 600 ms |
| API log signals | 0 `backpressureDrop`, 0 `heartbeatTerminate`, 0 rate-limit closes |
| App socket bytes per receiver over the run | legacy 1,907 KB on the wire vs modern 320 KB; `voice-roster` payload 1,562 vs 1,710 KB; deltas 0 (image predates #344) |

Reading. The port change is the difference between A1 and A2, and it is the
whole difference: same room, same box, same buffers, the SFU went from a
third of the required egress with the socket overflowing to the full
837 Mbit/s with zero drops and a comfortable 69% of four cores. Every
receiver decoded at 30 fps with no loss. The one receiver-side blemish, 72%
"sustained" and 131 freeze counts, arrived with generators at 87 to 94% of
their whole VM (the README's gate is 70%) because every receiver now decodes
30 fps instead of 1; the SFU-side counters, which are the authority for
capacity, show nothing at those moments. A2 is therefore **a demonstration
that four ports carry 468 at 720p on 4 vCPU with margin**, not a ceiling. The
ceiling comes from the ladders in E and F. Repeats with lower per-process join
concurrency and cooler generators follow as A2r.

### Run A2r: repeats of A2 with cooler generators

Not yet run at the time of writing. Same configuration as A2, lower
`--join-concurrency` and more processes per generator so no box passes the
70% gate and the full 499 hold. Fill in from
`/tmp/pqp-loadtest/runs/<run>/summary.md` with the A2 table's rows and say
whether the sustained-receipt figure recovered once the generators had room.

### Run B

Reserved. Not yet run at the time of writing. When it lands: one paragraph of
configuration (what differs from A2, with the `meta.json` fields
`sfuUdpPort`, `sfuLimitBlock`, `sfuRmemWmem`), the standard table, and a
reading.

### Run C

Reserved. Not yet run at the time of writing. Same template as B.

### Run D

Reserved. Not yet run at the time of writing. Same template as B.

### Ladder E: the 4 vCPU ceiling at 720p (`ladder4c-720`)

The ladder replaces the linear arithmetic with a measurement. Shape
(`ladder-run.sh` from the operator's Mac, `lk-ladder.sh` on generator `d`):
our own presenter, alone in its process on generator `a`, publishing the
same 720p30 / 1.5 Mbps share into a room made through the app; then `lk
load-test` subscribers from `d` (no decode, 10 joins a second, two tracks
each) at 200, 300, 400, 500, 600, 700 and 800 for 180 s a step with 20 s
between steps; the SFU sampled once a second throughout. `meta.json`:
`udp_port:7882-7885`, 4 vCPU / 7,934 MB. SFU figures are per step with the
first 60 s of each step (the join ramp) cut; `lk`'s loss and per-subscriber
bitrate are its own end-of-step totals.

| subscribers | SFU egress Mbit/s, steady p50 / p95 / peak | SFU CPU p50 / p95 | rcvbuf drops per s, p95 / peak | `lk` total loss | `lk` bitrate per subscriber |
|---|---|---|---|---|---|
| 200 | 344 / 361 / 365 | 26% / 28% | 0 / 0 | 0 (0%) | 1.5 Mbps |
| 300 | 516 / 533 / 551 | 38% / 40% | 0 / 0 | 0 (0%) | 1.5 Mbps |
| 400 | 687 / 717 / 746 | 48% / 52% | 0 / 711 | 0 (0%) | 1.4 Mbps |
| **500** | **860 / 896 / 951** | **59% / 63%** | 0 / 441 | **0 (0%)** | 1.4 Mbps |
| 600 | 590 / 680 / 956 | 81% / 84% | 135 / 1,735 | **5,262,186 (26.6%)** | 547 kbps |
| 700 | 549 / 602 / 907 | 85% / 86% | 58 / 616 | 5,516,725 (26.9%) | 421 kbps |
| 800 | 546 / 575 / 814 | 84% / 87% | 9 / 2,313 | 5,954,332 (27.2%) | 348 kbps |

14,584 new `RcvbufErrors` over the whole ladder (against A1's 137,200 in
one run); NIC drops 0. `lk` reported 0 errors at every step; every
subscriber held its two tracks.

Reading. Up to 500 the box is a straight line: about 1.72 Mbit/s of egress
and 0.12 points of CPU per subscriber, matching A2 (837 Mbit/s at 69% for
468 decoding receivers). **500 is clean at 59% CPU.** At 600 it is not a
little worse, it is a different regime: CPU jumps to 81% (linear would be
about 71%), steady egress falls to 590 Mbit/s, the per-subscriber bitrate
drops to a third and a quarter of all packets are lost, and the socket
drops return in bursts of up to 1,735 a second. 700 and 800 stay in that
regime with the same 27% loss, which is the SFU's congestion control
holding the room to what the machine can push. Peak egress never exceeded
about 956 Mbit/s at any step; nothing in the files says whether that is the
box's ceiling or a coincidence of the collapse, and the plan's port speed
was not measured on this run. So: **the 4 vCPU ceiling for a 720p / 1.5 Mbps
share sits between 500 and 600 subscribers, and the number to plan against
is 500**, which at 59% CPU leaves headroom for real viewers' retransmissions
but not for another hundred of them. The step where the first isolated drop
bursts appear is 400 (peak 711 a second in one second, p95 0), so a
long-running room of 400 to 500 should be watched for `RcvbufErrors` even
though `lk` saw no loss there.

Caveats. The subscribers do not decode and the tester box was not sampled
(section 3), so the collapse step is attributed to the SFU on the strength
of the SFU's own CPU and socket counters, not by elimination. A repeat with
the tester sampled, or split across two boxes, would settle it; so would a
step at 550.

### Ladder F: the 2 vCPU ceiling (production's plan)

Not yet run at the time of writing. Same shape as ladder E on a
`vhp-2c-4gb-amd` with four ports, stepping 100, 150, 200, 250, 300, 350,
400. It replaces the 2 vCPU rows of section 5 with a measurement. Record the
same table and name the first step where `lk` loss passes 1% or drops
return; the step before it is the number to plan against.

### Ladder G: bits per viewer (1080p at 4 Mbps)

Not yet run at the time of writing. Ladder E's shape with the presenter on
the explicit 1080p profile (`PROFILE=1080p`, 4 Mbps ceiling, pinned to the
top layer), on whichever box is measured, so the 2.67x cost factor in
section 5 is a measurement rather than a ratio of ceilings.

## 5. Extrapolation, stated as such

Everything in this section is arithmetic and is being replaced by the
ladders one row at a time. Basis, measured: **ladder E carried 500 `lk`
subscribers at 860 Mbit/s and 59% of 4 vCPU and collapsed at 600**; A2
carried 468 decoding receivers at 837 Mbit/s and 69%. Per viewer that is
about 1.72 to 1.79 Mbit/s of SFU egress for a 1.35 Mbit/s share (RTP, UDP
and IP headers, RTCP and audio on top) and about 0.12 points of a 4 vCPU
box's CPU, below the knee.

| Box | Share profile | Viewers | Status | How |
|---|---|---|---|---|
| 4 vCPU (`vhp-4c-8gb-amd`) | 720p at 1.5 Mbps (the large-room default) | **500**, ceiling between 500 and 600 | **measured** (ladder E) | last clean step 500, next step 600 collapsed |
| 4 vCPU | explicit 1080p at 4 Mbps top layer, every viewer on it | about 190 | extrapolated | 500 divided by 2.67 (4 over 1.5); ladder G measures it |
| 2 vCPU (`vhp-2c-4gb-amd`, production) after the port change | 720p at 1.5 Mbps | **about 250 to 300** | extrapolated | half of ladder E's 500 to 600 window; ladder F measures it |
| 2 vCPU after the port change | explicit 1080p at 4 Mbps | about 95 to 110 | extrapolated | the row above divided by 2.67 |

Earlier on 2026-09-07, before ladder E finished, the same table read "about
700" for 4 vCPU at 720p, "about 280" at 1080p, "300 to 400" and "140 to
150" for 2 vCPU. Those were A2's 468 at 69% scaled to 100% CPU. Ladder E
shows the box does not get there: it leaves the linear regime between 59%
and 81% CPU, so the earlier rows overstated by about a third and are
withdrawn. The 2 vCPU rows above are the corrected arithmetic and are still
a guess until ladder F.

Assumptions, each of which a ladder tests:

1. **CPU is linear in forwarded bytes and viewers below the knee, and the
   knee is near 60% CPU.** Measured on 4 vCPU (ladder E: 26%, 38%, 48%, 59%
   at 200, 300, 400, 500; then 81% and collapse at 600). Where the knee sits
   on 2 vCPU is ladder F's question; do not assume it is at the same
   percentage.
2. **Two cores behave like half of four.** Production has 2 NIC queues to
   the test box's 4, and four mux ports over two queues has not been
   measured. Ladder F is that measurement.
3. **The NIC and the plan's port speed carry it.** The test box peaked at
   959 Mbit/s (A2) and 956 (ladder E) with zero NIC drops; nothing above
   that has been observed and it is not established whether that is a cap.
   190 viewers at 1080p is about 1.3 Gbit/s on the 4 vCPU plan. Check the
   plan's port speed before promising a 1080p room of that size.
4. **Viewers are all on the top layer.** A real room has phones on the 360p
   rung and desktops with small tiles; every one of those costs less than the
   figures above. The default for a large room is 720p at 1.5 Mbps, so the
   720p rows are the planning rows.
5. **The single-viewer overhead factor holds** (1.72 to 1.79 over 1.35).
   Loss on real last miles adds retransmissions that a clean datacenter does
   not, and ladder E's subscribers do not decode, so a browser audience of
   500 costs the SFU the same bytes but asks for more NACKs.

Derived, for the egress budget: a three-hour party of 500 viewers at
1.79 Mbit/s each is about 1.2 TB. The production plan includes 5 TB a month
and the box already uses about 760 GB (idle reading, section 2), so three
such parties in a month reach the allowance; Vultr's overage and the 2 TB
account pool are in `plans/SELF_HOSTED_LIVEKIT.md`.

## 6. What would move the numbers, ranked

None of these is promised. They are ordered by how much they move the
viewer count per unit of work, with the reason in one line.

1. **Cores.** Linear below the knee, and the only lever that is a reboot:
   the 4 vCPU plan is measured at 500 for 720p (ladder E) and the 2 vCPU
   plan is expected at about half that (section 5, pending ladder F), for
   about $48 a month list against $36. Plan to about 60% CPU, not 100%:
   ladder E went from clean at 59% to a quarter of all packets lost at 81%.
2. **Bits per viewer.** Egress and CPU both scale with it. The large-room rule
   already holds a share to 720p at 1.5 Mbps above 20 participants; the
   remaining levers are the explicit 1080p escape hatch (2.67x the cost per
   viewer, section 5), the receive-quality defaults that put phones on the
   360p rung, and the codec (AV1 or VP9 at the same picture costs fewer bits
   but more encoder CPU on the presenter's machine, and browser support
   varies).
3. **TURN off the box.** Today the relay shares the SFU's CPU, NIC and port
   range. A viewer behind a hostile network costs the box twice (relay in,
   media out). Moving TURN to its own small box or to the API-served
   Cloudflare relay removes that from the SFU's budget; the size of the win
   depends on how many viewers relay, which has not been measured.
4. **Beyond about a thousand viewers, an architectural change.** One SFU
   forwarding one track to every viewer is bounded by one machine's cores and
   NIC. Past roughly a thousand the shape changes: HLS or LL-HLS egress for
   the passive audience (encode once, serve segments from a CDN, keep WebRTC
   for the people who talk), or a LiveKit multi-node deployment with Redis.
   Both are projects, not settings.

## 7. How to rerun

- **Safety rules first**: `docs/STAGING.md`, section "Load testing staging".
  Never production, never a deployment sharing production's database
  cluster, put staging back afterwards.
- **API join path**: `server/scripts/load-fanout.ts --mode join`, runbook and
  reading guide in `docs/STAGING.md`. Deploy the image you mean to measure
  first and check the `target ran <sha>` line.
- **Media**: `tools/watch-party-load` (`README.md` there covers `prepare`,
  `shard`, `--start-at-ms`, the acceptance contract and `cleanup`). Hosted
  runs only accept 500 participants; the 2 to 5 participant smoke needs
  `PQP_LOAD_SMOKE=1`.
- **Test SFU**: `tools/sfu/install.sh` on a throwaway Vultr instance with
  sslip.io names and a fresh key pair; point staging's `LIVEKIT_*` at it and
  confirm `/ready` reports that host before any run. Never put the production
  key pair on a test box.
- **Fleet shape used on 2026-09-07**: one `vhp-4c-8gb-amd` SFU and four
  `vhp-12c-24gb-amd` generators in Vultr `sao`, plus staging on
  `performance-2x`; about $0.66 an hour for the Vultr fleet plus the staging
  machine while it runs. Four generators with four processes each held 500
  receivers at 720p; at 30 fps decode they run at 87 to 94% (A2), so a
  full-decode 500 wants five or six generators or fewer receivers per box.
- **Ceiling ladders**: `ladder-run.sh <run> <steps> <seconds>` with
  `PROFILE=720p|1080p`; it publishes our presenter through the app from
  generator `a` and runs `lk-ladder.sh` (the LiveKit CLI's `lk load-test`)
  from generator `d`. Sample the tester box too next time, and add a step
  half-way into the last clean interval (550 on 4 vCPU).
- **Orchestration**: the run scripts of 2026-09-07 (`run500.sh`,
  `ladder-run.sh`, the per-host samplers, `summarize.mjs`, `lk-ladder.sh`,
  `ladder-summarize.mjs`, `sfu-config.sh`) lived in `/tmp/pqp-loadtest/` on
  the operator's Mac and are not committed. A rerun should commit them next
  to the harness; until then, their shape is: `systemd-run` one sampler per
  box writing a per-second TSV (`epoch cpu_total cpu_idle rx_bytes tx_bytes
  ... udp_rcvbuf ... mem`), one shard per process with a shared absolute
  `--start-at-ms`, pull reports and samples into `runs/<run>/`, summarise.
- **After the run**: scale staging down, unset the secrets, delete the
  `Load %` servers and `load_test_user%` accounts (the SQL is in
  `docs/STAGING.md`), destroy the Vultr fleet.
