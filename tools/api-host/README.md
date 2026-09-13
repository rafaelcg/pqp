# The API box, in git

Everything that makes a single Vultr box `api.pqp.gg` (API + worker + Caddy),
the same idea as [`tools/sfu/README.md`](../sfu/README.md) for the
self-hosted LiveKit box, adapted for a box that holds real secrets
(`DATABASE_URL`, `CLERK_SECRET_KEY`) rather than none.

Full runbook, including provisioning, secrets, cutover and rollback:
[`docs/deploy-vultr.md`](../../docs/deploy-vultr.md). Decision and cost
arithmetic: [`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`](../../docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md) §E.

| File | Role | On the box |
|---|---|---|
| `cloud-init.yaml` | First-boot only: Docker, the `pqp` user, base ufw rules, unattended-upgrades. Paste into Vultr's "User Data" at instance creation. | consumed once by cloud-init |
| `provision.sh` | Idempotent installer. Safe to re-run to check for drift. Lays out `/opt/pqp`, installs Alloy, wires the nightly `tools/db-backup` cron. Never starts/restarts `api`/`worker`/`caddy` — that is the deploy workflow's job. | run from a scp'd copy |
| `compose.yaml` | `api`, `worker` (same image as `pqp-api`/`pqp-worker` on Fly, `WORKER_MODE` set per service, same `stop_grace_period` contract as `fly.toml`'s `kill_timeout`), `caddy` | `/opt/pqp/compose.yaml` |
| `Caddyfile` | TLS for `api.pqp.gg` (two modes documented in its header: Cloudflare Origin CA, or Caddy automatic HTTPS), reverse proxy to `api:3001`, WebSocket pass-through | `/opt/pqp/Caddyfile` |
| `config.alloy` | Box metrics + `api`/`worker` container logs, both to the same Grafana Cloud stack `tools/sfu-monitoring` and `tools/log-shipper` already use | `/etc/alloy/config.alloy` |

Not here, and never in git: `.env`, `backup.env`, `certs/origin.{pem,key}`,
`/etc/alloy/credentials.env`. `provision.sh` writes empty templates for the
first two and refuses to overwrite anything that already exists.

## Deploy

`.github/workflows/deploy-api-vultr.yml` builds the root `Dockerfile` (the
same image `deploy-api-fly.yml` builds for Fly), pushes it to
`ghcr.io/rafaelcg/pqp-api:<sha>`, and over SSH runs
`docker compose pull && up -d api worker`. Gated on `vars.DEPLOY_TARGET ==
'vultr'`, so merging this directory or the workflow changes nothing on its
own — see `docs/deploy-vultr.md` for the cutover sequence.
