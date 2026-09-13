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
| `provision.sh` | Idempotent installer. Safe to re-run to check for drift. Lays out `/opt/pqp`, installs Alloy, wires the nightly `tools/db-backup` cron. Never starts/restarts `api-a`/`api-b`/`worker`/`caddy` — that is the deploy workflow's job. | run from a scp'd copy |
| `compose.yaml` | `api-a` + `api-b` (two copies of the API half, same image as `pqp-api` on Fly, `WORKER_MODE=api` on both — `api-b` is Compose-profile-gated, see `docs/deploy-vultr.md` §9 "Two replicas on one box"), `worker` (same image, `WORKER_MODE=worker`, stays single, same `stop_grace_period` contract as `fly.toml`'s `kill_timeout`), `caddy` | `/opt/pqp/compose.yaml` |
| `Caddyfile` | TLS for `api.pqp.gg` (two modes documented in its header: Cloudflare Origin CA, or Caddy automatic HTTPS), load-balancing reverse proxy across `api-a:3001` / `api-b:3001` with active health checking, WebSocket pass-through | `/opt/pqp/Caddyfile` |
| `config.alloy` | Box metrics + `api-a`/`api-b`/`worker` container logs (labeled by Compose service name automatically — no changes needed here for the second replica), both to the same Grafana Cloud stack `tools/sfu-monitoring` and `tools/log-shipper` already use | `/etc/alloy/config.alloy` |

Not here, and never in git: `.env`, `backup.env`, `certs/origin.{pem,key}`,
`/etc/alloy/credentials.env`. `provision.sh` writes empty templates for the
first two and refuses to overwrite anything that already exists.

## Deploy

`.github/workflows/deploy-api-vultr.yml` builds the root `Dockerfile` (the
same image `deploy-api-fly.yml` builds for Fly), pushes it to
`ghcr.io/rafaelcg/pqp-api:<sha>`, and over SSH runs `pqp-deploy.sh`, which
rolls the update across `api-a` then `api-b` (or just `api-a` under
`API_REPLICAS=1`) before touching `worker` — see `docs/deploy-vultr.md` §9
"Two replicas on one box". Gated on `vars.DEPLOY_TARGET == 'vultr'`, so
merging this directory or the workflow changes nothing on its own — see
`docs/deploy-vultr.md` for the cutover sequence.
