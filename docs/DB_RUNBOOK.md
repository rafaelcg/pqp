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

Runs directly on the **API box** (`216.238.126.103`, `api.pqp.gg`) as a root cron job, not as a separate Fly app. The app that used to do this, **`pqp-db-backup`**, was destroyed 2026-09-24: it had been failing silently since the 09-14 DB password rotation, because its secrets were only ever staged on the Fly app and never actually applied, and nobody was watching `fly logs -a pqp-db-backup` for a red run. Moving the job onto the box that already holds `DATABASE_URL` removes that whole class of failure, since there is no second, separate credential to rotate and forget. Everything for it lives in `tools/api-host/`:

| File | Role |
|---|---|
| `tools/api-host/db-backup.sh` | The job. Installed to `/opt/pqp/backup/run.sh` by `provision.sh`, which also installs `rclone` if it is missing |
| `/etc/cron.d/pqp-db-backup` | `23 4 * * * root /opt/pqp/backup/run.sh >>/var/log/pqp-db-backup.log 2>&1` (04:23 UTC, 01:23 Sao Paulo, an off-peak window) |

What `db-backup.sh` does, in order:

1. Reads `DATABASE_URL` and `LIVE_HLS_S3_*` out of `/opt/pqp/.env`, the same values the API containers use, and the same R2 bucket (`pqp-live-enam`) the watch party recording feature already writes to. There is no backup-only secret. It never prints either (no `set -x`, no echo).
2. `pg_dump -Fc --no-owner --no-privileges` against `DATABASE_URL` with `sslmode=require` appended (a `pg_dump`/libpq query parameter, not something the app's own pool reads, see `docs/deploy-vultr.md` "Secrets"), run inside `postgres:17-alpine` with `docker run --network host` so it reaches the managed cluster the same way the API containers do. Custom format carries its own zlib compression, so there is no separate gzip step.
3. **Refuses a dump under 100 KB.** That small is the wrong database, an empty one, or a truncated one. Nothing is kept or uploaded in that case.
4. Keeps the local file in `/var/backups/pqp/`, pruning local copies older than 7 days.
5. Uploads with `rclone` to `pqp-live-enam/backups/pqp-db/pqp-db-YYYYMMDDTHHMMSSZ.dump`, then prunes remote objects older than 30 days with `rclone delete --min-age 30d`.

Any non-zero exit is in `/var/log/pqp-db-backup.log` on the box. Cron runs the job on schedule regardless of how the previous run exited, so one failure does not stop the next night's attempt. There is no paging on a red run; see "Did last night's run succeed?" below for the weekly check.

### `trusted_ips`: the managed cluster only answers this box, by design

Since 2026-09-24 the Vultr managed cluster's `trusted_ips` allowlist (Settings tab on the database instance, also settable through the API below) holds exactly two entries: the API box (`216.238.126.103/32`, the only thing that needs to reach it in normal operation, this backup included) and the founder's home IP (`/32`, for read-only probes with the `pqp_ro` role and ad hoc `psql`). Nothing else can open a connection, which is why the dump runs *on* the box rather than from a GitHub runner or a laptop: neither of those is on the list.

Read the current list (look the database id up with a plain `GET /v2/databases` first if you do not have it to hand):

```bash
curl -s -H "Authorization: Bearer $VULTR_API_KEY" \
  https://api.vultr.com/v2/databases/<database-id> | jq '.database.trusted_ips'
```

Add an IP. The endpoint replaces the whole list on a `PUT`, so fetch it first and include every existing entry, not just the new one:

```bash
existing=$(curl -s -H "Authorization: Bearer $VULTR_API_KEY" \
  https://api.vultr.com/v2/databases/<database-id> | jq -c '.database.trusted_ips')
new=$(echo "$existing" | jq -c '. + ["<new-ip>/32"]')
curl -s -X PUT -H "Authorization: Bearer $VULTR_API_KEY" -H "Content-Type: application/json" \
  -d "{\"trusted_ips\": $new}" \
  https://api.vultr.com/v2/databases/<database-id>
```

Run this from an already allow-listed host, either the founder's own laptop or `ssh pqp@216.238.126.103` and curl from there. The Vultr API itself is not restricted by `trusted_ips`, that field only governs connections to Postgres, but adding an IP from a host you cannot yet reach the cluster from leaves you unable to confirm the change with `psql` right afterward.

Rollback, opening the cluster back up (an incident where a legitimate host got locked out and the fix is not obvious, never as a routine step):

```bash
curl -s -X PUT -H "Authorization: Bearer $VULTR_API_KEY" -H "Content-Type: application/json" \
  -d '{"trusted_ips": []}' \
  https://api.vultr.com/v2/databases/<database-id>
```

An empty list is Vultr's "no restriction" state for this field, confirm that is still true in the dashboard before relying on it mid-incident, and put the real allowlist back the moment the incident is over.

### Installing it (a rebuilt box gets this automatically)

There is nothing to create by hand. `tools/api-host/provision.sh` is idempotent and, on every run (a fresh box or a drift check on an existing one), installs `rclone` if it is missing, copies `tools/api-host/db-backup.sh` to `/opt/pqp/backup/run.sh`, and writes `/etc/cron.d/pqp-db-backup`. See `docs/deploy-vultr.md` step 2. Because the script reads its two secrets straight out of `/opt/pqp/.env`, a box that already has `DATABASE_URL` and `LIVE_HLS_S3_*` filled in needs nothing else before the first backup runs.

A one-off backup before a risky change, run by hand:

```bash
ssh pqp@216.238.126.103 'sudo /opt/pqp/backup/run.sh'
```

### Did last night's run succeed?

```bash
ssh pqp@216.238.126.103 'tail -20 /var/log/pqp-db-backup.log'   # want a line ending "OK", not "ERROR:"
ssh pqp@216.238.126.103 'ls -la /var/backups/pqp | tail -5'     # today's file should be the newest, well over 100 KB
```

The log lines that matter are `upload OK` right before the final `OK`; there is no separate byte-count-verified upload step the way the old script had one (`rclone copyto` fails loudly and exits non-zero on a partial transfer, so "no error" is the signal here).

Check the R2 side from a laptop with the `LIVE_HLS_S3_*` values (same ones on the box's `/opt/pqp/.env`, kept wherever secrets are kept):

```bash
export RCLONE_CONFIG_PQPBACKUP_TYPE=s3
export RCLONE_CONFIG_PQPBACKUP_PROVIDER=Cloudflare
export RCLONE_CONFIG_PQPBACKUP_ACCESS_KEY_ID=...       # LIVE_HLS_S3_ACCESS_KEY_ID
export RCLONE_CONFIG_PQPBACKUP_SECRET_ACCESS_KEY=...   # LIVE_HLS_S3_SECRET_ACCESS_KEY
export RCLONE_CONFIG_PQPBACKUP_ENDPOINT=...            # LIVE_HLS_S3_ENDPOINT
export RCLONE_CONFIG_PQPBACKUP_REGION=auto

rclone lsf pqpbackup:<LIVE_HLS_S3_BUCKET>/backups/pqp-db/ | sort | tail -5
```

Nobody is paged for a failure; look at this weekly, and always before touching the cluster.

### Verify a dump restores

A backup you have never restored is a hope, not a backup. Two checks, a fast one for any time and a real one for quarterly.

**Fast check, any time, no local Postgres needed.** `pg_restore --list` reads a custom-format archive's table of contents without touching a database at all, which is enough to prove the file is not truncated or corrupt. The box has no `pg_restore` binary of its own (same reason `db-backup.sh` runs `pg_dump` inside a container), so use the same image:

```bash
ssh pqp@216.238.126.103 '
  f=$(basename "$(ls -t /var/backups/pqp/*.dump | head -1)")
  docker run --rm -v /var/backups/pqp:/backup:ro postgres:17-alpine \
    pg_restore --list "/backup/$f"
' | head -30
```

A healthy dump lists dozens of `TABLE DATA` entries (`users`, `servers`, `messages`, ...); an empty or short listing, or `pg_restore: error: input file does not appear to be a valid archive`, means the same thing the old byte-floor check was for, do not trust this file.

**How to restore from R2**, onto a laptop, with the same `rclone` remote as above:

```bash
rclone copy pqpbackup:<LIVE_HLS_S3_BUCKET>/backups/pqp-db/pqp-db-<stamp>.dump .
```

(or just `scp` the file straight off `/var/backups/pqp` on the box if it is still within the 7-day local window, which is usually the faster path).

**Full quarterly restore, and after any schema-heavy month.** Local `docker compose` Postgres is `postgres:16-alpine`; a dump made by `pg_dump` 17 restores into 16 as long as `pg_restore` itself is 17 or newer, so use the `postgres:17` image for the client and keep the compose database as the target.

```bash
# 1. Fetch the newest dump, either of the two ways above, into ./latest.dump

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

Only after steps 7, 8 and 9 are done and a night has passed with a green backup run against the new cluster. The backup reads `DATABASE_URL` straight out of `/opt/pqp/.env` on the API box (section 1), so once step 6 has switched that value there is nothing separate to update for the backup to pick up the new cluster; confirm it did with the "Did last night's run succeed?" checks before destroying anything.

```bash
fly secrets unset -a pqp-api DATABASE_URL_NEW DATABASE_URL_OLD   # one more restart; do it in a quiet hour
fly mpg detach <old-id> -a pqp-api
fly mpg detach <old-id> -a pqp-api-staging
fly mpg destroy <old-id>
```

Then update this file's cluster ids, `docs/STAGING.md`, `docs/deploy-fly.md` where they name the cluster, and the memory note about prod DB access.

### What NOT to do

- **Do not resize a managed cluster during a live event, or at any hour someone is likely to be in a voice room.** A plan resize is a Patroni switchover. On 2026-09-05 it returned 503 mid-way and left the primary answering at 80 to 240 ms per query and cutting every connection every 10 to 40 seconds, while `fly mpg status` said `ready` throughout. If a resize is needed, do it at 05:00 São Paulo on a weekday, with this runbook open, right after a green nightly backup (or a one-off `ssh pqp@216.238.126.103 'sudo /opt/pqp/backup/run.sh'`), and be ready to run steps 1 to 7 immediately.
- **Do not trust `fly mpg status` over `fly logs -a pqp-api`.** The status endpoint reports orchestration state, not query latency or connection stability.
- **Do not wait for PITR to accept "now".** It never does; the floor was ~20 minutes on the night. Every 5 minutes spent retrying is 5 more minutes of live writes on a cluster you are about to abandon. Accept the newest point it takes and move on.
- **Do not `fly mpg attach` with the default variable name while diagnosing.** That rewrites `DATABASE_URL` and restarts the API before you have measured anything. Always `--variable-name DATABASE_URL_NEW` first.
- **Do not backfill by `created_at < deploy time` constants alone without the primary-key `on conflict` guards.** Rows created in the gap and re-created after the switch (the same person signing up twice) must resolve to the newer row, not error out half way through the load.
- **Do not point staging at `fly-db`**, and double-check `--database` on every `fly mpg connect`; without it the CLI connects to `fly-db`, which is production.
- **Do not destroy the old cluster the same night.** Sleep, verify, then destroy.

---

## 3. Connection budget (`PG_POOL_MAX`)

Managed Postgres ships with **`max_connections = 100`**, but that is not the number that matters on its own; memory and reservations are. Each Postgres backend costs several MB of RAM and the shared buffers and OS need the rest. Two generations of this table now:

| Cluster | `max_connections` | Keep total backends under |
|---|---|---|
| Fly Managed Postgres, 1 GB (retired) | 100 | ~30 (estimated from RAM, never measured directly) |
| Fly Managed Postgres, 2 GB (retired) | 100 | ~50 (estimated from RAM, never measured directly) |
| **Vultr Managed PostgreSQL, `pqp` cluster (production since 2026-09-13)** | **200 (measured)** | **187 — see below** |

The first two rows describe a retired Fly Managed Postgres cluster and are kept only as a reference for a self-host still on that platform, where they were sized by RAM alone because nobody had read the real `max_connections` off the cluster. **The current row is a measurement, not an estimate**: read 2026-09-14 with the read-only `pqp_ro` role against the live cluster (`SHOW max_connections; SHOW superuser_reserved_connections;`):

```
max_connections = 200
superuser_reserved_connections = 3
```

No other platform-level reservation showed up in `pg_stat_activity` beyond the ordinary consumers in the table below (re-check if Vultr's own monitoring or HA tooling ever shows up there). `200 − 3 (superuser-reserved) = 197` non-superuser connections are available at all; **187** is that figure after also setting aside the fixed, machine-count-independent reservations below (worker 4, backup 1, admin/platform headroom 5 — `197 − 4 − 1 − 5 = 187`), which is the number `fly.toml` and `docs/deploy-fly.md` §6a-bis's formula actually divides by machine count.

"Total backends" is everything holding a connection at once:

| Consumer | Connections |
|---|---|
| `pqp-api` pool (`PG_POOL_MAX`, per machine) | up to `PG_POOL_MAX`, **times the machine count** |
| `pqp-api`'s `CLUSTER_BUS` `LISTEN` session, per machine | 1 per machine, outside the pool |
| `pqp-api`'s outgoing-webhook poller `LISTEN` session, per machine | 1 per machine, outside the pool (a second, separate `LISTEN` connection — easy to undercount if you only remember the bus's) |
| `pqp-worker` pool (`PG_POOL_MAX` there, `fly.worker.toml`) | up to 4, fixed regardless of API machine count |
| `pqp-api-staging` pool | separate cluster (`pqp-db-staging-lite`) as of 2026-09-08 — does not compete with production's budget any more |
| Superuser-reserved (Postgres platform reservation) | 3, already carved out of `max_connections` above, never available to the app |
| Humans in a `psql`/GUI session against the cluster, and anything else transient | budgeted as part of the 5-connection admin/platform reserve above |
| The nightly backup, while it runs | 1, fixed regardless of API machine count |

**The formula:** `PG_POOL_MAX = floor(187 / n) − 2`, where the `− 2` is each machine's own pair of `LISTEN` sessions (bus + outgoing-webhook poller), applied per machine, not once overall. At `n = 2`: `floor(187 / 2) − 2 = 93 − 2 = 91`. This PR ships `PG_POOL_MAX = "70"` per machine at two machines — today's live value, left unchanged rather than raised to 91, since 70 already sits comfortably inside the budget (`2 × (70 + 2) + 4 (worker) + 1 (backup) = 149`, well under 187) and there is no live-traffic evidence yet that more than 70 is needed. At `n = 3`: `floor(187 / 3) − 2 = 62 − 2 = 60` per machine. See `docs/deploy-fly.md` §6a-bis "Scaling to n machines later" for the general runbook. The server code reads `PG_POOL_MAX` once at boot (`server/src/db.ts`, default 10) and exposes `max / total / idle / waiting` through the operator dashboard's `runtime.pool` block; if `waiting` is regularly non-zero **and** `total == max`, the pool is the bottleneck and you raise it within this budget, not past it.

When a query storm hits and backends approach `max_connections`, Postgres refuses new ones with `FATAL: too many connections` and the API's health check (`SELECT 1` on `/health`) fails, which takes the single machine out of the proxy. The budget above is what keeps that from ever being the failure mode.

If the cluster is ever resized (see "What NOT to do" first), re-derive the numbers from the new RAM before touching `PG_POOL_MAX`.

### Statement timeouts (`PG_QUERY_TIMEOUT_MS`, `PG_WORKER_QUERY_TIMEOUT_MS`)

A pool slot is only as reusable as the statement holding it, so every statement issued through the main pool is now bounded: `PG_QUERY_TIMEOUT_MS` (default **15000**) sets Postgres's own `statement_timeout` and puts pg's client-side read timeout one second above it, so a genuinely slow query is cancelled cleanly by the server (`57014`, connection still usable) and the client timer only fires for a reply that never arrives at all; the pool also enables TCP keepalive so the kernel eventually notices a peer that stopped answering. The batch worker reads `PG_WORKER_QUERY_TIMEOUT_MS` (default **120000**) instead, because a first retention sweep against a long backlog is allowed to take far longer than any request may; `0` on either disables the bound and is the rollback switch. This exists because a staging reconnect storm on 2026-09-17 left both API processes at `busy: 22 / waiting: 15 / pressure: "saturated"` with the breaker open for minutes while all 45 API backends sat `idle` in `ClientRead`, the oldest 756 seconds old: Postgres had finished every query and the replies were lost in transit, and nothing in the pool bounded waiting for one.

**A timeout is not enough on its own, and this is the part that bites.** `query_timeout` rejects the promise but does not cancel the statement and does not make the connection unusable in the driver's eyes, so a client borrowed through `getPool().connect()` (every transaction in `server/src/services/`) is handed back by the caller's ordinary `finally { client.release() }` still waiting on a response that is never coming, and the pool gives it to the next request. Any query that ends in pg's read timeout or in a connection-level error therefore marks that client poisoned, and the release destroys it whatever the borrower passed; `db.pool.clientDestroyed` names the reason and belongs at zero. A `57014` does **not** destroy the connection, deliberately: Postgres cancelled it with an ErrorResponse and a ReadyForQuery, so the protocol resynchronised and the connection is genuinely fine.

Boot DDL (`schema.sql` and `CREATE INDEX CONCURRENTLY`) runs on a connection with the bound lifted, destroyed rather than released afterwards, so an instance with real history cannot fail to boot on an index build and no `SET` leaks back into the pool. When the pool is saturated, read `runtime.pool.longestCheckoutMs` and `runtime.pool.checkedOutOver10s` on `GET /api/admin/metrics` before anything else: a high `busy` with a low `longestCheckoutMs` is load, and a high `busy` with a `longestCheckoutMs` in the minutes is this failure again. The `db.pool.stuckClient` log line names the statement, rate limited so a saturated pool produces one line rather than seventy.
