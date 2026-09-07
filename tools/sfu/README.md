# The SFU box, in git

Everything that makes `216.238.114.79` a LiveKit server. Until this directory
existed, these files lived only on that machine, which meant a lost box was a
lost afternoon of remembering. Now it is a scripted twenty minutes against a
fresh Vultr instance.

The box is deliberately disposable: it holds no data, only configuration. That
is why there are no Vultr automatic backups on it. This directory is the
backup. The monitoring half is next door in
[`tools/sfu-monitoring/`](../sfu-monitoring/), and `install.sh` here calls that
one at the end.

The prose, including the reasoning behind every port and the cost arithmetic,
is [`docs/plans/SELF_HOSTED_LIVEKIT.md`](../../docs/plans/SELF_HOSTED_LIVEKIT.md).
The rebuild procedure is section 7 of that file.

| File | Role | On the box |
|---|---|---|
| `install.sh` | Idempotent installer. Fresh Ubuntu 24.04 to serving, or a no-op re-run against the live box. | run from `/opt/sfu/` |
| `livekit.yaml.tmpl` | The LiveKit server config. Single node, no Redis, no webhooks. The `keys:` line is a placeholder. | `/opt/livekit/livekit.yaml` (0600) |
| `Caddyfile.tmpl` | Caddy: TLS for both hostnames, reverse proxy to LiveKit's 7880. | `/opt/livekit/Caddyfile` |
| `docker-compose.yaml` | The two containers, pinned. `network_mode: host` because UDP mux and TURN want the real interface. | `/opt/livekit/docker-compose.yaml` |
| `sync-turn-cert.sh.tmpl` | Copies the TURN certificate out of Caddy's volume into a path LiveKit can read, and restarts LiveKit only when the hash changed. | `/opt/livekit/sync-turn-cert.sh` (0700) |
| `livekit-docker.service` | systemd wrapper around `docker compose up -d` in `/opt/livekit`. | `/etc/systemd/system/` |
| `turn-cert-sync.service.tmpl` / `.timer` | Runs the cert sync daily. | `/etc/systemd/system/` |

Rendering the templates with the production defaults (`sfu.pqp.gg`,
`turn.pqp.gg`) reproduces the files on the box **byte for byte**; that was
checked by sha256 on 2026-09-07, with the `keys:` line normalised on both
sides. `docker-compose.yaml`, `livekit-docker.service` and
`turn-cert-sync.timer` are committed verbatim and hash-match directly.

## How the pieces fit

```
:443  tcp  Caddy ──reverse_proxy──► 127.0.0.1:7880  LiveKit signal + RoomService
:80   tcp  Caddy   (ACME only)
:7882 udp  LiveKit   all media, single UDP mux port
:7881 tcp  LiveKit   ICE over TCP fallback
:5349 tcp  LiveKit   TURN/TLS, cert copied in by the daily timer
:3478 udp  LiveKit   TURN/UDP
:6789 tcp  LiveKit   Prometheus, scraped by Alloy (tools/sfu-monitoring)
```

Caddy owns 443 and therefore owns the certificate for **both** hostnames. The
`turn.pqp.gg` block in the Caddyfile serves a 200 and nothing else; it exists
only so Caddy obtains and renews that certificate. LiveKit terminates TURN/TLS
itself on 5349, so it needs the certificate *files*, which is the whole reason
`sync-turn-cert.sh` exists. Renewal is Caddy's job and does not restart the
media server; the daily sync is what notices the new file and restarts LiveKit
once, in the small hours.

## Install

Fresh box (Vultr High Performance AMD 2 vCPU / 4 GB, São Paulo, Ubuntu 24.04),
with the DNS A records already pointing at its IP, grey cloud:

```bash
scp -r tools/sfu tools/sfu-monitoring root@<new-ip>:/opt/
ssh root@<new-ip> 'LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
  GC_PROM_USER=3563744 GC_PROM_TOKEN=<metrics:write token> \
  bash /opt/sfu/install.sh'
```

Re-run against the live box to check for drift. It rewrites identical bytes,
starts nothing, and never touches a running container:

```bash
scp -r tools/sfu root@216.238.114.79:/opt/
ssh root@216.238.114.79 'bash /opt/sfu/install.sh'
```

Overridable with environment variables: `SFU_DOMAIN`, `TURN_DOMAIN`,
`ACME_EMAIL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

## The secret

`livekit.yaml` carries one secret, the LiveKit API key pair in its `keys:`
block. It is **not** in this repo, in any form. `livekit.yaml.tmpl` has
`__LIVEKIT_API_KEY__: __LIVEKIT_API_SECRET__` and the installer substitutes,
in this order:

1. `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` from the environment.
2. The pair already in `/opt/livekit/livekit.yaml`, if the file exists. This is
   why a re-run against the live box needs no secret on the command line.
3. A fresh pair from `livekit-server generate-keys`, written to
   `/opt/livekit/keys.txt` (0600). Only happens on a genuinely new deployment,
   and the installer then prints the `fly secrets set` you owe it.

The live pair exists in exactly two places, and this is the whole inventory:
the `keys:` line on the box, and the `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`
Fly secrets on `pqp-api`. Read it back with
`ssh root@216.238.114.79 'grep -A1 ^keys: /opt/livekit/livekit.yaml'`. Fly does
not let you read a secret back, which is why the box is the copy that matters
during a rebuild: paste the same pair onto the new box and the Fly secrets stay
valid, so a rebuild is a DNS change and nothing else.

Same rule as `tools/sfu-monitoring` and its Grafana token: the credential
reaches the box through the environment on one `ssh` line, lands in a 0600 file
owned by root, and never in git.

## What is actually running, as of 2026-09-07

Read off the box, not off the plan. Where the plan document and reality
disagreed, reality won and this section says so.

| | |
|---|---|
| OS | Ubuntu 24.04.4 LTS, kernel 6.8.0-138, hostname `sfu-pqp` |
| Docker | `docker-ce` 29.8.0, compose plugin v5.5.1, no `/etc/docker/daemon.json` |
| LiveKit | `livekit/livekit-server:v1.13.6`, `livekit-server version 1.13.6` |
| Caddy | `caddy:2`, `v2.11.4` |
| Compose project | `livekit` (from `/opt/livekit`), so the Caddy volume is `livekit_caddy_data`, which is the path baked into `sync-turn-cert.sh` |
| Swap | 8 GB `/swapfile`, in `/etc/fstab` |
| journald | `SystemMaxUse=500M` |
| Upgrades | `unattended-upgrades` enabled, `Automatic-Reboot` left at its commented default (false) |

Four things worth knowing that the plan document did not say:

1. **`livekit-docker.service` is enabled but has never been started.** It is
   `enabled` / `inactive (dead)`. The containers come back after a reboot
   through Docker's own `restart: unless-stopped`, not through systemd. So the
   boot path works, it is just not the path the unit file describes. See the
   decision below.
2. **LiveKit binds 7880 and 6789 on `0.0.0.0`, not on loopback.** The plan says
   "localhost only" for both. They are private only because `ufw` denies them.
   The firewall is load-bearing, not defence in depth, for the RoomService API
   and the metrics endpoint. Do not turn `ufw` off to debug something.
3. **`ufw` allows `30000:40000/udp`.** LiveKit's default ICE port range, left
   over from before `rtc.udp_port: 7882` was set. Nothing listens there now
   (`ss -lntup` confirms), so it is an open hole to no process rather than a
   risk, but it is noise. The installer reproduces it, because this directory's
   job is to rebuild the box that exists, not to redesign it. Drop it in one
   command when you next want to tidy: `ufw delete allow 30000:40000/udp`, then
   delete the line from `install.sh`.
4. **SSH is open to the world** on 22/tcp, key auth only. The plan says
   `ufw allow from <your ip> to any port 22`. Reproduced as-is for the same
   reason: a rebuild that locks you out of the new box at 23:00 is worse than
   the risk it avoids. Tighten it after the box is up, by hand.

`turn-cert-sync.service` reports `static` rather than `enabled`, which is
correct: it has no `[Install]` section, and the `.timer` is what is enabled.

Minor and left alone: `livekit-docker.service` has
`After=network-online.target` without the matching
`Wants=network-online.target`, so the ordering is advisory. It does not matter
while Docker's restart policy is the real boot path.

## Decision: systemd or Docker's restart policy

Both mechanisms are installed, and they do not conflict, but only one is doing
the work.

The installer **starts the stack through `systemctl start livekit-docker` on a
fresh box**, so a new machine has systemd as the owner from its first boot and
`ExecStop` gives an orderly `docker compose down`. Against a box whose
containers are already running, it **detects them and skips the start
entirely**. Starting the unit there would run `docker compose up -d` under
systemd, and any drift between the committed compose spec and the one the
containers were created from would recreate them, which hangs up every call in
progress. That is not a risk worth taking to make a `systemctl is-active` line
read differently.

So the live box stays as it is: enabled, inactive, containers held up by
`restart: unless-stopped`. Aligning it is a two-command job for a quiet hour
with no room occupied, and it is worth doing once:

```bash
ssh root@216.238.114.79 'cd /opt/livekit && docker compose up -d && systemctl start livekit-docker'
ssh root@216.238.114.79 'systemctl is-active livekit-docker'   # expect: active
```

`docker compose up -d` first, on purpose: if that recreates anything you find
out while you are watching, rather than inside a systemd unit.

## Routine operations

**Upgrade LiveKit.** Edit the tag in `docker-compose.yaml` here, commit, copy
it up, `docker compose pull`, then `docker compose up -d livekit` in a quiet
hour. Reverting is the same three steps with the old tag, under a minute.
Check the release notes and that `livekit-server-sdk` in `server/package.json`
still matches.

**Reboot.** No room occupied, then `reboot`. The containers come back on their
own. Confirm with `curl -sS -o /dev/null -w '%{http_code}\n' https://sfu.pqp.gg/`
(expect 200) and by watching participants reappear in Grafana.

**Check the TURN certificate.**

```bash
ssh root@216.238.114.79 'ls -l /opt/livekit/certs; systemctl list-timers turn-cert-sync.timer'
ssh root@216.238.114.79 'openssl x509 -enddate -noout -in /opt/livekit/certs/turn.pqp.gg.crt'
```

**Rotate the API key pair.** Generate a new one, edit the `keys:` line on the
box, `docker compose restart livekit`, then `fly secrets set` the same pair on
`pqp-api`. Rooms occupied at that moment lose their tokens. Quiet hour.
