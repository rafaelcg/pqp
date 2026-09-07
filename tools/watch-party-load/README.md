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

Install its isolated dependencies once:

```sh
cd tools/watch-party-load && pnpm install
```

Prepare one shared room (this makes only the synthetic server, channels and
invite), then distribute the resulting manifest file to generator machines:

```sh
TEST_RUN_ID=wp500-01 PQP_LOAD_TARGET=staging \
PQP_LOAD_SFU_HOST=staging-sfu.example.test \
LOAD_TEST_TOKEN=... pnpm run run -- prepare --manifest /tmp/wp500.json --participants 500
```

Each generator runs one non-overlapping shard against that manifest. Start the
presenter shard first (`--shard-index 0` contains participant 0), then the
receiver shards. The default 900-second hold is intentionally in the requested
10–15 minute first-run range. The presenter is deterministic full-frame 720p30
motion plus 48 kHz audio, with a 1.5 Mbps video and 64 kbps audio encoding
ceiling. Reports include native RTC RTP bytes/bitrate/loss/decoded frames and
generator CPU, RSS, and event-loop lag.

All hosted shards require the same future Unix epoch milliseconds through
`--start-at-ms`. This is the barrier: every client must already have an RTC
connection before that instant; only then does the presenter start media and
the common hold begin. A late client fails the run rather than shortening its
own personal hold.

```sh
START_AT_MS=$(( $(date +%s) * 1000 + 120000 ))
TEST_RUN_ID=wp500-01 PQP_LOAD_TARGET=staging \
PQP_LOAD_SFU_HOST=staging-sfu.example.test \
LOAD_TEST_TOKEN=... pnpm run run -- shard --manifest /tmp/wp500.json \
  --shard-index 0 --shard-count 2 --decode-sample 25 --start-at-ms "$START_AT_MS" \
  --report /tmp/wp500-shard0.json
```

For the two-generator baseline, use `--shard-count 2 --decode-sample 25` on
each VM. Every client joins and subscribes to the real media tracks; 25
receivers per VM additionally drain decoded frame streams. This prevents the
generator's own 500-way decoding from being mistaken for an SFU ceiling while
still proving RTP receipt for every simulated participant. Treat the SFU's
host-side egress counters as the authority for aggregate egress and headroom.

The first acceptance contract is: all 500 tokened clients connect and receive
RTP; each shard has 25 decoded samples at >=24 fps; presenter input is >=27
fps; median sampled loss <1%; no unexpected disconnects; each generator stays
below 70% of one core per allocated vCPU with no growing event-loop lag; SFU
egress sustains the observed receiver bitrate with >=20% headroom. A report's
RTP bitrate is measured at its receivers; it does not substitute for the SFU's
aggregate NIC metric.

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
local SFU path is configured. Hosted runs only accept 500; the 2–5 local
exception is solely to validate the rig.
