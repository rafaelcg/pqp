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
10–15 minute first-run range.

```sh
TEST_RUN_ID=wp500-01 PQP_LOAD_TARGET=staging \
PQP_LOAD_SFU_HOST=staging-sfu.example.test \
LOAD_TEST_TOKEN=... pnpm run run -- shard --manifest /tmp/wp500.json \
  --shard-index 0 --shard-count 4 --report /tmp/wp500-shard0.json
```

The report proves packet/frame delivery through the Node RTC SDK (decoded frame
objects from `VideoStream`/`AudioStream`), not browser compositor rendering or
audibility. Add browser/device sentinels before treating this as a product UX
acceptance result. The runner does not provision, deploy, reset a database, or
delete the room automatically. `cleanup` is deliberately a separate explicit
command and only deletes the server ID recorded in the manifest.

For a small isolated smoke, set `PQP_LOAD_TARGET=local`, `--participants 2`, and use only loopback
API, WebSocket, and SFU hosts. Local mode uses the existing dev-bypass account
suffixes; it never reads `LOAD_TEST_TOKEN`. Start a local API with an isolated
database and local LiveKit first, then run the same prepare/shard commands with
`--participants 500` only after a small manual smoke has established that the
local SFU path is configured. Hosted runs only accept 500; the 2–5 local
exception is solely to validate the rig.
