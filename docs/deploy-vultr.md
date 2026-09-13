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

**This step does not start `api`, `worker` or `caddy`.** It lays out
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
comment — that hop is now Caddy on this box, not fly-proxy. Cloudflare in
front of Caddy is invisible to `clientAddress()`, the same way Cloudflare
proxied DNS in front of Fly already was.

**Postgres.** If moving to Vultr Managed PostgreSQL, its connection string
needs `sslmode=require` (Vultr's managed instances only accept TLS
connections):

```
DATABASE_URL=postgres://<user>:<password>@<host>:16751/<db>?sslmode=require
```

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
  docker compose pull api worker && \
  APP_IMAGE_TAG=<same> APP_VERSION=<same> docker compose up -d api worker caddy'
curl -sS https://api.pqp.gg/health   # once DNS points here, or curl the box IP with -H "Host: api.pqp.gg" --insecure first
curl -sS https://api.pqp.gg/ready
```

Fix anything here before touching DNS. `docker compose logs api worker
caddy` on the box is the first thing to read when either check fails.

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
ssh pqp@<ip> 'cd /opt/pqp && docker compose stop api worker'
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
ssh pqp@<ip> 'cd /opt/pqp && docker compose ps && docker compose logs --tail=100 api'
curl -sS https://api.pqp.gg/health | jq
```

**Rotate a secret.** Edit `/opt/pqp/.env` by hand (`ssh` + `sudoedit` or
`scp` a new copy), then `docker compose up -d api worker` to pick it up —
this restarts both, same WebSocket-drop contract as a Fly secret rotation.

**Provisioning drift.** Re-run `provision.sh` (see step 2); it changes
nothing that already matches and never touches the running containers.

**Backups.** `cat /var/log/pqp-db-backup.log` on the box, or check the R2
bucket listing — same verification steps as `docs/DB_RUNBOOK.md` describes
for the Fly-scheduled version, since it is the identical script.

**Reboot.** `unattended-upgrades` may schedule a kernel update; a reboot is
manual (`Automatic-Reboot` is left `false`, same call as the SFU box). In a
quiet window: `ssh pqp@<ip> sudo reboot`. Docker's `restart: unless-stopped`
brings `api`, `worker` and `caddy` back on their own; confirm with `curl
https://api.pqp.gg/health`.
