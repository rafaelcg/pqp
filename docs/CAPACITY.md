# Capacity: how the voice stack is measured

The method, the rigs and the configuration. **The measured results are not in
this repository.** They live in the operator's copy at
`~/.config/pqp/capacity-measured.md` (mode 600 in a 700 directory), and every
figure this document used to carry is there in full, run tables included.

That split is deliberate and it is not modesty about the numbers. This
repository is public and so is the load harness in `tools/watch-party-load`,
which is a working 500-client generator against the real application path.
Publishing the exact break point of the production media server, the API's
one-room join ceiling, the rate limiter's per-address budget and the recipe for
lifting it alongside that harness hands someone the whole map. The methodology
is good open source and stays; the coordinates do not.

Nothing was removed from git history. Earlier revisions of this file still
carry the figures and are readable by anyone who looks, which is fine: these
are operational measurements, not credentials. Rewriting history was considered
and deliberately not done.

Runs to date: control A, A1, A2, A2 repeat and ladder F, all on 2026-09-07,
plus the API-only morning runs whose method is in
[`docs/STAGING.md`](./STAGING.md). Results for all of them: the operator's copy.

## Timeline

Three changes to the production media server (Vultr `sfu-pqp`, São Paulo), in
order. This table is configuration and dates, which a self-hoster needs; read
it first to see which config any given result in the operator's copy describes.

| when | change |
|---|---|
| 2026-09-07, evening | Load tests run on an isolated test box. Production itself, untouched by any of these runs: 2 vCPU, one UDP mux port (`vhp-2c-4gb-amd`, `rtc.udp_port: 7882`), unchanged since it was provisioned on 2026-09-06. |
| 2026-09-08 07:17:17Z | Production: `rtc.udp_port: 7882-7885` (was one port), `limit: { num_tracks: -1, bytes_per_sec: -1 }`, and `/etc/sysctl.d/90-livekit.conf` (`net.core.rmem_max` / `wmem_max` 26214400) applied. Still a 2 vCPU box, so only two of the four ports bound (LiveKit binds `min(vCPUs, ports)`). |
| 2026-09-08 09:25:54Z | Production resized from `vhp-2c-4gb-amd` (2 vCPU, 4 GB) to `vhp-4c-8gb-amd` (4 vCPU, 8 GB), about 42 s of downtime. All four ports bound after the reboot. $48/mo list, about $72/mo in São Paulo. |
| 2026-09-08 | Redis and LiveKit Egress (for HLS) installed on the same box. The box has always run the TURN relay as well. |

The test box and production match in size only after 09:25:54Z on 2026-09-08. A
number measured on the isolated test box before that timestamp describes what
that LiveKit configuration *can* do; it is not a production measurement,
because production itself was a different size while every run was collected.
See section 3 for the full caveat. That caveat survives the resize: the
production box has still never been driven to load.

## 1. What the runs established, without the numbers

**The failure at scale was the single UDP mux socket, not CPU and not the
API.** On a copy of the production configuration of the time, a 720p watch
party failed on media while the box's cores and the API were both idle: most
viewers never decoded a frame, the rest ran at a fraction of the frame rate
with heavy packet loss, and the box pushed a small share of the egress the room
asked for. The socket's kernel receive buffer was overflowing in bursts. Same
rig, same hour, one config line changed to spread the receive path across four
UDP ports, and the same box delivered the full stream to every viewer at full
frame rate with zero measured loss and zero receive-buffer drops.

The reasoning behind that, which is the part worth keeping: **one UDP mux
socket serialises the whole receive path onto one kernel queue and, in
practice, one core.** Spreading it over a port per core scales with the cores
you have. LiveKit's own guidance is at least as many mux ports as vCPUs, and
the binary binds `min(vCPUs, ports in the range)`, so opening four ports on a
two-core box costs nothing and means a later resize needs no firewall change.

**Cores are the lever that was measured.** Doubling vCPU on the same image
roughly doubles what one room carries, because egress and SFU CPU both scale
with viewers times bits per viewer. A box gives out when its CPU pins; past
that point egress *falls* instead of rising and a large share of packets reach
nobody, which is a cliff and not a slope.

**Bits per viewer is the other half of every figure.** Above
`LARGE_ROOM_PARTICIPANTS` (20) a screen share is held to 720p at 1.5 Mbit/s
unless the presenter picks 1080p by name, which asks for 4 Mbit/s
(`client/src/lib/video-quality.ts`). That is a factor of about 2.7 on every
capacity number, decided by a menu the presenter touches, not by anything pqp
controls.

**The API was not the ceiling in any media run.** Across every run it answered
`welcome` in tens of milliseconds from socket open, with the pool under half
its budget, CPU in the teens, and zero retries, 429s or backpressure drops. Its
own one-room join ceiling was measured separately, without media, and sits well
above the sizes the media runs used. The figure is in the operator's copy.

## 2. Production topology and the recommended configuration

| piece | today |
|---|---|
| Media server | Vultr `sfu-pqp`, `vhp-4c-8gb-amd` (4 vCPU, 8 GB) since 2026-09-08 09:26Z (was `vhp-2c-4gb-amd`, 2 vCPU, 4 GB), São Paulo, LiveKit 1.13.6 in Docker, built from `tools/sfu/install.sh` |
| Media ports | four UDP mux ports, `rtc.udp_port: 7882-7885` since 2026-09-08 07:17Z (was one, `7882`); ICE over TCP on 7881 |
| TURN | LiveKit's built-in TURN on the same box, UDP 3478, relay range 30000 to 40000 |
| Signalling | `wss://sfu.pqp.gg` through Caddy on 443 to LiveKit 7880 |
| API | Fly `pqp-api`, `performance-2x` (2 vCPU, 4 GB), `PG_POOL_MAX=40`, one machine by choice (#341) |
| Client ladder | auto 3 Mbit/s, 720p 2 Mbit/s, 1080p 4 Mbit/s; above 20 participants a share is held to 720p at 1.5 Mbit/s unless 1080p is chosen by name |

Applied to production:

| change | why | applied on |
|---|---|---|
| `rtc.udp_port: 7882-7885` in `tools/sfu/livekit.yaml.tmpl`, plus `ufw allow 7882:7885/udp` | the one attributable difference between the run that failed and the run that passed. LiveKit binds `min(vCPUs, ports)`, so a 2 vCPU box uses two of the four; opening all four means a resize needs no firewall change | 2026-09-08 07:17:17Z |
| `net.core.rmem_max` / `wmem_max` raised (`tools/sfu/sysctl-livekit.conf`, 25 MB) | LiveKit asks for a 16 MB buffer per mux socket and logs `UDP receive buffer is too small for a production set-up, current 425984, suggested 5000000` on every boot, production included. Every run so far ran with the kernel default (`meta.json`, `sfuRmemWmem`). Bursty receive-buffer drops still appeared well before the CPU limit even with four ports; this is what absorbs them. Only new sockets see it: restart LiveKit after | 2026-09-08 07:17:17Z |
| `limit.num_tracks: -1` (and `bytes_per_sec: -1`) | 1.13.6 has no default track limit. Newer releases default to 400 tracks per CPU, which would silently cap a small box on an image bump. Pin before any bump | 2026-09-08 07:17:17Z |
| Resize `sfu-pqp` from `vhp-2c-4gb-amd` to `vhp-4c-8gb-amd` | the port change only pays off with four cores to bind the four ports to; gated on LiveKit participants at most 4 | 2026-09-08 09:25:54Z |

**TURN, corrected 2026-09-08.** This paragraph used to say that web, iOS and
Android LiveKit clients receive only the media box's own built-in TURN, that
its TLS relay is dead because Caddy owns 443, that about one join in ten
relayed through the box, and that handing LiveKit clients the
`/api/ice-servers` list was a fix under consideration. That fix has since
shipped: `client/src/lib/sfu-ice-servers.ts` and its iOS and Android twins
hand the app's own list (Cloudflare first) to the LiveKit SDK's `rtcConfig`,
and the SDK then skips the join response's list entirely, so the box's relay
is no longer offered to anybody.

Checked on the box on 2026-09-08 with 9 to 12 participants live: **zero**
relay allocations in the 30000 to 40000 range at three sampled instants.
Three instants is not a proof of never, but the one-in-ten figure this
replaces is certainly wrong now and should not be quoted. The TLS relay on
5349 is still dead and still unused, and nothing depends on it; the reason it
is dead (Caddy owns 443) is unchanged.

**Co-tenancy note.** Redis and LiveKit Egress (for HLS) run on `sfu-pqp`
alongside LiveKit itself, installed 2026-09-08; the box has always run the TURN
relay too. If watch parties running HLS become routine, the clean split is a
separate small egress box, not a bigger SFU.

The transcode cost itself used to be a guess here ("roughly one core on moving
content"). It is now measured, on 2026-09-09, on the staging media box, which
runs the same images and versions production does (`livekit/livekit-server`
1.13.6, `livekit/egress` v1.14.1) from the same `tools/sfu/install.sh`:

| rung | egress container CPU, sustained |
|---|---|
| `720p30` (1800 kbit/s out) | **0.51 core** |
| `1080p30` (4500 kbit/s out) | **0.88 core** |

Method: one publisher, one `SOURCE_SCREENSHARE` track at 1280x720@30 and
1.5 Mbit/s in, no subscribers, `docker stats --no-stream` sampled every 8 s
over 40 to 60 s of steady state. LiveKit's own container sat at 1.4 to 2.2%
throughout, so the egress is essentially the whole cost.

**Read it as an upper bound.** The source is synthetic full-frame motion at
30 fps, which is close to worst case; real screen content is mostly static
between frames and encodes considerably cheaper. And it is one rendition at a
time on an idle box, not a rung alongside a busy WebRTC room.

What it changes: the default two-rung ladder (`1080p30,720p30`) is about
**1.4 of the production box's 4 cores** for one watch party, not the ~2 the old
estimate implied, which leaves the SFU, TURN and the rest comfortably supplied
for a single party. There is still no cap on **concurrent** parties, so
`LIVE_HLS_SERVER_ALLOWLIST` is what bounds this in practice
(`docs/WATCH_PARTY.md`, "Turning it on in production").

Two things the same session showed that are not CPU. On a box with only one
core, the second rung's `StartEgress` **timed out** rather than being refused
by `LIVE_HLS_MAX_LADDER_MBPS` (the budget prices Mbit/s, not cores, so it does
not know how many cores it has); the session correctly degraded to the one rung
that started, logged `voice.hlsRungStartFailed`, and served it. And
time-to-first-playlist is CPU-sensitive: 10.8 s for a `720p30`-first ladder
against **43.7 s** for `1080p30` alone on that saturated single core. On a
4 vCPU box neither should bite, but a host staring at a blank pane for
three quarters of a minute after Ir ao vivo is the shape to watch for.

## 3. Methodology and its limits

Two rigs, both against `pqp-api-staging` and **never production**. The
generators had `api.pqp.gg` and `sfu.pqp.gg` denied in their firewall and the
harness refuses both by name (`PROD_HOSTS` in
`tools/watch-party-load/src/index.ts`, which also pins the hosted target to the
exact staging API and WebSocket and forbids any `*.pqp.gg` SFU host).

**Rig 1, API only:** `server/scripts/load-fanout.ts --mode join`. Real HTTP
bootstrap, app socket, `welcome`, held open. No media. Runbook in
[`docs/STAGING.md`](./STAGING.md).

**Neither rig touches HLS at all.** This is the limit to read before quoting
any number here at a watch party that has live HLS on. `tools/watch-party-load`
never sends `set-sharing-screen`, which is the frame that starts an egress, so
no run in this document has ever had a transcode running, and every "viewer" in
every result is a **WebRTC subscriber** pulling its own stream off the SFU. An
HLS viewer is a different animal on a different path: it holds an app socket
and takes no seat, polls a playlist off `pqp-api` every two seconds, and pulls
segments straight from R2. The SFU carries one publisher and nothing else for
it. So the measured subscriber ceilings do not transfer to an HLS audience in
either direction, and the parts of the HLS path that would give out first
(the playlist proxy's CPU on `pqp-api`, and R2) have never been driven with
hundreds of distinct viewers. See the additions to section 5.

**Rig 2, media:** `tools/watch-party-load` (PR #337 plus #348). Each simulated
viewer does the whole path: cold HTTP, app socket, `welcome`,
`POST /api/voice/token`, LiveKit connect, subscribe, decode. One presenter
publishes a 720p30 share at the client's large-room cap of 1.5 Mbit/s.
Presenter first, then receivers ramped in over 90 s, then a 600 s hold. A fifth
of the sockets declare no `caps` and no `permessage-deflate`, to stand in for
old clients. Sampled every second on the API machine (`/proc/stat`,
`/proc/net/dev`, `/ready`, `/api/admin/metrics` every 30 s), the SFU (the same
plus `/proc/net/snmp` UDP errors and LiveKit's `:6789/metrics`) and every
generator.

What a "sustained" viewer means: at least 120 decoded frames per 5 s window,
`freezeCount` flat, height at least 720, for the whole hold.

The subscriber ladder used `lk load-test` subscribers (LiveKit's own tool, no
decode) against our presenter, three minutes a step, because native decode
above the largest native run would have needed more generators than were
available.

Limits, all of which matter when reading any result:

- **Receivers are native WebRTC (`@livekit/rtc-node`), not browsers.** They
  decode real frames, so fps, loss and freezes are real, but there is no
  renderer, no tab throttling, no laptop Wi-Fi. A browser fleet would be worse
  at the edge, not better.
- **Generators are the noisiest instrument.** Decode costs about 0.08 of a core
  per 720p30 receiver. A generator over roughly 70% CPU starts freezing its own
  receivers and dropping its own decoded frames, which the harness then counts
  against "sustained". Several runs had generators over that gate, so their
  sustained figures are generator-limited. Delivery, fps and loss are not
  affected the same way and are the numbers to trust.
- **The test SFU was 4 vCPU; production was 2 at the time of every run.** Same
  image, same config template, same LiveKit version. No run was made on the
  production box itself. Production has since been resized to match the test
  rig's size, but that does not upgrade those numbers into production
  measurements: every run was collected on the isolated box before the resize.
- **Staging's database is smaller than production's** and its API machine was
  scaled to production's size for the runs only. The two address-keyed
  limiters were lifted for the run; per-identity limiters stayed at default.
  The names, the values and the exact commands are in the operator's copy, with
  the reason a single-source harness needs them at all.
- **`VOICE_REGISTRY=postgres` on staging meant the roster deltas were inert**
  (`registryOn() ? null : foldRoomEvents(events)` at the time). Every roster
  update went out as a full snapshot, so the API-only ceiling is the ceiling
  *before* PR #344 (deltas in registry mode), which merged after these runs.
- **Legacy sockets cost about six times the bytes.** Sockets with no caps and
  no deflate received roughly six times the app-WS bytes of modern ones. With
  deltas inert the whole difference is compression. A crowd of old clients
  loads the API, not the SFU.

## 4. Results

**Held privately.** Per-run tables (control A, A1, A2, A2 repeat, ladder F),
with participant counts, decode and loss distributions, SFU egress and CPU,
UDP error counters, welcome latencies, pool and generator telemetry, are in
`~/.config/pqp/capacity-measured.md`, part 1.

Raw data for every run (`summary.md`, `meta.json`, per-second samples,
`steps.tsv`) is kept under the run directory named in each heading there, on
the operator's machine. It has never been in this repository.

Where a summary and the executor's report disagreed, the summary won and the
difference is noted in the private copy.

## 5. Extrapolation

The extrapolation table is in the operator's copy. Its method is here, because
the method is what makes it readable: everything in it is arithmetic on the
runs, none of it is measured, and it assumes that egress and SFU CPU scale
linearly with viewers times bits per viewer (which held across the measured
part of the ladder), that a box gives out at roughly the CPU where the test box
did, that half the cores deliver about half, and that a 1080p-by-name share
costs 4 Mbit/s against 1.5. Linear scaling past one box's CPU is the least safe
assumption in it.

Not measured, in the order they would change that table most:

1. **The ladder on the production box itself.** Production is now the same size
   and configuration as the test rig, but every ladder step ran on the isolated
   box. This is the run that would turn "measured on the test rig" into
   "measured on production".
2. **The raised receive buffer and the `num_tracks` pin**, on their own, around
   the size where the bursty drops first appeared, to see whether they go away.
3. **1080p pinned at 4 Mbit/s** with receivers on the top layer.
4. **50 voices and 10 cameras** alongside the share (a real party is not one
   track).
5. **A join storm with resume** (what an API restart mid-party does to the SFU).
6. A repeat with every generator under the 70% gate, to get a
   sustained-receipt figure that is the SFU's and not the generators'.
7. An API-only ramp at the media runs' arrival shape, so the two rigs share a
   baseline.
8. Eight vCPU.
9. **An HLS audience of any size.** Nothing in either rig starts an egress, so
   the whole watch-mode path is unmeasured above a handful of viewers. What is
   known, from single-stream work against staging on 2026-09-09:
   - the playlist proxy's own latency is flat from 5 to 55 requests per second
     of successful traffic (p50 ~265 ms, p95 ~550 ms end to end from a laptop
     to `gru`), which is the per-session render cache doing its job: the body
     is identical for every viewer of a rendition and is rebuilt at most once
     a second however many ask;
   - segments come **straight from R2** over the presigned URL in the
     rewritten playlist, never through `pqp-api` and never through a CDN, at
     ~290 KB per two-second `720p30` segment. 300 concurrent fetches of one
     segment returned 200 with no errors and no throttling;
   - what could NOT be measured from one machine is the API's cost at hundreds
     of **distinct** viewers, because a single identity is capped by the
     per-user API limiter (120 burst, 10/s) and a single address by
     `anonLimiter` (240 burst, 60/s). At roughly half a request per second per
     viewer those bound a one-laptop rig to about a hundred viewers' worth of
     polling, which is well under the interesting range.
   Sizing that run means many distinct `LOAD_TEST_TOKEN` identities across
   several generator addresses, holding a socket and polling a playlist each.
   It needs no decode and no `rtc-node`, so it is far cheaper than rig 2; it
   just does not exist yet.

## 6. Levers, ranked

None of these is promised. Each is one line because each deserves its own
measurement before its own plan.

1. **Cores.** The cheapest and the only one measured: doubling vCPU on the same
   image roughly doubles the room. Resize needs a reboot; never during a party.
2. **Bits per viewer.** Egress is viewers times bitrate. The large-room cap at
   720p / 1.5 Mbit/s is already the lever that makes the current room size fit;
   AV1 or a lower large-room cap moves it again, at a quality and CPU cost on
   the presenter.
3. **TURN placement.** Relay traffic is about a tenth of joins today and
   doubles the SFU's bytes for each of them; moving relay to Cloudflare TURN
   via `/api/ice-servers` takes it off the box and fixes the dead TLS path at
   once.
4. **HLS for passive viewers** past the point where a WebRTC subscription per
   head stops making sense: a watch party where most people only watch does not
   need one. LiveKit egress to HLS is a separate pipeline with its own latency
   (seconds).
5. **A second SFU node** (LiveKit multi-node with Redis) is the last one; it
   splits rooms across boxes, not one room, unless the room is bridged.

## 6b. What binds first, and the measurement that would settle it

Two findings from the 2026-09-08 question "should every room go on the media
server". Recorded here rather than in a PR body because both outlive the answer
they came from.

### The monthly transfer allowance binds before the box does

Every lever in section 6 is about how much the box can *carry at once*. That is
not what runs out first. Priced against the day's own traffic, and expressed as
ratios because the coordinates do not belong in this repository:

- At **ten times** the day's usage, with today's routing, the estimated peak is
  still around a **tenth** of the box's measured clean throughput. Cores and the
  mux ports are nowhere near being the constraint at that multiple.
- The **monthly transfer allowance** is. With today's routing it is reached at
  roughly **3.7x** the day's usage. With every room moved onto the box it is
  reached at roughly **1.6 to 2.1x**, because moving the peer-to-peer half onto
  the box roughly **doubles** its bytes (two independent estimates, 1.8x and
  2.3x; see below for why that is a range).

So the decision "route more rooms to the media server" is a decision about the
transfer bill, not about capacity, and the two have opposite shapes: capacity is
a cliff you must stay well clear of, transfer is a slope you pay down. Read
section 6 for the first and this for the second.

**The allowance figure itself is not settled, which is why everything above is a
ratio.** The plan table says one number (6 TB) and Vultr's own API reports a
much smaller figure for the current billing period (612 GB), and until somebody
reconciles those two, an absolute "we have N TB left" sentence would be a guess
wearing a number. The ratios hold whichever it turns out to be; only the
multiple at which the wall arrives moves. Settle this before quoting a headroom
figure to anybody.

### Nothing records video publishers per room over time

The estimate above is a **range** rather than a number for one avoidable reason:
no table in this product has ever recorded how many cameras and screen shares
were up in a room, over time.

What exists, and why none of it answers the question:

| source | what it holds | why it is not enough |
|---|---|---|
| `voice_rooms` / `voice_peers` | live state only; rows go with the last peer | one instant, whenever you happen to look |
| `voice_occupancy_samples` | participants and rooms per sample, by transport | **no video counts at all** |
| Loki `voice.join` | room size at the moment of a join | says nothing about what the room then did |
| `call_ratings` | "was somebody sharing", self-selected | a boolean, on the calls people chose to rate |

Box cost is `participants x publishers x bitrate` per room, so a series with no
publisher term cannot price a room. Every figure above had to be built by taking
one live snapshot's room shapes and weighting them by the sampler's
participant counts, which is where the factor-of-two band comes from.

**The fix is small and it is already in the right place.** The occupancy sampler
that shipped on 2026-09-08 walks the rooms it already holds; counting
`sharingScreen` and `cameraStreamId` per room while it is there, split by
transport, costs nothing extra and turns the next version of this question from
an estimate into a measurement. Do that before the next routing decision, not
during it.

## 7. How to rerun

**Rig 1 (API only):** `server/scripts/load-fanout.ts`, README beside it,
procedure in [`docs/STAGING.md`](./STAGING.md) ("Load testing staging"). One
laptop suffices up to a few hundred Mbit/s of app-WS egress; beyond that shard
it.

**Rig 2 (media):** `tools/watch-party-load`, README in the directory (flags,
stampede mode, generator sizing, results). What it needs:

- Staging scaled to production's shape (`performance-2x`, `PG_POOL_MAX=40`),
  its `fly.staging.toml` proxy concurrency raised, `auto_stop_machines off`,
  `min_machines_running 1` (never commit that edit), and the two address-keyed
  rate limiters lifted for the run. The exact values and the `fly secrets set`
  and `fly deploy` invocations are in `~/.config/pqp/capacity-measured.md`,
  part 2, along with the matching teardown.
- A throwaway SFU built from `tools/sfu/install.sh` under sslip.io names with a
  fresh key pair, `LIVEKIT_*` on staging pointed at it. Use the vCPU count you
  want to answer a question about; production is 4 vCPU since
  2026-09-08 09:25:54Z (was 2; see Timeline).
- Generators: about 0.08 core per 720p30 receiver, keep every box under 70%. A
  Vultr `vhp-12c-24gb-amd` holds 80 to 90 receivers; size the fleet from that
  and the participant count. Fly `performance-16x` machines in `gru` work as
  extra generators, bootstrapped from `node:22-bookworm`. Shards of roughly
  twenty to thirty receivers per Node process, the presenter in a process of
  its own, join concurrency 8 to 12 per process (12 segfaulted `rtc-node` once
  in 43 process-runs).
- Deny `api.pqp.gg` and `sfu.pqp.gg` in every generator's firewall before the
  first run. The harness refuses both by name as well; that guard is not
  optional and must not be relaxed to "just check something quickly".
- Check the `target ran <sha> for the whole run` line in every report; the rig
  is shared and another agent's deploy mid-run has produced a wrong number
  before.

**Cost of one evening of this:** single-digit dollars of Vultr for the SFU and
the generators, a few dollars of Fly for extra generators, under a dollar of
staging. The Vultr account's monthly fee cap refused new machines mid-session
once, and its API key is IP-restricted (a VPN on the laptop breaks every call).

**Afterwards:** tear down the SFU and the generators, scale staging back,
`git checkout fly.staging.toml`, redeploy staging from its branch, and point
`LIVEKIT_*` on staging back (or unset it). Then append the run to the
operator's copy, and add anything methodological here.

## 8. Don't publish a capacity number

Do not put a viewer-count figure for the production media server in public copy
(marketing, release notes, the website, a pitch). This is the rule that made
the rest of this document what it is. Three reasons:

1. **The production box has never itself been driven to that load.** Every
   large result ran on an isolated test box. Production has been resized to
   match that box's configuration; it has not been proven to carry the same
   load.
2. **The ladder shows a cliff, not a slope.** Past the break point egress falls
   instead of rising, CPU pins, and a large share of packets reach nobody. A
   number just under the edge of a cliff is one bad night from being a number
   just over it.
3. **A presenter choosing 1080p by name divides the figure by about 2.7**
   (`client/src/lib/video-quality.ts`, section 1). The same headline number is
   true or false depending on a menu choice pqp does not control.

The one number that is safe to say publicly is the one that already happened in
public: the watch party of 2026-09-05, over a hundred people, real and observed
([`docs/voice-backends.md`](./voice-backends.md)).
