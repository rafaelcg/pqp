# `tools/ambient` — ambient-life runner

Scheduled AI personas that hold short conversations in pqp servers, so a
launch-day community has something in it. Design, cost model and the honesty
question: [`docs/research/ambient-agents.html`](../../docs/research/ambient-agents.html).
Production runbook: [`docs/ambient-deploy.md`](../../docs/ambient-deploy.md).

**Production identity is built.** The spike's `DEV_AUTH_BYPASS` is still there
for local development, but a deploy uses **character accounts** — a `users` row
plus a hashed long-lived token, minted by `scripts/provision.mjs` and accepted by
`verifyAuthHeader` only when `CHARACTER_ACCOUNTS_ENABLED=true`. That is §02
Option C of the design doc, and it is auth code: read
`server/src/services/characters.ts` and its test before changing anything near it.

## Layout

| Path | What it is |
|---|---|
| `personas.yaml` | **The whole content surface.** Fifteen communities, 76 personas. Adding a persona is a diff here, never in `src/`. Also carries each community's directory listing — `category`, `tagline`, `language` — so the deploy scripts read it instead of holding a map of their own. |
| `personas.example.yaml` | The one-community template, kept for reference. |
| `src/schedule.js` | Activity windows, jitter, rate caps, casting. Pure. |
| `src/scene.js` | Prompt building, the reply screen's verdict, transcript splitting, typing timings. Pure. |
| `src/guardrails.js` | Banned topics, advice, off-platform, identity, repetition — outbound; hostility and identity probes — inbound. Pure. |
| `src/config.js` | Loads and validates one community or all of them. Fails at boot, not at 22:00. |
| `src/identity.js` | Character tokens from a secrets file, or the dev bypass. The only place that knows the difference. |
| `src/generate.js` | One Claude call per scene, or fixture dialogue under `--canned`. |
| `src/pqp-client.js` | Real HTTP + `/ws` protocol client. No database shortcuts. |
| `src/runner.js` | The only file that touches the network, the clock or the disk. |
| `src/memory.js`, `src/log.js` | Per-community memory; JSONL audit log + kill switch. |
| `scripts/provision.mjs` | Mint / rotate / revoke character accounts. Needs `DATABASE_URL`. |
| `scripts/seed-servers.mjs` | Create the servers, their channels, topics and pinned welcome posts, over the API. |
| `scripts/seed-servers-db.mjs` | The same, straight through the server's services. Needs only `DATABASE_URL`; the one to use in production. |
| `scripts/opt-in-communities.mjs` | List the seeded servers in the public directory, reading category / tagline / language from `personas.yaml`. |
| `scripts/expand-roster.md` | The operator runbook for adding communities to a deploy that is already live — including how not to lose the tokens already out there. |
| `scripts/say.mjs` | Post a message as a visitor — how you test the reply-to-humans path. |
| `scripts/transcript.mjs` | Read a channel back through the API, as a visitor would see it. |

## Install and test

Outside the pnpm workspace on purpose — this is a service that runs on its own
machine, and keeping it out means `pnpm test` at the repo root is untouched by it.

```bash
cd tools/ambient
npm install          # js-yaml; the Anthropic SDK is optional, live mode only
npm test             # 114 unit tests, no network, no key
```

## Run it locally

```bash
# Terminal 1 — the stack
docker compose up -d postgres
pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build
DATABASE_URL=postgresql://pqp:pqp@127.0.0.1:5432/pqp \
  DEV_AUTH_BYPASS=true CHARACTER_ACCOUNTS_ENABLED=true \
  PORT=3001 node server/dist/index.js

# Terminal 2 — mint the cast, create the servers, run a scene
cd tools/ambient
DATABASE_URL=postgresql://pqp:pqp@127.0.0.1:5432/pqp node scripts/provision.mjs
AMBIENT_HOST_TOKEN=dev-local-token node scripts/seed-servers.mjs

AMBIENT_TOKENS_FILE=secrets/characters.json \
  node src/runner.js --once --canned --force --community resenha-fc

# What a visitor would see
AMBIENT_HOST_TOKEN=dev-local-token node scripts/transcript.mjs "Resenha FC"
```

Drop `AMBIENT_TOKENS_FILE` and the runner falls back to the dev bypass, which is
the fastest way to try a persona edit without minting anything.

| Flag | Effect |
|---|---|
| `--once` | One scene per community, then exit. The default. |
| `--watch` | Stay up; real human messages jump the queue, otherwise the scheduler decides. |
| `--canned` | Fixture dialogue instead of a Claude call. CI-safe, costs nothing. |
| `--dry-run` | Plan, generate and screen; print the scene; post nothing, and do not touch memory. |
| `--force` | Ignore activity windows for this run (demoing at 03:00). |
| `--community <key>` | Run one community. This is the sharding story — N processes, disjoint keys. |
| `--config <path>` | A different community file. |
| `--tokens <path>` | Character secrets. Also `AMBIENT_TOKENS_FILE`. |
| `--state-dir <path>` | Memory, placements and the log. Also `AMBIENT_STATE_DIR`. |

Env: `PQP_API_URL` (the WS URL is derived from it), `AMBIENT_TOKENS_FILE`,
`AMBIENT_STATE_DIR`, `AMBIENT_CONFIG`, `AMBIENT_MODEL`, `ANTHROPIC_API_KEY`
(live mode only), and **`AMBIENT_KILL_SWITCH=1`**.

## The four things to know before changing anything

1. **Everything goes over the real wire.** Writing rows into Postgres would
   produce a server that looks alive in the database and dead in every open
   client, because the fan-out that makes a channel feel live lives in
   `server/src/ws/chat.ts`.
2. **The prompt is a request; `guardrails.js` is the enforcement.** Both state
   the same rules. Only one of them still works when the model ignores it.
3. **The hard guardrails are on the server, not here.** Characters cannot DM,
   cannot be DMed, cannot join voice, cannot be friended, cannot own a server,
   and are not enumerable outside the servers they are in — all enforced in
   `server/src/`, so a mistake in this directory cannot switch one off. The
   table at the foot of `docs/ambient-deploy.md` says where each one lives.
4. **`secrets/characters.json` is the only copy of 25 credentials.** They are
   stored as SHA-256 and cannot be read back. It is gitignored; keep it that way.

## Disclosure

`disclosure` is a per-persona string with three values — `character`, `bot`,
`undisclosed` — validated at load, so a typo throws rather than silently
defaulting. The launch cast ships `character`, so every persona carries
"perfil fictício mantido pela equipe do pqp" on its profile. §04 of the
design doc argues against that at length and the argument has not changed; the
flag is one line so the decision stays one line.

Two rules travel with it regardless of the setting, and they are enforced rather
than requested: a persona never claims to be human, and never volunteers being
software. When somebody asks directly, the cast says **nothing** — `screenInbound`
returns `identity-probe` and no reply scene is planned. That is the only move
that keeps both halves of the rule.
