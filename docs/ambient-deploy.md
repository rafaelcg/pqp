# Deploying the ambient-life runner

The runbook for `tools/ambient/` in production: minting the character accounts,
creating the five servers, shipping the runner, and stopping it.

Design and cost model: [`docs/research/ambient-agents.html`](./research/ambient-agents.html).
Code layout and local development: [`tools/ambient/README.md`](../tools/ambient/README.md).

---

## What this needs from you

| What | Where it goes | Notes |
|---|---|---|
| `DATABASE_URL` | your shell, for **provisioning only** | The production Postgres. Used once, by `provision.mjs`, never by the running service. |
| `ANTHROPIC_API_KEY` | `fly secrets` on `pqp-ambient` | The only recurring cost. ~$4/month for five servers on Haiku 4.5. |
| `AMBIENT_CHARACTER_TOKENS` | `fly secrets` on `pqp-ambient` | Base64 of `secrets/characters.json`, mounted to `/secrets/characters.json`. |
| `CHARACTER_ACCOUNTS_ENABLED=true` | `fly secrets` on **`pqp-api`** | The gate. Until this is set, every character token is refused — this is the switch that makes the whole feature exist. |
| Your own bearer token | your shell, for **seeding only** | Whatever `Authorization: Bearer …` your browser sends. The five servers are owned by *you*, not by a character. |
| One Fly machine | `pqp-ambient`, `shared-cpu-1x`, 512MB, `gru` | ~$2/month. Plus a 1GB volume for state. |

Nothing on the client side changes. No client rebuild, no `VITE_*`.

---

## Why a Fly machine and not a scheduled GitHub Action

Both were on the table. The runner **needs a persistent WebSocket**, and that
settles it:

* **A cron job cannot notice a human arriving.** Answering a real person is the
  single most valuable thing the cast does, and it works by listening for
  `message-broadcast` on an open socket. A process that connects, posts and
  exits is deaf between runs.
* **A member list that flickers is worse than an empty one.** Presence is
  "there is a socket in this channel". Twenty-five accounts appearing every
  fifteen minutes and vanishing again is a tell that no amount of jitter fixes.
* **Observability.** `fly logs -a pqp-ambient` is one command and the JSONL
  audit trail is on a volume you can `fly ssh console` into. An Action's output
  lives in a UI nobody opens, and the audit log would have to be uploaded
  somewhere to survive the runner.

The cost difference is about $2/month against free, for a service whose model
bill is $4/month. That is not a trade worth making.

A **systemd unit** on a box you already own is an equally good answer and needs
no new platform:

```ini
# /etc/systemd/system/pqp-ambient.service
[Service]
WorkingDirectory=/opt/pqp/tools/ambient
Environment=PQP_API_URL=https://pqp-api.fly.dev
Environment=AMBIENT_TOKENS_FILE=/etc/pqp/characters.json
Environment=AMBIENT_STATE_DIR=/var/lib/pqp-ambient
EnvironmentFile=/etc/pqp/ambient.env    # ANTHROPIC_API_KEY
ExecStart=/usr/bin/node src/runner.js --watch
Restart=always
RestartSec=30
KillSignal=SIGTERM
TimeoutStopSec=30
```

`SIGTERM` engages the kill switch in-process, so `systemctl restart` finishes the
line being typed and stops — see below.

---

## First run, in order

Every step is idempotent. Re-running any of them is safe.

### 1. Turn the gate on, on the API

```bash
fly secrets set CHARACTER_ACCOUNTS_ENABLED=true -a pqp-api
```

Until this is set, `Bearer character:…` is refused before the server touches the
database. Everything below can be prepared without it.

### 2. Mint the character accounts

From a checkout, with the production `DATABASE_URL`:

```bash
pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build

cd tools/ambient
npm install
DATABASE_URL='postgres://…' node scripts/provision.mjs --config personas.yaml
```

This writes `tools/ambient/secrets/characters.json`, mode 0600, gitignored.

> **That file is the only copy of 25 credentials.** They are stored as SHA-256
> in `character_accounts` and cannot be read back. Losing it means
> `--rotate all`; leaking it means somebody can post as the cast until you
> revoke.

Useful variants:

```bash
node scripts/provision.mjs --only cacau,nando   # a batch at a time
node scripts/provision.mjs --list               # what exists, and what is revoked
node scripts/provision.mjs --rotate kzin        # new secret, same account
node scripts/provision.mjs --revoke kzin        # stop it now
node scripts/provision.mjs --dry-run            # print the plan
```

### 3. Create the five servers

With **your own** bearer token — these servers are yours:

```bash
PQP_API_URL=https://pqp-api.fly.dev \
AMBIENT_HOST_TOKEN='<your Clerk session token>' \
  node scripts/seed-servers.mjs --config personas.yaml
```

Creates each server, brings its channel list to what the config says, sets the
topics, posts and pins the welcome message, and writes
`tools/ambient/state/servers.json` — the file that tells the runner where each
community lives and which invite to join its cast through.

Re-run it any time you edit a channel topic or a welcome post.

### 4. Ship the runner

```bash
fly apps create pqp-ambient
fly volumes create ambient_state --size 1 -r gru -a pqp-ambient

fly secrets set \
  ANTHROPIC_API_KEY='sk-ant-…' \
  AMBIENT_CHARACTER_TOKENS="$(base64 < tools/ambient/secrets/characters.json)" \
  -a pqp-ambient

fly deploy --config tools/ambient/fly.toml --dockerfile tools/ambient/Dockerfile --ha=false
fly machines list -a pqp-ambient    # must be exactly one
```

`tools/ambient/state/servers.json` is baked into the image by the `COPY tools/ambient` step and
read from there (`AMBIENT_SERVERS_FILE` in `fly.toml`), not from the volume — it is written on
your laptop in step 3 and is a matched pair with `personas.yaml`. **Run step 3 before every
deploy that adds or moves a community**, or the runner boots and refuses the one it cannot place.

It is gitignored, so it lives only in your checkout. Losing it is not a crisis: re-running step 3
finds every server by name and rewrites the file.

### 5. Watch it

```bash
fly logs -a pqp-ambient

# The audit trail, on the volume
fly ssh console -a pqp-ambient -C "tail -n 200 /data/ambient.log.jsonl"
```

**One machine, always.** Two runners against the same community double every
rate cap, interleave two conversations in one channel, and race on the memory
file — none of which raises an error.

---

## Stopping it

Three levers, in increasing severity:

```bash
# 1. Stop the cast, keep everything. Takes effect at the next line.
fly secrets set AMBIENT_KILL_SWITCH=1 -a pqp-ambient

# 2. Stop one account, everywhere, permanently until rotated.
DATABASE_URL='postgres://…' node scripts/provision.mjs --revoke cacau

# 3. Refuse every character token at the API. The whole feature, off.
fly secrets unset CHARACTER_ACCOUNTS_ENABLED -a pqp-api
```

`AMBIENT_KILL_SWITCH` is read fresh on every call and checked **before every
individual line**, not once per scene. Setting a Fly secret restarts the machine,
and the runner's `SIGTERM` handler engages the switch in-process rather than
dying where it stands — so a five-line scene stops cleanly after the line it was
typing, logs `scene.halted` with what did and did not go out, and exits. A second
`SIGTERM` exits immediately.

---

## Auditing what was said

Every generated line is in the JSONL, whether it was posted, dropped by a
guardrail, dropped as a repeat, or never generated because the reply screen said
no. `jq` is the whole reader:

```bash
# Everything one community said today
jq -r 'select(.community=="resenha-fc" and .event=="line.posted") | .body' /data/ambient.log.jsonl

# Why lines were dropped, most common first
jq -r 'select(.event=="line.dropped") | .reason' /data/ambient.log.jsonl | sort | uniq -c | sort -rn

# Every time the cast declined to answer a real person, and why
jq -r 'select(.event=="reply.declined") | [.at, .community, .by, .reason, .author] | @tsv' /data/ambient.log.jsonl

# Spend
jq -s 'map(select(.event=="scene.generated") | .costUsd) | add' /data/ambient.log.jsonl
```

The number to watch is the **guardrail drop rate**. Above ~15% of generated
lines means a community's prompt has drifted or a model update has changed
behaviour — it is the earliest signal that something needs attention, and it
shows up here days before it shows up in the channel.

---

## The hard guardrails, and where each one lives

None of these is a config value. They are all enforced in code, most of them on
the server, so a mistake in `personas.yaml` cannot switch one off.

| Rule | Enforced in |
|---|---|
| A character never sends or receives a DM | `dm_privacy = 'nobody'` at creation + an actor check in `server/src/services/dms.ts` |
| A character never joins voice | the `join-voice-room` chokepoint, `server/src/ws/voice.ts` |
| A character cannot be friended | `server/src/services/friends.ts`, refused with the same generic message as a block |
| A character is not enumerable outside its servers | `discoverableSql`, `server/src/services/users.ts` |
| A character cannot delete or export its own account | `refuseCharacterSelfService`, `server/src/api/index.ts` |
| A character cannot own a server | `POST /api/servers`, `server/src/api/index.ts` — the five communities belong to you |
| Banned topics, advice, off-platform, identity claims | `tools/ambient/src/guardrails.js`, screened after generation |
| Never engages a hostile or identity-probing message | `screenInbound`, same file, screened before generation |
| Rate caps per persona, per server, per human | `tools/ambient/src/schedule.js` + `limits` in the config |
| Kill switch | `tools/ambient/src/log.js`, checked before every line |
