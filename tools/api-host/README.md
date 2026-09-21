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
| `provision.sh` | Idempotent installer. Safe to re-run to check for drift. Lays out `/opt/pqp`, installs Alloy, wires the nightly `tools/db-backup` cron, and does the initial `install` of `pqp-deploy.sh` below. Never starts/restarts `api-a`/`api-b`/`worker`/`caddy` — that is the deploy workflow's job. | run from a scp'd copy |
| `compose.yaml` | `api-a` + `api-b` (two copies of the API half, same image as `pqp-api` on Fly, `WORKER_MODE=api` on both — `api-b` is Compose-profile-gated, see `docs/deploy-vultr.md` §9 "Two replicas on one box"), `worker` (same image, `WORKER_MODE=worker`, stays single, same `stop_grace_period` contract as `fly.toml`'s `kill_timeout`), `caddy` | `/opt/pqp/compose.yaml` |
| `pqp-deploy.sh` | The one command the unprivileged `pqp-deploy` SSH account may sudo. Rolling-updates `api-a` → `api-b` → `worker`, verifies each replica's own reported version, splits `PG_POOL_MAX` across however many replicas are running. Signed and transferred by the deploy workflow the same way as `compose.yaml`/`Caddyfile` (same HMAC manifest) and installs a newer copy of itself mid-run when one is staged — see its own header comment for why that self-replacement is safe. A box whose installed copy predates this file's `api-a`/`api-b` split needs ONE manual `provision.sh` re-run first; `docs/deploy-vultr.md` §9 "Migrating an existing box" has the exact commands. | `/usr/local/bin/pqp-deploy` (root:root, 0755) |
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

## Manual ops on the box

Never run `docker compose up` on this box without `APP_IMAGE_TAG=<sha>` set
(`compose.yaml` refuses to parse without it now, see its header comment for
the 2026-09-21 incident that made this the rule). If you need to recreate a
container by hand, do it one replica at a time (`api-a`, confirm healthy,
then `api-b`) and never while a watch party is live.

## Apply a Caddyfile-only change by hand

For a change that is only this `Caddyfile` (no new image to roll), on the
box:

```bash
sudo cp Caddyfile /opt/pqp/Caddyfile
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
```

`caddy reload` validates the new config before it swaps it in, so a bad
config is refused rather than left half-applied — the explicit `validate`
step above just surfaces that same check before you commit to the reload.

**The first reload after adding (or changing) `stream_close_delay` still
closes every open `/ws` connection.** The delay only takes effect once a
config carrying it has itself been loaded — the reload that installs it is
the one reload it cannot protect. Every reload after that one drains
sockets instead of cutting them. Do this first reload outside a party.
