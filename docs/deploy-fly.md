# Fly.io deployment (API + WebSocket)

Runbook for moving the pqp API and WebSocket server from Railway to **Fly.io, region `gru` (São Paulo)**.

Only the API moves. The SPA stays on Cloudflare Pages; Fly serves `/api/*`, `/health`, `/status.json` and the `/ws` upgrade. Config lives in [`fly.toml`](../fly.toml) — read the header comment there before changing anything, because it explains the one constraint that governs this whole document:

> **This server is single-process by design.** WebSocket connections, presence, voice-room membership and rate-limit buckets are in-process `Map`s. Two machines are two disjoint chat servers behind one hostname, and nobody gets an error — people just stop seeing each other. Exactly one machine, in exactly one region, until a pub/sub layer exists.

`railway.toml` and `.github/workflows/deploy-api.yml` are deliberately left in place. They are the rollback path.

---

## 0. Prerequisites

```bash
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly version                  # 0.4.77+ is what this runbook was written against

fly auth login
fly auth whoami              # should print your email
fly orgs list                # note the org slug — "personal" for a solo account
fly platform regions | grep gru
```

You also need, locally:

- `psql`, `pg_dump` and `pg_restore` at **version 16 or newer** (`pg_dump --version`). A `pg_dump` older than the source server refuses to run.
- `gh` (GitHub CLI) authenticated against `rafaelcg/pqp`, for the secrets and workflow steps.
- Access to the Railway project, to read the current `DATABASE_URL`.

Nothing below bills anything until step 2.

---

## 1. Pick the database

The API opens a persistent `pg.Pool` (`PG_POOL_MAX=10`, 30s idle timeout), queries Postgres on effectively every request, and runs `SELECT 1` on `/health` **every 30 seconds** as the platform health check. Whatever you pick is on the hot path of both.

| | Fly Managed Postgres (`gru`) | Supabase (`sa-east-1`) | Neon (`sa-east-1`) |
|---|---|---|---|
| Network path | Private 6PN, same region, no public hop | Public internet + TLS | Public internet + TLS |
| `DATABASE_URL` | `fly mpg attach` writes it as a secret | Copy/paste | Copy/paste |
| `DATABASE_SSL` | not needed on 6PN | **must be `true`** | **must be `true`** |
| Idle behaviour | always on | always on (Pro); free tier pauses after 7d idle | **scale-to-zero by default** |
| Floor cost | ~$38/mo Basic + $0.28/GB storage | free tier, $25/mo Pro | free tier, usage-based |
| Blast radius | same vendor as the app | independent | independent |

### Recommendation: **Fly Managed Postgres in `gru`.**

1. **It is the only option on the private network.** MPG lives in your org's 6PN in the same region as the machine, so every query is an intra-region private hop with no TLS handshake to a third party and no public exposure of the database at all. The other two put a public internet round trip in front of every single request this app serves.
2. **`fly mpg attach` owns `DATABASE_URL`.** One less credential hand-copied between two dashboards, and rotation is a command rather than a ritual.
3. **One vendor during an incident.** App logs, database metrics, status page and support are the same place. For a two-person operation that is worth real money at 3am.
4. **Scale-to-zero is actively wrong for this app, which rules out Neon's default.** A suspended compute means the `/health` `SELECT 1` fails during resume → the machine is marked unhealthy → and with a single machine the proxy has nowhere else to route. The persistent pool would also be reconnecting constantly. You can disable autosuspend on Neon, but then you have bought a normal Postgres at a serverless vendor.

**The honest counterweight:** MPG's floor is ~$38/mo against Supabase's free tier, and it puts the app and its database in the same failure domain — a Fly `gru` incident takes out both, where an external database at least survives to be pointed at something else. If cost dominates, **Supabase `sa-east-1` is the fallback**: geographically the same city, so latency is a few milliseconds worse rather than a category worse. If you take it:

- set `DATABASE_SSL=true` (the pool then uses TLS with `rejectUnauthorized: false`, see `server/src/db.ts`),
- use the **session/direct** connection string, not the transaction pooler on `:6543`, unless you also drop `PG_POOL_MAX` — pooling twice with a 10-connection pool per side is how you exhaust the pooler and not the database,
- everything else in this runbook is unchanged except that you set `DATABASE_URL` by hand instead of with `fly mpg attach`.

> **Whichever you pick, connect to the direct/session endpoint, not a transaction-mode pooler.** A transaction pooler hands a different backend to every statement, which silently breaks `LISTEN`/`NOTIFY` — the connection subscribes and then simply never receives anything, with no error. That matters the moment anything in this app uses a Postgres-backed pub/sub channel, and it is close to undebuggable from the outside. Budget one connection above `PG_POOL_MAX` for it, since a `LISTEN` session has to live outside the pool.

### If you take Supabase `sa-east-1` — the exact setup

*Researched 2026-08-07 against Supabase, Fly and PgBouncer documentation. Everything here is sourced; the two places official documentation does not actually answer the question are called out as such.*

Supabase offers four endpoints, and the dashboard shows the wrong one by default. From [Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres):

| Endpoint | Host : port | Network | `LISTEN` |
|---|---|---|---|
| Direct connection | `db.<ref>.supabase.co:5432` | **IPv6** (IPv4 only with the add-on) | **yes** |
| Shared pooler (Supavisor) — **session** | `aws-<N>-sa-east-1.pooler.supabase.com:5432` | IPv4 on every tier | yes (see below) |
| Shared pooler (Supavisor) — **transaction** | `aws-<N>-sa-east-1.pooler.supabase.com:6543` | IPv4 on every tier | **NO** |
| Dedicated pooler (PgBouncer, Pro+) | `db.<ref>.supabase.co:6543` | IPv6 / IPv4 with add-on | **NO** — transaction mode only |

**Port 6543 is the trap, and Supabase does not document it.** PgBouncer's [SQL feature map](https://www.pgbouncer.org/features.html) is explicit — `LISTEN` is `Yes` under session pooling and **`Never`** under transaction pooling (`NOTIFY` is `Yes` in both, which is exactly why this fails asymmetrically: publishing keeps working, receiving stops). Supavisor's own [pool-mode docs](https://supabase.github.io/supavisor/configuration/pool_modes/) define transaction mode as holding a connection "for the duration of a single transaction" and session mode "for the duration of the client connection", but **nowhere in Supabase's or Supavisor's documentation is `LISTEN` mentioned at all**. The strongest official evidence is [supavisor#85](https://github.com/supabase/supavisor/issues/85), "listen/notify support with transaction pooling", open as an *enhancement request* since 2023. Treat session-mode `LISTEN` as strongly implied but unproven — hence the smoke test below, which is not optional.

**Use `db.<ref>.supabase.co:5432`, the direct connection.** It is plain Postgres with no pooler in the path, so `LISTEN` semantics are not a matter of inference, and it allows 60 connections on Micro rather than the pooler's shared `default_pool_size` of 15.

That means egressing over IPv6, which **Fly supports**: [Egress IP addresses](https://fly.io/docs/networking/egress-ips/) states that "Machines often egress over IPv6 when the destination has an AAAA record", and since [2026-05-19](https://community.fly.io/t/unfortunately-were-nating-fly-machines-ipv6-addresses/27908) Machines reach the public v6 internet by SNAT to the host's address rather than holding one themselves. Fly support has [explicitly endorsed this exact path](https://community.fly.io/t/ipv6-outbound-from-gru-to-supabase-100-packet-loss/27739) — a `gru` user hitting `db.<ref>.supabase.co` over v6.

**The honest caveat on that link:** the reason that thread exists is that outbound IPv6 blackholed on a subset of `gru` hosts in April 2026 (same again in `fra` in May). Fly fixed both and says new Machines are unaffected, but the failure mode is nasty — DNS resolves, the route exists, packets vanish, and it survives a Machine *restart* while a *recreate* clears it. So keep the IPv4 session-pooler string written down as a one-secret fallback:

```
# primary — direct, IPv6, LISTEN is plain Postgres
DATABASE_URL=postgresql://postgres:<PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres

# fallback — Supavisor session mode, IPv4, if Fly v6 egress misbehaves.
# Note the username carries the project ref, and read <N> off the dashboard
# (it is 0 or 1 depending on project age) — do not construct this host by hand.
DATABASE_URL=postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-<N>-sa-east-1.pooler.supabase.com:5432/postgres
```

Switching between them is `fly secrets set DATABASE_URL=... --app pqp-api` and a restart. **Re-run the smoke test after switching to the fallback** — it is the leg whose `LISTEN` support is inferred rather than documented. If you would rather not depend on Fly's IPv6 at all, the [dedicated IPv4 add-on](https://supabase.com/docs/guides/platform/manage-your-usage/ipv4) puts an A record on the *direct* endpoint for **$0.0055/hour (~$4/month, billed hourly and not covered by the spend cap)**, Pro plan and above. That is the configuration with no unknowns on either axis, at $25 + $4 = **$29/mo against Fly MPG's ~$38** — a thin enough margin that it is worth re-reading the recommendation above before committing.

**Settings that go with it:**

```bash
fly secrets set --app pqp-api --stage \
  DATABASE_URL='<one of the two above>' \
  DATABASE_SSL='true'
```

`PG_POOL_MAX` stays at `10` in `fly.toml`. Do **not** add `?sslmode=require` to the URL — `pgSslConfig()` in `server/src/db.ts` is what turns TLS on (with `rejectUnauthorized: false`), the pool and the cluster-bus client share it deliberately, and mixing the two ways of asking for TLS is a pointless way to acquire a certificate error.

**Connection budget.** Pro's included compute is Micro: [60 direct connections, 200 pooler clients](https://supabase.com/docs/guides/platform/compute-and-disk), and a Supavisor `default_pool_size` of 15 shared across both pooler ports. One machine at `PG_POOL_MAX=10` plus **one dedicated `LISTEN` session outside the pool** when `CLUSTER_BUS=postgres` is on = **11 connections**, and the pool only opens what it needs (30s idle timeout), so steady state is well under that. Against the direct endpoint's 60 that is ample. Against the *fallback* pooler's 15 it leaves 4 spare for `psql`/`pg_dump` — usable, but raise Default Pool Size to 25 in the dashboard if you sit there for long. At the ceiling, session mode [queues a client for up to a minute](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI) rather than refusing it, which the pool's 10s `connectionTimeoutMillis` turns into a connect timeout — i.e. a red `/health`, not an error message naming the real cause.

**Smoke-test `LISTEN` before you trust the bus.** Two terminals, thirty seconds, and it is the only thing that distinguishes a working bus from a silent one:

```bash
# terminal 1 — interactive, because psql only prints notifications between
# commands, so it needs to keep talking to the server
psql "$DATABASE_URL"
#   LISTEN pqp_cluster;
#   SELECT 1 \watch 2

# terminal 2
psql "$DATABASE_URL" -c "SELECT pg_notify('pqp_cluster', 'hello');"

# terminal 1 must print, between two \watch ticks:
#   Asynchronous notification "pqp_cluster" with payload "hello" received ...
```

Silence here on `:6543` is the whole point of this section. Then confirm it end to end with `CLUSTER_BUS=postgres` set: `fly logs --app pqp-api` must show `bus.connected` at boot, and `bus.connectFailed` or a stream of `bus.error` is the transport telling you it never came up.

**Backups.** Pro gives [daily backups with 7 days of retention](https://supabase.com/docs/guides/platform/backups); Free gives **none**, which alone disqualifies it here. PITR is a $100/mo add-on that also forces at least a Small compute instance — not proportionate for this app. Keep taking your own `pg_dump` on the schedule you already use.

**Latency.** Fly `gru` and AWS `sa-east-1` are both São Paulo, but Fly publishes nothing about interconnect between them and neither do we, so **this is unmeasured, not "fine"**. It is a public-internet hop with a TLS handshake in front of every request, where Fly MPG is an intra-region private one. Measure it during the rehearsal rather than assuming:

`/status.json` already times a real `SELECT 1` from inside the machine (`server/src/services/status.ts`), so the number is one curl away once the app is up — and it is the same number for either database, which makes it a fair comparison during the rehearsal:

```bash
curl -s https://pqp-api.fly.dev/status.json | jq '.components[] | select(.key=="database")'
# {"key":"database","label":"Database","state":"operational","latencyMs":<here>, ...}
```

---

## 2. Create the app

The app is created empty and deployed later, on purpose: the secrets and the database have to exist before the first boot, because `main()` throws and exits 1 without `CLERK_SECRET_KEY` or a reachable `DATABASE_URL`.

```bash
cd /path/to/pqp

# The name must match `app = "pqp-api"` in fly.toml.
fly apps create pqp-api --org personal

fly apps list | grep pqp-api
```

`fly apps create` does **not** allocate IPs or machines — nothing is running or billing yet.

> Do not run `fly launch`. It rewrites `fly.toml` from its own detection and will happily throw away the single-machine configuration this app depends on.

---

## 3. Create Postgres in GRU

```bash
fly mpg create \
  --name pqp-db \
  --org personal \
  --region gru \
  --plan Basic \
  --pg-major-version 17 \
  --volume-size 10

fly mpg list                      # note the CLUSTER ID
fly mpg status <CLUSTER_ID>
```

Then attach it to the app. This writes `DATABASE_URL` into the app's secrets for you — **do not also set it by hand**, or you will be debugging a value that is not the one the app is using:

```bash
fly mpg attach <CLUSTER_ID> --app pqp-api
fly secrets list --app pqp-api    # DATABASE_URL should now be listed (digest only)
```

Pre-create the one extension the schema needs, as the cluster's admin user, so that `initDb()` never has to:

```bash
fly mpg connect <CLUSTER_ID>
# at the psql prompt:
#   CREATE EXTENSION IF NOT EXISTS "pgcrypto";
#   \q
```

`server/src/schema.sql` opens with `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`. On a managed cluster the application role is usually not a superuser; `CREATE EXTENSION IF NOT EXISTS` is a no-op once the extension exists, so pre-creating it removes the only privileged statement from the boot path. Skip this and `initDb()` may throw, and a throw in `initDb()` is `process.exit(1)` — the deploy fails with a permissions error buried in machine logs.

---

## 4. Migrate the data from Railway

### 4a. Which order — restore first, then boot. Always.

`initDb()` (`server/src/db.ts`) executes the whole of `server/src/schema.sql` on **every** boot, before `listen()`. That file is written to be idempotent — `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP INDEX IF EXISTS`.

So:

- **Restore the dump into an empty database, then boot the app.** The dump carries the full schema and the data; `initDb()` afterwards sees everything already present and every statement becomes a no-op. This is the correct order.
- **Do not boot first.** `initDb()` would create empty tables, and a `pg_restore` of a normal dump then fails on `CREATE TABLE` for every object — `--data-only` sidesteps that but reintroduces constraint-ordering problems that the plain restore does not have. There is no upside.

### 4b. Should you attempt zero downtime? No — take a short window.

Zero-downtime would mean logical replication from Railway into the new cluster, which needs `wal_level=logical` on Railway's managed Postgres and `CREATE SUBSCRIPTION` privileges on the target. Neither is a given, both are fiddly, and the payoff is small here because the client already reconnects: `client/src/lib/realtime.ts` retries with backoff and re-resolves a Clerk token per attempt, so a few minutes of unavailability shows as a "reconnecting" state, not a broken session.

**A maintenance window is simpler and is what to do.** Expected length for a chat database well under a gigabyte: **2–5 minutes of dump + restore, 10–20 minutes end to end** including verification. Measure yours first:

```bash
export RAILWAY_DATABASE_URL='<paste DATABASE_PUBLIC_URL from the Railway dashboard>'
psql "$RAILWAY_DATABASE_URL" -c \
  "SELECT pg_size_pretty(pg_database_size(current_database()));"
```

Two things actually shorten the window, and neither is replication:

1. **Rehearse it days early.** Run 4c–4d in full against the real Fly cluster, boot the app, click around, then `DROP` and recreate the database. The rehearsal is where you find the extension permission, the `pg_dump` version mismatch and the missing secret — not the window.
2. **Move to a custom domain *before* you migrate.** See step 7; this is the single biggest lever and it is worth doing as its own change while still on Railway.

### 4c. Dump

```bash
export RAILWAY_DATABASE_URL='<paste from Railway dashboard>'

pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --verbose \
  --file "pqp-$(date +%Y%m%d-%H%M).dump" \
  "$RAILWAY_DATABASE_URL"

ls -lh pqp-*.dump
```

`--no-owner --no-privileges` because the role names differ between the two platforms and you do not want the restore failing on `ALTER TABLE ... OWNER TO`.

For the real window, do this **after** stopping writes (step 6b), so the dump is the final state. For the rehearsal, a live dump is fine.

### 4d. Restore

Open a local tunnel to the private cluster — MPG is not on the public internet, which is the point:

```bash
# terminal 1 — leave running
fly mpg proxy <CLUSTER_ID> --local-port 16380
```

```bash
# terminal 2
export FLY_DATABASE_URL='postgres://<user>:<password>@127.0.0.1:16380/<database>'
#   user / password / database come from `fly mpg status <CLUSTER_ID>` and the
#   attached DATABASE_URL secret; only the host:port is rewritten to the proxy.

pg_restore \
  --no-owner \
  --no-privileges \
  --single-transaction \
  --verbose \
  --dbname "$FLY_DATABASE_URL" \
  pqp-<stamp>.dump
```

`--single-transaction` means a failed restore leaves an empty database rather than a half-populated one you have to reason about. If it aborts on `CREATE EXTENSION`, you skipped the pgcrypto step in section 3 — do it and re-run.

Then give the planner statistics. A freshly restored database has none, and the first minutes on the new host will otherwise be inexplicably slow:

```bash
psql "$FLY_DATABASE_URL" -c "ANALYZE;"
```

### 4e. Verify the copy before you trust it

Run the same counts against both and compare by eye — this takes thirty seconds and is the only thing standing between you and discovering a truncated restore from a user report:

```bash
for url in "$RAILWAY_DATABASE_URL" "$FLY_DATABASE_URL"; do
  echo "--- $url"
  psql "$url" -tAc "
    SELECT 'users',     count(*) FROM users
    UNION ALL SELECT 'servers',  count(*) FROM servers
    UNION ALL SELECT 'channels', count(*) FROM channels
    UNION ALL SELECT 'messages', count(*) FROM messages
    UNION ALL SELECT 'attachments', count(*) FROM message_attachments
    ORDER BY 1;"
done
```

---

## 5. Secrets

`fly.toml` already carries the non-secret configuration in `[env]`: **`PORT`, `TRUST_PROXY` and `PG_POOL_MAX`**. Do not set those with `fly secrets set` — a secret of the same name shadows `[env]`, and then the file you are reading is not the config that is running.

`DATABASE_URL` was set for you by `fly mpg attach` in step 3.

Everything else goes in as a secret. Values below are **placeholders** — paste your real ones, and never commit them:

```bash
fly secrets set --app pqp-api --stage \
  CLERK_SECRET_KEY='<sk_live_...>' \
  CLERK_AUTHORIZED_PARTIES='https://pqp-3yr.pages.dev,https://pqp.gg' \
  CORS_ALLOWED_ORIGINS='https://pqp-3yr.pages.dev,https://pqp.gg' \
  TURN_URL='<turn:host:3478,turns:host:443?transport=tcp>' \
  TURN_USERNAME='<turn-username>' \
  TURN_CREDENTIAL='<turn-credential>'
```

`--stage` stores them without triggering a deploy, which matters here because there are no machines yet.

Notes on the two that are easy to get backwards:

- **`CLERK_AUTHORIZED_PARTIES` is the list of *SPA* origins**, not the API origin. It is checked against the `azp` claim, which Clerk sets to the origin the token was minted for — that is the browser's origin, i.e. Pages and any custom domain in front of the SPA.
- **`CORS_ALLOWED_ORIGINS` is also the SPA origins.** Leave it unset and `resolveCorsOrigin` falls open to `*` (`server/src/lib/http.ts`); the server logs `cors.wildcard_in_production` at boot rather than failing, so an empty value is a warning in the logs, not an error you will notice.

Optional, only if the corresponding feature is on — set the same names you already have on Railway:

```bash
# External Postgres only (Supabase/Neon). NOT needed for Fly MPG over 6PN.
fly secrets set --app pqp-api --stage DATABASE_SSL='true'

# Attachments (R2) — see docs/ATTACHMENTS.md
fly secrets set --app pqp-api --stage \
  S3_ENDPOINT='<...>' S3_BUCKET='<...>' S3_REGION='<...>' \
  S3_ACCESS_KEY_ID='<...>' S3_SECRET_ACCESS_KEY='<...>' \
  S3_FORCE_PATH_STYLE='false' S3_PUBLIC_BASE_URL='<...>'

# LiveKit SFU — see docs/voice-backends.md
fly secrets set --app pqp-api --stage \
  LIVEKIT_URL='<wss://...>' LIVEKIT_API_KEY='<...>' LIVEKIT_API_SECRET='<...>'

# ICE via provider APIs, if you use these instead of static TURN
fly secrets set --app pqp-api --stage \
  CLOUDFLARE_TURN_KEY_ID='<...>' CLOUDFLARE_TURN_API_TOKEN='<...>'
```

Confirm the set of names (values are never shown):

```bash
fly secrets list --app pqp-api
```

**Never set `DEV_AUTH_BYPASS` here.** `assertAuthConfig()` throws on boot if it is `true` alongside `NODE_ENV=production` — which the Dockerfile sets — so the app will simply refuse to start. That is the intended behaviour, but it is a confusing way to spend twenty minutes.

---

## 6. First deploy

### 6a. Deploy

```bash
fly deploy \
  --config fly.toml \
  --app pqp-api \
  --remote-only \
  --ha=false \
  -e APP_VERSION="$(git rev-parse HEAD)"
```

**`--ha=false` is not optional.** A plain `fly deploy` on a first release creates **two** machines. Two machines is the split-brain failure at the top of this document.

Then assert it, every time, because the failure is silent:

```bash
fly machines list --app pqp-api
# expect exactly one row, state "started", region "gru"

# if more than one appeared:
fly scale count 1 --region gru --app pqp-api
```

`-e APP_VERSION=...` is what makes `/health` report the running commit. Without it `/health` says `"version":"dev"`, which is how you tell a hand-rolled deploy from a CI one.

### 6b. Stop writes on Railway (real cutover only)

For the rehearsal, skip this. For the real window, this is the moment: scale the Railway service to zero replicas (or stop the service in the dashboard) **before** taking the final dump in step 4c. Do not delete anything — see Rollback.

### 6c. Check it came up

```bash
fly logs --app pqp-api
fly status --app pqp-api
curl -s https://pqp-api.fly.dev/health
# {"ok":true,"version":"<sha>"}
```

If `/health` never goes green, the first two suspects are in this order: the database is unreachable (`SELECT 1` is what `/health` runs), or `initDb()` threw on the pgcrypto extension. `fly logs` shows both plainly.

---

## 7. Cutover

### 7a. DNS — `pqp.gg` is registered at Porkbun

**Recommended: move the nameservers to Cloudflare.** The SPA is already on Cloudflare
Pages, and a Pages custom domain on the apex validates itself when Cloudflare is also
the DNS provider. It is free, and it keeps one dashboard for both halves of the site.

In Cloudflare: *Add a site* → `pqp.gg` → Free plan → it prints two nameservers. In
Porkbun: *Domain Management* → *Authoritative Nameservers* → replace with those two.
Propagation is usually minutes.

Then, three records:

| Name | Type | Target | Proxy |
|---|---|---|---|
| `pqp.gg` | CNAME | the Pages project | **Proxied** (orange) |
| `www` | CNAME | `pqp.gg` | **Proxied** (orange) |
| `api` | A + AAAA | `fly ips list --app pqp-api` | **DNS only** (grey) |

Add `pqp.gg` and `www.pqp.gg` as custom domains inside the Pages project itself —
Cloudflare then writes the apex record for you.

#### `api.pqp.gg` MUST be DNS-only. This is the part that bites.

Leaving the orange cloud on the API subdomain breaks two things at once, and neither
fails loudly:

1. **It adds a second proxy in front of the app.** `clientAddress()` counts hops in
   from the right of `X-Forwarded-For`, so with Cloudflare *and* fly-proxy in the
   chain, `TRUST_PROXY=true` (one hop) reads Cloudflare's address instead of the
   client's — and every client collapses into a single rate-limit bucket. If you
   deliberately want Cloudflare in front, you must set `TRUST_PROXY=2`.
2. **Cloudflare drops idle WebSockets at ~100 seconds.** The app's own heartbeat is
   30s so it would mostly survive, but this is exactly the shape of CLAUDE.md
   pitfall #9, and debugging it through two proxies is miserable.

Fly already terminates TLS and serves HTTP/2, so the orange cloud buys nothing here.

Keeping DNS at Porkbun also works — Porkbun supports `ALIAS` on the apex — but then
the Pages custom domain has to be validated by CNAME and you are managing records in
two places.

### 7a-bis. Custom domain before migrating — skip it, you have no users yet

### 7a. Do this first, ideally as a separate change: move to a custom domain

Today `VITE_API_URL` points at `https://api-production-206d.up.railway.app`. That hostname is baked into the SPA bundle at build time, which means **changing platforms requires rebuilding and redeploying the SPA**, and every browser still holding a cached bundle keeps talking to Railway until it reloads.

**This step existed to de-risk a cutover with live traffic. With no users, skip it and
point `api.pqp.gg` straight at Fly** — one cutover instead of two. Keep reading only if
you already have people using the Railway deploy.

Putting a custom domain in front while still on Railway turns the migration into a DNS change:

```bash
fly certs add api.pqp.gg --app pqp-api       # prints the DNS records to create
fly certs check api.pqp.gg --app pqp-api     # DNS + issuance status
fly certs list --app pqp-api
fly ips list --app pqp-api
```

Sequence:

1. While still on Railway: point `api.pqp.gg` at the Railway service, set `VITE_API_URL=https://api.pqp.gg` / `VITE_WS_URL=wss://api.pqp.gg/ws`, rebuild the SPA, verify. **Lower the DNS TTL to 60s at the same time.**
2. Migrate as above.
3. At cutover, repoint `api.pqp.gg` at Fly. No SPA rebuild, no cached-bundle tail, and rollback is the same DNS record in reverse.

If you cut over without a custom domain, the GitHub secrets have to change and the SPA has to be rebuilt:

```bash
gh secret set VITE_API_URL   # https://pqp-api.fly.dev   (no trailing slash)
gh secret set VITE_WS_URL    # wss://pqp-api.fly.dev/ws
gh workflow run deploy-web.yml
```

### 7b. Clerk dashboard

Add the API origin to the Clerk application's allowed origins (`https://api.pqp.gg`, or `https://pqp-api.fly.dev`). The SPA origins are already there and do not change. See CLAUDE.md pitfall #4 — a missing origin here presents as auth that works locally and 401s in production.

### 7c. CORS and authorized parties

Both were set in step 5 and are lists of **SPA** origins, so if the SPA hostname did not change, neither does. If you also moved the SPA to `https://pqp.gg`, add it to both:

```bash
fly secrets set --app pqp-api \
  CORS_ALLOWED_ORIGINS='https://pqp-3yr.pages.dev,https://pqp.gg' \
  CLERK_AUTHORIZED_PARTIES='https://pqp-3yr.pages.dev,https://pqp.gg'
```

(Without `--stage` this restarts the machine, which drops live WebSockets — do it in the window, not afterwards.)

### 7d. Switch CI over

Both deploy workflows exist. `deploy-api.yml` deploys Railway; `deploy-api-fly.yml` deploys Fly and is gated on a repository variable, so merging it changed nothing until now. They share a `concurrency` group so they can never run at the same time.

```bash
# a deploy token scoped to this app only — not a personal auth token
fly tokens create deploy --app pqp-api --name github-actions --expiry 8760h
gh secret set FLY_API_TOKEN            # paste the token, including the "FlyV1 " prefix

gh variable set DEPLOY_TARGET --body fly
gh workflow disable "Deploy API"       # the Railway one; file stays in the repo
gh workflow list
```

Then trigger it and watch:

```bash
gh workflow run "Deploy API (Fly)"
gh run watch
```

The Fly workflow asserts three things after deploying: exactly one machine, that it is in `gru`, and that `/health` reports the commit CI just built.

### 7e. Docs

Update the hosted-deploy table in `CLAUDE.md`, `docs/DEPLOY.md` and `docs/HANDOVER.md` to name Fly instead of Railway. Leave `docs/deploy-railway.md` — it is still the rollback target and is also the guide self-hosters follow.

---

## 8. Rollback

**Decide up front where the point of no easy return is: the first message a user writes against the Fly database.** Before that, rollback is a DNS record. After that, rolling back means either losing those writes or dumping Fly and restoring into Railway. Watch the clock, and if the verification checklist below is not clean within your window, go back rather than pressing on.

### Fast path — you have a custom domain (minutes)

1. Repoint `api.pqp.gg` back at Railway. With a 60s TTL, clients follow within a couple of minutes on their own reconnect backoff.
2. Bring the Railway service back up (scale replicas back to 1).
3. Restore CI:
   ```bash
   gh workflow enable "Deploy API"
   gh variable set DEPLOY_TARGET --body railway
   ```
4. Stop the Fly machine so nothing keeps writing to a database you are abandoning:
   ```bash
   fly machines list --app pqp-api
   fly machine stop <MACHINE_ID> --app pqp-api
   ```

### Slow path — no custom domain (one SPA rebuild)

Same as above, plus:

```bash
gh secret set VITE_API_URL   # back to https://api-production-206d.up.railway.app
gh secret set VITE_WS_URL    # back to wss://api-production-206d.up.railway.app/ws
gh workflow run deploy-web.yml
```

Browsers holding the Fly-pointing bundle keep hitting the stopped Fly app until they reload. They will see the reconnect banner, not a broken app.

### If users already wrote data on Fly

```bash
fly mpg proxy <CLUSTER_ID> --local-port 16380     # terminal 1
pg_dump -Fc --no-owner --no-privileges \
  --file rollback-$(date +%Y%m%d-%H%M).dump "$FLY_DATABASE_URL"
```

Restoring that into Railway is *not* a clean `pg_restore` — Railway's copy has diverged from the moment you stopped writes, so you are merging, not restoring. This is the case to avoid by keeping the window short and the verification tight.

### Keep the escape hatch open

Do not delete the Railway service or its Postgres for **at least two weeks** after a successful cutover, and take a Railway dump before you finally do. `railway.toml` and `.github/workflows/deploy-api.yml` stay in the repo permanently; they cost nothing and re-enabling them is one `gh workflow enable`.

---

## 9. Verification checklist

Run all five. Each one covers a layer the one before it does not.

**1. Health and version**

```bash
curl -s https://api.pqp.gg/health
# {"ok":true,"version":"<the sha you deployed>"}
curl -s -o /dev/null -w '%{http_code}\n' https://api.pqp.gg/status.json   # 200
```

A 503 here means the process is up but Postgres is not reachable. `"version":"dev"` means the running machine did not get `APP_VERSION` — the code may still be correct, but it did not come from CI.

**2. Authenticated API call**

Every `/api/*` route resolves a Bearer token before routing, so an unauthenticated `curl` returns 401 whether or not the route exists (CLAUDE.md pitfall #8). Take a real token from the browser (DevTools → Network → any `/api/` request → `Authorization` header) and:

```bash
TOKEN='<paste the Clerk JWT>'
curl -s -H "Authorization: Bearer $TOKEN" https://api.pqp.gg/api/servers | head -c 400
```

You want your actual servers back. An empty list is a **red flag** — it means auth works but the migrated data is not there, which is exactly the failure that a health check cannot see.

**3. CORS from the real origin**

```bash
curl -si -X OPTIONS https://api.pqp.gg/api/servers \
  -H 'Origin: https://pqp-3yr.pages.dev' \
  -H 'Access-Control-Request-Method: GET' | grep -i 'access-control-allow-origin'
```

Must echo back `https://pqp-3yr.pages.dev`. If it echoes `*`, `CORS_ALLOWED_ORIGINS` did not take. If the header is absent, the origin is not in the list and the browser will block every call.

**4. WebSocket connect and message round-trip**

The part no HTTP check covers. In the real client, in two browsers signed in as two different users:

- open `/app`, confirm no "Realtime connection closed" banner,
- send a message in a text channel from browser A and confirm it appears in browser B **without a refresh** (that is the WS path, not the REST path),
- leave both idle for **five minutes** and confirm neither disconnects. This is the one that catches a proxy killing idle connections; Fly should not, since it removed TCP idle-timeout enforcement and the app pings every 30s, but "should not" is not "verified".
- check `fly logs --app pqp-api` for `ws.heartbeatTerminate` — a steady stream of those means sockets are dying and being reaped, not that the heartbeat is working.

**5. Voice join**

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://api.pqp.gg/api/ice-servers
```

Must return TURN entries, not STUN alone — STUN-only is CLAUDE.md pitfall #1 and it fails only across NATs, which is to say only in production. Then join a voice channel from two devices **on different networks** (one on mobile data), and confirm both hear each other. Same-LAN success proves nothing about TURN.

Also confirm the rate limiter is keyed correctly now that there is a new proxy in front: make a burst of requests from two different networks and check that one does not exhaust the other's budget. If it does, `TRUST_PROXY` is wrong for this topology (see below).

---

## 10. Before a second region (e.g. `lhr`) can ever exist

Adding a region means adding a machine, and this server keeps every WebSocket connection, presence entry, voice-room membership and rate-limit bucket in process memory (`server/src/ws/`, `server/src/lib/rate-limit.ts`) — so a second machine is a second, disjoint chat server behind the same hostname, and users on one simply cannot see users on the other, with no error anywhere to explain it.

A second region is therefore blocked on a shared pub/sub and presence layer (Redis or equivalent) that fans chat, presence and voice signalling out across instances, plus a shared rate-limit store; only once messages and presence survive a machine boundary do `fly scale count`, multi-region, and zero-downtime blue-green deploys become available at all.

---

## 11. If you add Cloudflare in front

`TRUST_PROXY=true` in `fly.toml` means **exactly one** proxy hop. `clientAddress()` counts in from the right of `X-Forwarded-For` precisely so the value cannot be forged; if you put Cloudflare's proxy (orange cloud) in front of Fly, there are two hops and the value must become `TRUST_PROXY=2`, or every client gets the same rate-limit bucket. Cloudflare also applies its own ~100s idle timeout to WebSocket connections, which the app's 30s heartbeat stays comfortably inside — but it is the first thing to suspect if connections start dying on a fixed interval after such a change.
