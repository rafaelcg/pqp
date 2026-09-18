# Vultr deployment (API + WebSocket)

Runbook for moving the pqp API and WebSocket server from **Fly.io** to a
single **Vultr** box in São Paulo. Decision and cost arithmetic:
[`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`](./plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md)
section E, written after the 2026-09-12 watch party.

Only the API + worker move. The SPA stays on Cloudflare Pages; this box
serves `/api/*`, `/health`, `/ready`, `/status.json` and the `/ws` upgrade,
behind Caddy, behind Cloudflare. `fly.toml` and `deploy-api-fly.yml` are
deliberately left in place for **30 days after cutover**. They are the
rollback path — see "Rollback" below.

Files this runbook drives: [`tools/api-host/`](../tools/api-host/)
(`cloud-init.yaml`, `provision.sh`, `compose.yaml`, `Caddyfile`,
`config.alloy`) and
[`.github/workflows/deploy-api-vultr.yml`](../.github/workflows/deploy-api-vultr.yml).
The provisioning pattern (idempotent installer, ufw, Alloy for Grafana Cloud,
Docker from Docker's own apt repo) copies
[`tools/sfu/README.md`](../tools/sfu/README.md) and
[`tools/sfu-monitoring/`](../tools/sfu-monitoring/), which already do this for
the self-hosted LiveKit box — read those first if anything below is unclear
about *why* a step exists rather than *what* it does.

**Order, per the postmortem plan: database first, run one party on it, API
second.** This document only covers the API half. The Postgres half (Vultr
Managed PostgreSQL vs. a self-hosted box) is decided in
`docs/DB_RUNBOOK.md` / the postmortem doc; either way this box's `.env` just
needs a `DATABASE_URL` that resolves, which section "Secrets" below covers.

---

## 0. Prerequisites

- A Vultr account, org access, and the box sized per the postmortem's table:
  **High Performance AMD `vhp-4c-8gb-amd`** (4 vCPU / 8 GB), Ubuntu 24.04,
  region São Paulo.
- `ssh`, `scp` locally.
- `gh` authenticated against `rafaelcg/pqp`, for secrets and workflow steps.
- The existing Fly secrets, readable (`fly secrets list -a pqp-api` shows
  names, not values — pull values from wherever they are actually kept; Fly
  never shows them back).
- Cloudflare dashboard access for the `api` DNS record and, if using Mode A
  in `tools/api-host/Caddyfile`, an Origin CA certificate.

Nothing below bills anything until you create the instance in step 1.

---

## 1. Create the box

Vultr dashboard (or `vultr-cli`): Cloud Compute, **High Performance**, AMD,
`vhp-4c-8gb-amd`, region **São Paulo (bjs? — pick the São Paulo location
code shown at creation, matching the SFU box's region)**, image **Ubuntu
24.04 LTS**, attach your SSH key (this lands on the human account, `pqp` —
see "Two accounts" below), and paste
[`tools/api-host/cloud-init.yaml`](../tools/api-host/cloud-init.yaml) into
**User Data** after replacing `__PQP_DEPLOY_PUBLIC_KEY__` with the *public*
half of a **dedicated deploy key** (generate one just for this:
`ssh-keygen -t ed25519 -f deploy_vultr_api -C pqp-api-deploy`; the private
half becomes the GitHub secret `VULTR_API_SSH_KEY` in step 4, never your own
key) and `__SSH_ALLOWLIST_CIDRS__` with a space-separated list of admin
CIDRs (e.g. your home IP `/32` and any office egress range). Do not open 22
to the world — this box holds `DATABASE_URL` and `CLERK_SECRET_KEY`, unlike
the disposable SFU box, which is why `tools/sfu`'s "22 open to everyone, key
auth only" call does not carry over here.

**Two accounts, two threat models.** `pqp` is for a human, with a human's
own key (docker group, broad-ish scoped sudo, for troubleshooting — see
"Check what is running" below). `pqp-deploy` is what
`VULTR_API_SSH_KEY` actually authenticates to, and it is deliberately
powerless: no docker group, no broad sudo, only a sudoers rule for one
fixed, root-owned script (`/usr/local/bin/pqp-deploy <image-tag>`,
[`tools/api-host/pqp-deploy.sh`](../tools/api-host/pqp-deploy.sh)) that
pulls fixed images and reloads Caddy from fixed files under `/opt/pqp`. A
fully leaked `VULTR_API_SSH_KEY` cannot start an arbitrary container,
mount `/`, or read `/opt/pqp/.env` — the Docker socket a docker-group
account has is root-equivalent, which is exactly what a CI secret must
never be handed.

One more secret closes the loop on that: `pqp-deploy` can still stage
*any* `compose.yaml`/`Caddyfile` it wants in its own home directory (that
is exactly what an attacker holding `VULTR_API_SSH_KEY` could do), but the
root script only installs a staged file when it comes with a checksum
manifest signed using `VULTR_CONFIG_HMAC_KEY` — a second secret that
never touches the SSH connection or the `pqp-deploy` account, only the
GitHub Actions runner (which signs) and `/etc/pqp/deploy-hmac.key` on the
box (which verifies). A key leak on its own can no longer make the root
script apply arbitrary Compose configuration.

**80/443 are not open to the world.** `api.pqp.gg` is proxied (orange
cloud) behind Cloudflare — see "Cutover" below — so cloud-init and
`provision.sh` both restrict 80/443 to Cloudflare's own published IP
ranges (fetched live at boot, refreshed on every `provision.sh` re-run) and
leave everyone else's traffic dropped by `ufw`. If you point DNS straight
at this box instead (no Cloudflare in front), those ranges will refuse
your own real traffic too — open the ports yourself in that case
(`ufw allow 80/tcp`, `ufw allow 443/tcp`) and use Caddyfile Mode B.

Wait for the instance, then confirm cloud-init finished:

```bash
ssh pqp@<new-ip> 'cloud-init status --wait'
```

## 2. Provision

```bash
ssh pqp@<new-ip> 'mkdir -p /tmp/pqp-provision'
scp -r tools/api-host tools/db-backup pqp@<new-ip>:/tmp/pqp-provision/
ssh pqp@<new-ip> 'sudo mv /tmp/pqp-provision/db-backup /tmp/pqp-provision/api-host/db-backup && \
  sudo SSH_ALLOWLIST_CIDRS="<your CIDRs>" \
    PQP_DEPLOY_PUBLIC_KEY="$(cat deploy_vultr_api.pub)" \
    VULTR_CONFIG_HMAC_KEY=<same value as the GitHub secret, see step 4> \
    GHCR_USER=<gh username> GHCR_TOKEN=<PAT scoped to read:packages only> \
    GC_PROM_USER=<grafana cloud prom user> GC_PROM_TOKEN=<metrics:write token> \
    LOKI_URL=<grafanacloud loki push url> LOKI_USERNAME=<loki user> LOKI_PASSWORD=<logs:write token> \
    bash /tmp/pqp-provision/api-host/provision.sh'
```

`scp` needs `/tmp/pqp-provision` to already exist before it will accept two
source directories in one call — hence the `mkdir -p` first; skipping it
fails the copy before either directory lands.

`PQP_DEPLOY_PUBLIC_KEY` here is the same public key you already pasted into
`cloud-init.yaml`'s `__PQP_DEPLOY_PUBLIC_KEY__` placeholder in step 1 (now
provisioned onto `pqp-deploy`, not `pqp` — see "Two accounts" above);
passing it again to `provision.sh` is what re-provisioning (or a box that
skipped cloud-init) uses to catch it up. `GHCR_USER`/`GHCR_TOKEN` are only
needed if `ghcr.io/rafaelcg/pqp-api` stays **private** — see "GHCR pull on
the host" below; omit both and make the package public instead if you'd
rather not manage a token on the box.

The Grafana Cloud values are the same stack `tools/sfu-monitoring` and
`tools/log-shipper` already push to — see `docs/MONITORING.md` and
`~/.config/pqp/grafana.env` (or wherever those tokens are actually kept) for
their current values rather than minting new ones. `provision.sh` is
idempotent; re-run it (without the secrets, which persist once set) any time
to check for drift, the same way `tools/sfu/install.sh` works.

**This step does not start `api-a`/`api-b`, `worker` or `caddy`.** It lays out
`/opt/pqp/{compose.yaml,Caddyfile,.env,backup.env}`, installs Docker, ufw,
unattended-upgrades, Alloy, and the nightly backup cron. `.env` and
`backup.env` are written as empty templates the first time only — fill them
in next.

## 3. Secrets

`/opt/pqp/.env` on the box (0600, `pqp:pqp`, never in git) needs the same
values as `fly secrets list -a pqp-api`. Names only, from CLAUDE.md's env
table — copy the actual values from wherever they are kept, not from Fly,
which never shows secret values back:

```
DATABASE_URL              CLERK_SECRET_KEY          CORS_ALLOWED_ORIGINS
CLERK_AUTHORIZED_PARTIES  TRUST_PROXY               PG_POOL_MAX
TURN_URL / TURN_USERNAME / TURN_CREDENTIAL   (or CLOUDFLARE_TURN_* / METERED_*)
LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
S3_ENDPOINT / S3_BUCKET / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_FORCE_PATH_STYLE / S3_PUBLIC_BASE_URL
MAX_ATTACHMENT_BYTES / ATTACHMENT_URL_TTL_SECONDS
PUBLIC_APP_URL / STEAM_WEB_API_KEY / BATTLENET_CLIENT_ID / BATTLENET_CLIENT_SECRET / TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET
CLUSTER_BUS / VOICE_REGISTRY    (both "postgres", matching fly.toml — this
                                  box is one machine, same as pqp-api today,
                                  but the app boots with the same production
                                  config either way)
ADMIN_METRICS_TOKEN
COMMUNITIES_ENABLED / COMMUNITY_HOME_ENABLED / COMMUNITY_HOME_VIP_ENABLED
WS_COMPRESSION
```

`TRUST_PROXY=true` still means exactly one hop, same as `fly.toml`'s
comment — that hop is now Caddy on this box, not fly-proxy. That hop is only
trustworthy if Caddy itself is configured to trust it: Caddy's
`reverse_proxy`, per its own docs, does not use the `X-Forwarded-For` it
receives from Cloudflare's edge unless the immediate connection is in its
`trusted_proxies` list — without one, it discards whatever Cloudflare sent
and writes its own, carrying only the immediate connection's address, which
behind Cloudflare is a Cloudflare edge IP, the *same* address for every
viewer who lands on that edge. `clientAddress()` (`server/src/lib/rate-limit.ts`)
reads exactly that one hop, so every such viewer would share one anonymous
bucket and one socket bucket — a watch party where 300 people arrive at once
gets closed with 4429 rather than rate-limited per person.
`tools/api-host/Caddyfile`'s `(upstreams)` snippet sets `trusted_proxies` to
Cloudflare's published ranges plus a `header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}`
belt-and-braces line, so the one hop `TRUST_PROXY=true` reads is the real
per-viewer address Cloudflare itself vouches for, not Cloudflare's own edge.

**Verify it from two networks**, since this is exactly the kind of bug that
passes every single-machine test: from two different networks (a laptop off
wifi plus a phone on cellular, or two cloud boxes in different regions),
send bursts of requests at the same anonymous endpoint at the same time and
confirm one network exhausting its 240-per-60s budget does not touch the
other's — for example two `curl` loops run in parallel, each hammering
`GET /api/ice-servers` (or any other unauthenticated-but-rate-limited route)
and each expecting its *own* 429 after roughly 240 requests, not before. The
other check needs a live party rather than a synthetic burst: watch
`ws.close code=4429` on the operator dashboard while a room fills up — it
should stay near zero as people join from many networks through the same
Cloudflare edge, not climb with the room size.

**Postgres.** If moving to Vultr Managed PostgreSQL, its instances only
accept TLS connections, but that TLS requirement belongs on `DATABASE_SSL`,
not on the connection string. Do **not** put `?sslmode=require` on
`DATABASE_URL` for the API/worker containers — this codebase's own pool
(`pgSslConfig` in `server/src/db.ts`) turns TLS on from `DATABASE_SSL=true`
(or `PGSSLMODE=require`) and always connects with `rejectUnauthorized:
false`, which is what lets it accept a managed host's certificate at all;
`sslmode=require` is a libpq-family query parameter for `psql` / `pg_dump`
(and any other tool that reads connection strings the libpq way), not
something this pool interprets itself, and it can quietly appear to take
effect via `pg`'s own connection-string parsing while disagreeing with the
config `pgSslConfig` sets:

```
DATABASE_URL=postgres://<user>:<password>@<host>:16751/<db>
DATABASE_SSL=true
```

Reach for `sslmode=require` only when connecting by hand with `psql` or
`pg_dump` (as `docs/DB_RUNBOOK.md` already does), never in the `.env` this
box's containers read.

Vultr Managed PostgreSQL's port is not 5432 by default — read it off the
instance's **Connection Details** tab, don't assume it.

`/opt/pqp/backup.env` needs `BACKUP_DATABASE_URL` (a read-only role against
whichever Postgres this box now backs up), `R2_BACKUP_BUCKET`,
`R2_ACCOUNT_ID` (or `R2_BACKUP_ENDPOINT`), `R2_BACKUP_ACCESS_KEY_ID`,
`R2_BACKUP_SECRET_ACCESS_KEY` — same names, same bucket, `tools/db-backup`
run as a nightly cron job instead of a scheduled Fly machine (`docs/DB_RUNBOOK.md`).

**TLS.** Pick Mode A or B in `tools/api-host/Caddyfile` (the file's header
comment explains both). Mode A needs `/opt/pqp/certs/origin.{pem,key}`
copied onto the box by hand (`scp`, 0600, never in git):

```bash
scp -o StrictHostKeyChecking=accept-new origin.pem origin.key pqp@<ip>:/opt/pqp/certs/
ssh pqp@<ip> 'sudo chown pqp:pqp /opt/pqp/certs/* && chmod 600 /opt/pqp/certs/*'
```

## 4. GitHub Actions secrets and variables

```bash
gh secret set VULTR_API_HOST --body '<box public IP or hostname>'
gh secret set VULTR_API_SSH_KEY < deploy_vultr_api   # the PRIVATE half from step 1
gh secret set VULTR_CONFIG_HMAC_KEY --body "$(openssl rand -hex 32)"
```

Keep the exact value `VULTR_CONFIG_HMAC_KEY` prints out — step 2's
`provision.sh` call needs the same string in `/etc/pqp/deploy-hmac.key` on
the box (see "Two accounts" above for what it protects). GitHub never
shows a secret's value back, so save it somewhere (a password manager, not
git) before moving on, the same as the deploy key's private half.

`GITHUB_TOKEN` already has what it needs to push to
`ghcr.io/rafaelcg/pqp-api` (the workflow requests `packages: write`); no
extra PAT.

**GHCR pull on the host.** The runner pushing an image is a separate
question from the *box* being allowed to pull it back down — GHCR packages
default to private, and a private package needs its own credential on the
box or every `docker compose pull` there fails with "unauthorized",
starting with the very first deploy. Pick one:

- **Make the package public** (Settings → Packages →
  `ghcr.io/rafaelcg/pqp-api` → Package settings → Change visibility). The
  image has no secrets baked in (env vars are injected at container start,
  never at build time), so this is usually the simpler choice.
- **Or** give the box a **read-only** credential: a GitHub PAT scoped to
  `read:packages` only, passed to `provision.sh` as `GHCR_TOKEN` (with
  `GHCR_USER` set to the account that minted it) the same way the Grafana
  Cloud tokens are — it lands at `/etc/pqp/ghcr.env` (0600, root-only), and
  `pqp-deploy` (the script) logs in with it before every pull. Leave both
  unset and the login is skipped, which only works if the package is
  public.

Leave `vars.DEPLOY_TARGET` at `fly` for now — merging
`deploy-api-vultr.yml` changes nothing until you flip it (see the
workflow's own header comment). You can still exercise the whole pipeline
early with `gh workflow run "Deploy API (Vultr)"` — the `workflow_dispatch`
branch of the `if:` still requires `vars.DEPLOY_TARGET == 'vultr'`, so a true
dry run before cutover is a manual SSH deploy (`docker compose pull && up -d
api worker` by hand) rather than the workflow.

## 5. First deploy (manual, before CI is trusted with it)

```bash
ssh pqp@<ip> 'cd /opt/pqp && \
  APP_IMAGE_TAG=<a tag you pushed by hand, or build+push once locally> \
  APP_VERSION=<same> \
  COMPOSE_PROFILES=replicas docker compose pull api-a api-b worker && \
  APP_IMAGE_TAG=<same> APP_VERSION=<same> COMPOSE_PROFILES=replicas docker compose up -d api-a api-b worker caddy'
curl -sS https://api.pqp.gg/health   # once DNS points here, or curl the box IP with -H "Host: api.pqp.gg" --insecure first
curl -sS https://api.pqp.gg/ready
```

`COMPOSE_PROFILES=replicas` is what turns `api-b` on — see "Two replicas on
one box" below. Drop it (and `api-b` from the service lists) for a
single-container first deploy instead. Fix anything here before touching
DNS. `docker compose logs api-a api-b worker caddy` on the box is the first
thing to read when either check fails.

**Run these checks from the box, not from your laptop.** `provision.sh` and
`cloud-init.yaml` leave ufw denying 80/443 to everyone except Cloudflare's
own published ranges (`api.pqp.gg` is proxied, orange-cloud), so a `curl`
straight at the box's public IP or hostname from wherever you're sitting has
its TCP connection dropped before TLS even starts — the same failure that
hit the CI deploy workflow's own verification step. Do the pre-cutover
health/ready checks the same way that workflow does now, over SSH:

```bash
ssh pqp@<ip> 'curl -sk --connect-to api.pqp.gg:443:127.0.0.1:443 https://api.pqp.gg/ready'
ssh pqp@<ip> 'curl -sk --connect-to api.pqp.gg:443:127.0.0.1:443 https://api.pqp.gg/health'
```

`--connect-to` still forces the real TLS handshake for `api.pqp.gg` (SNI,
cert, `Host` header) while dialing loopback instead of the public address,
so this proves Caddy itself is serving the site rather than just that
something answers on port 3001. `-k` is required with Caddyfile Mode A (the
default): the box terminates TLS with a Cloudflare Origin CA certificate,
which nothing but Cloudflare's own client trusts, so curl on the box would
otherwise refuse its own reverse proxy's certificate.

## 6. Cutover

1. **DNS first, at low TTL.** In Cloudflare, set the `api.pqp.gg` A/AAAA
   record's TTL to 60 seconds *before* changing anything else — DNS changes
   propagate on whatever TTL was in effect when a resolver cached the
   record, not the new one.
2. Point `api.pqp.gg` at the box's IP, **proxied (orange cloud)**, same as
   today. Confirm SSL/TLS mode is **Full (strict)** in Cloudflare
   (`tools/api-host/Caddyfile`'s header explains why "Flexible" is wrong
   here).
3. Watch clients reconnect (`docs/MONITORING.md` dashboards, or just
   `GET /api/admin/metrics`). Fly is still running the old commit at this
   point; new connections land on Vultr, and Fly is not yet told to stop.
4. Flip CI over:
   ```bash
   gh variable set DEPLOY_TARGET --body vultr
   gh workflow disable "Deploy API (Fly)"
   ```
5. Trigger and watch the first CI-driven deploy:
   ```bash
   gh workflow run "Deploy API (Vultr)"
   gh run watch
   ```
6. **Scale Fly to zero, but keep it** for the 30-day rollback window (the
   postmortem plan's own arithmetic: ~$60-80 of double-running the API for a
   month, bought as insurance):
   ```bash
   fly scale count 0 --region gru --app pqp-api
   ```
   Leaving `min_machines_running` in `fly.toml` untouched is fine — the
   workflow that would re-assert it is now disabled, and `fly scale count 0`
   is the manual override in effect until rollback or the 30 days pass.
7. Update the deploy table pointer in `CLAUDE.md` and `docs/DEPLOY.md` (both
   already point here as of this PR) and `docs/HANDOVER.md` if it names Fly
   as current.
8. **Logs.** `tools/log-shipper` reads Fly's org-level NATS log stream and
   has nothing to ship once `pqp-api` is scaled to zero on Fly. Once
   cutover is confirmed stable, `fly apps destroy pqp-log-shipper` (or scale
   it to zero) and update any saved Grafana Explore queries / alert rules
   from `{fly_app_name="pqp-api"}` to `{container="api"}` /
   `{container="worker"}` (`tools/api-host/config.alloy`'s label scheme) —
   see `docs/MONITORING.md`.

## 7. Rollback

Same "decide the point of no easy return up front" rule as
`docs/deploy-fly.md` §8: before the first message is written against
whichever Postgres this box points at, rollback is a DNS record. After that
it is a database migration.

```bash
# 1. Point api.pqp.gg back at Fly (60s TTL from the cutover means this lands fast).
# 2. Bring Fly back up:
fly scale count 1 --region gru --app pqp-api
# 3. Restore CI:
gh workflow enable "Deploy API (Fly)"
gh variable set DEPLOY_TARGET --body fly
# 4. Stop the box from taking further writes, once traffic has drained:
ssh pqp@<ip> 'cd /opt/pqp && docker compose stop api-a api-b worker'
# (harmless if api-b was never running — API_REPLICAS=1 — compose just
# reports it has no container for that service)
```

If the two Postgres instances have diverged (writes landed on the Vultr
database that Fly's never saw), rollback also means reconciling or accepting
data loss — the same warning `docs/deploy-fly.md` gives about Railway.
Decide the cutover window with that in mind, same as the Fly migration was.

## 8. Routine operations

**Deploy.** Merge to `main`; `deploy-api-vultr.yml` does the rest once
`DEPLOY_TARGET=vultr`. Manual: `gh workflow run "Deploy API (Vultr)"`.

**Check what is running.**
```bash
ssh pqp@<ip> 'cd /opt/pqp && COMPOSE_PROFILES=replicas docker compose ps && docker compose logs --tail=100 api-a'
curl -sS https://api.pqp.gg/health | jq
```
`COMPOSE_PROFILES=replicas` on the `ps` is only needed to see `api-b` in the
listing when it's running (§9) — a bare `docker compose ps` still shows
`api-a`, `worker` and `caddy` either way, since only `api-b` carries the
profile.

**Rotate a secret.** Edit `/opt/pqp/.env` by hand (`ssh` + `sudoedit` or
`scp` a new copy), then re-run a deploy (`gh workflow run "Deploy API
(Vultr)"`, or `sudo /usr/local/bin/pqp-deploy $(cat /opt/pqp/.deployed-tag)`
on the box) to pick it up — `pqp-deploy.sh` always brings up whichever
replicas `API_REPLICAS` currently calls for, so this is the same motion as
a normal deploy, just against the tag already running. This restarts every
api replica and the worker, same WebSocket-drop contract as a Fly secret
rotation, but rolling — see §9.

**Provisioning drift.** Re-run `provision.sh` (see step 2); it changes
nothing that already matches and never touches the running containers.

**Backups.** `cat /var/log/pqp-db-backup.log` on the box, or check the R2
bucket listing — same verification steps as `docs/DB_RUNBOOK.md` describes
for the Fly-scheduled version, since it is the identical script.

**Reboot.** `unattended-upgrades` may schedule a kernel update; a reboot is
manual (`Automatic-Reboot` is left `false`, same call as the SFU box). In a
quiet window: `ssh pqp@<ip> sudo reboot`. Docker's `restart: unless-stopped`
brings `api-a`, `api-b` (if `API_REPLICAS` calls for it), `worker` and
`caddy` back on their own; confirm with `curl https://api.pqp.gg/health`.

## 9. Two replicas on one box

`docs/plans/ALWAYS_ON.md` A0.2. `compose.yaml` runs the API half twice —
`api-a` and `api-b`, same image, same `.env`, same `WORKER_MODE=api` — and
Caddy load-balances `/api/*` and `/ws` across both (`tools/api-host/
Caddyfile`'s `(upstreams)` snippet: `round_robin`, active health checking
on `/health` every 5s). `pqp-deploy.sh` updates them one at a time: pull,
bring up `api-a`, wait for its Docker healthcheck AND confirm its `/health`
reports the tag just deployed, only then touch `api-b`, then `worker`. Cost:
**$0** — same box, same plan, two processes instead of one.

This works because the multi-instance server groundwork is already live in
production: `CLUSTER_BUS=postgres` (chat fan-out over Postgres LISTEN/
NOTIFY) and `VOICE_REGISTRY=postgres` (the shared voice peer map and
transport pins) are both set in this box's `.env` today, M1-M5 of
`docs/plans/MULTI_INSTANCE_VOICE.md`. Two processes serving the same
channel is only safe with those two flags on — without them, two replicas
would just split the userbase, and two people in one channel on different
replicas would silently stop seeing each other's messages and presence.
Each process picks its own random instance id at boot
(`server/src/lib/bus.ts`'s `INSTANCE_ID`, regenerated every boot on
purpose, not configurable) — `api-a` and `api-b` are already distinct rows
in the voice registry with no extra wiring in this file.

**What this protects against.** A redeploy no longer takes every WebSocket
down at once — only the replica being updated drains, the other keeps
serving, and it's the drain contract CLAUDE.md pitfall #11 already
describes: `/health` goes unhealthy on that container first (Caddy's active
health check pulls it out of rotation within ~5s), then its sockets close
in batches, and the reconnects land on the sibling via Caddy the same way a
second Fly machine used to catch them. A single container crash (OOM, an
unhandled exception that takes the process down, `docker restart` by hand)
fails over the same way, automatically, with no deploy involved.

**What it does not protect against.** This is still ONE box. Losing the
host — power, disk, Vultr maintenance, a `docker compose down` typo — is
still full downtime for both replicas at once, same as before this PR.
That is what `docs/plans/ALWAYS_ON.md` A0.3 (a second box + a Vultr Load
Balancer) is for, and it explicitly depends on A0.2 (this) soaking cleanly
first.

**Flipping `API_REPLICAS`.** Default (unset, or anything other than
exactly `1`) runs both replicas — that is the normal, shipped state.
`API_REPLICAS=1` is the one-line rollback to a single container, kept
around until `docs/plans/ALWAYS_ON.md` A0.1/M6 (a staging rehearsal of the
multi-instance registry under real traffic shape) has reported back:

```bash
ssh pqp@<ip> 'sudoedit /opt/pqp/.env'
# add or change: API_REPLICAS=1
ssh pqp@<ip> 'sudo /usr/local/bin/pqp-deploy $(cat /opt/pqp/.deployed-tag)'
```

`pqp-deploy.sh` reads `API_REPLICAS` out of `.env` on every invocation, so
re-running a deploy (the same tag, or a new one) is what applies a change —
there is no separate switch to flip in CI or in `compose.yaml` itself.
Setting it back to unset (or any value other than `1`) and re-deploying
restores both replicas. `compose.yaml` gates `api-b` behind the `replicas`
Compose profile, which the script activates via `COMPOSE_PROFILES` based on
this same variable, so a fresh box that has never run two replicas never
creates `api-b` at all. A box that WAS running two replicas and is being
switched down to one is different: Compose does not remove a container
just because its profile went inactive, so `pqp-deploy.sh` explicitly
`stop`s and `rm`s an existing `api-b` (once `api-a` is confirmed healthy on
the new tag) as part of applying `API_REPLICAS=1` — without that step a
stale `api-b` would keep running, keep taking a share of Caddy's
round-robin, and keep drifting further from whatever tag `api-a` is on.
Either way, once the transition is applied, a bare `docker compose ps` on
the box correctly shows only `api-a`.

**Database connection budget.** `api-a` and `api-b` each keep their own
independent Postgres pool — nothing here shares one pool between them — so
`pqp-deploy.sh` treats `.env`'s `PG_POOL_MAX` as the TOTAL budget for the
API side and divides it evenly across however many replicas are actually
running (`API_PG_POOL_MAX_PER_REPLICA`, re-derived on every deploy and
passed to `compose.yaml` as each api container's own `PG_POOL_MAX`
override). Production's `PG_POOL_MAX=70` (`docs/plans/
WATCH_PARTY_POSTMORTEM_2026-09-12.md` §E) means two replicas get 35 each —
the SAME total the single `api` container used to hold alone, not double
it, and `API_REPLICAS=1` restores the full 70 to `api-a` on its own. This
is on top of `worker`'s own, already-separate `WORKER_PG_POOL_MAX` (default
4), which this split does not touch. Before changing `.env`'s `PG_POOL_MAX`
itself, check what the box's actual Vultr Managed PostgreSQL plan reports
for `max_connections` in the Vultr dashboard — same "could not fetch this
live" gap `docs/plans/ALWAYS_ON.md`'s A3.5 already flags for Vultr pricing,
so this doc does not repeat a number here that might not match the plan —
and re-derive the total the way `docs/DB_RUNBOOK.md` §3 walks through for
Fly's memory-based ceiling (that section predates the Vultr move and still
describes Fly's tiers, but the reasoning — leave headroom for shared
buffers and the OS, not just backend count — carries over). `PG_POOL_MAX`
in `.env` staying a single number an operator sizes once, rather than a
separate one per replica to keep in sync, is deliberate; `docs/plans/
ALWAYS_ON.md`'s A3.2 (PgBouncer) is the follow-up that raises the ceiling
itself rather than just dividing today's number more ways.

**Migrating an existing box — ONE MANUAL STEP REQUIRED FIRST, before the
first CI-driven deploy of this PR.** `/usr/local/bin/pqp-deploy` on the box
today is whatever `provision.sh` last installed there — the deploy
workflow only ever transfers `compose.yaml`/`Caddyfile` automatically, so
the script itself does not update on its own... except this PR changes
that (see "Keeping `pqp-deploy.sh` itself in sync" below), and that new
self-update logic only exists in the NEW script. An old, pre-this-PR
script has no code path that even looks for a staged `pqp-deploy.sh`, so
it cannot bootstrap itself — the first deploy has to be pushed by hand.
Skip this and the automated pipeline does not degrade gracefully: the old
script's fixed `docker compose pull api worker` line runs against the
NEWLY installed compose.yaml (which the old script *does* know how to
install, since that part hasn't changed) — but that file no longer defines
an `api` service at all, so the pull fails outright, the workflow's
rollback re-invokes the SAME old script against the SAME already-replaced
compose.yaml, and rollback fails the same way. Do this instead:

```bash
# From a checkout of this PR's branch (or main, once merged):
ssh pqp@<ip> 'mkdir -p /tmp/pqp-provision'
scp -r tools/api-host tools/db-backup pqp@<ip>:/tmp/pqp-provision/
ssh pqp@<ip> 'sudo mv /tmp/pqp-provision/db-backup /tmp/pqp-provision/api-host/db-backup && \
  sudo bash /tmp/pqp-provision/api-host/provision.sh'
```
No new secrets needed for this re-run (`provision.sh` is idempotent and
keeps whatever it already has — see step 2 above); this only needs to
install the updated `/usr/local/bin/pqp-deploy`. Confirm it landed:
```bash
ssh pqp@<ip> 'sha256sum /usr/local/bin/pqp-deploy'
sha256sum tools/api-host/pqp-deploy.sh   # should match
```
Only after that does the normal CI-driven deploy pick up this PR safely.
From that point on, this is a one-time cost: every deploy after it keeps
`/usr/local/bin/pqp-deploy` current on its own (see below), so the next
change to this file never needs this dance repeated.

**What actually happens once the box's script is current.** A box already
running the old single-`api` service still has an `api` container when
this compose file lands — `api-a`/`api-b` are new service names, not a
rename Compose can follow on its own. `pqp-deploy.sh` passes
`--remove-orphans` on its first `up`, which stops (honouring that old
container's own 60s `stop_grace_period`, set when it was created under the
previous compose file) and removes it once `api-a` is confirmed healthy —
without that flag the old `api` container would keep running forever under
`restart: unless-stopped`, invisible to Caddy (which only ever pointed at
`api`, never `api-a`) and to every check in this script, still holding a
database connection and a cluster-bus identity. Expect this one migration
deploy to cause a one-time full drain of whatever was still connected to
the old container — same shape as any other `restarts-api` deploy, just
folded into adopting the two-replica layout instead of a second, separate
step.

**Keeping `pqp-deploy.sh` itself in sync.** Past that first manual step,
the deploy workflow signs and transfers `pqp-deploy.sh` alongside
`compose.yaml`/`Caddyfile` — same HMAC manifest, same verify-before-install
gate — and `pqp-deploy.sh` installs a newer copy of itself into
`/usr/local/bin/pqp-deploy` mid-run when one is staged. That is safe while
the CURRENTLY EXECUTING copy keeps running: `install` writes the new
content to a fresh inode and renames it into place atomically, so the
already-open script the shell is mid-way through reading is unaffected —
only the NEXT invocation picks up whatever was just installed. Provisioning
drift (routine ops, below) still works the same way for everything else
`provision.sh` owns; this is specifically about the one file that used to
require it.

**Verifying it.**
```bash
# Both replicas answer directly, on their own loopback-only port
# (compose.yaml's 127.0.0.1:3011 / :3012 — not reachable off the box):
ssh pqp@<ip> 'curl -sS http://127.0.0.1:3011/health | jq'
ssh pqp@<ip> 'curl -sS http://127.0.0.1:3012/health | jq'   # empty/refused is expected under API_REPLICAS=1

# The public path, round-robined by Caddy — run it a few times and both
# hits should report the same deployed version:
for i in 1 2 3 4; do curl -sS https://api.pqp.gg/health | jq -r .version; done

# What Caddy itself thinks of each upstream's health (look for api-a/api-b
# in the log lines; a single dial failure right after a redeploy is
# expected and self-heals within one health_interval):
ssh pqp@<ip> 'cd /opt/pqp && docker compose logs --tail=50 caddy'
```
The deploy workflow (`.github/workflows/deploy-api-vultr.yml`) runs the
first two of these itself as part of "Verify the deployed commit" — direct
per-container checks, because the SSH identity it uses (`pqp-deploy`) has
no Docker socket access and can't `exec` into a container the way
`pqp-deploy.sh` does as root — plus the round-robined check through Caddy,
before calling a deploy done.

**Expected noise under `API_REPLICAS=1`.** Caddy still lists `api-b:3001`
as an upstream (the Caddyfile does not change per replica count); with the
container never started, its hostname does not resolve on the compose
network, so Caddy's active health checker logs a dial failure for it every
`health_interval`. That is this mechanism working as designed — Caddy
routes everything to `api-a`, the only thing actually running — not a
misconfiguration to chase.
