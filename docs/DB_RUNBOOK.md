# DB runbook: backups, restore, and the managed Postgres that went sideways

Production Postgres is **Fly Managed Postgres (MPG)** in `gru`. One cluster, two databases:

| Database | Used by | Notes |
|---|---|---|
| `fly-db` | `pqp-api` (production) | The one that matters |
| `pqp-staging` | `pqp-api-staging` | Empty-ish, recreated from `schema.sql` at boot (see `docs/STAGING.md`) |

Cluster ids move when a cluster is rebuilt, so **always look them up** with `fly mpg list --org personal` rather than trusting a number in a doc. As of 2026-09-06 production is **`pqp-db-2`, id `9g6y30wdxzmrv5ml`**. The original `pqp-db` (`82ylg01v4n30zx19`) is the degraded cluster from the incident below; it exists only until the backfill in step 8 is done and then gets destroyed.

This document exists because on 2026-09-05 a plan resize on the managed cluster failed mid-switchover, the primary kept answering at 80 to 240 ms per query while cutting every connection every 10 to 40 seconds, `fly mpg status` said `ready` the whole time, and the only way out was Fly's point-in-time restore, which would not accept a point inside the last ~20 minutes. Roughly twenty minutes of writes were lost. We now keep our own copy.

Three parts:

1. [The nightly backup](#1-nightly-backup) and how to prove a dump restores.
2. [Production is degraded: restore into a fresh MPG cluster and repoint the API](#2-production-postgres-is-degraded), the rehearsed procedure with the commands that were actually run.
3. [Connection budget](#3-connection-budget-pg_pool_max) (`PG_POOL_MAX`).

No em dashes in this file on purpose; it is meant to be pasted into a terminal at 3 am.

---

## 1. Nightly backup

Fly Managed Postgres answers only on the org's private 6PN network (`*.flympg.net`), so a GitHub runner cannot reach it. The dump therefore runs **inside Fly**, as a scheduled machine in a tiny dedicated app, **`pqp-db-backup`**, region `gru`. Everything for it lives in `tools/db-backup/`:

| File | Role |
|---|---|
| `tools/db-backup/Dockerfile` | `debian:bookworm-slim` + `postgresql-client-17` (PGDG) + `awscli` + `jq`; runs `backup.sh` as a non-root user and exits |
| `tools/db-backup/backup.sh` | The job |
| `tools/db-backup/fly.toml` | App name and region, nothing else. Never `fly deploy` it as a service |

What `backup.sh` does, in order:

1. Checks the secrets exist and refuses a `BACKUP_DATABASE_URL` containing `localhost`, `127.0.0.1`, `staging` or `pqp_test`. It reads **exactly one** connection string and never prints it (no `set -x`, no echo, passed as `--dbname="$BACKUP_DATABASE_URL"`).
2. `pg_dump --format=custom --no-owner --no-privileges`, then `gzip -9`.
3. **Exits 1 if the result is under 1 MB.** A dump that small is the wrong database, an empty one, or a truncated one. Nothing is uploaded in that case.
4. `put-object` to R2 at `pqp-db/YYYY-MM-DD/fly-db-YYYYMMDDTHHMMSSZ.dump.gz`, then `head-object`; exits 1 if the byte count differs.
5. Deletes objects under `pqp-db/` with `LastModified` older than 30 days, but only when at least one newer object is listed, so a clock or listing bug cannot empty the bucket.

Any non-zero exit is visible in `fly logs -a pqp-db-backup` and in `fly machine list` / `fly machine status`. A machine with a schedule is restarted by Fly on that cadence regardless of how the previous run exited, so one failure does not stop the next night's attempt.

### Secrets to create (Fly secrets on the app, nothing in GitHub)

| Secret | What |
|---|---|
| `BACKUP_DATABASE_URL` | Connection string for `fly-db` on the **production** cluster (`pqp-db-2`), using the `direct.<cluster>.flympg.net` host so the dump talks to the primary and not through a pooler. Ideally the read-only role below. |
| `R2_BACKUP_BUCKET` | Bucket name. A new private bucket, suggested `pqp-db-backups`. Not the attachments bucket. |
| `R2_ACCOUNT_ID` | Cloudflare account id. The script builds `https://<id>.r2.cloudflarestorage.com` from it. |
| `R2_BACKUP_ENDPOINT` | Optional. Full S3 endpoint URL; overrides the one built from `R2_ACCOUNT_ID`. |
| `R2_BACKUP_ACCESS_KEY_ID` | From an R2 API token scoped to that one bucket, permission **Object Read & Write** |
| `R2_BACKUP_SECRET_ACCESS_KEY` | Same token |

Cloudflare side: R2 > Create bucket (`pqp-db-backups`, private, no public access, no CORS) and R2 > Manage R2 API Tokens > Create API token > Object Read & Write > Apply to specific buckets > that bucket only. Do not reuse the attachments token; if the backup token leaks, the blast radius should be the backups and nothing else.

### Read-only backup role

The job works with the app's own `DATABASE_URL` value, but a dedicated role that can only read is better: a leaked backup credential then cannot alter production.

```bash
# Cluster id from `fly mpg list --org personal` (9g6y30wdxzmrv5ml as of 2026-09-06)
fly mpg users create --cluster 9g6y30wdxzmrv5ml --name pqp_backup
# Prints a password once. Keep it.

fly mpg connect 9g6y30wdxzmrv5ml --database fly-db
```

```sql
GRANT CONNECT ON DATABASE "fly-db" TO pqp_backup;
GRANT USAGE ON SCHEMA public TO pqp_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pqp_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO pqp_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE schema_admin IN SCHEMA public GRANT SELECT ON TABLES TO pqp_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE schema_admin IN SCHEMA public GRANT SELECT ON SEQUENCES TO pqp_backup;
```

`schema_admin` is what the app's `fly-user` login resolves to on this cluster (see `docs/STAGING.md`); it owns every table, so default privileges have to be declared *for* it, or a table added by a future schema change is invisible to the backup. If `fly mpg users create` is not in your CLI version, `CREATE ROLE pqp_backup LOGIN PASSWORD '...'` from `fly mpg connect` does the same thing if `schema_admin` is allowed to create roles; try the CLI path first.

`BACKUP_DATABASE_URL` is then the `direct.<cluster>.flympg.net` connection string with `pqp_backup:<password>` in place of the app user, database `fly-db`, `?sslmode=require`. Test it from inside Fly before saving the secret (a laptop cannot reach it):

```bash
fly ssh console -a pqp-api -C "psql '<the url>' -qtAc 'select count(*) from users;'"
```

### Creating the backup machine (one time)

```bash
# 1. The app. No machines, no IPs, nothing billing yet.
fly apps create pqp-db-backup --org personal

# 2. Secrets. Values are never in git; see the table above.
fly secrets set -a pqp-db-backup \
  BACKUP_DATABASE_URL='...' \
  R2_BACKUP_BUCKET='pqp-db-backups' \
  R2_ACCOUNT_ID='...' \
  R2_BACKUP_ACCESS_KEY_ID='...' \
  R2_BACKUP_SECRET_ACCESS_KEY='...'

# 3. Build the image and push it to Fly's registry. No machine is created.
#    Run from tools/db-backup so the Dockerfile's COPY sees backup.sh.
(cd tools/db-backup && fly deploy --build-only --push --image-label v1)
# Prints: registry.fly.io/pqp-db-backup:v1

# 4. One scheduled machine. It runs immediately, then Fly restarts it every
#    ~24 h counted from that first start, so run this at the hour you want the
#    backup to happen (04:00 UTC / 01:00 São Paulo is quiet). `--schedule`
#    accepts hourly, daily, weekly, monthly; there is no cron expression.
fly machine run registry.fly.io/pqp-db-backup:v1 -a pqp-db-backup \
  --region gru --schedule daily --vm-size shared-cpu-1x --vm-memory 512 \
  --name nightly-dump --restart no

# 5. Watch the first run finish.
fly logs -a pqp-db-backup
```

The image bakes in the script, so any change to `backup.sh` or the Dockerfile means step 3 again with a new label, then:

```bash
fly machine update <machine-id> -a pqp-db-backup --image registry.fly.io/pqp-db-backup:v2 --yes
```

`fly machine list -a pqp-db-backup` gives the id. Secret changes (`fly secrets set`) apply to the next run without touching the machine.

There is no GitHub Actions path; it would only be a `fly machine run` wrapped in a workflow with another long-lived Fly token in GitHub, which is not worth the extra credential. A one-off backup before a risky change is

```bash
fly machine run registry.fly.io/pqp-db-backup:v1 -a pqp-db-backup --region gru --rm
```

(no schedule, machine deleted on exit), or `fly machine start <machine-id>` to fire the scheduled one early.

### Did last night's run succeed?

```bash
fly logs -a pqp-db-backup --no-tail | tail -20     # want a line ending "OK", not "ERROR:"
fly machine list -a pqp-db-backup                  # state stopped, last exit code 0
```

Optionally list the bucket from a laptop with the R2 credentials: `aws --endpoint-url https://<account-id>.r2.cloudflarestorage.com s3 ls s3://pqp-db-backups/pqp-db/ --recursive | tail -3`. Nobody is paged for a failure; look at this weekly, and always before touching the cluster.

### Verify a dump restores (do this quarterly, and after any schema-heavy month)

A backup you have never restored is a hope, not a backup. Local `docker compose` Postgres is `postgres:16-alpine`; a dump made by `pg_dump` 17 restores into 16 as long as `pg_restore` itself is 17 or newer, so use the `postgres:17` image for the client and keep the compose database as the target.

```bash
# 1. Fetch the newest dump (AWS CLI against R2, from a laptop; the bucket is reachable from the internet, the database is not)
export AWS_ACCESS_KEY_ID=...   AWS_SECRET_ACCESS_KEY=...   AWS_DEFAULT_REGION=auto
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
E="https://<account-id>.r2.cloudflarestorage.com"
KEY=$(aws --endpoint-url "$E" s3api list-objects-v2 --bucket pqp-db-backups --prefix pqp-db/ \
  --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
aws --endpoint-url "$E" s3 cp "s3://pqp-db-backups/$KEY" ./latest.dump.gz
gunzip -k latest.dump.gz

# 2. Fresh local database. Never restore over `pqp`, your dev data lives there.
docker compose up -d postgres
docker compose exec postgres psql -U pqp -c 'DROP DATABASE IF EXISTS pqp_restore;'
docker compose exec postgres psql -U pqp -c 'CREATE DATABASE pqp_restore;'

# 3. Restore with a pg 17 client, from a container on the compose network.
docker run --rm -v "$PWD:/w" --network host postgres:17 \
  pg_restore --no-owner --no-privileges --dbname 'postgresql://pqp:pqp@localhost:5432/pqp_restore' /w/latest.dump

# 4. Row counts should look like production.
docker compose exec postgres psql -U pqp -d pqp_restore -c \
  "select 'users' t, count(*) from users union all select 'servers', count(*) from servers union all select 'messages', count(*) from messages;"

# 5. Optionally boot the API against it
DATABASE_URL=postgresql://pqp:pqp@localhost:5432/pqp_restore pnpm --filter @pqp/server dev
```

`pg_restore` printing a handful of `already exists` errors for `pgcrypto` is normal; anything about a missing table or a failed `COPY` is not. If a native Postgres is shadowing Docker on 5432 (this has happened on the dev Mac), point at the compose container's mapped port explicitly or stop the native one.

---

## 2. Production Postgres is degraded

### Recognise it

Symptoms seen on 2026-09-05, all at once:

- `fly logs -a pqp-api` full of `Connection terminated unexpectedly` and `[db] idle client error`, in bursts every 10 to 40 seconds.
- Every query 80 to 240 ms from inside the API machine, where the normal figure is single-digit ms.
- `fly mpg status <id>` says **ready**. It lied for the entire incident. Do not let it talk you out of what the logs show.
- The trigger was a plan resize (a Patroni switchover that returned 503 and never completed).

If the app is slow but the DB answers quickly from `fly mpg connect`, this is not your runbook. Look at the API machine first.

### Decide

A degraded managed cluster that Fly's own tooling calls healthy is not going to fix itself on a timescale you can wait for. The rehearsed path is: **restore into a fresh cluster, repoint the API, then reconcile the gap.** Budget 30 to 45 minutes of degraded service and one API restart. Open a Fly support ticket in parallel, but do not wait on it.

### Step 1. Find what Fly can restore from

```bash
fly mpg list --org personal            # cluster ids, plans, regions
fly mpg backup list <degraded-id>      # base backups; PITR sits on top of these
# On 2026-09-05 <degraded-id> was 82ylg01v4n30zx19 (pqp-db). Today's production is 9g6y30wdxzmrv5ml (pqp-db-2).
```

Note the time now, in UTC. Every write after the point you pick is going to be reconciled by hand in step 8, so the newer the point the less work later.

### Step 2. Restore to a new cluster

```bash
fly mpg restore <degraded-id> --pitr-time "2026-09-05T22:40:00Z" --name pqp-db-3   # the incident produced pqp-db-2; use the next free name
```

**`--pitr-time` refuses points inside roughly the last 20 minutes** ("target time is after the latest restorable point", or a generic error). Step back in **5-minute increments** until it accepts. Write down the accepted time; it is the boundary for the backfill.

The command returns quickly; the cluster comes up over the next few minutes. Watch it:

```bash
fly mpg list --org personal            # the new cluster appears with its own id
fly mpg status <new-id>
```

### Step 3. Verify the data before touching the API

```bash
fly mpg connect <new-id> --database fly-db
```

```sql
select count(*) from users;
select count(*) from servers;
select count(*) from server_members;
select count(*) from messages;
select max(created_at) from messages;    -- should be close to the PITR time
```

Run the same four counts against the old cluster if it will answer (`fly mpg connect <old-id> --database fly-db`). The differences are the size of the gap. Anything wildly off (zero rows, half the users) means the wrong database name or a bad restore point; stop and re-check before going further.

### Step 4. Get the new connection string without switching yet

`fly mpg attach` normally writes `DATABASE_URL` and restarts the app. Attach under a **different variable name** so nothing changes yet and you hold the string:

```bash
fly mpg attach <new-id> -a pqp-api --database fly-db --variable-name DATABASE_URL_NEW
```

This sets a secret `DATABASE_URL_NEW` on `pqp-api` (which does trigger a machine restart on Fly, because any secret change does; the API keeps running against the old `DATABASE_URL`). Read it back from inside the machine in the next step; do not paste it into a chat, an issue or this file.

### Step 5. Measure from inside the API machine

Latency has to be measured from where the queries come from. `fly ssh console` drops you into the API container:

```bash
fly ssh console -a pqp-api
# inside the machine:
apt-get update -qq && apt-get install -y -qq postgresql-client >/dev/null   # if psql is missing; the image is slim
for i in 1 2 3 4 5; do /usr/bin/time -f '%e s' psql "$DATABASE_URL_NEW" -qtAc 'select 1' ; done
for i in 1 2 3 4 5; do /usr/bin/time -f '%e s' psql "$DATABASE_URL"     -qtAc 'select 1' ; done
```

Healthy is a few milliseconds plus connection setup. On the night, the old cluster measured 80 to 240 ms per `select 1` and the new one was normal. If the new cluster is *not* faster, the problem is not the database and you should stop here.

Also confirm the new string resolves to the new cluster and the right database:

```bash
psql "$DATABASE_URL_NEW" -qtAc 'select current_database(), inet_server_addr();'
```

### Step 6. Switch the API (one restart)

```bash
fly secrets set -a pqp-api DATABASE_URL="<value of DATABASE_URL_NEW>" PG_POOL_MAX=40
```

Get the value from inside the machine (`echo "$DATABASE_URL_NEW"` in the ssh console) and paste it into the command locally; do not `fly secrets set DATABASE_URL_NEW=` in reverse or leave both pointing at different clusters. One `fly secrets set` with both variables is one restart. `PG_POOL_MAX=40` is explained in section 3; the default is 10 and the previous production value was left there because nobody had needed to think about it.

Every `/ws` client is dropped by the restart; web and Electron resume their voice session within the 90 s orphan window (PR #162), iOS and Android rejoin by hand.

### Step 7. Confirm it is quiet

```bash
fly logs -a pqp-api
```

Watch for two to three minutes. Acceptance criterion: **zero** `Connection terminated unexpectedly` and zero `[db] idle client error`. Open the app, send a message, join voice. Check `GET /api/admin/metrics` (with `ADMIN_METRICS_TOKEN`) if the dashboard is up: the `runtime.pool` block should show `max: 40` and a small `total`.

Post in the QG that the incident is over and that anything written between the PITR time and the switch may be missing while you backfill.

### Step 8. Backfill the gap from the old cluster

The old cluster still has the rows written between the PITR point (T0) and the switch (T1). It answers slowly but it answers. Copy them by primary key so re-running is safe.

Priorities, in order: **accounts** (a user who signed up in the gap otherwise hits a missing row on next login), **memberships**, **messages**. Everything else (reactions, reads, presence samples) is either derivable or not worth the risk of a wrong `INSERT`.

Dump the slice from the old cluster with `pg_dump`'s `--table` plus a `COPY` filter, or the simplest thing that works, `psql \copy`:

```bash
# OLD_URL / NEW_URL: the old and new fly-db connection strings. Both are already
# on the API machine (DATABASE_URL_OLD if you attach the old cluster under that
# name, DATABASE_URL for the new one), so the easiest place to run this is
# `fly ssh console -a pqp-api` with psql installed as in step 5.
T0='2026-09-05T22:40:00Z'   # accepted PITR time
T1='2026-09-05T23:05:00Z'   # when DATABASE_URL was switched

psql "$OLD_URL" -c "\copy (select * from users          where created_at > '$T0' and created_at <= '$T1') to 'gap_users.csv' csv header"
psql "$OLD_URL" -c "\copy (select * from servers        where created_at > '$T0' and created_at <= '$T1') to 'gap_servers.csv' csv header"
psql "$OLD_URL" -c "\copy (select * from channels       where created_at > '$T0' and created_at <= '$T1') to 'gap_channels.csv' csv header"
psql "$OLD_URL" -c "\copy (select * from server_members where joined_at  > '$T0' and joined_at  <= '$T1') to 'gap_server_members.csv' csv header"
psql "$OLD_URL" -c "\copy (select * from messages       where created_at > '$T0' and created_at <= '$T1') to 'gap_messages.csv' csv header"
```

Load them into the new cluster through a staging table so conflicts are skipped rather than fatal. Users conflict on `clerk_id` (a user who signed up during the gap and again after the switch has two ids; keep the new one), the others on their primary keys:

```sql
-- in psql "$NEW_URL"
create temp table t_users (like users including defaults);
\copy t_users from 'gap_users.csv' csv header
insert into users select * from t_users
  on conflict (clerk_id) do nothing;

create temp table t_servers (like servers including defaults);
\copy t_servers from 'gap_servers.csv' csv header
insert into servers select * from t_servers on conflict (id) do nothing;

create temp table t_channels (like channels including defaults);
\copy t_channels from 'gap_channels.csv' csv header
insert into channels select * from t_channels on conflict (id) do nothing;

create temp table t_sm (like server_members including defaults);
\copy t_sm from 'gap_server_members.csv' csv header
insert into server_members select * from t_sm
  where exists (select 1 from users u where u.id = t_sm.user_id)
    and exists (select 1 from servers s where s.id = t_sm.server_id)
  on conflict (server_id, user_id) do nothing;

create temp table t_msg (like messages including defaults);
\copy t_msg from 'gap_messages.csv' csv header
insert into messages select * from t_msg
  where exists (select 1 from channels c where c.id = t_msg.channel_id)
    and exists (select 1 from users u where u.id = t_msg.author_id)
  on conflict (id) do nothing;
```

The `where exists` guards drop rows whose parent was itself lost and not backfilled; count them and decide whether they matter. `server_members` for a user whose `clerk_id` collided will reference the old user id and be skipped, which is the correct outcome: that person re-joined after the switch under the new row.

Do the backfill within a day. The old cluster costs money every hour it exists, and the longer it lives the more tempting it is to trust it.

### Step 9. Move staging

`pqp-api-staging` still points at `pqp-staging` on the old cluster. Staging data is disposable (`docs/STAGING.md`), so do not migrate it; create the database on the new cluster and repoint:

```bash
fly mpg databases create --cluster <new-id> --name pqp-staging
fly mpg attach <new-id> -a pqp-api-staging --database pqp-staging
```

The attach writes `DATABASE_URL` and restarts staging; the schema self-applies at boot.

### Step 10. Detach and destroy the old cluster

Only after steps 7, 8 and 9 are done and a night has passed with a green `DB backup` run against the new cluster (update `BACKUP_DATABASE_URL` on `pqp-db-backup` first; the backup role from section 1 does not exist on the new cluster until you recreate it).

```bash
fly secrets unset -a pqp-api DATABASE_URL_NEW DATABASE_URL_OLD   # one more restart; do it in a quiet hour
fly mpg detach <old-id> -a pqp-api
fly mpg detach <old-id> -a pqp-api-staging
fly mpg destroy <old-id>
```

Then update this file's cluster ids, `docs/STAGING.md`, `docs/deploy-fly.md` where they name the cluster, and the memory note about prod DB access.

### What NOT to do

- **Do not resize a managed cluster during a live event, or at any hour someone is likely to be in a voice room.** A plan resize is a Patroni switchover. On 2026-09-05 it returned 503 mid-way and left the primary answering at 80 to 240 ms per query and cutting every connection every 10 to 40 seconds, while `fly mpg status` said `ready` throughout. If a resize is needed, do it at 05:00 São Paulo on a weekday, with this runbook open, right after a green `pqp-db-backup` run (or a one-off `fly machine run ... --rm` dump), and be ready to run steps 1 to 7 immediately.
- **Do not trust `fly mpg status` over `fly logs -a pqp-api`.** The status endpoint reports orchestration state, not query latency or connection stability.
- **Do not wait for PITR to accept "now".** It never does; the floor was ~20 minutes on the night. Every 5 minutes spent retrying is 5 more minutes of live writes on a cluster you are about to abandon. Accept the newest point it takes and move on.
- **Do not `fly mpg attach` with the default variable name while diagnosing.** That rewrites `DATABASE_URL` and restarts the API before you have measured anything. Always `--variable-name DATABASE_URL_NEW` first.
- **Do not backfill by `created_at < deploy time` constants alone without the primary-key `on conflict` guards.** Rows created in the gap and re-created after the switch (the same person signing up twice) must resolve to the newer row, not error out half way through the load.
- **Do not point staging at `fly-db`**, and double-check `--database` on every `fly mpg connect`; without it the CLI connects to `fly-db`, which is production.
- **Do not destroy the old cluster the same night.** Sleep, verify, then destroy.

---

## 3. Connection budget (`PG_POOL_MAX`)

Managed Postgres ships with **`max_connections = 100`**, but that is not the number that matters; memory is. Each Postgres backend costs several MB of RAM and the shared buffers and OS need the rest. The comfortable ceiling for total backends:

| Cluster RAM | Keep total backends under |
|---|---|
| 1 GB | ~30 |
| 2 GB | ~50 |

"Total backends" is everything holding a connection at once:

| Consumer | Connections |
|---|---|
| `pqp-api` pool (`PG_POOL_MAX`, one process, one machine) | up to `PG_POOL_MAX` |
| `pqp-api` `LISTEN` session outside the pool, if enabled | 1 |
| `pqp-api-staging` pool (`PG_POOL_MAX` there, default 10) | up to 10 |
| Fly's own health checks, Patroni, replication slot | a few |
| Humans in `fly mpg connect` or a GUI | 1 each, and they forget to close them |
| The nightly backup, while it runs | 1 |

So on **2 GB**, `PG_POOL_MAX=40` on production plus staging's 10 plus a couple of admin sessions is right at the ~50 line; do not go higher without also lowering staging (`fly secrets set -a pqp-api-staging PG_POOL_MAX=5` is fine, staging never needs more). On **1 GB**, production `PG_POOL_MAX=20` is the sensible ceiling with staging at 5. The server code reads `PG_POOL_MAX` once at boot (`server/src/db.ts`, default 10) and exposes `max / total / idle / waiting` through the operator dashboard's `runtime.pool` block; if `waiting` is regularly non-zero **and** `total == max`, the pool is the bottleneck and you raise it within this budget, not past it.

When a query storm hits and backends approach `max_connections`, Postgres refuses new ones with `FATAL: too many connections` and the API's health check (`SELECT 1` on `/health`) fails, which takes the single machine out of the proxy. The budget above is what keeps that from ever being the failure mode.

If the cluster is ever resized (see "What NOT to do" first), re-derive the numbers from the new RAM before touching `PG_POOL_MAX`.
