# Capacity: what the voice stack carries, measured

The durable record of the load tests. One section per run, so later runs
append rather than rewrite. Every number carries the label of the run it came
from; a number with no label is an extrapolation and is marked as one.

Runs to date: control A, A1, A2, A2 repeat and ladder F, all on 2026-09-07,
plus the API-only morning runs recorded in `docs/STAGING.md`. Method and rigs
are in section 3 and section 7; the staging runbook is
[`docs/STAGING.md`](./STAGING.md) ("What it has measured", evening section).

## 1. Summary

**What production carries today.** The production media server is a 2 vCPU
box with LiveKit on **one** UDP mux port. On a 4 vCPU copy of that
configuration, a 500-person watch party at 720p failed on media: 229 of 499
viewers never decoded a frame, the rest ran at 1.2 fps with 58% packet loss,
and the box could push only 250 to 270 Mbit/s out of the roughly 800 the room
asked for (run A1). The failure is the single UDP socket overflowing its
receive buffer, not CPU and not the API. The 2 vCPU box has not been driven to
its own limit; a single-port room fails before that matters.

**What the port change buys.** With `rtc.udp_port: 7882-7885` and nothing else
changed, the same 4 vCPU box delivered the full 720p stream to 499 of 499
viewers at 29.5 fps median, 0.000% median loss, 880 to 935 Mbit/s, at 76% CPU
p95 (run A2 repeat). Same rig, same hour, one config line.

**What needs four cores.** 500 viewers at 720p (1.5 Mbit/s each) fits a 4 vCPU
box with about a quarter of its CPU left, and that box breaks between 500 and
600 subscribers (ladder F: 500 clean at 59% CPU, 600 at 27% loss and 81% CPU).
On the 2 vCPU production box with four ports, expect **about 250 to 300 viewers
at 720p**. That figure is an extrapolation (half the cores of a box that broke
between 500 and 600); the 2 vCPU ladder was not run. Measure it before quoting
it to anyone.

**1080p divides those numbers by about 2.7.** Above `LARGE_ROOM_PARTICIPANTS`
(20) a share is held to 720p at 1.5 Mbit/s unless the sharer picks 1080p by
name, which asks for 4 Mbit/s (`client/src/lib/video-quality.ts`). Egress
scales with bits per viewer, so 500 at 720p is about 185 at 1080p on the same
box. Not measured (condition B was not run); it is arithmetic on measured
egress.

**The API is not the ceiling at 500.** Across every 500 run the API answered
`welcome` in 37 to 39 ms p50 and 65 to 69 ms p95 from socket open, pool 14 to
18 of 40, CPU under 16% p95, zero retries, 429s or backpressure drops. Its own
one-room join ceiling, measured without media, is about 650 to 674 in the room
(control A), before the roster deltas of PR #344.

## 2. Production topology and the recommended configuration

| piece | today |
|---|---|
| Media server | Vultr `sfu-pqp`, `vhp-2c-4gb-amd` (2 vCPU, 4 GB), São Paulo, LiveKit 1.13.6 in Docker, built from `tools/sfu/install.sh` |
| Media ports | one UDP mux port, `rtc.udp_port: 7882`; ICE over TCP on 7881 |
| TURN | LiveKit's built-in TURN on the same box, UDP 3478, relay range 30000 to 40000 |
| Signalling | `wss://sfu.pqp.gg` through Caddy on 443 to LiveKit 7880 |
| API | Fly `pqp-api`, `performance-2x` (2 vCPU, 4 GB), `PG_POOL_MAX=40`, one machine by choice (#341) |
| Client ladder | auto 3 Mbit/s, 720p 2 Mbit/s, 1080p 4 Mbit/s; above 20 participants a share is held to 720p at 1.5 Mbit/s unless 1080p is chosen by name |

Recommended, being applied to production (another agent is applying it; fill
in the date when it lands):

| change | why | applied on |
|---|---|---|
| `rtc.udp_port: 7882-7885` in `tools/sfu/livekit.yaml.tmpl`, plus `ufw allow 7882:7885/udp` | the one attributable difference between A1 (fails at 500) and A2 (passes). LiveKit binds `min(vCPUs, ports)`, so a 2 vCPU box uses two of the four; opening all four means a resize needs no firewall change | _pending_ |
| `net.core.rmem_max` / `wmem_max` raised (`tools/sfu/sysctl-livekit.conf`, 25 MB) | LiveKit asks for a 16 MB buffer per mux socket and logs `UDP receive buffer is too small for a production set-up, current 425984, suggested 5000000` on every boot, production included. Every run in this document ran with the default 212992 (`meta.json`, `sfuRmemWmem`). Bursty receive-buffer drops still appeared from 400 subscribers upward with four ports (ladder F); this is what absorbs them. Only new sockets see it: restart LiveKit after | _pending_ |
| `limit.num_tracks: -1` (and `bytes_per_sec: -1`) | 1.13.6 has no default track limit. Newer releases default to 400 tracks per CPU, which would silently cap a 2 vCPU box at about 400 viewers on an image bump. Pin before any bump | _pending_ |

Known and not fixed: **TURN over TLS is dead.** Web, iOS and Android LiveKit
clients receive only the LiveKit server's built-in TURN. LiveKit advertises
`turns:turn.pqp.gg:443`, but Caddy owns 443 on the box, so that candidate never
connects; the UDP 3478 relay is what works. Measured relay share on production:
13 of 139 joins (9.4%), all UDP, all Windows web or Electron. A viewer behind a
network that blocks UDP has no working relay today. Fix under consideration:
hand LiveKit clients the same `/api/ice-servers` list (Cloudflare TURN) the mesh
path already uses.

## 3. Methodology and its limits

Two rigs, both against `pqp-api-staging` and never production. The generators
had `api.pqp.gg` and `sfu.pqp.gg` denied in their firewall and the harness
refuses both by name.

**Rig 1, API only:** `server/scripts/load-fanout.ts --mode join`. Real HTTP
bootstrap, app socket, `welcome`, held open. No media. Runbook and the
morning results in `docs/STAGING.md`.

**Rig 2, media:** `tools/watch-party-load` (PR #337 plus #348). Each simulated
viewer does the whole path: cold HTTP, app socket, `welcome`,
`POST /api/voice/token`, LiveKit connect, subscribe, decode. One presenter
publishes a 720p30 share at the client's large-room cap of 1.5 Mbit/s.
Presenter first, 499 receivers over 90 s (5.5/s), 600 s hold. 20% of sockets
declare no `caps` and no `permessage-deflate`, to stand in for old clients.
Sampled every second on the API machine (`/proc/stat`, `/proc/net/dev`,
`/ready`, `/api/admin/metrics` every 30 s), the SFU (the same plus
`/proc/net/snmp` UDP errors and LiveKit's `:6789/metrics`) and every generator.

What a "sustained" viewer means: at least 120 decoded frames per 5 s window,
`freezeCount` flat, height at least 720, for the whole hold.

Ladder F used `lk load-test` subscribers (LiveKit's own tool, no decode)
against our presenter, three minutes a step, because native decode would have
needed more generators than were available above 500.

Limits, all of which matter when reading the tables:

- **Receivers are native WebRTC (`@livekit/rtc-node`), not browsers.** They
  decode real frames, so fps, loss and freezes are real, but there is no
  renderer, no tab throttling, no laptop Wi-Fi. A browser fleet would be worse
  at the edge, not better.
- **Generators are the noisiest instrument.** Decode costs about 0.08 of a
  core per 720p30 receiver. A generator over roughly 70% CPU starts freezing
  its own receivers and dropping its own decoded frames, which the harness
  then counts against "sustained". A1 ran the generators at 19 to 27%; A2 at
  67 to 94% (over the gate); A2 repeat at 54 to 66% on the Vultr boxes and 90%
  on one Fly box. Read the sustained figures of A2 and A2 repeat as
  generator-limited. Delivery, fps and loss are not affected the same way and
  are the numbers to trust.
- **The test SFU had 4 vCPU; production has 2.** Same image, same config
  template, same LiveKit version. No run was made on a 2 vCPU box.
- **Staging's database is smaller than production's** and its API machine was
  scaled to production's size (`performance-2x`, `PG_POOL_MAX=40`) for the
  runs only. Two address-keyed limiters (`RATE_LIMIT_ANON_*`,
  `RATE_LIMIT_SOCKET_*`) were lifted; per-identity limiters stayed at default.
- **`VOICE_REGISTRY=postgres` on staging meant the roster deltas were inert**
  (`registryOn() ? null : foldRoomEvents(events)` at the time). Every roster
  update went out as a full snapshot. Control A's ceiling is therefore the
  ceiling *before* PR #344 (deltas in registry mode), which merged after these
  runs and is not in any number here. At 500 participants a roster snapshot
  is 220,878 bytes and a one-join delta is 580 bytes (PR #344).
- **Legacy sockets cost six times the bytes.** Sockets with no caps and no
  deflate received 1810 to 1907 KB of app-WS bytes per run versus 308 to
  320 KB for modern ones (A1, A2, A2 repeat). With deltas inert the whole
  difference is compression. A crowd of old clients loads the API, not the SFU.
- **Why an earlier attempt stalled at 61 viewers:** the pre-auth `anonLimiter`
  (240 tokens, 60/s refill, keyed by client address; on Fly that is the
  rightmost `X-Forwarded-For` entry, so forged headers are ignored and every
  client on one generator shares one bucket). 300 requests from one box at the
  defaults: 285 x 401 and 15 x 429; after lifting `RATE_LIMIT_ANON_*` and
  `RATE_LIMIT_SOCKET_*`: 300 x 401. A rig artefact, not a product limit, but
  also a reminder that 240 requests from one NAT address is a real cap for a
  LAN party.

## 4. Results

Raw data for every run: `summary.md`, `meta.json`, per-second samples, and
the ladder's `steps.tsv`, kept under the run directory named in each heading.
Where a summary and the executor's report disagreed, the summary won and the
difference is noted.

### 4.1 Control A: API join ramp, no media (`controlA`, 2026-09-07 18:53Z)

Rig 1 from one generator, ramp 4/s +4 every 20 s to 1200, everyone stays.
Staging `performance-2x`, `PG_POOL_MAX=40`, image `53099a94`,
`VOICE_REGISTRY=postgres` (deltas inert).

| metric | control A |
|---|---|
| attempted / reached `welcome` | 1200 / 1083 |
| time to welcome p50 / p90 / p99 / max | 1526 / 7648 / 11382 / 11970 ms |
| joins stop fitting the client's 12 s budget at | about 650 to 674 already in the room |
| welcome p90 at 475 to 524 in the room | 2.2 s |
| API pool | 40/40 busy; queue peak 555 in the samples, 616 process high-water |
| pool saturated / tight / ok | 47 s / 2 s / 140 s of 189 samples |
| API CPU | 97% p95, 100% peak of 2 vCPU |
| peak wire rate | 346.9 Mbit/s (5.43x compression, 1083 of 1083 sockets compressed) |
| what the bytes were | 93% `voice-roster` keyframes at about 192 kB each |

This is the API-side one-room ceiling before PR #344. It sits above 500, so
none of the media runs below were API-bound.

### 4.2 A1: single UDP mux port, production's config (`wpa1-single`, 18:56Z)

Rig 2. Test SFU 4 vCPU, `udp_port: 7882`, `rmem_max` default 212992. Four
Vultr 12 vCPU generators, 17 processes, presenter 720p at 1.5 Mbit/s.

| metric | A1 |
|---|---|
| participants | 500 (499 receivers, 1 presenter, 100 legacy sockets) |
| connected to LiveKit | 499 / 499 |
| decoding within 45 s of arrival | 270 / 499 (54.1%) |
| never decoded a frame | 229 (`first-frame-abandoned`) |
| sustained over the hold | **0 / 499** |
| decoded fps p5 / p50 | 0.1 / 1.2 |
| packet loss median / p95 | 58.1% / 59.4% |
| freezes / PLIs / NACKs | 194 receivers / 626,801 / 20,389,411 |
| SFU egress | about 250 to 270 Mbit/s steady (report); p95 314, peak 459 (samples); 273 aggregate received at generators |
| SFU CPU p95 / peak | 74% / 82% of 4 vCPU |
| SFU UDP `RcvbufErrors` | 137,200, in bursts of 700 to 1100 per second |
| welcome p50 / p95 from socket open | 39 / 66 ms |
| first frame from arrival p50 / p95 | 765 / 1439 ms (for the 270 that got one) |
| generators CPU p95 | 19 to 27% (clean) |
| API pool peak / CPU p95 | 16 of 40 / 16% |

The generators were idle and the API was idle. The one thing at its limit was
the single UDP socket on the SFU.

### 4.3 A2: four UDP mux ports (`wpa2-fourport`, 19:19Z)

Same rig, same hour, `udp_port: 7882-7885`, nothing else changed. One
generator process segfaulted in `rtc-node` ninety seconds in and took its 31
receivers with it, so 468 were present.

| metric | A2 |
|---|---|
| participants present | 469 (468 receivers) |
| decoding within 45 s | **468 / 468 (100%)** |
| never decoded a frame | 0 |
| sustained over the hold | 337 / 468 (72%), generator-limited |
| decoded fps p5 / p50 | 29.4 / 29.7 |
| packet loss median / p95 | 0.000% / 0.001% |
| freezes / PLIs / NACKs | 131 receivers / 0 / 1606 |
| SFU egress | 805 to 853 Mbit/s steady (report); p95 858, peak 959 (samples) |
| SFU CPU p95 / peak | 75% / 81% of 4 vCPU |
| SFU UDP `RcvbufErrors` | **0** |
| welcome p50 / p95 | 37 / 69 ms |
| first frame from arrival p50 / p95 / p99 | 811 / 1366 / 1646 ms |
| generators CPU p95 | 67 to 94% (three of four over the 70% gate) |
| API pool peak / CPU p95 | 18 of 40 / 15% |

105 of the 131 freezes were on the one generator at 94% CPU that also ran the
presenter (15,243 decoder frames dropped there, none elsewhere). Report says
CPU p95 75% ("67 to 78%" band); the sample file says p95 75%, peak 81%.

### 4.4 A2 repeat: four ports, six generators (`wpa2-fourport-r2`, 20:39Z)

Same SFU config. Four Vultr 12 vCPU boxes plus two Fly `performance-16x`
machines in `gru`, 27 processes of about 19 receivers, join concurrency 8.

| metric | A2 repeat |
|---|---|
| participants | 500 (499 receivers, 100 legacy sockets) |
| decoding within 45 s | **499 / 499 (100%)** |
| never decoded a frame | 0 |
| sustained over the hold | 279 / 499 (56%), generator-limited (see below) |
| decoded fps p5 / p50 | 27.7 / 29.5 |
| packet loss median / p95 | 0.000% / 0.027% |
| freezes / PLIs / NACKs | 220 receivers / 10 / 825 |
| SFU egress | 880 to 935 Mbit/s steady (report); p95 913, peak 1011 (samples) |
| SFU CPU p95 / peak | 76% / 82% of 4 vCPU |
| SFU UDP `RcvbufErrors` | **0** |
| welcome p50 / p95 | 37 / 65 ms |
| first frame from arrival p50 / p95 / p99 | 835 / 1747 / 2402 ms |
| presenter | 30.1 fps at 1.35 Mbit/s |
| generators CPU p95 | Vultr 54 to 66%; Fly 65% and 90% |
| API pool peak / CPU p95 | 14 of 40 / 14% |

The 90% Fly box froze all 95 of its receivers (96,785 frames dropped by its
own decoders). The four Vultr boxes, all under 66%, froze 55 of their 309
receivers once each with zero dropped frames and 111 lost packets between
them: brief jitter at the edge of the SFU's CPU, not a starved generator. Read
A2 and its repeat together as: at 500 the four-port 4 vCPU box delivers the
full 720p stream to everyone, and the first thing to give is smoothness, not
delivery.

### 4.5 Ladder F: 4 vCPU, 720p, four ports, `lk load-test` subscribers (`ladder4c-720`, 19:42Z)

Three minutes a step, our presenter at 1.5 Mbit/s, `rmem_max` default.

| subscribers | egress p50 (peak) Mbit/s | SFU CPU p50 (p95) | rcvbuf drops/s mean (peak) | loss (lk aggregate) | per subscriber |
|---|---|---|---|---|---|
| 200 | 343 (376) | 26% (28%) | 0 (0) | 0.00% | 1.50 Mbit/s |
| 300 | 516 (565) | 37% (39%) | 0 (0) | 0.00% | 1.50 |
| 400 | 687 (746) | 48% (52%) | 5 (711) | 0.00% | 1.40 |
| 500 | 858 (951) | 59% (63%) | 3 (441) | 0.00% | 1.40 |
| 600 | 588 (956) | 81% (84%) | 26 (1735) | 26.6% | 0.55 |
| 700 | 549 (907) | 85% (86%) | 8 (616) | 26.9% | 0.42 |
| 800 | 547 (911) | 84% (86%) | 15 (2313) | 27.2% | 0.35 |

Between 500 and 600 the 4 vCPU box stops delivering: egress falls instead of
rising, CPU pins in the low 80s and a quarter of the packets reach nobody.
Bursty receive-buffer drops start at 400 with no cost to loss; that is what the
sysctl change in section 2 targets.

## 5. Extrapolation

Everything in this table is arithmetic on the runs above. None of it has been
measured. The assumptions: egress and SFU CPU scale linearly with viewers times
bits per viewer (true from 200 to 500 in ladder F); a box gives out at roughly
the CPU where the 4 vCPU box did (about 80%); 2 vCPU delivers about half of
4 vCPU; a 1080p-by-name share costs 4 Mbit/s against 1.5.

| box | ports | 720p at 1.5 Mbit/s | 1080p by name at 4 Mbit/s | basis |
|---|---|---|---|---|
| 2 vCPU (production today) | one | fails well under 500; exact point unknown | worse | A1 failed at 500 on 4 vCPU with the single socket; 2 vCPU was not run |
| 2 vCPU (production) | four | **about 250 to 300** | about 90 to 110 | half of the 4 vCPU break (500 to 600) at 80% CPU; ladder E not run |
| 4 vCPU | four | 500 measured clean, break 500 to 600 | about 185 to 220 | A2, A2 repeat, ladder F; divide by 2.7 for 1080p |
| 8 vCPU | four or more | about 1000 to 1200 if linear; 1.5 to 1.8 Gbit/s of egress, likely the NIC or the uplink first | about 370 to 440 | not run; linear scaling past one box's CPU is the least safe assumption here |

Not measured, in the order they would change the table most:

1. **E, the 2 vCPU production-identical ladder.** The only run that would turn
   the "250 to 300" into a number.
2. **The raised receive buffer and `num_tracks` conditions**, on their own,
   at 400 to 600, to see whether the bursty drops go away.
3. **B, 1080p pinned at 4 Mbit/s** with receivers on the top layer.
4. **C, 50 voices and 10 cameras** alongside the share (a real party is not
   one track).
5. **D, the join storm with resume** (what an API restart mid-party does to
   the SFU).
6. A third A2 repeat with every generator under the 70% gate, to get a
   sustained-receipt figure that is the SFU's and not the generators'.
7. A separate control B: the API-only ramp at the media runs' arrival shape
   (5.5/s), so the two rigs share a baseline.
8. 8 vCPU.

## 6. Levers, ranked

None of these is promised. Each is one line because each deserves its own
measurement before its own plan.

1. **Cores.** The cheapest and the only one measured: 2 to 4 vCPU on the same
   image roughly doubles the room (section 5). Resize needs a reboot; never
   during a party.
2. **Bits per viewer.** Egress is viewers times bitrate. The large-room cap at
   720p / 1.5 Mbit/s is already the lever that makes 500 fit; AV1 or a lower
   large-room cap moves it again, at a quality and CPU cost on the presenter.
3. **TURN placement.** Relay traffic is 9.4% of joins today and doubles the
   SFU's bytes for each of them; moving relay to Cloudflare TURN via
   `/api/ice-servers` takes it off the box and fixes the dead TLS path at once.
4. **HLS for passive viewers** beyond about a thousand: a watch party where
   most people only watch does not need a WebRTC subscription per head. LiveKit
   egress to HLS is a separate pipeline with its own latency (seconds).
5. **A second SFU node** (LiveKit multi-node with Redis) is the last one; it
   splits rooms across boxes, not one room, unless the room is bridged.

## 7. How to rerun

**Rig 1 (API only):** `server/scripts/load-fanout.ts`, README beside it,
procedure in [`docs/STAGING.md`](./STAGING.md) ("Load testing staging"). One
laptop suffices up to about 700 Mbit/s of app-WS egress; beyond that shard it.

**Rig 2 (media):** `tools/watch-party-load`, README in the directory
(flags, stampede mode, generator sizing, results). What it needs:

- Staging scaled to production's shape: `performance-2x`, `PG_POOL_MAX=40`,
  an edited `fly.staging.toml` with `soft_limit 1000 / hard_limit 2000`,
  `auto_stop_machines off`, `min_machines_running 1` (never commit that
  edit), and `RATE_LIMIT_ANON_*` / `RATE_LIMIT_SOCKET_*` lifted for the run.
- A throwaway SFU built from `tools/sfu/install.sh` under sslip.io names with
  a fresh key pair, `LIVEKIT_*` on staging pointed at it. Use the vCPU count
  you want to answer a question about; production is 2.
- Generators: about 0.08 core per 720p30 receiver, keep every box under 70%.
  A Vultr `vhp-12c-24gb-amd` holds 80 to 90 receivers; 500 needs six such
  boxes (or four plus two Fly `performance-16x` in `gru`, bootstrapped from
  `node:22-bookworm`). Shards of about 19 to 31 receivers per Node process,
  the presenter in a process of its own, join concurrency 8 to 12 per process
  (12 segfaulted `rtc-node` once in 43 process-runs).
- Deny `api.pqp.gg` and `sfu.pqp.gg` in every generator's firewall before
  the first run. The harness refuses both by name as well.
- Check the `target ran <sha> for the whole run` line in every report; the
  rig is shared and another agent's deploy mid-run has produced a wrong
  number before.

**Cost of the 2026-09-07 evening:** about $4.50 Vultr (SFU plus four
generators) plus about $4 Fly for the two extra generators, under $1 of
staging. The Vultr account's monthly fee cap refused new machines mid-session
and its API key is IP-restricted (a VPN on the laptop breaks every call).

**Afterwards:** tear down the SFU and the generators, scale staging back,
`git checkout fly.staging.toml`, redeploy staging from its branch, and point
`LIVEKIT_*` on staging back (or unset it). Then append the run here.
