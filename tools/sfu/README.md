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
| `sshd-hardening.conf` | Turns SSH password authentication off. Sorts ahead of Ubuntu's `50-cloud-init.conf`, which turns it back on. | `/etc/ssh/sshd_config.d/01-pqp-hardening.conf` (0600) |
| `fail2ban-jail-sshd.conf` | The SSH jail. Reads the journal, with the `journalmatch` corrected for Ubuntu. | `/etc/fail2ban/jail.d/pqp-sshd.local` |
| `turn-cert-sync.service.tmpl` / `.timer` | Runs the cert sync daily. | `/etc/systemd/system/` |

Rendering the templates with the production defaults (`sfu.pqp.gg`,
`turn.pqp.gg`) reproduces the files on the box **byte for byte**; that was
checked by sha256 on 2026-09-07, with the `keys:` line normalised on both
sides. `docker-compose.yaml`, `livekit-docker.service` and
`turn-cert-sync.timer` are committed verbatim and hash-match directly, as are
`sshd-hardening.conf` and `fail2ban-jail-sshd.conf`, which were copied down off the
box rather than written up to it.

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

The run turns SSH password authentication off and installs a fail2ban jail; see
"SSH: keys only, plus a jail" below. On a fresh box that step is skipped,
loudly, if `/root/.ssh/authorized_keys` is empty, so it cannot seal you out of a
machine you have not put a key on yet.

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
| SSH | OpenSSH 9.6p1, port 22, **password auth off**, pubkey on, root key-only, one key in `authorized_keys` |
| fail2ban | 1.0.2, enabled, `sshd` jail on the systemd journal, `nftables` ban action |

Five things worth knowing that the plan document did not say:

1. **`livekit-docker.service` is enabled but has never been started.** It is
   `enabled` / `inactive (dead)`. The containers come back after a reboot
   through Docker's own `restart: unless-stopped`, not through systemd. So the
   boot path works, it is just not the path the unit file describes. See the
   decision below.
2. **LiveKit binds 7880 and 6789 on `0.0.0.0`, not on loopback.** The plan says
   "localhost only" for both. They are private only because `ufw` denies them.
   The firewall is load-bearing, not defence in depth, for the RoomService API
   and the metrics endpoint. Do not turn `ufw` off to debug something.
3. **`ufw` allows `30000:40000/udp`, and it is load-bearing.** An earlier
   version of this file called it stale, left over from before
   `rtc.udp_port: 7882` was pinned, and said nothing listened there. That was
   wrong, and the mistake is worth understanding because the evidence for it
   looks convincing. `30000:40000` is LiveKit's **TURN relay allocation
   range**, `turn.relay_range_start` / `turn.relay_range_end`, which default to
   exactly those numbers and which `livekit.yaml` does not override. LiveKit
   says so on every boot:

   ```
   docker logs livekit-livekit-1 | grep 'Starting TURN server'
   ... "turn.relay_range_start":30000,"turn.relay_range_end":40000 ...
   ```

   A relay socket exists only while a TURN allocation is live, so `ss -lnup`
   shows an empty range whenever no cross-NAT client is relaying, which is most
   of the time. **The empty range is not evidence that the rule is unused.** It
   is a sampling artefact, and it is what produced the wrong conclusion. The
   traffic is real and you can see it in the ICE candidates of any relayed
   participant:

   ```
   docker logs livekit-livekit-1 | grep -o 'udp relay [0-9.]*:[0-9]*' | sort -u
   ```

   Deleting the rule would break relayed calls for precisely the users who have
   no other path to the box. Leave it.
4. **SSH is key-only and rate-limited**, and open to the world on 22/tcp. See
   the section below. The plan's `ufw allow from <your ip> to any port 22` is
   still not done, deliberately: a rebuild that locks you out of the new box at
   23:00 is worse than the risk it avoids, and with passwords off plus a jail
   in front, what is left on 22 is noise rather than exposure.
5. **LiveKit binds 7880 and 6789 on `0.0.0.0`.** This is item 2 above and it is
   the one real thing still outstanding. See "Known and not yet fixed".

`turn-cert-sync.service` reports `static` rather than `enabled`, which is
correct: it has no `[Install]` section, and the `.timer` is what is enabled.

Minor and left alone: `livekit-docker.service` has
`After=network-online.target` without the matching
`Wants=network-online.target`, so the ordering is advisory. It does not matter
while Docker's restart policy is the real boot path.

## SSH: keys only, plus a jail

Hardened 2026-09-07. Before that the box was taking **5,411 failed password
attempts in 24 hours** and answering every one of them, because
`/etc/ssh/sshd_config.d/50-cloud-init.conf` contained
`PasswordAuthentication yes` and quietly beat the `no` in the main
`sshd_config`. sshd takes the *first* value it sees for a keyword and the
`Include` of the drop-in directory sits at line 12, above the setting it
overrides. Reading `sshd_config` told you the opposite of the truth.

**Always check the outcome, never the file:**

```bash
ssh root@216.238.114.79 'sshd -T | grep -E "^(passwordauthentication|pubkeyauthentication|permitrootlogin) "'
# passwordauthentication no
# pubkeyauthentication yes
# permitrootlogin without-password
```

`sshd-hardening.conf` lands as `01-pqp-hardening.conf` and wins by sorting
ahead of the cloud-init file. The number is the mechanism; do not renumber it
above `50-`. `PermitRootLogin` is untouched and was already key-only.

If you ever change this by hand, reload rather than restart, validate first,
and prove a *new* connection works before you close the one you have:

```bash
ssh root@216.238.114.79 'sshd -t && systemctl reload ssh'   # reload keeps sessions
ssh -o ControlPath=none root@216.238.114.79 'echo still reachable'
```

A belt-and-braces trick for doing this alone, which is what was used here: arm
a revert before you touch anything, and disarm it once a fresh connection has
proved itself.

```bash
systemd-run --on-active=15min --unit=pqp-sshd-revert-guard \
  /bin/bash -c 'rm -f /etc/ssh/sshd_config.d/01-pqp-hardening.conf; sshd -t && systemctl reload ssh'
# ... prove a new connection works ...
systemctl stop pqp-sshd-revert-guard.timer
```

**There is exactly one key in `/root/.ssh/authorized_keys`.** With passwords
off that key is now the only way in, and losing it means a Vultr console
session or a rebuild. Adding a second one is cheap insurance and is not done
yet.

`install.sh` refuses to disable password auth when `authorized_keys` is empty,
which is what stops a fresh-box run from sealing you out of a machine you have
not put a key on yet.

### fail2ban

`fail2ban-jail-sshd.conf` installs the `sshd` jail: 4 failures in 30 minutes earns
a week, doubling to a cap of five weeks for repeat offenders.

The one line that matters is the `journalmatch`. fail2ban ships

```
journalmatch = _SYSTEMD_UNIT=sshd.service + _COMM=sshd
```

which is right on RHEL and **wrong on Ubuntu**, where the unit is `ssh.service`.
On this box the journal holds 21,905 lines under `ssh.service` and exactly one
under `sshd.service`. With the shipped value the jail starts, reports healthy,
and watches nothing forever. That is the failure mode to check for, and it is
invisible unless you look at the counters:

```bash
ssh root@216.238.114.79 'fail2ban-client status sshd'
```

`Journal matches` must name `ssh.service`, and on a box being knocked on the
counters must move within a minute or two. `Total failed: 0` an hour after a
restart means the jail is decorative, not that the internet has gone quiet.

Two things deliberately chosen:

- **`mode = normal`, not `aggressive`.** Aggressive counts ordinary connection
  closes and would eventually ban an admin on a flaky link. In normal mode a
  successful key login matches nothing, so key-based access cannot ban itself.
  `ignoreip` is loopback only for the same reason: nothing else needs it.
- **The Debian default `nftables` ban action**, left alone rather than switched
  to the `ufw` action. It writes to its own `inet f2b-table` at hook priority
  -1 and never touches ufw's ruleset, so a ban is one set element rather than a
  firewall reload under a live call. The rule is scoped to `tcp dport 22`, so
  it cannot touch media on any UDP port:

  ```bash
  ssh root@216.238.114.79 'nft list table inet f2b-table'
  ```

## Known and not yet fixed

**LiveKit binds 7880 (RoomService API) and 6789 (Prometheus) on `0.0.0.0`.**
`ufw` is the only thing keeping them private, so the firewall is load-bearing
rather than defence in depth. Do not turn `ufw` off to debug something.

6789 is the easy half and worth doing: Alloy scrapes it over loopback
(`tools/sfu-monitoring/config.alloy` points at `localhost:6789`), so binding it
to `127.0.0.1` costs nothing and removes an unauthenticated metrics endpoint
from the public interface. LiveKit has no per-listener bind address for it, so
this means either a `prometheus_port` behind a loopback-only publish or moving
the container off `network_mode: host`, and **either way it needs a LiveKit
restart, which hangs up every call in progress**. Not a thing to do while the
box is carrying traffic. Pair it with the `systemctl start livekit-docker`
alignment below and spend one quiet hour on both.

7880 is the harder half and should stay as it is for now: Caddy reverse-proxies
to it on `127.0.0.1:7880`, but LiveKit also needs 7880 reachable for its own
purposes, and the RoomService API is authenticated by the API key pair. The
firewall is doing real work there and the change is not obviously safe.

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
