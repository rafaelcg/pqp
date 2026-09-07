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

  Two things about that move that `fly mpg list` will make you doubt. **`pqp-db-staging` lists no attached apps**, because `DATABASE_URL` was set by hand at the `direct.<cluster>.flympg.net` host, which is how production is configured and is not what `fly mpg attach` writes; the attachment record is a label, the secret is the connection, and `/ready` is the thing that answers whether it works. And **the old `pqp-staging` database still exists on `pqp-db-2`**, holding the copy that was dumped out of it, unreferenced by anything. It is a rollback, not a live database. Delete it when nobody wants that rollback any more, remembering whose cluster it is on.
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

**`fly mpg connect` cannot do this on the new cluster.** It authenticates as an MPG system role there, and `DROP OWNED BY current_user` comes back `ERROR: MPG system roles cannot be modified`. The app's own `fly-user` login is the one that owns the tables, so go in through the proxy with its password (the one in `DATABASE_URL`):

```bash
fly machine stop <machine id> -a pqp-api-staging   # nothing holding connections or recreating tables mid-wipe
fly mpg proxy dzx6qo65q9n0jpv5 -p 16394 &          # STAGING cluster; production is 9g6y30wdxzmrv5ml
psql -h 127.0.0.1 -p 16394 -U fly-user -d pqp-staging -c 'DROP OWNED BY current_user;'
fly machine start <machine id> -a pqp-api-staging  # boot reapplies schema.sql, including CREATE EXTENSION pgcrypto
```

Read that cluster id before pressing enter, every time.

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

`~/.config/pqp/staging-load-test.env`, mode 0600, holding `LOAD_TEST_TOKEN` and `ADMIN_METRICS_TOKEN`, the same values that are set as Fly secrets on `pqp-api-staging`. Load them into the shell and they are the two the harness reads:

```bash
set -a; . ~/.config/pqp/staging-load-test.env; set +a
```

Rotating either is one `openssl rand -base64 48`, one `fly secrets set -a pqp-api-staging`, and the same edit to that file. Never echo either into a terminal you are sharing, a commit, or a PR.

### Prepare staging (before the run)

Size it like production, give it an SFU so one room can hold more than `MESH_VOICE_LIMIT` (8) peers, and lift the two **address-keyed** rate limiters, because a harness runs from one IP so at their defaults those buckets are the ceiling and the run measures them instead of the server.

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

The one lever that is **not** a secret is fly-proxy's per-machine connection ceiling, `[http_service.concurrency]` in `fly.staging.toml` (soft 400 / hard 600, the same numbers production runs). It only takes effect through a config deploy, so overriding it means `fly deploy -c <edited copy> -a pqp-api-staging --image <current image> --ha=false`, and the next CI deploy puts it back. Tested on 2026-09-07 at 4000/5000 and it changed nothing: the room fell over at ~460 sockets on bandwidth long before the proxy limit was in play. Do not spend time on it again unless a run actually reaches 600 connections.

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

### What it has measured (2026-09-07)

The rig: `pqp-api-staging` on `performance-2x` / 4 GB with `PG_POOL_MAX=40` (production's size), one LiveKit-pinned voice room, the harness on one laptop in Brazil whose downlink measures 703 Mbit/s. Arrivals ramped from 6/s, +3/s every 15 s, every welcomed socket staying in the room.

**The ceiling on the code that is shipping today is roughly 300 to 400 people in one room, centre about 350.** Three clean runs against `main` at `0e97f22f` and `8dc691dd` put the first bucket past the client's 12 s budget at 325-349, 300-324 and 375-399. Below that, joins land in one to three seconds; above it, the p90 crosses twelve and people start seeing the join fail.

| | `main` before the roster deltas | **`main` today** |
|---|---|---|
| **Joins stop fitting the client's 12 s budget at** | ~225 to 250 in the room | **~300 to 400, centre ~350** |
| Machine CPU, max | 24 % of the VM | 14 to 36 % |
| Pool saturated | 6 of 213 samples | 4 of ~220 samples (transient queue up to 287) |
| Peak wire rate | 651 Mbit/s | 556 to 734 Mbit/s |

That is about 1.4x more people than before the roster delta work, and it matches what that branch measured on this rig before it merged (350 to 375), so the improvement survived landing. It is still two to three times short of the 800 to 1000 the branch's description extrapolated: that estimate was arithmetic on one cost, and the room falls over on a different one first.

**What runs out is bandwidth.** Not CPU, which never passed 36 % of a two-core VM. Not the Postgres pool, which saturates for four seconds out of four minutes behind requests already queued on the wire. Signalling fan-out is O(room size) per arrival, so a filling room is quadratic, and the per-frame-type table names the frame:

| frame | before the deltas | today |
|---|---|---|
| `voice-roster` | 4 981 MB over 52 607 frames, **99 kB each** | 1 190 to 1 286 MB over ~9 000 frames (keyframes only), 147 kB each |
| `voice-roster-delta` | did not exist | 78 to 87 MB over ~75 000 frames, 1.1 kB each |
| `presence-update` | 1 555 MB, 30 kB each | **3 360 to 3 900 MB, 45 kB each** |
| `peer-joined` | 40 MB, 336 bytes each | 74 to 83 MB, 335 bytes each |

So the roster stopped being the largest thing on the wire and `presence-update` took over, at 45 kB a frame and roughly 70 % of the bytes. That is the next one to fix, and as of this writing two changes are in flight and **not** in these numbers: WebSocket compression with payload trimming, and audience rosters with presence deltas. Read the figure above as the state before those, not as the final ceiling.

Three caveats, all of which make the number **conservative rather than optimistic**:

- The harness concentrates every simulated client on one link, and that link's 703 Mbit/s is roughly where the peaks land, so part of the slowdown at the top of each ramp is the harness. The server-side egress is real either way: those bytes have to leave the machine regardless of who receives them. To measure a distributed crowd properly, shard the harness across machines.
- **A capability the harness does not declare is an optimisation the run cannot see.** The first comparison against the roster deltas measured no improvement at all, because `voice-roster-delta` is opt-in per socket (`caps` on the `auth` frame, `SOCKET_CAPS` in `server/src/ws/sockets.ts`) and the harness was silent. `--caps` is how you choose; `--caps 0` deliberately measures an old client. Worth knowing for production too: a client that does not negotiate keeps paying the whole roster.
- **The rig is shared, and a run that cannot say which build it measured is not a measurement.** On 2026-09-07 another agent deployed their branch to `pqp-api-staging` between two runs, and the second run quietly measured their code: different wire volume, CPU pegged where it had been idle, a ceiling a bucket higher, and nothing in the output to say the binary had changed. The report now prints `target ran <sha> for the whole run`, or shouts when that moves. Check that line before believing any number, and redeploy the build you meant before every run.

### What it has measured (2026-09-07, evening): 500 in one room with real media

The morning runs above drove the app WebSocket only. This rig put 500 real
media subscribers through the whole path: cold HTTP, app socket, `welcome`,
`POST /api/voice/token`, LiveKit connect, and a 720p30 share decoded by every
receiver, from four Vultr boxes in São Paulo against `pqp-api-staging` and an
isolated test SFU built from `tools/sfu/install.sh`. Harness:
`tools/watch-party-load` (PR #337 plus the stampede-mode additions described
in its README). Nothing here touched production; the generators had
`api.pqp.gg` and `sfu.pqp.gg` denied in their firewall and the harness refuses
both by name.

**The rig.** Staging on `performance-2x` / 4 GB, `PG_POOL_MAX=40`, image
`53099a94`, a config deploy of an edited `fly.staging.toml` with
`soft_limit 1000 / hard_limit 2000`, `auto_stop_machines off`,
`min_machines_running 1` (never committed; the next CI deploy reverts it), and
the two address-keyed limiters lifted (`RATE_LIMIT_ANON_*`,
`RATE_LIMIT_SOCKET_*`); the per-identity API and write limiters stayed at
their defaults. Test SFU: Vultr `vhp-4c-8gb-amd` (4 vCPU, twice production's
2), LiveKit 1.13.6 from the committed template under sslip.io names, fresh key
pair, `LIVEKIT_*` on staging pointed at it. Generators: four
`vhp-12c-24gb-amd`, four Node processes each of about 31 receivers plus the
presenter in a process of its own on the first box; links measured at 23 Gbit/s
between boxes and to the SFU. Arrival: presenter live first, 499 receivers
over 90 s (5.5/s), 20% of them with no `caps` and no `permessage-deflate`,
then a 600 s hold. Sampled every second on the API machine (`/proc/stat`,
`/proc/net/dev`, `/ready` for the pool, `/api/admin/metrics` every 30 s), the
SFU (the same plus `/proc/net/snmp` UDP errors and LiveKit's `:6789/metrics`)
and every generator (CPU split incl. steal, ingress, UDP errors).

**Why the previous attempt stalled at 61.** The pre-auth `anonLimiter`
(240 tokens, 60/s refill, keyed by client address) charges every `/api`
request, and on Fly the address is the rightmost `X-Forwarded-For` entry, the
one fly-proxy appends, so a harness's forged header is ignored and every
client on one generator shares one bucket. Confirmed without load: 300
concurrent requests from one box with 300 distinct forged addresses at the
default limits answered 285 x 401 and 15 x 429 (the bucket plus what refilled
during the burst); after lifting the two pairs, 300 x 401. At roughly four
pre-socket requests per client, 240 tokens is about 60 clients, then 429s:
the 61.

**Control, API only** (`load-fanout --mode join`, ramp 4/s +4 every 20 s to
1200 from one box): joins stop fitting the client's 12 s budget at roughly
650 to 674 people already in the room; at 475 to 524 occupants welcome p90 was
2.2 s. The machine was at 100% CPU and the pool at 40/40 with a queue of 616
from about 545 occupants at a 20/s arrival rate, and 93% of the 347 Mbit/s of
egress was `voice-roster` keyframes at 192 kB each, because with
`VOICE_REGISTRY=postgres` the roster deltas do not run (`server/src/ws/voice.ts`,
`registryOn() ? null : foldRoomEvents(events)`). That is the join path's own
ceiling and it sits above 500.

**Generators.** One Node process for 95 receivers is itself a ceiling (event
loop lag 4.3 s, presenter capture at 21 fps, decoded 12 fps median, rtc-node
handle errors on the last arrivals, with the SFU at 17% CPU). Split across
processes of about 31 receivers with the presenter in its own process it is
clean, and the cost is decode: about 0.08 of a core per receiver of 720p30,
paid by every subscriber whether or not a `VideoStream` drains it. A 12 vCPU
box therefore holds 80 to 90 receivers under the 70% gate; 500 needs six such
boxes, and four ran at 87 to 94% during A2, which is why A2's receiver-side
sustained figure is labelled generator-limited below. Details and the numbers
are in `tools/watch-party-load/README.md`.

**Run A1, single UDP mux port (production's `livekit.yaml`).** 499 of 499 joined
(welcome p95 66 ms from socket open, 778 ms with the cold HTTP; API pool 16 of
40, CPU 16% p95). Then the media path collapsed: 229 receivers never decoded a
frame within 45 s, the 270 that did decoded 1.2 fps median for the rest of the
hold with 58% packet loss, 194 froze, 627 k PLIs and 20 M NACKs went up to the
SFU and it retransmitted 812 packets. The SFU sat at 66 to 77% CPU (LiveKit at
236% of 400%) pushing only 250 to 270 Mbit/s against about 800 expected, and its
one UDP socket dropped 137,200 inbound packets on its 416 kB receive buffer in
bursts of 700 to 1100 a second. LiveKit says so itself on every boot, on
production too: `UDP receive buffer is too small for a production set-up,
current 425984, suggested 5000000`.

**Run A2, four UDP mux ports (`rtc.udp_port: 7882-7885`, nothing else changed).**
468 receivers present (one generator process died in native libwebrtc ninety
seconds in and took 31 with it). **468 of 468 decoded within 45 s** (p50 811 ms,
p95 1.4 s, p99 1.6 s from their own arrival), decoded 29.7 fps median and 29.4
at p5 at 720 lines, packet loss 0.000% median and 0.001% p95, zero PLIs. The
SFU carried **805 to 853 Mbit/s at 67 to 78% CPU of 4 vCPU with zero
receive-buffer drops for the whole run**; the API pool peaked at 18 of 40 with
CPU at 15% p95. 131 receivers recorded at least one freeze, 105 of them on the
one generator that was at 94% CPU and also ran the presenter (15,243 decoder
frames dropped there, none elsewhere), so the sustained-receipt figure of 72%
is the generators' number, not the SFU's. No receive-buffer drops means the
raised-buffer condition was not triggered; the one attributable change between
A1 and A2 is the port count.

**Ladder F, the 4 vCPU test box, 720p / 1.5 Mbit/s, four ports, `lk load-test`
subscribers (no decode) against our own presenter, three minutes a step.**

| subscribers | egress, steady p50 (peak) | SFU CPU p50 (p95) | receive-buffer drops per s, mean (peak) | loss (lk aggregate) | per subscriber |
|---|---|---|---|---|---|
| 200 | 343 (376) Mbit/s | 26% (28%) | 0 (0) | 0.00% | 1.50 Mbit/s |
| 300 | 516 (565) | 37% (39%) | 0 (0) | 0.00% | 1.50 |
| 400 | 687 (746) | 48% (52%) | 5 (711) | 0.00% | 1.40 |
| 500 | 858 (951) | 59% (63%) | 3 (441) | 0.00% | 1.40 |
| 600 | 588 (956) | 81% (84%) | 26 (1735) | 26.6% | 0.55 |
| 700 | 549 (907) | 85% (86%) | 8 (616) | 26.9% | 0.42 |
| 800 | 547 (911) | 84% (86%) | 15 (2313) | 27.2% | 0.35 |

Between 500 and 600 subscribers the 4 vCPU box stops delivering: egress falls
rather than rises, CPU pins in the low 80s and a quarter of the packets never
reach anyone. Bursty receive-buffer drops start at 400 at no cost to loss; the
buffer condition is what the raised-buffer follow-up is for.

**Run A2 repeated on six generators (four Vultr 12 vCPU plus two Fly
performance-16x, 26 receiver processes of 19), four ports, same everything.**
500 present, **499 of 499 decoded within 45 s** (p50 835 ms, p95 1.7 s, p99
2.4 s from arrival), welcome p95 65 ms from socket open (801 ms with the cold
HTTP), decoded fps median 29.5 and p5 27.7, loss median 0.000% and p95 0.027%,
10 PLIs in ten minutes, presenter 30.1 fps at 1.35 Mbit/s. **SFU: 880 to 935
Mbit/s steady (p95 913, peak 1011), CPU 63 to 81% (p95 76%, peak 82%) of 4 vCPU,
zero receive-buffer drops.** API pool 14 of 40, CPU 14% p95. Sustained receipt
56%: one Fly box ran at 90% CPU and froze all 95 of its receivers (96,785 frames
dropped by its own decoders); the four Vultr boxes, all under 66% CPU, froze 55
of their 309 receivers once each with zero dropped frames and 111 lost packets
between them, which is the shape of brief jitter at the edge of the box's CPU
rather than a starved generator. Read A2 as: at 500 the four-port 4 vCPU box
delivers the full 720p stream to everyone with roughly a quarter of its CPU
left, and the first thing to give at 500 is smoothness, not delivery.

**What the numbers say.**

| condition | outcome at 500 |
|---|---|
| single mux port (production's config), 4 vCPU | fails: 54% ever decode, 58% loss, 250 to 270 Mbit/s out of the box, receive-buffer overflow on the one socket |
| four mux ports, nothing else changed, 4 vCPU | passes delivery: 100% decode within 45 s (p95 1.4 to 1.7 s), 0.000% loss, 880 to 935 Mbit/s at 76% CPU p95 |
| four ports, lk subscribers, 4 vCPU (ladder F) | fine to 500, collapses between 500 and 600 |
| join path alone (control A) | fits the 12 s budget to about 650 in the room |

**The one change to make on production before next weekend is
`rtc.udp_port: 7882-7885` (plus `ufw allow 7883:7885/udp`) in
`tools/sfu/livekit.yaml.tmpl`.** On the test box it was the difference between a
party that fails at 500 and one that passes. Two caveats that decide whether
500 fits on the box production runs today: production is 2 vCPU, not 4, and the
2 vCPU ladder (condition E) was not run because the rig was torn down first; the
4 vCPU box broke between 500 and 600, so on 2 vCPU expect the break well under
500 unless a ladder says otherwise. And the LiveKit boot warning about the UDP
receive buffer (`current 425984, suggested 5000000`) is real: raise
`net.core.rmem_max` / `wmem_max` on the box the next quiet hour, as its own
change, and watch `RcvbufErrors` in `/proc/net/snmp`.

**Not run tonight** (the rig was destroyed while the session was down): the
third repeat of A2; B (explicit 1080p at 4 Mbit/s with receivers pinned to the
top layer); C (50 voices and 10 cameras); D (join storm with resume); E (the 2
vCPU ladder and the confirmation at its found count); the raised-buffer and
`limit` conditions. The harness flags for B, C and D exist and were smoke-tested
at small scale; the ladder scripts are in this run's scratch directory.

**Operational lessons.** The Vultr account's monthly fee cap refused new
machines mid-session; Fly performance-16x machines in `gru` work as generators
(bootstrapped from `node:22-bookworm`, production addresses dropped with
`iptables`) and cost about $0.70 an hour each. The Vultr API key is
IP-restricted, so a VPN on the laptop makes every Vultr call fail with
`Unauthorized IP address` until it drops. `pkill -f <pattern>` from an ssh
command whose own command line contains the pattern kills the session.
rtc-node under 12 concurrent connects per process segfaulted once in 43
process-runs; there is no catching that, only smaller shards.

**Cost.** About five hours of Vultr at $0.86 an hour plus two Fly machines for
about three hours, under $12 for the compute, and the staging cluster's
performance-2x hours.

## Known caveats

- **Canonical URLs point at production.** Marketing and blog routes pin their canonical tag to https://pqp.gg (`client/src/lib/marketing-meta.ts`, `client/src/lib/blog-meta.ts`), so staging pages carry prod canonicals. Harmless for testing; it only means staging marketing pages are not independently indexable, which is a feature.
- **Game connections do not work.** Steam, Battle.net and Twitch OAuth apps are registered for the production origin only; the staging origin has no provider registrations, so those linking flows will fail or stay hidden.
- **First request after idle is slow.** A parked machine takes a few seconds to wake. If a probe or test suite hits a timeout, retry once before suspecting the deploy.
- **Voice on staging is signalling only unless LiveKit is configured.** There is no TURN and no SFU by default, so a load test that needs one room bigger than `MESH_VOICE_LIMIT` has to set `LIVEKIT_*` first. See the load-test runbook below.

## Rehearsing two machines (M5 of `docs/plans/MULTI_INSTANCE_VOICE.md`)

Before production is ever scaled to two (`docs/deploy-fly.md` 6a-bis), run the whole thing here once. Staging has no LiveKit, so this rehearses the bus, the registry, the drain and the mesh guard's *refusal* path; the SFU path is what production will take and can only be watched there.

**Set up (all temporary, undo at the end):**

```bash
# 1. The two flags. `fly secrets set` restarts the machine.
fly secrets set CLUSTER_BUS=postgres VOICE_REGISTRY=postgres -a pqp-api-staging

# 2. Auto-stop off for the rehearsal. fly.staging.toml says "stop" / min 0;
#    a parked machine would count as one instance that stopped answering.
#    Edit fly.staging.toml locally (auto_stop_machines = "off",
#    min_machines_running = 2) and deploy it; do not commit that edit.
gh workflow run deploy-staging.yml --ref <your-branch>   # or fly deploy -c fly.staging.toml -a pqp-api-staging --ha=false

# 3. Two machines, same region.
fly scale count 2 --region gru -a pqp-api-staging
fly machines list -a pqp-api-staging      # two rows, both "started", both gru
```

**Verify, in this order:**

1. `fly logs -a pqp-api-staging` shows `voice.registryEnabled` from both instance ids, then `bus.selfEcho` from both (never `bus.selfEchoMissing`: that means `DATABASE_URL` is a transaction-mode pooler and LISTEN is not delivering, stop here). No `voice.configDrift`.
2. `voice.meshClusterUnsafe` appears once from each instance within 15 s (no LiveKit on staging: that is the guard saying so).
3. Two browsers (`localStorage.setItem("pqp:dev-user-suffix", "bob")` is not available here; sign up twice on the Clerk dev instance). Send a message in a text channel from one and confirm it appears in the other without a refresh; open the same server in both and confirm presence agrees. Reload each a few times: every `fly logs` line is prefixed with the machine id, so the `ws.*` lines for your two users tell you which machine each socket landed on, and you want to see both ids across reloads.
4. Voice, the refusal path: join a voice channel in browser A. In browser B, join the same channel. If B is on the other machine, it must show the call as not connected within a second, with `voice-join-refused` (`reason: mesh-multi-instance`) in the WS frames and `voice.meshRefusedMultiInstance` in the logs, and A must **not** see B in the room. If B landed on the same machine it simply joins; reload B until it lands on the other one. Nobody may ever appear in a room they cannot hear.
5. The drain. With both browsers connected and A still in voice, `fly machine restart <id of the machine A is on> -a pqp-api-staging`. In the logs: `[shutdown] SIGTERM`, then `ws.drainBatch` lines, then `ws.drained`, all inside a few seconds. In the browsers: at most a brief "reconnecting", no "Realtime connection closed" banner that stays, and both land on the surviving machine (the machine id prefix on their `ws.*` log lines). A's voice seat resumes with the same peer id (`voice.resumeAdopted` in the logs, `resumed: true` in the `welcome` frame). `curl -s -o /dev/null -w '%{http_code}' https://pqp-api-staging.fly.dev/health` during the drain answers 503 once the draining machine is the one hit, and `/up` stays 200 throughout.
6. Once the restarted machine is back, repeat step 5 on the other one. Then a real deploy (`gh workflow run deploy-staging.yml --ref <branch>`): the rolling strategy does step 5 to each machine in turn, and the deploy-staging job's own checks pass.

**Scale back (do not leave staging on two machines; it doubles the bill and parks nothing):**

```bash
fly scale count 1 --region gru -a pqp-api-staging
git checkout fly.staging.toml                       # auto-stop "stop", min 0 again
gh workflow run deploy-staging.yml --ref staging    # redeploys the committed file
fly secrets unset CLUSTER_BUS VOICE_REGISTRY -a pqp-api-staging   # optional; harmless to leave on one machine
fly machines list -a pqp-api-staging                # one row
```

Record the date and the outcome in the M5 line of the plan's status header when it has been done.
