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
| `provision.sh` | Idempotent installer. Safe to re-run to check for drift. Lays out `/opt/pqp`, installs Alloy and `rclone`, wires the nightly `db-backup.sh` root cron job, and does the initial `install` of `pqp-deploy.sh` below. Never starts/restarts `api-a`/`api-b`/`worker`/`caddy`, that is the deploy workflow's job. | run from a scp'd copy |
| `db-backup.sh` | The nightly Postgres backup job (`docs/DB_RUNBOOK.md`): `pg_dump` against `DATABASE_URL` from `/opt/pqp/.env`, uploaded with `rclone` to the `LIVE_HLS_S3_*` R2 bucket. No secrets of its own. | `/opt/pqp/backup/run.sh`, run by root's crontab (`/etc/cron.d/pqp-db-backup`) |
| `compose.yaml` | `api-a` + `api-b` (two copies of the API half, same image as `pqp-api` on Fly, `WORKER_MODE=api` on both — `api-b` is Compose-profile-gated, see `docs/deploy-vultr.md` §9 "Two replicas on one box"), `worker` (same image, `WORKER_MODE=worker`, stays single, same `stop_grace_period` contract as `fly.toml`'s `kill_timeout`), `caddy` | `/opt/pqp/compose.yaml` |
| `pqp-deploy.sh` | The one command the unprivileged `pqp-deploy` SSH account may sudo. Rolling-updates `api-a` → `api-b` → `worker`, verifies each replica's own reported version, splits `PG_POOL_MAX` across however many replicas are running. Signed and transferred by the deploy workflow the same way as `compose.yaml`/`Caddyfile` (same HMAC manifest) and installs a newer copy of itself mid-run when one is staged — see its own header comment for why that self-replacement is safe. A box whose installed copy predates this file's `api-a`/`api-b` split needs ONE manual `provision.sh` re-run first; `docs/deploy-vultr.md` §9 "Migrating an existing box" has the exact commands. | `/usr/local/bin/pqp-deploy` (root:root, 0755) |
| `Caddyfile` | TLS for `api.pqp.gg` (two modes documented in its header: Cloudflare Origin CA, or Caddy automatic HTTPS), load-balancing reverse proxy across `api-a:3001` / `api-b:3001` with active health checking, WebSocket pass-through | `/opt/pqp/caddy/Caddyfile` (the directory `/opt/pqp/caddy` is mounted whole at `/etc/caddy`, never the single file: see below) |
| `test-pqp-deploy.sh` | Offline checks (stubbed `docker`, temp directories, no root) for the Caddy layout seeding and the post-reload integrity check in `pqp-deploy.sh`; the functions are cut out of the real script. Not installed on the box. | not on the box |
| `config.alloy` | Box metrics + `api-a`/`api-b`/`worker` container logs (labeled by Compose service name automatically, no changes needed here for the second replica), both to the same Grafana Cloud stack `tools/sfu-monitoring` and `tools/log-shipper` already use. Also per-container CPU and memory (Alloy's embedded cAdvisor, labelled `service`) and Caddy's request metrics (scraped at the caddy container's bridge address, port 2020, which is not published). See `docs/MONITORING.md` "Capacity gauges" | `/etc/alloy/config.alloy` |

Not here, and never in git: `.env`, `caddy/certs/origin.{pem,key}`,
`/etc/alloy/credentials.env`. `provision.sh` writes an empty template for
the first and refuses to overwrite anything that already exists. The
nightly backup has no secrets file of its own, `db-backup.sh` reads
`DATABASE_URL` and `LIVE_HLS_S3_*` straight out of `.env`.

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
then `api-b`) and never while a watch party is live. `.env`'s own
`APP_IMAGE_TAG`/`APP_VERSION` fallback pin is maintained automatically now:
every `pqp-deploy.sh` run rewrites it to the tag it just verified healthy,
so a bare manual recreate with no tag in scope lands on the last deployed
build, not a stale hand-written one.

`.env`'s `PG_POOL_MAX` is the total for the API half, not a per-replica value:
`pqp-deploy.sh` divides it by the replica count on every roll
(`API_PG_POOL_MAX_PER_REPLICA`). It is 64 since 2026-10-26, so 32 per replica;
the reasoning and the rollback are in `docs/DB_RUNBOOK.md` section 3. A change
to `.env` takes effect only on the next roll of `api-a` and `api-b`, and the
`pqp` account's `sudo` needs a password, so the way to roll is a deploy through
the workflow, which only runs when the API needs the commit (a change under
`tools/api-host/` counts).

## Viewer address (what the API's limiters key on)

The API keys its per-address limiters (anonymous routes, `/ws` sockets, every
public route) on the one `X-Forwarded-For` hop `TRUST_PROXY=true` reads
(`clientAddress`, `server/src/lib/rate-limit.ts`). Behind Cloudflare that hop
must be the viewer, which the Caddyfile does with the global `servers` block
(`trusted_proxies static <Cloudflare ranges>`, `client_ip_headers
CF-Connecting-IP`) plus `header_up X-Forwarded-For {client_ip}` in the
`(upstreams)` snippet. The reverse_proxy-level `trusted_proxies` the file used
to carry is ignored since Caddy 2.7.

**Applying it changes the keying for ALL traffic**: until now every viewer
behind one Cloudflare colo shared one bucket (so the limiters almost never
tripped through Cloudflare); afterwards each viewer has their own, and the
limits start to mean what their numbers say. Apply it outside a party, with
the reload note below.

Verify on the box, from a second terminal, while one tagged request goes
through Cloudflare from a known address:

```bash
# Caddy -> API traffic on the compose network. Expect the viewer's own
# address in X-Forwarded-For, not a 172.64-71.x.x / 104.16-31.x.x edge IP.
sudo tcpdump -l -A -i any "tcp dst port 3001" | grep -ai x-forwarded-for
curl -s -o /dev/null "https://api.pqp.gg/status.json?probe=$(date +%s)"

# Then prove the limiter sees people. Cloudflare caches /status.json, so use
# unique query strings. A burst from ONE address trips 429, while a second
# address still gets 200 at the same time.
for i in $(seq 1 400); do curl -s -o /dev/null -w "%{http_code}\n" "https://api.pqp.gg/status.json?b=$i"; done | sort | uniq -c
```

Checked locally with Caddy 2.11.4 and an echo upstream: a trusted peer sending
`CF-Connecting-IP: 198.51.100.9` and a spoofed `X-Forwarded-For: 1.2.3.4`
reaches the upstream as `X-Forwarded-For: 198.51.100.9`; an untrusted peer's
headers are ignored (the upstream sees the peer's own address).

## Apply an Alloy config change by hand

`pqp-deploy.sh` does not touch `/etc/alloy/config.alloy` (the deploy workflow
ships `compose.yaml`, the `Caddyfile` and the script, not the monitoring
config), so a change to `config.alloy` is applied on the box by hand and takes
effect at once without touching a container or a call:

```bash
sudo install -m 0644 config.alloy /etc/alloy/config.alloy
sudo alloy validate /etc/alloy/config.alloy        # refuses a bad file before the reload
sudo systemctl reload alloy                         # or: curl -X POST localhost:12345/-/reload
systemctl is-active alloy
curl -s localhost:12345/metrics | grep -E 'prometheus_remote_storage_samples_(total|failed_total)'
```

Then confirm the series in Grafana rather than trusting the config:
`container_cpu_usage_seconds_total{box="api-pqp"}` (labelled `service`) and
`caddy_http_request_duration_seconds_count{box="api-pqp"}`. If `service` is
missing from the cAdvisor series, Alloy could not read the Docker socket or the
cgroup files: check `groups alloy` includes `docker` and read
`journalctl -u alloy -n 50`. The Caddy scrape target is the caddy container's
address on the Docker bridge, port 2020 (`http://:2020` in the Caddyfile);
`curl -s http://<that ip>:2020/metrics | head` from the box proves it. The first
Caddyfile that carries `servers { metrics }` and the `:2020` site goes live with
the deploy's own `caddy reload`.

## Apply a Caddyfile-only change by hand

For a change that is only this `Caddyfile` (no new image to roll), on the
box:

```bash
sudo install -m 0644 -o pqp -g pqp Caddyfile /opt/pqp/caddy/Caddyfile
cd /opt/pqp
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
# the two hashes must be identical, or the container is not running what you installed
sha256sum /opt/pqp/caddy/Caddyfile
docker compose exec -T caddy sha256sum /etc/caddy/Caddyfile
```

`compose.yaml` mounts the directory `/opt/pqp/caddy` at `/etc/caddy`, so
any way of replacing the file (`install`, `cp`, `mv`, an editor's save) is
seen by the container. It used to bind-mount the single file, which pins an
inode: a rename-replace left the container on the old content for four
weeks (2026-09-16 to 2026-10-15) while `caddy reload` said "config is
unchanged". Do not put a single-file mount back. `pqp-deploy.sh` also
compares the two hashes after every reload and recreates only `caddy` when
they differ. The one-time move from the old layout is in
`docs/deploy-vultr.md` §8, "Caddy directory layout".

`caddy reload` validates the new config before it swaps it in, so a bad
config is refused rather than left half-applied — the explicit `validate`
step above just surfaces that same check before you commit to the reload.

**The first reload after adding (or changing) `stream_close_delay` still
closes every open `/ws` connection.** The delay only takes effect once a
config carrying it has itself been loaded — the reload that installs it is
the one reload it cannot protect. Every reload after that one drains
sockets instead of cutting them. Do this first reload outside a party.
