# Staging

A full staging environment: real Clerk auth, real Postgres, real Fly and Pages, zero overlap with production users or data. Use it to try a change against hosted infrastructure without restarting `pqp-api` or touching pqp.gg.

## URLs

| Piece | URL |
|---|---|
| Web (Pages branch deploy of project `pqp`) | https://staging.pqp-3yr.pages.dev |
| API (Fly.io app `pqp-api-staging`, region `gru`) | https://pqp-api-staging.fly.dev |
| WebSocket | `wss://pqp-api-staging.fly.dev/ws` |
| Health | `GET https://pqp-api-staging.fly.dev/health` |

## What staging is (and is not)

- **Separate users.** Auth is a Clerk DEVELOPMENT instance (`pk_test` / `sk_test`). Accounts, sessions and origins are fully disjoint from production Clerk. Your prod account does not exist here; sign up again.
- **Separate database on its own cluster.** Database `pqp-staging` (hyphen: Fly Managed Postgres rejects underscores in database names) on cluster **`pqp-db-staging`, id `dzx6qo65q9n0jpv5`**, region `gru`, Basic plan (shared x2 / 1 GB / 10 GB disk, $38 a month). The schema self-applies at boot via `server/src/schema.sql` (`initDb()` in `server/src/db.ts`); there is no migration step and nothing to run by hand.

  It used to live on production's cluster, and moving it off (2026-09-07) was a **safety** change, not a tidiness one: one cluster means one `max_connections` of 100, so a load test that exhausted connections on staging would have starved `pqp-api` and taken pqp.gg down. Isolation is what makes it legitimate to push staging to failure. Production is `pqp-db-2`, id `9g6y30wdxzmrv5ml`, database `fly-db`; nothing in this document should ever touch it.
- **Object storage is its own R2 bucket, `pqp-attachments-staging`** (created 2026-09-01, private, CORS for `https://staging.pqp-3yr.pages.dev` and `http://localhost:5173`). `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION=auto` and `S3_FORCE_PATH_STYLE=false` are set on `pqp-api-staging`; the two credentials come from an R2 API token scoped to that bucket (Dashboard → R2 → Manage R2 API Tokens → Object Read & Write). `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are set from the account token `pqp-staging` (Object Read & Write, that bucket only), verified with a signed PUT / HEAD / DELETE round trip on 2026-09-01. Attachments and Baú media both work on staging. Never point staging at the production bucket; to rotate, create a new token in the dashboard, `fly secrets set` the pair, then delete the old token.
- **No TURN.** Cross-NAT voice may fail on staging; same-network voice works. This is the known STUN-only limitation (CLAUDE.md pitfall 1), accepted here to keep staging cheap.
- **No analytics or ads tags.** The build omits Umami, Google Ads and the APK click beacon on purpose; staging traffic must not pollute production numbers.
- **Scales to zero.** `fly.staging.toml` sets `auto_stop_machines = "stop"` and `min_machines_running = 0`, so the machine parks when idle and the first request after an idle period takes a few seconds while it boots. Production deliberately keeps min 1 because a stop drops every live WebSocket; staging accepts that trade.

## How to deploy

Both jobs (web and API) run in parallel from `.github/workflows/deploy-staging.yml`; neither blocks the other, and neither waits for CI.

```bash
# Option A: the long-lived branch
git push origin my-branch:staging     # or merge to staging and push

# Option B: try any ref without touching the staging branch
gh workflow run deploy-staging.yml --ref my-feature-branch
```

A deploy to staging never restarts production: the workflow only talks to `pqp-api-staging` and to the `staging` branch alias of the Pages project.

## Resetting the staging database

Wipe the contents of `pqp-staging` in place; the next boot recreates the whole schema from `server/src/schema.sql`. Dropping the database itself is not an option on Managed Postgres: the `schema_admin` role owns neither the database nor the `public` schema (both belong to `postgres`, and there is no `fly mpg databases delete`), so `DROP DATABASE` and `DROP SCHEMA public` are both refused. What the role can drop is everything it created, which is exactly the app's tables and the `pgcrypto` extension (the app's `fly-user` login resolves to `schema_admin` on this cluster).

```bash
fly machine stop -a pqp-api-staging     # so nothing holds connections or recreates tables mid-wipe
echo 'DROP OWNED BY current_user;' | fly mpg connect dzx6qo65q9n0jpv5 -d pqp-staging
fly machine start -a pqp-api-staging    # boot reapplies schema.sql, including CREATE EXTENSION pgcrypto
```

`dzx6qo65q9n0jpv5` is the **staging** cluster (`fly mpg list -o personal` to look it up). Read that id before pressing enter. Production is `9g6y30wdxzmrv5ml`, and the same command aimed there — with or without `-d` — drops production's tables.

## Credentials that back it (names only, never values)

| Where | Name | What |
|---|---|---|
| GitHub Actions secret | `FLY_API_TOKEN_STAGING` | Deploy token scoped to `pqp-api-staging` |
| GitHub Actions secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Shared with the production web deploy |
| GitHub repo variable | `STAGING_CLERK_PUBLISHABLE_KEY` | Clerk dev `pk_test`; public by definition, so a variable, not a secret |
| Fly secrets on `pqp-api-staging` | `DATABASE_URL` | Points at `pqp-staging` on `pqp-db-staging` (`dzx6qo65q9n0jpv5`), via its `direct.<cluster>.flympg.net` host, the way production is configured |
| Fly secrets on `pqp-api-staging` | `CLERK_SECRET_KEY` | The dev instance `sk_test`, never the prod key |
| Fly secrets on `pqp-api-staging` | `CORS_ALLOWED_ORIGINS`, `CLERK_AUTHORIZED_PARTIES` | The staging Pages origin |
| Fly secrets on `pqp-api-staging` | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | R2 API token scoped to `pqp-attachments-staging` only |
| Fly secrets on `pqp-api-staging` | `LOAD_TEST_TOKEN` | The load-test auth secret. **Staging only**; see the runbook below |
| Fly secrets on `pqp-api-staging` | `ADMIN_METRICS_TOKEN` | Lets the harness read `GET /api/admin/metrics` for the pool sample |
| Local file, mode 0600 | `~/.config/pqp/staging-load-test.env` | The operator's copy of both tokens. Never commit it, never paste it into a PR |

## Load testing staging

Capacity is a measured number or it is a guess, and a guess gets discovered during a watch party. This is how to measure it without touching anybody real.

### The safety rules

Read these before the commands, because the commands are easy and two of these mistakes are not recoverable.

1. **Never point a load test at production.** `pqp.gg` and `api.pqp.gg` are out of bounds, full stop. `load-fanout.ts` refuses a `--url` on that domain, but the refusal is a backstop, not permission to try.
2. **Never load test a deployment whose database cluster is shared with production.** This is the rule that made the September 2026 rig possible at all: staging and production shared one Fly Managed Postgres cluster with one `max_connections` of 100, and exhausting connections on staging would have starved `pqp-api`. Staging now has its own cluster (`pqp-db-staging`, `dzx6qo65q9n0jpv5`). If you ever repoint staging back onto `pqp-db-2`, load testing stops being allowed until you undo that.
3. **The harness writes.** It creates users, a server, channels, invites and messages, and it leaves them there. That is fine on staging and is why the database reset above exists.
4. **`LOAD_TEST_TOKEN` belongs on `pqp-api-staging` and nowhere else.** The server refuses it on any Fly app not named `-staging`, but do not lean on that: the secret is the boundary, the app-name check is the second lock.
5. **Put staging back when you are done.** A `performance-2x` machine left running is real money for an environment that is idle most of the week.

### Where the tokens live

`~/.config/pqp/staging-load-test.env`, mode 0600, holding `LOAD_TEST_TOKEN` and `ADMIN_METRICS_TOKEN` — the same values that are set as Fly secrets on `pqp-api-staging`. Load them into the shell and they are the two the harness reads:

```bash
set -a; . ~/.config/pqp/staging-load-test.env; set +a
```

Rotating either is one `openssl rand -base64 48`, one `fly secrets set -a pqp-api-staging`, and the same edit to that file. Never echo either into a terminal you are sharing, a commit, or a PR.

### Prepare staging (before the run)

Size it like production, give it an SFU so one room can hold more than `MESH_VOICE_LIMIT` (8) peers, and lift the two **address-keyed** rate limiters — a harness runs from one IP, so at their defaults those buckets are the ceiling and the run measures them instead of the server.

```bash
# 1. Deploy the branch you want to measure. Do this FIRST: a deploy resets the
#    machine to the size in fly.staging.toml, so scaling before deploying is undone.
gh workflow run deploy-staging.yml --ref my-branch

# 2. Size to match production (fly.toml: performance-2x / 4 GB).
fly scale vm performance-2x --vm-memory 4096 -a pqp-api-staging

# 3. Production's pool ceiling, plus the limiter headroom, as secrets. A secret
#    shadows [env] in fly.staging.toml, which is exactly what makes it revertible.
fly secrets set -a pqp-api-staging \
  PG_POOL_MAX=40 \
  RATE_LIMIT_ANON_CAPACITY=100000 RATE_LIMIT_ANON_REFILL=10000 \
  RATE_LIMIT_SOCKET_CAPACITY=100000 RATE_LIMIT_SOCKET_REFILL=10000 \
  RATE_LIMIT_API_CAPACITY=100000 RATE_LIMIT_API_REFILL=10000 \
  RATE_LIMIT_WRITE_CAPACITY=100000 RATE_LIMIT_WRITE_REFILL=10000

# 4. LiveKit, if you are measuring one big room. Placeholder values are enough
#    for signalling: joining never contacts the SFU, only minting and eviction do.
fly secrets set -a pqp-api-staging \
  LIVEKIT_URL=wss://livekit.invalid LIVEKIT_API_KEY=loadtest \
  LIVEKIT_API_SECRET="$(openssl rand -base64 32)"
```

`/ready` will report LiveKit unhealthy while step 4 is in place, because the host is deliberately fake. That is expected and is one more reason to undo it afterwards.

### Run it

```bash
set -a; . ~/.config/pqp/staging-load-test.env; set +a

pnpm --filter @pqp/server exec tsx scripts/load-fanout.ts \
  --mode join \
  --url https://pqp-api-staging.fly.dev \
  --fly-app pqp-api-staging \
  --arrivals 4 --ramp 4 --ramp-every 20 --max-clients 1200 --hold 30
```

- `--mode join` is the arrival test: it ramps arrivals per second until joins fail. `--mode steady` (the default) is the older one: it holds N clients in a room and measures the per-second cost of the traffic they generate.
- `--arrivals` is the starting rate, `--ramp` the step, `--ramp-every` the step interval. The ramp stops on the first of: `--max-clients`, more than `--abort-fail-rate` of the last 40 arrivals failing, or a p90 time-to-welcome past the client's own budget.
- `--fly-app` streams `/proc/stat` off the machine once a second for a real CPU number. Omit it and everything else still works.
- `--join-timeout` defaults to 12 000 ms, which is `JOIN_TIMEOUT_MS` in `client/src/hooks/use-voice.ts`. Keep the two in step; that constant is what defines the ceiling.
- `--no-bootstrap` skips the cold-browser HTTP. Only use it to isolate the WebSocket: the bootstrap is roughly a hundred pool checkouts per person and is where the pressure actually lives.

### Put staging back (after the run)

```bash
fly scale vm shared-cpu-1x --vm-memory 1024 -a pqp-api-staging
fly secrets unset -a pqp-api-staging \
  PG_POOL_MAX \
  RATE_LIMIT_ANON_CAPACITY RATE_LIMIT_ANON_REFILL \
  RATE_LIMIT_SOCKET_CAPACITY RATE_LIMIT_SOCKET_REFILL \
  RATE_LIMIT_API_CAPACITY RATE_LIMIT_API_REFILL \
  RATE_LIMIT_WRITE_CAPACITY RATE_LIMIT_WRITE_REFILL \
  LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET
```

Unsetting `PG_POOL_MAX` restores the `10` in `fly.staging.toml`. Then wipe the accounts the run created with the database reset above, and confirm `curl -s https://pqp-api-staging.fly.dev/ready` is green.

### Reading the output

Four blocks, in the order they matter.

**Time to welcome, p50 / p90 / p99.** Measured from the start of one simulated person's arrival to the `welcome` frame, which is the same span the browser puts its own 12 s timer on. p99 is the number to care about: p50 stays flat long after the room has started failing for the unlucky.

**The occupancy table.** One row per 25 people already in the room when this person arrived, and it is the answer to the actual question — not "how slow did it get" but "how many people could already be in there". `over` counts arrivals that took longer than the client budget, `failed` counts the ones that never got in at all. The `CEILING:` line under the table is the first bucket where p90 crossed the budget or more than half the arrivals failed.

**Failures by cause.** `transport-refused`, `join-refused` and `room-full` are the server saying no, and each names a specific rule. `closed:4429` is a rate limiter — if you see it, one of the buckets above was not lifted and the run measured the limiter. `closed:1006` and `http:503` mean the machine stopped answering. `timeout` is the residual bucket and is what an overloaded server produces: no refusal, just nothing back inside the budget. Note that a *cold* join the server refuses sends nothing at all (`refuseResume` only answers a resume attempt), so a genuine refusal and an overloaded server both land here; the harness invites every account into the server first so that ambiguity does not normally arise.

**Resources.** `peak sockets` against `soft_limit`/`hard_limit` in `fly.staging.toml`. `pool busy` against `pool max`: `busy == max` with a non-empty queue is the unambiguous wall, and `peak queued` is the deepest queue the process saw even between samples. `machine cpu` is the whole VM, so on a 2-vCPU machine 100 % means both cores. Whichever of those three hits its ceiling first is the resource that ran out, and it is the one to fix.

## Known caveats

- **Canonical URLs point at production.** Marketing and blog routes pin their canonical tag to https://pqp.gg (`client/src/lib/marketing-meta.ts`, `client/src/lib/blog-meta.ts`), so staging pages carry prod canonicals. Harmless for testing; it only means staging marketing pages are not independently indexable, which is a feature.
- **Game connections do not work.** Steam, Battle.net and Twitch OAuth apps are registered for the production origin only; the staging origin has no provider registrations, so those linking flows will fail or stay hidden.
- **First request after idle is slow.** A parked machine takes a few seconds to wake. If a probe or test suite hits a timeout, retry once before suspecting the deploy.
- **Voice on staging is signalling only unless LiveKit is configured.** There is no TURN and no SFU by default, so a load test that needs one room bigger than `MESH_VOICE_LIMIT` has to set `LIVEKIT_*` first — see the load-test runbook below.
