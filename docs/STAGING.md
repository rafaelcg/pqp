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
- **Separate database, on its own unmanaged Fly Postgres app, not Managed Postgres.** Database `pqp_staging` on Fly app **`pqp-db-staging-lite`**, region `gru`: one `shared-cpu-1x` machine, 256 MB RAM, 1 GB volume, `postgres-flex` image, `max_connections` 300 out of the box. Cost is roughly $2 to $3 a month, versus the $38 a month the prior Managed Postgres cluster (`pqp-db-staging`, Basic plan, shared x2 / 1 GB / 10 GB disk) cost for a database staging mostly leaves idle. Moved 2026-09-08 for that reason alone: staging data is disposable, so paying managed-cluster money for it was never buying anything staging needed. The schema self-applies at boot via `server/src/schema.sql` (`initDb()` in `server/src/db.ts`); there is no migration step and nothing to run by hand.

  `DATABASE_URL` on `pqp-api-staging` points at the app's Flycast address, `postgres://postgres:<password>@pqp-db-staging-lite.flycast:5432/pqp_staging`, private 6PN networking, the same as Managed Postgres, just without the pooler and without Fly operating it for you: this is unmanaged Postgres, so there is no automatic failover, no point-in-time restore, and no `fly mpg` tooling. That trade is fine for staging (see the safety rule below) and would not be fine for production. `DATABASE_SSL` is unset, matching how `pqp-api-staging` was already configured before the move; the connection is unencrypted but confined to Fly's private network.

  To connect by hand: `fly proxy 15433:5432 -a pqp-db-staging-lite`, then `psql -h 127.0.0.1 -p 15433 -U postgres -d pqp_staging` with the password from `fly ssh console -a pqp-api-staging -C "printenv DATABASE_URL"`. There is no `fly mpg proxy` for this instance; it is a plain `fly proxy`.

  **A load test above roughly 100 concurrent connections needs `max_connections` raised on `pqp-db-staging-lite` (300 today is headroom, not a guarantee once `PG_POOL_MAX` is pushed past what the load-testing runbook below normally sets) or, for one run, a temporary Managed Postgres cluster stood up and torn down for it.** Do not assume this instance scales the way the old managed cluster did; it is deliberately the cheapest thing that keeps ordinary staging traffic working.

  **The old Managed Postgres cluster, `pqp-db-staging` (id `dzx6qo65q9n0jpv5`), is destroyed** (2026-09-08). `fly mpg list` now shows only `pqp-db-2` (production). A `pg_dump` of the old cluster taken immediately before the switch lives at `~/.config/pqp/staging-db-dump-20260908.sql.gz` on the operator's machine (0600, never committed) as the rollback if anything looked wrong.

  The GitHub repo variable `MONITOR_MPG_CLUSTER` points at production (`pqp-db-2`) and was never affected by any of this; it never pointed at staging.

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

## Feature flags staging builds with

`deploy-staging.yml` turns on any `VITE_` build flag that is still gated off in production, so newly merged work is visible for review without a manual step. Each one reads a repo variable and defaults to `"true"` when that variable is unset, e.g. `VITE_WATCH_PARTY_CHANNELS: ${{ vars.STAGING_WATCH_PARTY_CHANNELS || 'true' }}`. `deploy-web.yml` (production) is untouched, so production stays dark until a flag is deliberately turned on there.

| Client flag | Repo variable | What it gates |
|---|---|---|
| `VITE_WATCH_PARTY_CHANNELS` | `STAGING_WATCH_PARTY_CHANNELS` | The `watch_party` channel type: sidebar "Watch party" section, create button, live pill and viewer count |
| `VITE_WATCH_PARTY_SCHEDULE` | `STAGING_WATCH_PARTY_SCHEDULE` | The "Agendar sessão" scheduling sheet, the upcoming-session card, the "Lembrar" reminder toggle |
| `VITE_LIVE_REACTIONS` | `STAGING_LIVE_REACTIONS` | The floating live-reactions overlay and reaction bar during a watch party |

To turn one off on staging without editing the workflow: `gh variable set STAGING_WATCH_PARTY_CHANNELS --body false -R rafaelcg/pqp` (same pattern for the others), then redeploy. Remember a Cloudflare Pages deploy also registers a service worker, so verify a flag change with a hard refresh or an incognito tab, not a plain reload.

## Resetting the staging database

Wipe the contents of `pqp_staging` in place; the next boot recreates the whole schema from `server/src/schema.sql`. `pqp-db-staging-lite` is unmanaged Postgres and the connection uses the `postgres` superuser, so this is the ordinary drop-and-recreate, not the Managed Postgres workaround an earlier version of this doc needed:

```bash
fly machine stop <machine id> -a pqp-api-staging     # nothing holding connections mid-wipe
fly proxy 15433:5432 -a pqp-db-staging-lite &        # not `fly mpg proxy`; this instance is unmanaged
psql -h 127.0.0.1 -p 15433 -U postgres -d postgres -c 'DROP DATABASE pqp_staging;'
psql -h 127.0.0.1 -p 15433 -U postgres -d postgres -c 'CREATE DATABASE pqp_staging;'
fly machine start <machine id> -a pqp-api-staging    # boot reapplies schema.sql, including CREATE EXTENSION pgcrypto
```

**After a load test you usually want the smaller version**, which keeps the staging accounts you signed up by hand and removes only what the run created. Verified on 2026-09-07, when it took the database from 5 638 users back to 3:

```sql
DELETE FROM servers WHERE name LIKE 'Load %';
DELETE FROM users  WHERE clerk_id LIKE 'load\_test\_user%';
```

Every load-test identity carries the `load_test_user` prefix (`LOAD_TEST_CLERK_ID_PREFIX` in `server/src/auth/load-test.ts`) precisely so that this is one greppable `DELETE`, and the foreign keys cascade the memberships, messages and voice rows away with them.

## Credentials that back it (names only, never values)

| Where | Name | What |
|---|---|---|
| GitHub Actions secret | `FLY_API_TOKEN_STAGING` | Deploy token scoped to `pqp-api-staging` |
| GitHub Actions secrets | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Shared with the production web deploy |
| GitHub repo variable | `STAGING_CLERK_PUBLISHABLE_KEY` | Clerk dev `pk_test`; public by definition, so a variable, not a secret |
| Fly secrets on `pqp-api-staging` | `DATABASE_URL` | Points at `pqp_staging` on `pqp-db-staging-lite`, an unmanaged Fly Postgres app, via its `.flycast` address |
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
2. **Never load test a deployment whose database is shared with production.** This is the rule that made the September 2026 rig possible at all: staging and production originally shared one Fly Managed Postgres cluster with one `max_connections` of 100, and exhausting connections on staging would have starved `pqp-api`. Staging now has its own database, first on a dedicated Managed Postgres cluster (`pqp-db-staging`, since destroyed) and now on the unmanaged `pqp-db-staging-lite` (`max_connections` 300). If you ever repoint staging's `DATABASE_URL` back onto `pqp-db-2`, load testing stops being allowed until you undo that.
3. **The harness writes.** It creates users, a server, channels, invites and messages, and it leaves them there. That is fine on staging and is why the database reset above exists.
4. **`LOAD_TEST_TOKEN` belongs on `pqp-api-staging` and nowhere else.** The server refuses it on any Fly app not named `-staging`, but do not lean on that: the secret is the boundary, the app-name check is the second lock.
5. **Put staging back when you are done.** A `performance-2x` machine left running is real money for an environment that is idle most of the week.

### Where the tokens live

`~/.config/pqp/staging-load-test.env`, mode 0600, holding `LOAD_TEST_TOKEN` and `ADMIN_METRICS_TOKEN`, the same values that are set as Fly secrets on `pqp-api-staging`. Load them into the shell and they are the two the harness reads:

```bash
set -a; . ~/.config/pqp/staging-load-test.env; set +a
```

Rotating either is one `openssl rand -base64 48`, one `fly secrets set -a pqp-api-staging`, and the same edit to that file. Never echo either into a terminal you are sharing, a commit, or a PR.

### Prepare staging (before the run)

Size it like production, give it an SFU so one room can hold more than `MESH_VOICE_LIMIT` (8) peers, and lift the **address-keyed** rate limiters, because a harness runs from one IP so at their defaults those buckets are the ceiling and the run measures them instead of the server. The values are not in this repository; see `~/.config/pqp/capacity-measured.md`, part 2.

```bash
# 1. Deploy the branch you want to measure. Do this FIRST: a deploy resets the
#    machine to the size in fly.staging.toml, so scaling before deploying is undone.
gh workflow run deploy-staging.yml --ref my-branch

# 2. Size to match production (fly.toml: performance-2x / 4 GB).
fly scale vm performance-2x --vm-memory 4096 -a pqp-api-staging

# 3. Production's pool ceiling, plus the limiter headroom, as secrets. A secret
#    shadows [env] in fly.staging.toml, which is exactly what makes it revertible.
#    The variables to set are PG_POOL_MAX and the four limiter pairs
#    (RATE_LIMIT_ANON_*, RATE_LIMIT_SOCKET_*, RATE_LIMIT_API_*,
#    RATE_LIMIT_WRITE_*). The values to give them are in the operator's copy,
#    ~/.config/pqp/capacity-measured.md, part 2, with the matching teardown.
fly secrets set -a pqp-api-staging PG_POOL_MAX=... RATE_LIMIT_...=...

# 4. LiveKit, if you are measuring one big room. Placeholder values are enough
#    for signalling: joining never contacts the SFU, only minting and eviction do.
fly secrets set -a pqp-api-staging \
  LIVEKIT_URL=wss://livekit.invalid LIVEKIT_API_KEY=loadtest \
  LIVEKIT_API_SECRET="$(openssl rand -base64 32)"
```

`/ready` will report LiveKit unhealthy while step 4 is in place, because the host is deliberately fake. That is expected and is one more reason to undo it afterwards.

The one lever that is **not** a secret is fly-proxy's per-machine connection ceiling, `[http_service.concurrency]` in `fly.staging.toml`. It only takes effect through a config deploy, so overriding it means `fly deploy -c <edited copy> -a pqp-api-staging --image <current image> --ha=false`, and the next CI deploy puts it back. It was tested on 2026-09-07 and it changed nothing: the room fell over on bandwidth long before the proxy limit was in play. Do not spend time on it again unless a run actually reaches the limit. The values tried and the socket count where it fell over are in `~/.config/pqp/capacity-measured.md`, part 2.

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

Five blocks, in the order they matter.

**Time to welcome, p50 / p90 / p99.** Measured **from the socket**, not from the top of the attempt, because that is where the browser arms its own 12 s timer (`armJoinTimeout` in `client/src/hooks/use-voice.ts`). The cold-browser HTTP that runs before it gets its own `boot` column and is not charged to the join budget. p99 is the number to care about: p50 stays flat long after the room has started failing for the unlucky.

**The occupancy table.** One row per 25 people already in the room when this person arrived, and it is the answer to the actual question. Not "how slow did it get" but "how many people could already be in there". `over` counts arrivals that took longer than the client budget, `failed` counts the ones that never got in at all. The `CEILING:` line under the table is the first bucket where p90 crossed the budget or more than half the arrivals failed.

**Failures by cause.** `transport-refused`, `join-refused` and `room-full` are the server saying no, and each names a specific rule. `closed:4429` is a rate limiter. If you see it, one of the buckets above was not lifted and the run measured the limiter. `closed:1006` and `http:503` mean the machine stopped answering. `timeout` is the residual bucket and is what an overloaded server produces: no refusal, just nothing back inside the budget. Note that a *cold* join the server refuses sends nothing at all (`refuseResume` only answers a resume attempt), so a genuine refusal and an overloaded server both land here; the harness invites every account into the server first so that ambiguity does not normally arise.

**Resources.** `peak sockets` against `soft_limit`/`hard_limit` in `fly.staging.toml`. `pool busy` against `pool max`: `busy == max` with a non-empty queue is the unambiguous wall, and `peak queued` is the deepest queue the process saw even between samples. `machine cpu` is the whole VM, so on a 2-vCPU machine 100 % means both cores.

**The wire, and the harness's own vital signs.** `wire in` is every byte the run received, with a per-frame-type table under it. Read this **before** believing any latency above it, for two reasons. Signalling fan-out is O(room size) per arrival, so a filling room is quadratic and the bytes land on one link instead of the N households they would in production: a peak near that machine's downlink means the run measured the link. And `harness: N% of one core` is the load generator itself, which does every TLS handshake and parses every fanned-out frame; past roughly 80 % it is the thing being measured, and the run wants sharding across processes or machines.

The per-frame-type table is the one that turns a wall into a fix. A signalling frame should be a few hundred bytes; a type averaging tens of kilobytes is a whole-collection re-send, and the table names it.

Whichever of CPU, pool and wire hits its ceiling first is the resource that ran out, and it is the one to fix.

### What it has measured

**The results are not in this repository.** Ceilings, break points, per-run
tables and the arithmetic behind them live in the operator's copy at
`~/.config/pqp/capacity-measured.md` (mode 600 in a 700 directory), for the
reason given at the top of [`docs/CAPACITY.md`](./CAPACITY.md): this repo is
public and so is the load harness, so publishing the coordinates alongside a
working 500-client generator hands someone the whole map. The method is public
and stays here.

Two campaigns so far, both on 2026-09-07.

**Morning, API only** (`load-fanout --mode join`). One LiveKit-pinned voice
room, staging on `performance-2x` / 4 GB at production's `PG_POOL_MAX`, the
harness on one laptop in Brazil, arrivals ramped until joins stopped fitting
the client's 12 s budget, every welcomed socket staying in the room. Three
clean runs against `main`, plus a comparison against the revision before the
roster delta work.

What it established, in shape rather than in numbers: **what runs out is
bandwidth**, not CPU (which never passed about a third of a two-core VM) and
not the Postgres pool (which saturates for seconds at a time behind requests
already queued on the wire). Signalling fan-out is O(room size) per arrival, so
a filling room is quadratic. The roster delta work moved the ceiling up by a
clear multiple, and it held after landing, but it landed well short of what the
branch description had extrapolated: that estimate was arithmetic on one cost,
and the room falls over on a different one first. After the deltas,
`presence-update` rather than `voice-roster` is the largest thing on the wire,
and it is the next one to fix.

**Evening, 500 in one room with real media.** The same staging API, but the
whole path: cold HTTP, app socket, `welcome`, `POST /api/voice/token`, LiveKit
connect, and a 720p30 share decoded by every receiver, from Vultr boxes in São
Paulo against an isolated test SFU built from `tools/sfu/install.sh`. Harness:
`tools/watch-party-load`. Nothing touched production; the generators had
`api.pqp.gg` and `sfu.pqp.gg` denied in their firewall and the harness refuses
both by name.

The rig: staging on `performance-2x` / 4 GB at production's pool ceiling, image
`53099a94`, a config deploy of an edited `fly.staging.toml` with the proxy
concurrency raised, `auto_stop_machines off` and `min_machines_running 1`
(never committed; the next CI deploy reverts it), and the address-keyed
limiters lifted; the per-identity API and write limiters stayed at their
defaults. Test SFU: Vultr `vhp-4c-8gb-amd`, LiveKit 1.13.6 from the committed
template under sslip.io names, fresh key pair, `LIVEKIT_*` on staging pointed
at it. Generators: `vhp-12c-24gb-amd` boxes, several Node processes each,
presenter in a process of its own. Arrival: presenter live first, 499 receivers
over 90 s, a fifth of them with no `caps` and no `permessage-deflate`, then a
600 s hold. Sampled every second on the API machine, the SFU and every
generator.

The one finding that changed production, with its reasoning intact: **a single
UDP mux port serialises the SFU's whole receive path and overflows its kernel
receive buffer long before the CPU is busy.** Four ports instead of one, with
nothing else changed, turned a run that failed on delivery into one that
delivered the full stream to every receiver with no measured loss and no
receive-buffer drops. LiveKit binds `min(vCPUs, ports in the range)`, so the
port count and the core count have to move together. That change and the
raised `net.core.rmem_max` / `wmem_max` are on production; see
[`docs/CAPACITY.md`](./CAPACITY.md) section 2 for the full list and dates.

**Generator sizing is the other durable lesson.** One Node process for 95
receivers is itself a ceiling (event loop lag in seconds, presenter capture
falling below 30 fps, decoded frame rate collapsing, `rtc-node` handle errors
on the last arrivals, all while the SFU is idle). Split across processes of
roughly thirty receivers with the presenter in its own process it is clean. The
cost is decode: about 0.08 of a core per receiver of 720p30, paid whether or
not a `VideoStream` drains it, so a 12 vCPU box holds 80 to 90 receivers under
the 70% gate. Any run whose generators went over that gate has a
receiver-side "sustained" figure that is the generators' number and not the
SFU's. Details in `tools/watch-party-load/README.md`.

**Why an early attempt stalled at a few dozen clients.** The pre-auth
address-keyed limiter charges every `/api` request, and on Fly the address is
the rightmost `X-Forwarded-For` entry, the one fly-proxy appends, so a
harness's forged header is ignored and every client on one generator shares one
bucket. That is why the preparation step above lifts it. The bucket size, the
refill and the arithmetic are in the operator's copy; the thing to remember
here is that the fix is to lift the limiter for the run, not to try to spread
the harness across addresses.

Three caveats, all of which make any figure **conservative rather than
optimistic**:

- The API-only harness concentrates every simulated client on one link, and the
  peaks land near that link's capacity, so part of the slowdown at the top of
  each ramp is the harness. The server-side egress is real either way: those
  bytes have to leave the machine regardless of who receives them. To measure a
  distributed crowd properly, shard the harness across machines.
- **A capability the harness does not declare is an optimisation the run cannot
  see.** The first comparison against the roster deltas measured no improvement
  at all, because `voice-roster-delta` is opt-in per socket (`caps` on the
  `auth` frame, `SOCKET_CAPS` in `server/src/ws/sockets.ts`) and the harness was
  silent. `--caps` is how you choose; `--caps 0` deliberately measures an old
  client. Worth knowing for production too: a client that does not negotiate
  keeps paying the whole roster.
- **The rig is shared, and a run that cannot say which build it measured is not
  a measurement.** On 2026-09-07 another agent deployed their branch to
  `pqp-api-staging` between two runs, and the second run quietly measured their
  code: different wire volume, CPU pegged where it had been idle, a ceiling a
  bucket higher, and nothing in the output to say the binary had changed. The
  report now prints `target ran <sha> for the whole run`, or shouts when that
  moves. Check that line before believing any number, and redeploy the build
  you meant before every run.

**Operational lessons.** The Vultr account's monthly fee cap refused new
machines mid-session; Fly `performance-16x` machines in `gru` work as
generators (bootstrapped from `node:22-bookworm`, production addresses dropped
with `iptables`). The Vultr API key is IP-restricted, so a VPN on the laptop
makes every Vultr call fail with `Unauthorized IP address` until it drops.
`pkill -f <pattern>` from an ssh command whose own command line contains the
pattern kills the session. `rtc-node` under 12 concurrent connects per process
segfaulted once in 43 process-runs; there is no catching that, only smaller
shards.

**Cost.** A few hours of Vultr plus a couple of Fly machines for an evening,
single-digit to low double-digit dollars for the compute, plus the staging
machine's `performance-2x` hours.

## Known caveats

- **Canonical URLs point at production.** Marketing and blog routes pin their canonical tag to https://pqp.gg (`client/src/lib/marketing-meta.ts`, `client/src/lib/blog-meta.ts`), so staging pages carry prod canonicals. Harmless for testing; it only means staging marketing pages are not independently indexable, which is a feature.
- **Game connections do not work.** Steam, Battle.net and Twitch OAuth apps are registered for the production origin only; the staging origin has no provider registrations, so those linking flows will fail or stay hidden.
- **First request after idle is slow.** A parked machine takes a few seconds to wake. If a probe or test suite hits a timeout, retry once before suspecting the deploy.
- **Voice on staging is signalling only unless LiveKit is configured.** There is no TURN and no SFU by default, so a load test that needs one room bigger than `MESH_VOICE_LIMIT` has to set `LIVEKIT_*` first. See the load-test runbook below.
- **A stale `APP_VERSION` secret fails the deploy gate.** `deploy-staging.yml` passes `-e APP_VERSION=<sha>` and then polls `/health` until `version` equals that sha. A Fly *secret* named `APP_VERSION` shadows the `-e` flag, so `/health` keeps reporting the old sha and the "Verify the deployed commit" step times out after ten minutes even though the new image is serving. It happened on 2026-09-08; the secret is unset now (`fly secrets list -a pqp-api-staging` must not show it). Never set `APP_VERSION` as a secret on either app; it is a per-deploy env flag.

## Rehearsing two machines (step 4 of `docs/deploy-fly.md` 6a-bis)

Before production is ever scaled to two again, run this once here, **with `LIVEKIT_*` set** (production's posture; a pass with them unset, which is what the 2026-09-08 run first got, does not count, because the point is that small rooms stay mesh and large rooms go to LiveKit while two machines are live). Written as a checklist an agent can execute: every step has a command, what it must show, and what to do if it does not. Do not touch `pqp-api` (production) at any point; every command below names `pqp-api-staging`. Everything here is temporary and the last section undoes it.

Prerequisites: `fly` and `gh` authenticated (`fly auth whoami`, `gh auth status`), the three `LIVEKIT_*` values from the operator (never from a doc or a commit; a second LiveKit Cloud project is ideal, the production one is acceptable because room names are channel UUIDs from a different database and cannot collide), and two browser profiles signed up on the staging Clerk dev instance (`localStorage` suffixes do not exist on staging).

**Set up:**

```bash
# 1. The flags and the SFU. `fly secrets set` restarts the machine.
fly secrets set CLUSTER_BUS=postgres VOICE_REGISTRY=postgres \
  LIVEKIT_URL=<wss://...> LIVEKIT_API_KEY=<...> LIVEKIT_API_SECRET=<...> \
  -a pqp-api-staging
curl -s https://pqp-api-staging.fly.dev/ready | jq .checks.livekit   # {"ok":true,...}; staging may already carry LIVEKIT_* (it did on 2026-09-08), then skip the three

# 2. Auto-stop off for the rehearsal. fly.staging.toml says "stop" / min 0;
#    a parked machine would count as one instance that stopped answering.
#    Edit fly.staging.toml locally (auto_stop_machines = "off",
#    min_machines_running = 2) and deploy it from a branch; do not merge that edit.
gh workflow run deploy-staging.yml --ref <your-branch>
gh run watch                                                    # green before going on

# 3. Two machines, same region.
fly scale count 2 --region gru -a pqp-api-staging
fly machines list -a pqp-api-staging      # two rows, both "started", both gru
```

**Verify, in this order. Each step is pass or stop; on a stop, scale back (below) and report the step and the log lines.**

1. **Bus and registry alive on both.** `fly logs -a pqp-api-staging` shows `voice.registryEnabled` from both machine ids, then `bus.selfEcho` from both. Stop on `bus.selfEchoMissing` (that is `DATABASE_URL` through a transaction-mode pooler; LISTEN is not delivering) or on `voice.configDrift` (the two machines have different LiveKit config; a secrets change landed on one).
2. **Two sockets on two machines.** Open `/app` in both browsers. Every `fly logs` line is prefixed with the machine id, so the `ws.*` lines for your two users say which machine each socket landed on. Reload one browser until the two users are on different machines; if ten reloads never split them, stop (the proxy is pinning connections, which the whole rehearsal assumes it does not).
3. **Chat and presence cross.** Send a message from A; it appears in B without a refresh. Both open the same server; the member list's online state agrees. Fail: stop.
4. **A LiveKit room spans the machines.** In a community, or a server with ten or more members (make one with the load-test seeder if staging has none; a small server is mesh by policy and belongs to step 6), A joins a voice channel; B joins the same one. B's `welcome` frame (DevTools, WS) says `transport: "livekit"` and lists A's peer; both tiles appear on both screens, both hear each other, `fly logs` shows `voice.join` from each machine id for that channel and `voice.transportPinned` with `reason: "community"` or `"large"` from the machine that opened it. `voice-join-refused` must not appear anywhere, and neither may `voice.meshGuardForcedSfu` (it no longer exists; seeing it means the image predates 2026-09-08). Fail: stop.
5. **The counters climb.** `curl -s -H "Authorization: Bearer $ADMIN_METRICS_TOKEN" https://pqp-api-staging.fly.dev/api/admin/metrics | jq .voice.cluster`, several times: it answers from whichever machine takes the request, and within a minute of step 4 both `framesRelayed` and `framesReceived` are above zero on both (keep calling until both machine ids have answered; `fly logs` says which one served each request). Zero after a minute on a machine that has a peer in the room: stop, the bus is not delivering.
6. **A small room stays mesh across the machines, with LiveKit set.** Twice: a DM call between the two users (a conversation call is mesh whatever the SFU), and a voice channel in a server with fewer than ten members, both joined by A first and B second, with the users on different machines. The `welcome` on B says `transport: "mesh"` both times, `fly logs` shows `voice.transportPinned` with `reason: "dm"` and then `"small"` from A's machine and `voice.meshPinAdopted` from B's, both hear each other, and the WS frames on B show an `offer` arriving from A's peer id and an `answer` going back. A `welcome` saying `livekit` for either room is the guard that was deleted on 2026-09-08 coming back, and is a fail: on production every small room of the night would land on the media box. Fail (no audio, `voice-join-refused`, or the wrong transport): stop.
7. **A moderator mute holds across machines.** On a staging server both belong to, with A as owner: in the voice channel from step 4, A opens B's member card and mutes B for everyone. B's tile shows the server-mute badge on both screens, B's own client refuses to unmute (the mic button snaps back), and `fly logs` shows `voice.serverMute` on the bus if B's socket is on the other machine. A unmutes B; B can talk again. Then B leaves and rejoins while muted (repeat the mute first): B comes back muted. Fail: stop.
8. **A resume crosses.** With A in the voice channel, `fly machine restart <id of the machine A is on> -a pqp-api-staging`. Logs: `[shutdown] SIGTERM`, `ws.drainBatch` lines, `ws.drained`, all inside a few seconds. Browsers: at most a brief "reconnecting", no "Realtime connection closed" banner that stays, and A's socket lands on the survivor (machine id prefix). A's seat resumes with the same peer id (`voice.resumeAdopted` in the logs, `resumed: true` in the `welcome` frame) and A keeps hearing B. `curl -s -o /dev/null -w '%{http_code}' https://pqp-api-staging.fly.dev/health` during the drain answers 503 once the draining machine is the one hit; `/up` stays 200 throughout. Fail: stop.
9. **The other machine too.** Once the restarted machine is back (`fly machines list`), repeat step 8 on the other one.
10. **A real deploy.** `gh workflow run deploy-staging.yml --ref <your-branch>` and `gh run watch`: the rolling strategy does step 8 to each machine in turn, both browsers stay connected, the job's own checks pass, and afterwards `fly machines list` shows two started machines on the new image.

**Scale back (do not leave staging on two machines; it doubles the bill and parks nothing):**

```bash
fly scale count 1 --region gru -a pqp-api-staging
git checkout fly.staging.toml                       # auto-stop "stop", min 0 again
gh workflow run deploy-staging.yml --ref staging    # redeploys the committed file
fly secrets unset LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET -a pqp-api-staging   # unless staging is meant to keep an SFU
fly machines list -a pqp-api-staging                # one row
```

`CLUSTER_BUS` and `VOICE_REGISTRY` are harmless to leave on one machine (production runs them on one). Record the date, the step reached and the outcome in the M6 line of the plan's status header; a full pass is what unblocks step 5 of `docs/deploy-fly.md` 6a-bis.
