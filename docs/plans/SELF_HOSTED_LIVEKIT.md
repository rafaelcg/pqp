# Self-hosted LiveKit for pqp voice

Status: plan, not yet executed. Written 2026-09-06.
Owner: solo maintainer. Audience: the same person, six months from now, at 23:00, with a party tomorrow.

Production voice moved to LiveKit Cloud (Ship plan) on 2026-09-05. This document is the step-by-step
path to running our own LiveKit server on one VM in São Paulo, with the reasoning behind each choice,
and the rollback back to Cloud. Nothing in the app changes; the switch is three Fly secrets.

Decision already taken by the owner (2026-09-06): self-host once parties are more than monthly. The
review date is 2026-09-13, using real party counts and the LiveKit Cloud usage page.

Related code and docs:

- `docs/voice-backends.md` (how the app uses LiveKit, and the eviction re-sweep)
- `server/src/voice/backends.ts` (env vars, `TOKEN_TTL_SECONDS = 15 * 60`)
- `server/src/voice/admin.ts` (`RESWEEP_INTERVAL_MS = 5_000`, `revokeTokenTs` is Cloud-only)
- `client/src/lib/livekit-session.ts` and `client/src/lib/video-quality.ts` (screen-share ceiling:
  3 Mbps on "auto", 4 Mbps at 1080p, 2 Mbps at 720p; simulcast off; dynacast on)
- `docker-compose.yml`, `livekit` profile (the dev server and the three ports it really binds)
- `fly.toml` (pqp-api is single-machine in `gru` by design; see `docs/plans/MULTI_INSTANCE_VOICE.md`)

## 1. Why self-host, and when

### The cost driver is downstream bytes, not minutes

A watch party is one screen-share track fanned out to every viewer. With our "auto" ceiling of 3 Mbps
(`AUTO_SCREEN_BITRATE` in `video-quality.ts`) and 100 viewers for 3 hours:

    3 Mbps * 100 viewers * 10,800 s = 3.24 Tbit = ~405 GB at the ceiling

The observed figure on 2026-09-05 was about 55 GB in the first 40 minutes of a 90 to 100 viewer room,
so roughly 250 GB for a three-hour party (the ceiling is a ceiling, not a target; static content sits
well under it). Use 250 GB per party as the planning number and re-measure after the first
self-hosted party (section 5).

Minutes are the second bill. 100 viewers for 180 minutes is 18,000 WebRTC minutes per party; Ship
includes 150,000 per month, so even 8 parties fit. But every ordinary small call is on the SFU today
as well, and 10 people in voice around the clock is about 430,000 minutes a month, so overage at
$0.0005 per minute is roughly $140 before any party. Routing small rooms back to mesh (a separate
change, threshold 10 members) removes most of that. Bandwidth is the bill that self-hosting removes.

### Prices, from the vendors

| Item | Price | Source |
|---|---|---|
| LiveKit Cloud Ship | $50/mo, 250 GB downstream included, then $0.12/GB; 150,000 WebRTC minutes then $0.0005/min; 1,000 concurrent connections | https://livekit.com/pricing |
| LiveKit Cloud Build (free) | $0, 50 GB downstream, 5,000 WebRTC minutes, 100 concurrent connections | https://livekit.com/pricing |
| Vultr egress policy | 2 TB free per account per month, pooled across all instances and regions, on top of each plan's own allowance; ingress free; overage $0.01/GB worldwide | https://blogs.vultr.com/Vultr-Announces-Reduced-Bandwidth-Pricing-2-Tb-Of-Free-Monthly-Egress-Free-Ingress-And-Global-Pooling and https://docs.vultr.com/support/platform/billing/what-is-the-bandwidth-overage-rate |
| Vultr High Performance AMD 2 vCPU / 4 GB (`vhp-2c-4gb-amd`) | $24/mo list, **$36/mo in São Paulo** (region markup shown at checkout on 2026-09-06; 5 TB transfer, 100 GB NVMe). Automatic Backups add $4.80 and are off. | https://www.vultr.com/pricing/ |
| Vultr High Performance AMD 4 vCPU / 8 GB (`vhp-4c-8gb-amd`) | $48/mo list, expect about $72 in São Paulo | https://www.vultr.com/pricing/ |
| Fly.io egress, South America | $0.04/GB, no free allowance; inbound free | https://fly.io/docs/about/pricing/ |
| Fly.io compute for an SFU | verify; a `performance-*` machine in `gru` carries a regional markup and an SFU should not share CPU | https://fly.io/docs/about/pricing/ |

### Monthly cost by party count

Assumptions: 250 GB per party; the Vultr VM's own allowance (verify, High Frequency plans list several
TB) plus the 2 TB account pool is never exceeded at these volumes; Fly machine cost shown as "M" because
it depends on the size you pick.

| Parties / month | Egress | LiveKit Cloud Ship | Vultr São Paulo (2 vCPU / 4 GB) | Fly gru |
|---|---|---|---|---|
| 1 | 250 GB | $50 (at the included limit) | $36 + $0 egress | M + $10 |
| 4 | 1,000 GB | $50 + 750 * $0.12 = $140 | $36 + $0 | M + $40 |
| 8 | 2,000 GB | $50 + 1,750 * $0.12 = $260 | $36 + $0 | M + $80 |

Break-even on the bill alone is below one party a month, because the VM ($36) costs less than Ship ($50). The
reason to stay on Cloud at one party a month is not money, it is the other column: your time and
someone else's pager. From the second party onward Cloud is $90+ a month above the VM and rising $30
per party.

Fly is listed to close the question: at $0.04/GB it is cheaper than Cloud overage but four times Vultr's
worst case, and Fly's networking is not built for a WebRTC media server (no raw UDP port ranges without
extra work). Keeping the SFU off Fly also keeps the API's single-machine story simple.

### What you give up

1. **Token revocation on `RemoveParticipant`.** `revokeTokenTs` is LiveKit Cloud only. We measured this
   on `livekit-server` v1.13.5: the removed participant reconnects with the same token. Our
   `server/src/voice/admin.ts` already compensates by re-sweeping the room every 5 s for the 15 minute
   token TTL, and only ejecting participants whose `mintedAt` predates the eviction. So a kicked user is
   gone within about 5 s on self-hosted, versus instantly on Cloud. Section 5 verifies this.
2. **Someone else's pager.** If the VM dies during a party, you are the one who notices. The mitigation
   is a dumb box with nothing stateful on it (section 4) and the three-secret rollback to Cloud.
3. **Automatic multi-region.** Cloud picks the closest edge per participant. Our users are in Brazil;
   one São Paulo node is the right trade, and the API is already pinned to `gru`.
4. **Cloud dashboard, session inspector, egress recording.** The session inspector was genuinely useful
   on 2026-09-05 (it showed the 552-unique-participants churn that exposed the 12 s join timer). The
   self-hosted substitute is Prometheus metrics plus our own API logs.

## 2. Target architecture

One LiveKit server, one Vultr VM in São Paulo, one subdomain. No Redis, no load balancer, no Kubernetes.

```
browser  --wss://sfu.pqp.gg:443-->  Caddy --> livekit :7880   (signal + RoomService API)
browser  --udp  sfu.pqp.gg:7882 -->         livekit          (all media, single UDP mux port)
browser  --tcp  sfu.pqp.gg:7881 -->         livekit          (ICE over TCP fallback)
browser  --tls  turn.pqp.gg:443 -->         livekit TURN     (relay for hostile networks)
pqp-api (Fly gru) --https://sfu.pqp.gg--> livekit RoomService (removeParticipant, listParticipants)
```

### VM size

LiveKit's published benchmark (https://docs.livekit.io/transport/self-hosting/benchmark/) ran on a
16-core `c2-standard-16`: 1 video publisher to 3,000 subscribers at 720p pushed 531 MB/s out at 92% CPU,
and 10 audio publishers to 3,000 subscribers used 80% CPU driven by packet rate (959k packets/s out).

Our party: 1 screen-share track at up to 3 Mbps to ~150 subscribers, plus ~150 audio tracks (mostly
muted; the SFU forwards only what is published, and dynacast pauses layers nobody consumes).

- Video egress: 150 * 3 Mbps = 450 Mbps = ~56 MB/s, about one tenth of the benchmark's video egress,
  so roughly 1.5 to 2 of those 16 cores' worth of work.
- Audio: even 20 simultaneous unmuted speakers to 150 listeners is ~3,000 audio forwards at 50 pkt/s
  = 150k pkt/s, about one sixth of the audio benchmark.
- Memory is not the constraint; LiveKit is a Go process that sits in the low hundreds of MB here.

Recommendation: **start on Vultr High Performance AMD 2 vCPU / 4 GB ($36/mo in São Paulo)**. This is what was provisioned on 2026-09-06 as `sfu-pqp`, 216.238.114.79. The High Frequency line had no 4 GB plan in São Paulo that night. and gate the
production switch on the load test in section 5. If the load test shows sustained CPU above 60% or
packet loss, move to **4 vCPU / 8 GB (verify price)**; a Vultr resize is a reboot, and the box is
stateless. Choose High Frequency over Regular because packet forwarding is latency-sensitive
single-thread work and benefits from the faster cores. Verify the plan's network port speed: 450 Mbps
sustained needs a 1 Gbps port, not a shared 100 Mbps one.

### TLS and hostnames

- `sfu.pqp.gg`: signaling and RoomService. Caddy terminates TLS on 443 and proxies to `127.0.0.1:7880`.
  LiveKit's VM guide uses exactly this arrangement and provisions certificates automatically
  (https://docs.livekit.io/transport/self-hosting/vm/). Reason for Caddy over LiveKit's own TLS:
  certificate renewal is Caddy's job and needs no restart of the media server.
- `turn.pqp.gg`: LiveKit's embedded TURN needs its own hostname whose certificate LiveKit itself
  terminates (the deployment guide: the TURN domain must match the certificate, and without a load
  balancer `tls_port` must be 443, https://docs.livekit.io/transport/self-hosting/deployment/).
  Caddy holds the cert; a small systemd timer copies it to a path LiveKit can read after each renewal
  (section 4). Reason a separate hostname is needed: two processes cannot both own 443 on one IP, so
  TURN gets its own IP or its own hostname behind a second IP. On Vultr, attach one additional
  reserved IP to the VM and bind TURN to it; verify the monthly price of a reserved IPv4 on Vultr.
  **Decision taken 2026-09-06: TURN/TLS on 5349 on the single IP, no reserved IP.** Zero extra cost;
  the few corporate networks that only allow outbound 443 will fail to relay, and if that ever shows
  up in the wild the fix is a reserved IP and `tls_port: 443`. `ufw` on the box already allows 5349.

### Ports (from https://docs.livekit.io/transport/self-hosting/ports-firewall/)

| Port | Proto | Purpose | Exposed to |
|---|---|---|---|
| 443 | TCP | HTTPS/WSS via Caddy to 7880 | Internet |
| 80 | TCP | ACME issuance only | Internet |
| 7882 | UDP | Single UDP mux port for all media ("It's possible to handle all UDP traffic on a single port. When this is set, rtc.port_range_start/end are not used") | Internet |
| 7881 | TCP | ICE over TCP fallback | Internet |
| 5349 | TCP | TURN/TLS (single-IP decision, see above) | Internet |
| 3478 | UDP | TURN/UDP (optional, cheap, enable) | Internet |
| 7880 | TCP | LiveKit HTTP; only via Caddy | localhost only |
| 6789 | TCP | Prometheus metrics | localhost or your monitoring IP only |
| 22 | TCP | SSH | your IP only, key auth |

Why a single UDP port instead of 50000-60000: identical behaviour for clients (ICE candidates carry the
port), a one-line firewall rule, and it matches what our dev compose already documents. This is the
same shape the `livekit` profile in `docker-compose.yml` binds (7880, 7881, 7882/udp).

### Redis

Not needed. LiveKit's distributed guide: "In distributed mode, Redis is required as shared data store
and message bus", and "When Redis is configured, LiveKit automatically switches to a distributed setup"
(https://docs.livekit.io/transport/self-hosting/distributed/). One node, no Redis, and the `redis:`
block stays out of the config so the server does not try to cluster. Revisit only if a second node is
ever added.

### DNS on Cloudflare: proxy OFF

`sfu.pqp.gg` and `turn.pqp.gg` must be **DNS only (grey cloud)**. Cloudflare's proxy only carries
HTTP(S) and WebSocket over its own ports; WebRTC's UDP, ICE/TCP on 7881 and TURN/TLS are not HTTP and
cannot traverse it. An orange-cloud record would let the WSS signal succeed and every media path fail,
which our client surfaces as "Could not reach the voice server" after 45 s. Both records: `A` to the VM
IP (TURN record to the TURN IP), TTL 5 min during migration, then whatever you like.

### Firewall (Vultr firewall group plus ufw on the box, both)

```
ufw default deny incoming
ufw allow from <your ip> to any port 22 proto tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 7882/udp
ufw allow 3478/udp
ufw enable
```

Mirror the same in a Vultr Firewall Group attached to the instance so a mistake in ufw is not the only
line of defence.

## 3. Configuration

### Generate keys on the box

```
docker run --rm livekit/livekit-server generate-keys
```

Prints an `APIxxxx: secret` pair. Never reuse Cloud's key/secret; they are per deployment.

### `/opt/livekit/livekit.yaml`

Defaults quoted from upstream `config-sample.yaml`
(https://raw.githubusercontent.com/livekit/livekit/master/config-sample.yaml).

```yaml
# pqp production SFU. Single node, no Redis, no webhooks.
port: 7880                      # behind Caddy only; never exposed

rtc:
  udp_port: 7882                # single UDP mux port; port_range_* unused when set
  tcp_port: 7881                # ICE over TCP fallback
  use_external_ip: true         # discover the public IP via STUN; Vultr VMs sit behind 1:1 NAT
  # node_ip: <public ip>        # uncomment only if STUN discovery picks the wrong address

turn:
  enabled: true
  domain: turn.pqp.gg
  tls_port: 5349                # single IP shares 443 with Caddy; 5349 is the LiveKit default
  udp_port: 3478
  external_tls: false           # LiveKit terminates TURN/TLS itself, so it needs the cert files
  cert_file: /opt/livekit/certs/turn.pqp.gg.crt
  key_file:  /opt/livekit/certs/turn.pqp.gg.key

keys:
  APIxxxxxxxxxxxx: <secret from generate-keys>

room:
  auto_create: true             # the API mints tokens for room = voiceChannelId; no pre-creation step
  empty_timeout: 300            # seconds a room lingers with nobody in it (upstream default 300)
  departure_timeout: 20         # seconds after the last participant leaves before the room closes
  max_participants: 0           # unlimited; pqp enforces channel limits itself

# webhook: deliberately absent. Presence rides pqp's own WebSocket, not LiveKit events.

logging:
  level: info
  json: true                    # journald + jq friendly
  pion_level: error
  sample: true                  # rate-limit repetitive lines during a 150-viewer party

prometheus_port: 6789           # metrics at :6789/metrics, firewalled to localhost
```

Notes:

- Bind the TURN listener to the second IP if you have one. LiveKit binds `turn.tls_port` on all
  addresses; if 443 is also Caddy's port on the primary IP, set Caddy's `bind` to the primary IP only
  in the Caddyfile so the two do not collide.
- `room.auto_create: true` is required. `server/src/voice/backends.ts` mints a token with
  `room = voiceChannelId` and the client connects; nothing calls `CreateRoom`.
- Keep `webhook` off. Roster and presence are derived from `/ws`, not from LiveKit, and a webhook URL
  would be one more thing to secure.

### `/opt/livekit/Caddyfile`

```
{
  email you@example.com
}

sfu.pqp.gg {
  bind <primary ip>
  reverse_proxy 127.0.0.1:7880
}

turn.pqp.gg {
  bind <primary ip>
  respond "ok" 200
  # This block exists only so Caddy obtains and renews the TURN certificate.
}
```

A `caddy-cert-sync.timer` (section 4) copies the `turn.pqp.gg` cert and key from Caddy's data dir to
`/opt/livekit/certs/` and restarts LiveKit when the file hash changes.

### Secrets: the same three env vars, nowhere else

pqp-api reads exactly `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
(`server/src/voice/backends.ts`, `server/src/voice/admin.ts`). The admin client reuses
`LIVEKIT_URL` unchanged, so there is one URL to get right.

Store them in exactly two places: the `keys:` block on the box (mode 0600, root) and Fly secrets. Do not
put them in `.env` files in the repo, in Cloudflare, or in a password manager note that outlives the
box; rotate by editing `livekit.yaml`, restarting, and re-running `fly secrets set`.

### The switch is one command

```
fly secrets set -a pqp-api \
  LIVEKIT_URL=wss://sfu.pqp.gg \
  LIVEKIT_API_KEY=APIxxxxxxxxxxxx \
  LIVEKIT_API_SECRET=<secret>
```

`fly secrets set` restarts the API machine. That drops every live WebSocket for a few seconds, so do it
in a quiet hour (weekday morning São Paulo time; never during a stream). Voice rooms are pinned to a
transport when their first peer joins and keep it until they empty (`docs/voice-backends.md`, "One
room, one transport"), so a call in progress is unaffected by the restart beyond the WS reconnect; the
next new room gets the new SFU. There is no mixed state to reason about. Note that the pin is by
transport kind (`livekit`), not by URL: a room that started on Cloud and is still occupied at the
switch will hand new joiners a token for the new server, so they would land in a different LiveKit
room. Do the switch when no room is occupied, or accept that occupied rooms need to empty and refill.

## 4. Operations

### Running it: systemd + docker compose

LiveKit's VM guide installs a `livekit-docker` systemd unit that runs docker compose from `/opt/livekit`
(https://docs.livekit.io/transport/self-hosting/vm/). We do the same by hand, so the file is ours to
read.

`/opt/livekit/docker-compose.yaml`:

```yaml
services:
  livekit:
    image: livekit/livekit-server:v1.13.6        # pin; see upgrade procedure
    command: --config /etc/livekit.yaml
    restart: unless-stopped
    network_mode: host                           # UDP mux + TURN want the real interface
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
      - ./certs:/opt/livekit/certs:ro
    logging:
      driver: journald
  caddy:
    image: caddy:2
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    logging:
      driver: journald
volumes:
  caddy_data:
  caddy_config:
```

`/etc/systemd/system/livekit-docker.service`:

```
[Unit]
Description=pqp LiveKit SFU (docker compose)
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/livekit
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
```

Log rotation: the `journald` driver hands logs to systemd-journald; set `SystemMaxUse=500M` in
`/etc/systemd/journald.conf`. Nothing writes to `/opt/livekit` at runtime.

Cert sync for TURN, `/etc/systemd/system/caddy-cert-sync.service` (oneshot) plus a `.timer` at
`OnCalendar=daily`: copy `/var/lib/docker/volumes/livekit_caddy_data/_data/caddy/certificates/.../turn.pqp.gg.{crt,key}`
to `/opt/livekit/certs/`, and `docker compose restart livekit` only if `sha256sum` changed. Verify the
exact path Caddy uses on first run; it includes the ACME issuer directory name.

### Metrics and one alert

`prometheus_port: 6789` exposes `/metrics` (config-sample.yaml). Two low-effort options:

1. Grafana Cloud free tier (verify current limits) with Grafana Alloy on the box scraping
   `127.0.0.1:6789` and node_exporter. One alert rule: `up{job="livekit"} == 0` for 2 minutes. A second,
   optional: participant count drops to zero while a room total metric is non-zero for 1 minute (verify
   metric names against your own `/metrics` output), which is what a mass ICE failure looks like from
   the server.
2. Cheaper still: an external HTTPS check on `https://sfu.pqp.gg/` every minute (any uptime service),
   which catches the box or Caddy being down but not media failures. Do at least this before the first
   production party.

### OS updates

Ubuntu LTS with `unattended-upgrades` enabled for security updates only, `Unattended-Upgrade::Automatic-Reboot "false"`.
Reboot by hand after checking there is no room active (`docker compose logs --since 10m livekit` or the
metrics endpoint).

### LiveKit version pinning and upgrades

Pin the image tag (`v1.13.5` is what the re-sweep was measured against). Upgrade procedure, monthly or
when the release notes mention security:

1. Read https://github.com/livekit/livekit/releases for the target tag.
2. Edit the tag in `docker-compose.yaml`, `docker compose pull`.
3. Quiet hour, no rooms active: `docker compose up -d livekit`.
4. Run the two-browser check from section 5 and the kick test.
5. If it misbehaves, revert the tag and `docker compose up -d livekit`. Under one minute.

Because the API talks to LiveKit via `livekit-server-sdk`, also check that the pinned SDK in
`server/package.json` supports the server version (the RoomService API has been stable across 1.x).

### Backups

There is nothing to back up. Rooms are ephemeral, keys are in two known places, TLS re-issues itself.
The runbook for a lost box is "rebuild from this doc": provision, run the steps in section 6 up to
milestone (a), paste the same `keys:` value so Fly secrets stay valid, point DNS at the new IP. Twenty
minutes, of which most is waiting for ACME.

### Rollback

```
fly secrets set -a pqp-api \
  LIVEKIT_URL=<cloud url> LIVEKIT_API_KEY=<cloud key> LIVEKIT_API_SECRET=<cloud secret>
```

Same restart caveat as the switch. Keep the LiveKit Cloud project alive on the free Build tier for this
purpose (50 GB and 100 concurrent connections is enough for a rollback night, not for a party; upgrade
back to Ship in the dashboard if the self-hosted box is out for longer).

## 5. Verification checklist before switching production

Point a staging copy of the API at the new SFU (or, simpler, set the three env vars on a local `pnpm dev`
server and use the deployed client against it via `VITE_API_URL`; the SFU URL travels in the token
response, so the client needs no rebuild).

- [ ] Two browsers on different networks, one on mobile data (4G/5G is a carrier NAT, the hardest
      common case), join the same voice channel and hear each other within 5 s. Check
      `chrome://webrtc-internals` on the mobile side: the selected candidate pair should be `srflx` or
      `host` over UDP to port 7882.
- [ ] Block UDP on one side (or use a network that does) and confirm the call still connects over
      ICE/TCP 7881, then over TURN/TLS 443 with 7881 blocked as well. The relay case shows `relay`
      candidates in webrtc-internals.
- [ ] Screen share a browser tab with "share tab audio" ticked; the far side sees the video and hears
      the tab audio in the second `<audio>` sink (`docs/voice-backends.md`, "Screen-share audio").
- [ ] Kick or ban the mobile user from the server. They are ejected within about 5 s
      (`RESWEEP_INTERVAL_MS`), and a reconnect attempt with the same token is ejected again within
      5 s. This is the self-hosted compensation for the missing `revokeTokenTs`.
- [ ] Load test with LiveKit's CLI (https://github.com/livekit/livekit-cli, install with
      `curl -sSL https://get.livekit.io/cli | bash`; the README warns that a home connection cannot
      simulate hundreds of subscribers, so run it from a second cloud VM in the same region and
      destroy it afterward):

      lk load-test --url wss://sfu.pqp.gg --api-key APIxxx --api-secret <secret> \
        --room load-test --video-publishers 1 --subscribers 150 --duration 10m

      The CLI's default publisher is 720p; our screen ceiling is 3 Mbps, so also run a pass with
      `--video-resolution 1080p` if the CLI version supports it (verify flag name with
      `lk load-test --help`). Pass criteria: CPU under 60% sustained (`htop` on the box), no growth in
      packet loss in the CLI summary, egress around 150 * 3 Mbps = 450 Mbps on `vnstat` or the Vultr
      graph. Above 60% CPU, resize to 4 vCPU before production.
- [ ] Open 20 real browser tabs (one machine is fine) on a channel with one screen share, for 10
      minutes. This exercises the real client code path (dynacast, our bitrate ceilings) that the CLI
      does not.
- [ ] After the first real party, read the Vultr bandwidth meter for the instance and record the GB
      here next to the 250 GB assumption. Confirm the account is still inside the pooled allowance.

## 6. Cost summary and timeline

Monthly, steady state, from section 1: $36 for the VM plus $0 egress for up to 8 parties
under the Vultr pool and plan allowance, plus a reserved IP for TURN if you take that route (verify).
Against Ship at $140 (4 parties) or $260 (8 parties). The Cloud project stays on the free tier at $0.

| Milestone | Steps | Hours |
|---|---|---|
| (a) Provision, TLS, first call | Vultr account, São Paulo VM, firewall group, DNS grey-cloud records, Docker, compose + Caddyfile + livekit.yaml from section 3, generate keys, `systemctl enable --now livekit-docker`, cert sync timer, first two-browser call from one network | 3 to 4 |
| (b) TURN and cross-NAT | Second IP or 5349 decision, TURN cert path, mobile-data test, UDP-blocked test, relay confirmed | 2 |
| (c) Load test | Second VM in the same region, `lk load-test` runs, 20-tab test, resize decision, tear down the tester | 2 |
| Monitoring | Uptime check or Grafana Cloud + Alloy, one alert to your phone | 1 to 2 |
| (d) Production switch | Quiet hour, `fly secrets set`, watch the API log for `voice.sfuEvictFailed`, run the kick test in production with a friend | 1 |
| (e) Downgrade Cloud | In the LiveKit Cloud dashboard set the project to Build (free). Keep the project, keep the keys somewhere safe as the rollback secrets, do not delete it | 0.5 |

Total: roughly 10 to 12 hours, spread over a week so each milestone gets a night of soak.

## Sources

- LiveKit VM deployment: https://docs.livekit.io/transport/self-hosting/vm/
- LiveKit deployment and config overview (TURN on 443, Redis "recommended", prometheus): https://docs.livekit.io/transport/self-hosting/deployment/
- LiveKit ports and firewall: https://docs.livekit.io/transport/self-hosting/ports-firewall/
- LiveKit distributed mode (Redis required only there): https://docs.livekit.io/transport/self-hosting/distributed/
- LiveKit benchmarks and load-test commands: https://docs.livekit.io/transport/self-hosting/benchmark/
- LiveKit config-sample.yaml (all defaults): https://raw.githubusercontent.com/livekit/livekit/master/config-sample.yaml
- LiveKit CLI load tester: https://github.com/livekit/livekit-cli
- LiveKit Cloud pricing: https://livekit.com/pricing
- Vultr bandwidth policy (2 TB pooled, $0.01/GB, free ingress): https://blogs.vultr.com/Vultr-Announces-Reduced-Bandwidth-Pricing-2-Tb-Of-Free-Monthly-Egress-Free-Ingress-And-Global-Pooling
- Vultr overage rate: https://docs.vultr.com/support/platform/billing/what-is-the-bandwidth-overage-rate
- Vultr plan prices (verify, select São Paulo): https://www.vultr.com/pricing/
- Fly.io pricing (egress $0.04/GB South America): https://fly.io/docs/about/pricing/
