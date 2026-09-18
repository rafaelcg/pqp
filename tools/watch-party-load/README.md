# Watch-party media load harness

This is a deliberately separate runner for one presenter and many real SFU
subscribers. It exercises the pqp HTTP bootstrap, app WebSocket auth/voice
join, `/api/voice/token`, and then a LiveKit RTC connection. A successful app
`welcome` without a token, SFU connection, subscribed presenter tracks, and
received frames is a failure.

**It refuses production and the production SFU, and that guard is not
optional.** Hosted use is only the exact staging API
(`https://pqp-api-staging.fly.dev`) plus an explicitly supplied,
non-production isolated SFU host; any `*.pqp.gg` SFU host is rejected, and
local mode is restricted to loopback. `PROD_HOSTS` and `parseTarget` in
`src/index.ts` are where that lives. Generators are firewalled against
`api.pqp.gg` and `sfu.pqp.gg` as well; this is the second lock, not the only
one. `TEST_RUN_ID` is required and is included in
synthetic account/server names and reports. Do not pass secrets on the command
line; the runner reads only `LOAD_TEST_TOKEN` from its environment.

Install its isolated dependencies once, and run every command from this
directory with `pnpm exec tsx src/index.ts <command>` (the `pnpm wp <command>`
script is the same thing). Under pnpm 10 the older `pnpm run run -- prepare`
form hands the literal `--` to the script as its command and fails with the
usage line, so do not use it. `pnpm exec tsx src/index.ts help` prints the
commands, flags and environment names.

```sh
cd tools/watch-party-load && pnpm install
pnpm exec tsx src/index.ts help
```

Prepare one shared room (this makes only the synthetic server, channels and
invite), then distribute the resulting manifest file to generator machines:

```sh
TEST_RUN_ID=wp500-01 PQP_LOAD_TARGET=staging \
PQP_LOAD_SFU_HOST=staging-sfu.example.test \
LOAD_TEST_TOKEN=... pnpm exec tsx src/index.ts prepare --manifest /tmp/wp500.json --participants 500
```

Add `--watch-party` to also make a real `watch_party` channel beside the plain
voice one, and grant `@everyone` `START_WATCH_PARTY` on it. This is what a
`shard --presenter-only` run (and `seat-churn.ts`, which prefers it
automatically) needs to actually exercise the watch-party path: HLS only ever
starts in a `watch_party` channel (`pickHlsSharer` in `server/src/ws/voice.ts`),
and the grant has to land before the presenter ever joins, because `canStream`
is computed from the role bits at join time — which is exactly why it happens
here, in `prepare`, and not later in `shard`.

Each generator runs one non-overlapping shard against that manifest. Start the
presenter shard first (`--shard-index 0` contains participant 0), then the
receiver shards. The default 900-second hold is intentionally in the requested
10 to 15 minute first-run range. The presenter is deterministic full-frame 720p30
motion plus 48 kHz audio, with a 1.5 Mbps video and 64 kbps audio encoding
ceiling. Reports include native RTC RTP bytes/bitrate/loss/decoded frames and
generator CPU, RSS, and event-loop lag.

Its HTTP bootstrap is deliberately light: the age gate, the invite join and
four GETs (`/api/me`, `/api/servers`, `/api/friends`, `/api/dms`) before the
socket opens. The fan-out rig's `coldBootstrap` in
`server/scripts/load-fanout.ts` replays what a real cold browser does, about
twenty requests including channels, members, roles, permissions and messages,
because that rig measures the API join path and its pool pressure. This tool
measures media delivery, so its `bootstrapMs` and `welcomeMs` are not
comparable with the fan-out rig's join timings and must not be quoted as
API join capacity.

Every seat is given back when a run ends. Each client sends `leave-voice-room`
over its app socket, then closes its RTC room, then its socket, on a normal
hold end, on its own failure, and on SIGINT, SIGTERM or a crash of the shard
process (bounded to ten seconds, then the process exits). A socket that only
closed would leave a resumable orphan seat in the API's voice maps and
`voice_peers` for the 90-second resume window, which is what an earlier
version did.

All hosted shards require the same future Unix epoch milliseconds through
`--start-at-ms`. This is the barrier: every client must already have an RTC
connection before that instant; only then does the presenter start media and
the common hold begin. A late client fails the run rather than shortening its
own personal hold.

```sh
START_AT_MS=$(( $(date +%s) * 1000 + 120000 ))
TEST_RUN_ID=wp500-01 PQP_LOAD_TARGET=staging \
PQP_LOAD_SFU_HOST=staging-sfu.example.test \
LOAD_TEST_TOKEN=... pnpm exec tsx src/index.ts shard --manifest /tmp/wp500.json \
  --shard-index 0 --shard-count 2 --decode-sample 25 --start-at-ms "$START_AT_MS" \
  --report /tmp/wp500-shard0.json
```

For the two-generator baseline, use `--shard-count 2 --decode-sample 25` on
each VM. Every client joins and subscribes to the real media tracks, and the
native SDK decodes every subscribed video track whether or not anything reads
the frames: a receiver outside the sample still reports a growing
`framesDecoded`, and its decode CPU is spent either way, so `--decode-sample`
does not make the generator cheaper. What the flag selects is which receivers
additionally drain `VideoStream` / `AudioStream` frame objects (`videoFrames`,
`audioFrames` in the report) and are held to the decode-rate criterion below.
Size and monitor generators for a full-width decode. Treat the SFU's host-side
egress counters as the authority for aggregate egress and headroom.

No capacity result belongs in this file. The contract below is the rig's own
pass mark, not a measurement of pqp; measured results live in the operator's
copy named at the top of `docs/CAPACITY.md`.

The first acceptance contract is: all 500 tokened clients connect and receive
RTP; each shard has 25 decoded samples at >=24 fps; presenter input is >=27
fps and its outbound RTP video is >=27 fps at 1280×720; median sampled loss
<1%; no unexpected disconnects; each generator stays
below 70% of one core per allocated vCPU with no growing event-loop lag; SFU
egress sustains the observed receiver bitrate with >=20% headroom. A report's
RTP bitrate is measured at its receivers; it does not substitute for the SFU's
aggregate NIC metric.

How a shard judges itself, and how that scales with the hold. Every result
carries a `verdict` array (empty means passed) and the console line lists the
first ten that missed. For every receiver: two subscribed tracks, RTP
received, and continuity, meaning each five-second flow reading plus the final
reading (readings closer than a second apart are merged) must carry more
bytes and more decoded frames than the one before; a stalled SFU or a frozen
decoder fails this on every receiver, sampled or not. For sampled receivers:
`framesDecoded >= --min-decoded-fps (24) * (hold - --decode-warmup-seconds)`.
The warm-up default is 10 s because the SFU's bandwidth estimate takes about
that long to reach the 1.5 Mbps ceiling after the presenter starts, and
decoded frames only reach 30 fps once it has (a local smoke measured 46
frames in the first five seconds, 88 in the next, then 145 per five seconds).
For the 900 s hold that is 21 360 frames, within 1.2 % of the old flat
threshold; for a 15 s smoke it is 120 frames, so a healthy short smoke passes
and a real stall fails on continuity. A hold of 10 s or less proves delivery
and continuity, not the decode rate. The presenter must keep outbound RTP
video at >=27 fps; everyone must have connected before `--start-at-ms` and
seen no unexpected disconnect.

Before the 500 run, an explicitly named staging smoke may use exactly two
participants and a 60 to 120 second hold. It is unavailable unless
`PQP_LOAD_SMOKE=1` is set, retains every staging/SFU safety gate, and is not a
capacity result. Do not use it as a shortcut for the 500 contract.

The report proves packet/frame delivery through the Node RTC SDK (decoded frame
objects from `VideoStream`/`AudioStream`), not browser compositor rendering or
audibility. Add browser/device sentinels before treating this as a product UX
acceptance result. The runner does not provision, deploy, reset a database, or
delete the room automatically. `cleanup` is deliberately a separate explicit
command. It requires an explicitly supplied `PQP_LOAD_DATABASE_URL`, deletes
only the manifest's server, then deletes only the exact synthetic Clerk IDs
derived from `TEST_RUN_ID`; it refuses to start without that URL.

For a small isolated smoke, set `PQP_LOAD_TARGET=local`, `--participants 2`, and use only loopback
API, WebSocket, and SFU hosts. Local mode uses the existing dev-bypass account
suffixes; it never reads `LOAD_TEST_TOKEN`. Start a local API with an isolated
database and local LiveKit first, then run the same prepare/shard commands with
`--participants 500` only after a small manual smoke has established that the
local SFU path is configured. Hosted runs only accept 500; the 2 to 5 local
exception is solely to validate the rig.

A worked local smoke, against an API started with `DEV_AUTH_BYPASS=true`, an
isolated `DATABASE_URL`, and `LIVEKIT_URL=ws://localhost:7880` with the dev
key pair from `docker compose --profile livekit up -d livekit`:

```sh
export TEST_RUN_ID=wpl-smoke-01 PQP_LOAD_TARGET=local PQP_LOAD_SFU_HOST=localhost
pnpm exec tsx src/index.ts prepare --manifest /tmp/wpl.json --participants 5
pnpm exec tsx src/index.ts shard --manifest /tmp/wpl.json --shard-index 0 --shard-count 1 \
  --hold-seconds 15 --start-at-ms $(( $(date +%s) * 1000 + 8000 )) --report /tmp/wpl-report.json
```

`PQP_LOAD_API_URL` / `PQP_LOAD_WS_URL` move it off port 3001 (loopback only).
Give `--start-at-ms` a few seconds of headroom: every client must hold an RTC
connection before that instant or it is judged late.

## Stampede mode, legacy sockets, publishers, churn (2026-09-07 additions)

The barrier described above (everyone connected before `--start-at-ms`, the
presenter starting media at that instant) measures a room that was already
full when the stream began. A watch party is the opposite: the stream is live
and people pile in. `--arrival-window-seconds W` switches to that shape. The
presenter connects and publishes as soon as it can; receiver `i` arrives at
`start + lead + (i - 1) x W / (N - 1)` (`--arrival-lead-seconds`, default 10),
and every timer is the receiver's own: welcome is measured from socket open
the way `JOIN_TIMEOUT_MS` in `client/src/hooks/use-voice.ts` arms it (12 s per
attempt, 1 s doubling backoff to 30 s, give up at `--join-deadline-seconds`),
the first decoded frame is polled from RTC connect and abandoned at 45 s
(`SFU_JOIN_TIMEOUT_MS`), and the hold runs from the receiver's own media
start. The barrier rule in `judge()` does not apply in this mode; the 45 s
first-frame budget and the expected received height do.

| Flag | Default | What it does |
|---|---|---|
| `--arrival-window-seconds W` | 0 (barrier) | Stampede: presenter live first, receivers spread across W seconds |
| `--arrival-lead-seconds L` | 10 | Seconds the presenter is live before the first receiver arrives |
| `--legacy-share P` | 0 | P% of receivers (indexes 80 to 99 of every hundred, never the presenter) send `auth` with no `caps` and no `permessage-deflate`, which is what a native app that has not updated looks like to the server |
| `--presenter-profile 720p\|720p-simulcast\|1080p` | 720p | The client's ladder (`client/src/lib/video-quality.ts`): a room above 20 people holds the share at 720p / 1.5 Mbps unless the presenter chose 1080p by name, which is 4 Mbps with simulcast rungs under it |
| `--screen-pin high\|medium\|low\|none` | none | Ask the SFU for a specific simulcast layer of the share, through the FFI request rtc-node has no public method for. rtc-node has no adaptiveStream, so `none` already receives the top layer |
| `--audio-publishers N` / `--camera-publishers M` | 0 / 0 | Indexes 1..N publish a speech-shaped signal (not a tone, so Opus and the SFU's speaker detection treat it as a voice); the next M publish a 1080p30 / 2.5 Mbps camera with simulcast. Receivers pin camera tracks to `--camera-pin` (default `low`, the small tile) |
| `--cold-bootstrap` | off | The browser's 21-request first load (`coldBootstrap` in `server/scripts/load-fanout.ts`) instead of the thin four GETs |
| `--churn-every-ms MS` / `--churn-rtc-every N` | 0 / 10 | Run D: this process drops one receiver's app socket without a leave every MS during the hold and reconnects with the resume pair, recording `resumed: true` and the time to welcome; every Nth churn also drops the LiveKit room, re-mints and reconnects, recording the time to the first frame again |
| `--join-concurrency N` | 12 | Joins in flight per process |
| `--presenter-only` / `--no-presenter` | | Run the presenter in a process of its own: the shard that would contain index 0 passes `--no-presenter`. Against a manifest `prepare --watch-party` made, `--presenter-only` joins the `watch_party` channel instead of the plain voice one, creates the party as the presenter, goes live before joining, and ends it (`state: ended`) once the hold is over — this is what actually produces an HLS playlist; a plain `--presenter-only` run in an ordinary voice channel never starts one |
| `--low-latency` | off | With `--presenter-only` against a `--watch-party` manifest: go live requesting the LL-HLS ladder |
| `PQP_LOAD_SIZE_OVERRIDE=1` | | Hosted counts from 2 to 2000 and holds from 5 s to 30 min, for calibration and the stall check. The production refusals are untouched |
| `PQP_LOAD_TRACE=1` | | Per-participant event lines on stderr without the `wpdiag-` run-id rule |

Every result now carries `role`, `legacy`, `socketOpenToWelcomeMs`,
`welcomeAttempts`, `firstFrameFromArrivalMs`, `firstFrameFromConnectMs`,
inbound `frameWidth`/`frameHeight`/`framesPerSecond`/`framesDropped`/
`freezeCount`/`pliCount`/`nackCount` in every 5 s `flow` sample, the
presenter's outbound layers, a `ws` block with the bytes the app socket
received per frame type (this is how the report says what a socket without
the delta caps pays), a `failureClass` (`proxy-limit`, `generator:fds`,
`rate-limit:<path>`, `server:<status>`, `welcome-timeout`,
`rtc-connect-timeout`, `rtc-node:handle`) and `churns[]` when run D is on.

### Sizing a generator, measured

One 12 vCPU Vultr box (`vhp-12c-24gb-amd`, São Paulo), 95 receivers of a
720p30 / 1.5 Mbps share, 2026-09-07:

- **One Node process for all 95 plus the presenter does not work.** Event-loop
  lag reached 4.3 s, the presenter's capture fell to 21 fps, receivers decoded
  12 fps median, the last arrivals failed with rtc-node handle errors and
  connect timeouts, while the SFU sat at 17% CPU. That is a generator
  ceiling that would have been read as a server one.
- **Three processes of about 32 receivers plus the presenter in its own
  process is clean**: 95/95 first frame within 45 s (p95 1.3 s from arrival),
  29.7 fps decoded on every receiver, presenter 30.1 fps, loop lag under
  170 ms. Whole-VM CPU p95 76%, of which about 0.08 of a core per receiver is
  libwebrtc decoding 720p30 (every subscriber decodes whether or not a
  `VideoStream` drains it), so budget 80 to 90 receivers per 12 vCPU box to
  stay under the 70% gate.
- `--decode-sample` is not free: each drained receiver copies 1.38 MB per
  frame across the FFI on the main thread, 41 MB/s at 30 fps. Ten per process
  was enough to starve the loop; one or two per process is plenty, because
  `framesDecoded` already proves decoding for every receiver.
- rtc-node's FFI finalizer can throw `trying to drop an invalid handle` for a
  participant whose connect already failed. `armAbort` counts and survives
  that one error class (`generator.uncaughtErrors` in the report) instead of
  hanging up every other seat in the shard, which is what a 96-client
  calibration lost 95 seats to.

### Results, 2026-09-07 (staging, isolated 4 vCPU test SFU)

Full write-up in `docs/STAGING.md`. Headline: with the SFU on one UDP mux port
(production's config) a 500-person room fails (54% ever decode, 58% loss); with
`rtc.udp_port: 7882-7885` and nothing else changed it passes delivery (100%
decode within 45 s, p95 1.4 to 1.7 s, 0.000% loss, 880 to 935 Mbit/s at 76%
CPU p95 on 4 vCPU). Generator sizing that produced clean numbers: 19 to 31
receivers per Node process, four to five processes per 12 to 16 vCPU box, the
presenter alone in its own process, one decode sample per process.

## HLS audience (`src/hls-audience.ts`)

A separate, standalone script (own `main`, no shared state with `index.ts`
above) that drives the *other* half of a watch party: viewers polling the
HLS playlist proxy (`server/src/voice/hls-playlist-proxy.ts`) the way hls.js
1.7 actually does it, rather than a LiveKit RTC connection. It measures the
proxy's Postgres lookup, render cache, and presigned-segment-URL signing
under many concurrent pollers, independent of the SFU/mesh path.

Each simulated viewer: fetches the master playlist once with its own
`?t=` token, picks the LAST `#EXT-X-STREAM-INF` variant (same rule hls.js's
default ABR uses, and the same order `buildMasterPlaylist` writes them in),
then polls that media playlist on a timer seeded at 2 s and corrected to
`#EXT-X-TARGETDURATION` once known, timed from the end of the previous load.
It tracks `nextSeq` like `liveSyncDurationCount: 3` (starts three segments
behind the live edge, jumps forward with a counted `windowMiss` if the proxy's
window ever moves past what it was tracking), and fetches every newly listed
segment's body in order unless `--segments false`. Segment fetches are capped
at 64 in flight globally (a small semaphore) so the harness box is never the
bottleneck; playlist polls are never gated by it.

It refuses to run against `pqp.gg`, `api.pqp.gg`, or any `*.pqp.gg` host
unless `--allow-production` is passed. There is no separate local-loopback
allowance beyond that check — point it at whatever host you like as long as
it isn't a production one.

```sh
cd tools/watch-party-load && pnpm install

pnpm exec tsx src/hls-audience.ts \
  --url https://pqp-api-staging.fly.dev/api/voice/hls-playlist/<channelId>/<startedAt> \
  --tokens ./hls-tokens.txt \
  --viewers 500 --seconds 180 --ramp-seconds 20 \
  --out /tmp/hls-audience-500.json
```

`--url` is the master playlist URL **without** a `?t=` token — each viewer
appends its own from `--tokens` (one per line; `--viewers` is capped at
however many lines the file has). `--ramp-seconds` spreads viewer start times
uniformly over that window so the run looks like people trickling into a
party rather than 500 simultaneous cold starts. Every 10 s it prints a
progress line to stderr (active viewers, requests/sec by kind, error counts,
p50/p95/p99 latency for media playlists and segments, total `windowMisses`,
and segment throughput in Mbit/s); at the end it writes the full JSON summary
to `--out` (default `./hls-audience-<timestamp>.json`) and also prints it.

Tokens are minted on the API machine itself (this mints 500 short-lived
viewer tokens for one channel/session and prints one per line — redirect to
a file for `--tokens`); `crypto` is a Node global, no import needed:

```sh
fly ssh console -a pqp-api-staging -C "node -e \"import('/app/server/dist/voice/hls-viewer-token.js').then(m=>{for(let i=0;i<500;i++)console.log(m.mintHlsViewerToken({userId:crypto.randomUUID(),channelId:'<channelId>',startedAt:<startedAt>}))})\""
```

## Seat churn (`src/seat-churn.ts`)

A third, standalone script (own `main`, no shared state with `index.ts` or
`hls-audience.ts`) for the load shape that actually took production down on
2026-09-12: not the presenter's media (`index.ts`), not the HLS audience
polling the playlist (`hls-audience.ts`), but **people continuously joining
and leaving the voice call** while all of that runs — the write path
`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md` item A3 says "every
earlier test hit the playlist route or WS joins on staging's DB; the write
path was never measured."

It reads the manifest `index.ts prepare` already wrote (any `--participants`
value is fine — seat-churn does not reuse `index.ts`'s 500-person RTC
contract, only the manifest's server/channel/invite). Seats join the
manifest's `watchPartyChannelId` when `prepare --watch-party` made one, the
plain `voiceChannelId` otherwise — the same room a presenter from `index.ts
shard --presenter-only` is sharing into, which is the point: a seated
population churning in the room a party is actually live in, not a separate
empty voice channel. It ramps `--seats` accounts up to a steady seated
population, then:

- every seat sends `set-voice-state` (mute/unmute) on its own clock
  (`--presence-every-ms`), exercising the roster-broadcast path;
- a churn scheduler picks one currently-seated slot at random every
  `60_000 / --churn-per-minute` ms, has it leave for real
  (`leave-voice-room`, not a resume), waits a short random "stepped away"
  gap, then rejoins as a fresh seat — the seated population stays near
  `--seats` while the join/leave write rate stays at the configured rate;
- optionally (`--speaking-publishers N`, needs `PQP_LOAD_SFU_HOST`), the
  first N seats mint a LiveKit token and publish a continuous speech-shaped
  audio track so the SFU's real active-speaker detection fires — these seats
  never churn. "Speaking" is deliberately not a WS message the client can
  send (`packages/shared/src/signaling.ts` explains why), so audio is the
  only honest way to produce it;
- every `--ready-sample-seconds` (default 10s) it polls the deployment's own
  `GET /ready` (no auth needed — CLAUDE.md pitfall 8) and records
  `checks.postgres.ms` and `checks.pool.queued`/`inUse`/`max`, independently
  of anything the seats themselves see.

**Staging only, and not configurable to be otherwise.** `PQP_LOAD_TARGET`
must be exactly `staging`; there is no local or production path in this file
at all, unlike `index.ts`. `--speaking-publishers > 0` needs the same
non-production `PQP_LOAD_SFU_HOST` guard as `index.ts`.

**Pinning seats to specific machines** (`PQP_LOAD_MACHINE_IDS`, added for the
M6 multi-instance rehearsal): a comma-separated list of Fly machine ids
(`fly machines list -a pqp-api-staging`). When set, each seat's WS socket is
opened with `fly-force-instance-id` set to `machineIds[slot % machineIds.length]`,
so seats land on every listed machine deterministically instead of trusting
the proxy's own balancing — needed to prove a moderator mute or an eviction
resweep holds across instances with a *real* published track, not just a
signaling-only identity. HTTP calls are never pinned (room state is
cluster-wide via `CLUSTER_BUS`/`VOICE_REGISTRY`, so only the socket's home
instance matters). Omit it and behavior is unchanged.

Two things it cannot do, learned in M6 rehearsal 3 (`docs/plans/M6_REHEARSAL_2026-09-14b.md`):
a seat whose slot is pinned to a machine that is later **destroyed** (`fly scale
count` downward) keeps re-opening its socket with that dead id on every churn
cycle, fly-proxy accepts the upgrade and never routes it, and the seat fails
with "no voice welcome within 12s" — a harness artifact, since no real client
sends the header; run the scale-down test with the pinning off, or expect and
discount those failures. And this script neither reconnects a socket the
server closed (a rolling deploy's 1001 drain) nor records that close as an
event, so it cannot measure drops or reconnect time across a deploy; that
needs a reconnecting probe beside it (the rehearsal doc describes one).

```sh
cd tools/watch-party-load && pnpm install

TEST_RUN_ID=wpsc-01 PQP_LOAD_TARGET=staging LOAD_TEST_TOKEN=... \
pnpm exec tsx src/seat-churn.ts --manifest /tmp/wp-event.json --out /tmp/seat-churn-report.json \
  --seats 80 --churn-per-minute 5 --duration-seconds 1800 --speaking-publishers 6
# only if --speaking-publishers > 0:
PQP_LOAD_SFU_HOST=staging-sfu.example.test
```

### The recommended event rehearsal

Prepare the manifest with `--watch-party` first, or step 1 below never
produces a playlist for step 3 to poll:

```sh
TEST_RUN_ID=wp-event PQP_LOAD_TARGET=staging PQP_LOAD_SFU_HOST=staging-sfu.example.test \
LOAD_TEST_TOKEN=... pnpm exec tsx src/index.ts prepare --manifest wp-event.json --participants 500 --watch-party
```

Then run all three at once against that manifest, on staging:

1. `index.ts shard --manifest wp-event.json --shard-index 0 --shard-count 1 --presenter-only --hold-seconds 1800 --start-at-ms <T+60s>` — the presenter's share. Because the manifest has a `watchPartyChannelId`, this joins that channel instead of the plain voice one, creates the party as the presenter, goes live before joining (add `--low-latency` to request the LL-HLS ladder), and ends it (`state: ended`) once the hold is over.
2. `seat-churn.ts --manifest wp-event.json --out seat-churn-report.json --seats 80 --churn-per-minute 5 --duration-seconds 1800` — 60 to 100 seated, churning at 5 joins/min, for 30 minutes (the postmortem's own event shape). Prefers the manifest's `watchPartyChannelId` automatically, so these seats land in the same room the presenter is sharing into.
3. `hls-audience.ts --url <the channel's playlist URL> --tokens 300-tokens.txt --viewers 300 --seconds 1800 --ramp-seconds 120` — 300 watchers.

**Pass criteria** (seat-churn's own report already judges itself against
these and sets `passed`/`verdict`; the numbers mirror
`tools/monitoring/grafana-alert-rules-event.json` exactly, because a load
rehearsal that cannot fail the same rules an event will be watched by proves
nothing new): `GET /ready` never reports `ok:false` for 60 continuous
seconds, `checks.postgres.ms` never stays above 200 for 2 continuous
minutes, `checks.pool.queued` never stays above 20 for 60 continuous
seconds, and seat-churn's own join/leave failure rate stays under 1%. A
failed `hls-audience.ts` run judges itself by its own existing
window-miss/stuck-event numbers (see above); there is no combined verdict
across all three processes, read each report on its own.

## Full-stack party storm, presenter-free (`src/party-storm.ts`)

A single, zero-npm-dependency orchestrator (Node 22+/24 global `WebSocket` +
`fetch`, native TS stripping — run with `node src/party-storm.ts`) for the
watch-party tiers that do **not** need a live SFU/egress. Built for the
2026-09-12 post-mortem's A3 (DB reconnect storm) and CLAUDE.md pitfall 17 (the
DB circuit breaker). Complements the media rig in `index.ts` (synthetic 720p30
presenter + real SFU receivers) and the viewer poller in `hls-audience.ts`.

**Target is fully configurable, with a hard isolation gate.** `PQP_LOAD_TARGET`
(any non-empty string, e.g. `staging` / `shadow`), `PQP_LOAD_API_URL`,
`PQP_LOAD_WS_URL`, `PQP_LOAD_HLS_BASE_URL`. The gate refuses `pqp.gg`,
`*.pqp.gg` (so api./hls./www.) and any Postgres host, unconditionally, before
any network call. It also requires `https://` / `wss://` for every target and
refuses private-use, link-local and cloud-metadata addresses (an env var this
harness's `LOAD_TEST_TOKEN` and `ADMIN_METRICS_TOKEN` should never reach),
except loopback, which stays on plain `http:`/`ws:` for local dev; set
`PQP_LOAD_ALLOW_PRIVATE_HOST=1` to opt a genuinely private shadow box back in.
It speaks only HTTP/WS — never SQL — so the database it hits never sees more
than the server's own pool no matter how hard this pushes. Point it at
staging today or a Vultr shadow-prod box later (note: a shadow box running
`NODE_ENV=production` and not named `-staging` on Fly will make
`LOAD_TEST_TOKEN` inert — the identity path needs a `-staging` Fly app name or
non-production `NODE_ENV`; see `server/src/auth/load-test.ts`).

```bash
set -a; . ~/.config/pqp/staging-load-test.env; set +a   # LOAD_TEST_TOKEN + ADMIN_METRICS_TOKEN
export PQP_LOAD_TARGET=staging

# 1. Provision a load server (HTTP only; pins the voice channel to LiveKit so a
#    presence room can exceed MESH_VOICE_LIMIT=8):
node src/party-storm.ts provision --out /tmp/manifest.json

# 2. DB reconnect storm — distinct identities run the cold-browser bootstrap in
#    a loop to saturate the Postgres pool. Samples runtime.db.breaker / pool /
#    readCache + /health + /ready + a fresh-identity canary every second:
node src/party-storm.ts db-storm --manifest /tmp/manifest.json \
  --concurrency 100 --ramp-seconds 8 --seconds 45 --out /tmp/db.json

# 3. WS presence storm + synchronized reconnect wave (the 09-12 failure mode):
node src/party-storm.ts ws-storm --manifest /tmp/manifest.json \
  --sockets 150 --ramp-seconds 40 --hold 25 --reconnect-at 15 --out /tmp/ws.json

# 4. HLS viewer poll (needs a LIVE presenter+egress for real playlists; without
#    --channel/--started it probes the path only). Point --hls base at the API
#    origin proxy OR the hls.pqp.gg edge to compare origin coalescing:
node src/party-storm.ts hls --channel <id> --started <ms> --tokens ./tokens.txt --viewers 500
```

What it proves without a presenter: the breaker (pitfall 17) opens under pool
saturation and sheds DB-dependent routes with fast ~250ms 503s
(`database_unavailable`) while `/health` stays 200 and `/ready` goes 503, then
recovers within ~1–2s of load easing. Saturation edge on staging (`PG_POOL_MAX`
10): healthy below ~12 concurrent bootstrappers, a brownout band ~12–18 (pool
queues, p99 to multiple seconds, breaker flaps), clean shed at ≥~25–30. Scales
~linearly with `PG_POOL_MAX`, so prod's 70 ≈ 7×.

What still needs the live SFU/egress (coordinate separately): real HLS segments
and playlists, hence any true end-to-end HLS viewer / segment-GET / edge-vs-
origin coalescing measurement. Feed the egress with `index.ts`'s synthetic
720p30 presenter (`shard --presenter-only`), then drive viewers here or with
`hls-audience.ts`. The edge path also needs `LIVE_HLS_PLAYLIST_BASE_URL` set +
a deployed edge Worker (empty on staging today).

**Residue:** every identity is `load_test_user_{st,ws,canary,owner}_*`; the run
also leaves a `Load <runId>` server unless deleted via `DELETE /api/servers/:id`
with the owner token. Clean both with the one-liners in `docs/STAGING.md`
§"Resetting the staging database".
