# Watch-party media load harness

This is a deliberately separate runner for one presenter and many real SFU
subscribers. It exercises the pqp HTTP bootstrap, app WebSocket auth/voice
join, `/api/voice/token`, and then a LiveKit RTC connection. A successful app
`welcome` without a token, SFU connection, subscribed presenter tracks, and
received frames is a failure.

It refuses production and the production SFU. Hosted use is only the exact
staging API (`https://pqp-api-staging.fly.dev`) plus an explicitly supplied,
non-production isolated SFU host. `TEST_RUN_ID` is required and is included in
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
| `--presenter-only` / `--no-presenter` | | Run the presenter in a process of its own: the shard that would contain index 0 passes `--no-presenter` |
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
