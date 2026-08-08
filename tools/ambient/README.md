# `tools/ambient` — ambient-life runner

Scheduled AI personas that hold short conversations in pqp servers, so a
launch-day community has something in it. Design, cost model and the honesty
question: [`docs/research/ambient-agents.html`](../../docs/research/ambient-agents.html).

**This is a v1 spike.** It runs against a local server with `DEV_AUTH_BYPASS`,
which the server refuses under `NODE_ENV=production` — there is deliberately no
production identity story in this directory yet. §1 of the design doc is that
decision.

## Layout

| Path | What it is |
|---|---|
| `personas.example.yaml` | One community and its cast. Adding a persona is a diff here, never in `src/`. |
| `src/schedule.js` | Activity windows, jitter, rate caps, casting. Pure. |
| `src/scene.js` | Prompt building, transcript splitting, typing timings. Pure. |
| `src/guardrails.js` | Banned topics, advice, off-platform, identity claims, repetition. Pure. |
| `src/config.js` | Loads and validates a community file. Fails at boot, not at 22:00. |
| `src/generate.js` | One Claude call per scene, or fixture dialogue under `--canned`. |
| `src/pqp-client.js` | Real HTTP + `/ws` protocol client. No database shortcuts. |
| `src/runner.js` | The only file that touches the network, the clock or the disk. |
| `src/memory.js`, `src/log.js` | Per-community memory; JSONL audit log + kill switch. |
| `scripts/transcript.mjs` | Reads a channel back through the API, as a visitor would see it. |

## Install and test

Outside the pnpm workspace on purpose — this is a service that will eventually
run on its own machine, and keeping it out means `pnpm test` at the repo root is
untouched by it.

```bash
cd tools/ambient
npm install          # js-yaml; the Anthropic SDK is optional and only needed for live mode
npm test             # 85 unit tests, no network, no key
```

## Run it

```bash
# Terminal 1 — the stack
docker compose up -d postgres
pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build
DATABASE_URL=postgresql://pqp:pqp@127.0.0.1:5432/pqp DEV_AUTH_BYPASS=true \
  PORT=3001 node server/dist/index.js

# Terminal 2 — one scene, fixture dialogue, no API key needed
cd tools/ambient
node src/runner.js --once --canned --force

# What a visitor would see
node scripts/transcript.mjs
```

| Flag | Effect |
|---|---|
| `--once` | One scene, then exit. The default. |
| `--watch` | Stay up; real human messages jump the queue, otherwise the scheduler decides. |
| `--canned` | Fixture dialogue instead of a Claude call. CI-safe, costs nothing. |
| `--dry-run` | Plan, generate and screen; post nothing. |
| `--force` | Ignore activity windows for this run (demoing at 03:00). |
| `--config <path>` | A different community file. |
| `--log <path>` | Where the JSONL audit log goes. |

Env: `AMBIENT_API_URL`, `AMBIENT_WS_URL`, `AMBIENT_DEV_TOKEN`, `AMBIENT_MODEL`,
`ANTHROPIC_API_KEY` (live mode only), and **`AMBIENT_KILL_SWITCH=1`**, which
stops every write to pqp before the runner touches it.

## The two things to know before changing anything

1. **Everything goes over the real wire.** Writing rows into Postgres would
   produce a server that looks alive in the database and dead in every open
   client, because the fan-out that makes a channel feel live lives in
   `server/src/ws/chat.ts`.
2. **The prompt is a request; `guardrails.js` is the enforcement.** Both state
   the same rules. Only one of them still works when the model ignores it.
