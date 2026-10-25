# SFU resize runbook: `sfu-pqp` from 4 to 8 vCPU

The home media server (Vultr `sfu-pqp`, São Paulo, LiveKit and TURN, the box
every watch party and the default voice region use) runs `vhp-4c-8gb-amd`. This
is the procedure for the pre-approved in-place upgrade to **`vhp-8c-16gb-amd`**:
about a ten minute job, one reboot of about a minute, one way only.

Why it is pre-approved and not bought: the 2026-10-22 capacity review (operator
copy, `~/.config/pqp/ops/capacity-review-2026-10-22.md`, with the same
convention as `docs/CAPACITY.md`: the measured numbers do not live in this
repository) found the evening peak at about a third of the cores, kept 4c, and wrote
down the triggers below. The owner decision of 2026-10-25: do not
buy yet, make the trigger an alert, make the upgrade a ten minute job. The
alerts are `tools/monitoring/grafana-alert-rules-capacity.json`; this file is
what they hand over to.

Cost of the step: about **+$86.40 a month** including VAT (`/upgrades` listed
`vhp-8c-16gb-amd` at 144 a month in São Paulo against 72 for the 4c plan, plus
20% VAT). Re-read the price in step 3 of the pre-checks, it is the only number
here that Vultr can change.

No em dashes in this file on purpose; it is meant to be pasted into a terminal.

Parts:

1. [When to do it, and when not to](#1-when-to-do-it-and-when-not-to)
2. [Access and credentials](#2-access-and-credentials)
3. [Pre-checks](#3-pre-checks)
4. [The change](#4-the-change)
5. [What people see, and what is not covered](#5-what-people-see-and-what-is-not-covered)
6. [Post-checks](#6-post-checks)
7. [After: what to update](#7-after-what-to-update)
8. [It cannot be undone](#8-it-cannot-be-undone)
9. [After 8c](#9-after-8c)

---

## 1. When to do it, and when not to

**Triggers** (any one is enough, from the 2026-10-22 review):

| Trigger | Where it shows |
|---|---|
| Evening 5-minute CPU busy fraction above 0.60 (2.4 of 4 cores) on **3 evenings** | alert `SFU capacity: CPU busy above 60% for 10m` (critical) and the earlier `above 45% for 15m` (warning), group `pqp-capacity` |
| LiveKit participants above **240** | alert `SFU capacity: LiveKit participants above 240 for 5m` |
| Outgoing packet loss p95 above **0.5%** for an hour | alert `SFU capacity: packet loss p95 above 0.5% for 1h` (read the note on it: check CPU first) |
| **Event rule:** any booked event expected above about **2,000 forwarded audio streams** (about 200 seated people with 10 open microphones) | not an alert. Upgrade the **day before**, in the trough |

Two more alerts in the same group are related but are not upgrade triggers on
their own: `SFU capacity: transmit above 600 Mbit/s for 10m` (a bigger CPU does
not raise the network ceiling, see section 9) and the API box disk and memory
rules.

**How to read the Vultr portal graph.** The triggers above are in node exporter
terms (the guest's own view, Grafana). The Vultr portal (Server Monitors, vCPU
Usage, instance `sfu-pqp`) reads in units of **one vCPU**: 100% means one core
busy, not the whole box. Divide by the vCPU count (4 now, 8 after the resize) to
get the box fraction, so a portal peak of 94% on this 4 vCPU box is about 0.94
cores, about 24% of the box. The graph is also a roughly 6 hour average, so it
understates a 5-minute peak: on 2026-10-25 the portal showed 94% while the
5-minute node exporter peak was 1.41 cores. It is a sanity check, not a
trigger.

**Who decides: Rafael.** The alert says "consider"; nobody resizes on an alert
alone. The decision is "yes, at 09Z tomorrow" or "not yet, because...".

**When NOT to do it** (any one of these means wait):

- A **watch party is live or booked**, or an LL session is running:
  `liveHls.sessions` or `liveHls.llSessions` above 0 on `GET /api/admin/metrics`.
  The egress and the remux read the host's room from this box, so the reboot
  ends the show.
- Any event in `docs/EVENT_RUNBOOK.md` is registered for the next hours, or the
  merge freeze (`DEPLOY_FREEZE`) is on for one.
- Outside the **09Z to 12Z trough** (06:00 to 09:00 in São Paulo, the quietest
  band, 0.1 to 0.2 cores in the review). The one exception is an incident, see
  "Resizing during an incident" below.
- The box is busy right now: more than about 10 LiveKit participants or any
  screen share in progress (the 2026-09-08 resize went at 1 participant; the
  go/no-go that day was "at most 4").
- Another change is in flight on the same box (a LiveKit version bump, the
  egress or remux deploys, a TURN certificate renewal).

### Resizing during an incident

Same steps, no trough. First prove the cause is the CPU: the busy fraction on
the **pqp SFU box** dashboard is above about 0.85, or `load5` is above the core
count. If CPU is fine and tx is high or loss is high with CPU low, a bigger
box does not help: see section 9 and `docs/CAPACITY.md` section 1c. A resize
mid-evening drops every LiveKit call for about a minute, so say so in the QG
first if there is time.

---

## 2. Access and credentials

What you need, none of it in git:

| What | Where | How |
|---|---|---|
| Vultr API key | `VULTR_API_KEY` in `~/.config/pqp/vultr-test.env` | `set -a; . ~/.config/pqp/vultr-test.env; set +a`. Never `echo` it, never paste it into a ticket |
| Instance id of `sfu-pqp` | **not stored.** As of 2026-10-25 that file holds only the key | look it up by label (command below) |
| ADMIN_METRICS_TOKEN | `ADMIN_METRICS_TOKEN` line of the root `.env` in the main checkout | read into a variable, never printed (command below) |
| SSH to the box | `ssh root@sfu.pqp.gg`; password login is off, key only; the second key is the break-glass key described in `~/.config/pqp/sfu-breakglass.README.txt` | `ssh -i ~/.config/pqp/sfu-breakglass root@sfu.pqp.gg` if the usual key fails |
| Grafana read | `GRAFANA_URL`, `GRAFANA_SA_TOKEN` in `~/.config/pqp/grafana.env` | same `set -a` pattern |

**Warning about the instance id.** `~/.config/pqp/staging-sfu-instance.env` also
defines a variable called `VULTR_INSTANCE_ID`: it is the id of the **throwaway
staging SFU**, not production. Do not source that file in the same shell, and
check the label before every write.

**The Vultr API is IP restricted.** A new address answers
`401 Unauthorized IP address: <ip>` (this stopped the 2026-10-22 review for a
day). Find the caller's address and make sure it is on the key's access control
list (Vultr dashboard, Account, API, a write only Rafael can do):

```bash
curl -s4 https://www.cloudflare.com/cdn-cgi/trace | grep '^ip='
```

Set up the shell (read-only so far):

```bash
set -a; . ~/.config/pqp/vultr-test.env; set +a
export VULTR_INSTANCE_ID=$(curl -s -H "Authorization: Bearer $VULTR_API_KEY" \
  "https://api.vultr.com/v2/instances?per_page=50" \
  | jq -r '.instances[] | select(.label=="sfu-pqp") | .id')
# must print exactly one id of 36 characters; empty means a 401 (see above)
echo "${#VULTR_INSTANCE_ID}"

T=$(grep '^ADMIN_METRICS_TOKEN=' <main-checkout>/.env | cut -d= -f2- | tr -d '"')
```

(Cloudflare answers 403 to some default client user agents; `-A pqp-ops/1` on
the admin calls below is what the other operator scripts send.)

---

## 3. Pre-checks

Do all of them. About five minutes. Stop at the first red one.

**1. Occupancy now.** There is no repo helper for this today: the
`voice-occupancy.sh` that older docs name was a Fly-only script
(`fly ssh console -a pqp-api`), is not in the repository, and the Fly apps run
zero machines. Read the same numbers from the API:

```bash
curl -s -A pqp-ops/1 -H "Authorization: Bearer $T" https://api.pqp.gg/api/admin/metrics \
  | jq '{people_all_paths: .voice.participants, rooms: .voice.activeRooms, largest: .voice.largestRoomNow,
         sfu_people: .sfu.participants, sfu_rooms: .sfu.rooms, sfu_ok: .sfu.reachable,
         hls_sessions: .liveHls.sessions, ll_sessions: .liveHls.llSessions}'
```

Go: `hls_sessions` is 0, `ll_sessions` is 0, `sfu_people` is at most about 10,
`sfu_ok` is true. `people_all_paths` counts mesh rooms too, which the reboot does
not touch, so it can be higher. The day's peaks, minute by minute, are on
`GET /api/admin/voice-occupancy` (same token). Cross-check on the box:
`ssh root@sfu.pqp.gg "curl -s localhost:6789/metrics | grep '^livekit_participant_total'"`.

**1b. Sanity check against the Vultr portal.** Open Server Monitors, vCPU Usage
for `sfu-pqp` and note the last evening's peak. Read it as percent of one vCPU
divided by the core count, and as a 6 hour average (see "How to read the Vultr
portal graph" in section 1). It should be in the same ballpark as the node
exporter's evening average, and below its 5-minute peak. A big disagreement is
a reason to look at the exporter, not a trigger.

**2. `/ready` is green, and the region boxes are too** (they are not touched, but
a red one means somebody else is mid-incident):

```bash
curl -s -A pqp-ops/1 https://api.pqp.gg/ready | jq '{ok, livekit: .checks.livekit.ok, regions: .checks.livekitRegions}'
```

Expect `ok: true`, `livekit: true`, `mia` and `lhr` ok.

**3. The upgrade is offered, and what it costs.** This is the check that tells
you the plan name has not changed and the price has not moved:

```bash
curl -s -H "Authorization: Bearer $VULTR_API_KEY" \
  "https://api.vultr.com/v2/instances/$VULTR_INSTANCE_ID/upgrades" \
  | jq '.upgrades.plans_available[] | select(.id=="vhp-8c-16gb-amd")'
```

Expect `vcpu_count: 8`, `ram: 16384`, `disk: 350`, `bandwidth: 8192`,
`pricing_rate: 144` (a month, São Paulo price, VAT not included). Also confirm
the instance is the right one and what it is today:

```bash
curl -s -H "Authorization: Bearer $VULTR_API_KEY" "https://api.vultr.com/v2/instances/$VULTR_INSTANCE_ID" \
  | jq '.instance | {label, plan, vcpu_count, ram, disk, power_status, features}'
```

Expect label `sfu-pqp`, plan `vhp-4c-8gb-amd`, `vcpu_count` 4, `power_status`
`running`, features without `auto_backups` (backups are off on purpose, see
section 4). No Vultr firewall group is attached to this instance (`ufw` on the
box is the only filter), so there is nothing to edit there.

**4. Where the month's transfer stands.** The plan allowance changes with the
plan (6,144 GB a month on 4c, 8,192 GB on 8c, per `GET /v2/plans`), and the
alerts on it are percentages of a gauge that nothing updates by itself (section
7). Note today's reading for the "after" comparison:

```bash
ssh root@sfu.pqp.gg 'vnstat -i enp1s0 -m | tail -6'
```

or in Grafana, `pqp_sfu_egress_month_tx_bytes` and `pqp_sfu_egress_allowance_bytes`.

**5. Confirm what must not change.** The resize does not touch the LiveKit key
pair, so `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` on the API
stay valid and **no API restart is involved**. The region boxes `mia` and `lhr`
are separate Vultr instances with their own key pairs (`LIVEKIT_API_KEY_<ID>`)
and are not touched. Nothing in `/opt/pqp/.env` is edited by this procedure. If
a step below ever asks you to edit it, stop: you are doing something else.

**6. Back up the box's own state.** The box is disposable by design
(`docs/plans/SELF_HOSTED_LIVEKIT.md` section 4, "Backups": a Vultr snapshot is
deliberately not used, it would take longer than the reboot it protects
against). What is worth a copy is the config:

```bash
ssh root@sfu.pqp.gg 'S=$(date -u +%Y%m%dT%H%MZ); cp -a /opt/livekit /root/opt-livekit-before-8c-$S && ufw status numbered > /root/ufw-before-8c-$S.txt && echo "backup $S done" && ls /root | grep before-8c'
```

---

## 4. The change

The port range goes first, **before** the resize. This is the one thing the old
4c procedure does not say, and it matters: LiveKit binds one UDP mux socket per
core, but only up to the number of ports in `rtc.udp_port`, and ours is
`7882-7885`, four ports. `tools/sfu/livekit.yaml.tmpl` says it in as many words:
"Keep this at or above the vCPU count." Leave it and the 8c box runs eight
cores on four sockets, which is the shape the 2026-09-07 measurement showed
queueing on one socket long before the cores were busy (`docs/CAPACITY.md`
section 1, "the failure at scale was the single UDP mux socket"). The reboot of
the resize restarts the container anyway, so editing the file first costs no
extra interruption: the container comes back up already reading the wide range.
(Even if something restarted the container before the resize, eight ports on
four cores is harmless: LiveKit binds the smaller number.)

**Step 1. Widen the UDP range and the firewall.** On the box:

```bash
ssh root@sfu.pqp.gg
# the file is mode 0600 root, and holds the key pair: do not cat it into a log
sed -i 's/^  udp_port: 7882-7885$/  udp_port: 7882-7889/' /opt/livekit/livekit.yaml
grep -n 'udp_port' /opt/livekit/livekit.yaml        # expect 7882-7889 and the turn block's 3478
ufw allow 7882:7889/udp
ufw status | grep 7882
```

Then update `tools/sfu/livekit.yaml.tmpl` and `tools/sfu/install.sh` in the repo
to `7882-7889` in the same follow-up PR as section 7, so a rebuild matches.
(There is no Vultr firewall group to edit, see pre-check 3.)

Do not restart the container now. The next boot is the restart.

**Step 2. The resize.** From the Mac, with the shell from section 2:

```bash
curl -s -X PATCH -H "Authorization: Bearer $VULTR_API_KEY" -H "Content-Type: application/json" \
  -d '{"plan":"vhp-8c-16gb-amd"}' \
  "https://api.vultr.com/v2/instances/$VULTR_INSTANCE_ID" | jq '.instance | {label, plan, status, power_status}'
```

Write the time down (UTC). **I could not read Vultr's own API documentation for
this call while writing this runbook (the pages answered 403 and 404 to a
fetch), so what follows is what the 2026-09-08 resize of this same box
observed plus what `/upgrades` lists, not a quote from Vultr:**

- Vultr **reboots the instance** to apply the plan. There is no CPU hot add.
  Measured on 2026-09-08 for 2c to 4c: last log line 09:25:48Z, first
  `participant active` 09:26:30Z, so **about 42 seconds**. Budget two minutes,
  the bigger plan boots the same Ubuntu with more to size.
- **The IP does not change.** The box has answered at the same address since
  the 2026-09-07 rebuild through the 09-08 resize, `sfu.pqp.gg` and
  `turn.pqp.gg` are DNS only records pointing straight at it
  (`docs/plans/SELF_HOSTED_LIVEKIT.md`, "DNS on Cloudflare"), and no DNS change
  was made. Check it anyway in the post-checks.
- **The disk grows, and cannot shrink.** `/upgrades` lists 350 GB for the 8c
  plan (180 GB today). On 2026-09-08 the root filesystem grew on its own
  (94 GB to 169 GB) with no manual step. This is the reason there is no way
  back, section 8.
- **Transfer allowance changes** from 6,144 GB to 8,192 GB a month (plan table).
  Vultr bills the new plan from the resize on; I did not verify how it
  prorates the first month, so read the pending charges afterwards.
- Everything on the box's disk stays: `/opt/livekit`, the Caddy volume (the TLS
  certificates), `/var/lib/vnstat`, the journal.

If the call returns an error instead of the instance, nothing happened. A 401
is the IP list (section 2). Do not retry in a loop: read the instance back first
with the `GET` from the pre-checks.

**Step 3. Wait, then run the post-checks.**

```bash
until curl -s -o /dev/null -w '%{http_code}\n' https://sfu.pqp.gg/ | grep -q 200; do sleep 5; done; date -u
```

LiveKit answers its HTTP root with 200 once it is up (Caddy in front, TLS from
the stored certificate). Then section 6.

---

## 5. What people see, and what is not covered

**Every call on the home SFU drops, for about a minute, and comes back.**

- The API is not restarted (no `restarts-api`, no `drops-voice` label: nothing
  in git changes the API) and **`/ws` stays up**: chat, presence and signaling
  go on. Only the media connection to this box goes away.
- A browser or desktop client in a LiveKit room has the LiveKit client's own
  reconnect logic (`client/src/lib/livekit-session.ts`: a `ReconnectPolicy`
  based on LiveKit's default, `Reconnecting`, `SignalReconnecting`,
  `Reconnected` hints). A short outage is a reconnect with the same peer id.
  The seat does not move: the room and the `join-voice-room.resume` token
  (`docs/voice-backends.md`, "Resume lands anywhere") are API-side and the API
  is alive. The room itself on LiveKit is recreated by the first participant
  that rejoins (`room.auto_create: true` in the box's config).
- **What I could not verify:** whether a client whose LiveKit connection gives
  up before the box is back (after a first retry spread by `drainJitterMs`, the
  client uses LiveKit's own default backoff, which as I remember it runs for
  about 40 seconds, the same length as the outage) rejoins on its own, or needs the
  person to hang up and join again. In `livekit-session.ts` a final
  `RoomEvent.Disconnected` only clears the local streams; I did not find code
  that starts a new join from it. Plan for "most people are back within about a
  minute, a few need to rejoin the call", which is also how the 2026-09-07
  restart of the container went ("users reconnected within about a minute").
  The first resize with 8c in the log is the chance to measure it: count
  `participant active` lines in the minute after the reboot against the
  participant count before.
- iOS in a LiveKit room declares `resume` and keeps its session on a `/ws`
  blip, but this is a media loss, not a `/ws` loss. Same caveat as above.

**Not covered, and not affected:**

- **Mesh rooms** (DM calls and servers under ten members) never touch the SFU.
  They are unaffected.
- **`mia` and `lhr` rooms** (`sfu-mia.pqp.gg`, `sfu-lhr.pqp.gg`) are separate
  boxes. Unaffected.
- **Watch parties and egress** run against this home box (the only one they
  ever use). **None may be live**, that is a hard gate in section 1. A party
  running through the reboot loses its host room and its ladder.
- **TURN** for SFU rooms is LiveKit's own embedded TURN on this box: UDP 3478 and
  TURN/TLS **5349** (the single IP decision of 2026-09-06; not 443). It goes
  down and comes back with the container.

**Comes back by itself after the reboot** (what I checked in the files, and what
the 2026-09-08 reboot proved):

| Piece | Why it returns | Verified how |
|---|---|---|
| `livekit` and `caddy` containers | `restart: unless-stopped` in `tools/sfu/docker-compose.yaml`, and `docker` is `enabled` by `tools/sfu/install.sh` | files, and observed on 2026-09-08 ("the compose stack came back on its own") |
| ports, `sysctl` buffers, `ufw` rules | files in `/etc/sysctl.d/90-livekit.conf`, `ufw --force enable` persists | observed on 2026-09-08 |
| TURN | same container | files; TURN listening is in the post-checks |
| TURN cert sync | `turn-cert-sync.timer` is enabled by the installer | files only |
| Alloy (which carries node exporter and the textfile collector and scrapes LiveKit's `:6789`), `vnstat`, `pqp-box-metrics.timer`, `fail2ban` | each is `systemctl enable --now` in `tools/sfu-monitoring/install.sh` and `tools/sfu/install.sh` | **files only. The 2026-09-08 note does not record them, so confirm in the post-checks that `up{box="sfu-pqp"}` returns** |
| `livekit-docker.service` | it is `enabled` but has never been started, the containers return through Docker's restart policy, not through it | `tools/sfu/README.md`; irrelevant to the reboot |

What I could **not** verify: that nothing on the box was changed by hand since
the installer last ran (nobody can, without logging in), and how long Alloy
takes to resume remote write after the boot. The post-checks are written so
that a missing piece is found in minutes.

---

## 6. Post-checks

In this order. Expected values in the comment.

```bash
# 1. the box: 8 cores, ~16 GB, bigger disk, and it did reboot
ssh root@sfu.pqp.gg 'nproc; free -m | sed -n 2p; df -h / | tail -1; uptime -s'
#    8 | total about 16000 | / about 350G | boot time a minute or two ago

# 2. the stack came back, the port range is wide and bound
ssh root@sfu.pqp.gg 'docker compose --project-directory /opt/livekit ps'
#    livekit and caddy: Up
ssh root@sfu.pqp.gg 'docker logs --since "$(uptime -s)" livekit-livekit-1 2>&1 | grep -m1 "starting LiveKit server" | grep -o "rtc.portUDP[^}]*}"'
#    rtc.portUDP":{"Start":7882,"End":7889}   (--since matters: the log keeps older boots, with the old range)
ssh root@sfu.pqp.gg "ss -lnup | grep -oE ':788[0-9]' | sort -u | tr '\n' ' '; echo"
#    :7882 :7883 :7884 :7885 :7886 :7887 :7888 :7889  (eight: one per core)
ssh root@sfu.pqp.gg 'docker logs --since "$(uptime -s)" livekit-livekit-1 2>&1 | grep -c "receive buffer is too small"'
#    0   (the sysctl file survived)
ssh root@sfu.pqp.gg "ss -lntup | grep -E ':(3478|5349) ' | wc -l"
#    at least 2: TURN/UDP and TURN/TLS listening
ssh root@sfu.pqp.gg 'ufw status | grep -E "7882|5349|3478"'
#    the rules are intact, including 7882:7889/udp
ssh root@sfu.pqp.gg 'for i in 1 2 3; do awk "NR>1 && \$13>0" /proc/net/udp; sleep 10; done'
#    prints nothing: no receive-buffer drops (only meaningful once people are back)
```

```bash
# 3. same address, and the API sees it
dig +short sfu.pqp.gg turn.pqp.gg           # unchanged from before the resize
curl -s -A pqp-ops/1 https://api.pqp.gg/ready | jq '.checks.livekit'       # {"ok":true,...}
curl -s -A pqp-ops/1 -H "Authorization: Bearer $T" https://api.pqp.gg/api/admin/metrics \
  | jq '{ok: .ready.ok, sfu_ok: .sfu.reachable, sfu_people: .sfu.participants, sfu_rooms: .sfu.rooms}'
#    true | true | climbing back toward the number you wrote down before
```

```bash
# 4. Prometheus (read only): source ~/.config/pqp/grafana.env first
q() { curl -sG "$GRAFANA_URL/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query" \
        -H "Authorization: Bearer $GRAFANA_SA_TOKEN" --data-urlencode "query=$1" | jq -c '.data.result[] | [.metric, .value[1]]'; }
q 'up{box="sfu-pqp"}'                                              # two series, both 1
q 'count(node_cpu_seconds_total{box="sfu-pqp",mode="idle"})'       # 8 (a few minutes after boot)
q 'node_memory_MemTotal_bytes{box="sfu-pqp"}'                      # about 1.6e10
q 'node_network_transmit_bytes_total{box="sfu-pqp",device="enp1s0"}'   # exists: the tx alert names this interface
q 'livekit_participant_total{box="sfu-pqp"}'                       # back above 0 as people rejoin
q 'pqp_sfu_egress_month_tx_bytes{box="sfu-pqp"}'                   # present, not reset: vnstat kept its database
```

If `up{box="sfu-pqp"}` is missing after 10 minutes, Alloy did not come back:
`ssh root@sfu.pqp.gg 'systemctl status alloy --no-pager | head -20'`, and
`systemctl start alloy` (`tools/sfu-monitoring/README.md`).

**5. A real call.** Production ignores the dev auth bypass, so use two real
accounts (Rafael's laptop and phone): join a voice channel in a server that is
pinned to LiveKit (a listed community or a server of ten or more members, the
QG), hear each other within 5 seconds, share a screen for ten seconds. Then
the kick test from `docs/plans/SELF_HOSTED_LIVEKIT.md` section 5 if time allows:
it is the one that exercises the RoomService path from the API to the box.
`docker logs -f livekit-livekit-1 | grep 'participant active'` on the box shows
each arrival.

**6. Participants rejoin.** Within ten minutes `sfu_people` is back to within
roughly the number before. If it is clearly lower and stays lower, some clients
did not rejoin on their own (section 5): that is information, not an incident
in the trough.

**7. The transfer gauge.** `pqp_sfu_egress_month_tx_bytes` continues without a
reset (vnstat's database is on disk). `pqp_sfu_egress_allowance_bytes` still
says the 4c number until section 7 is done; that is expected, and until then
the `egress past 60% / 80%` alerts compare against the old allowance.

**8. Grafana alerts quiet.** Alerting, rules, group `pqp-sfu-box`:
`sfu box: a docker container restarted` (`changes(pqp_sfu_container_started_seconds[10m])`)
**will fire once**, that is the reboot, resolve it by reading it. `sfu box: no
metrics for 10m` and `LiveKit metrics unreachable for 10m` must not fire (the
outage is shorter than 10 minutes). Anything else firing: look before
declaring done. From a shell:
`q 'count by (alertname)(GRAFANA_ALERTS{alertstate="firing"})'`.

Write the result in a line in the PR or the handover: time of the PATCH, time
`https://sfu.pqp.gg/` answered 200, participants before and after.

---

## 7. After: what to update

Same day, in one follow-up PR (docs, monitoring config and `tools/sfu` only, no
API restart):

1. **`docs/CAPACITY.md`** section 2 table: "Media server" row says 8 vCPU, 16 GB
   since the date and time of the PATCH, and "Media ports" says
   `7882-7889`. Add a line to the Timeline.
2. **`tools/sfu/livekit.yaml.tmpl`**: `udp_port: 7882-7889`, and the comment
   about "a resize picks the rest up" updated. **`tools/sfu/install.sh`**:
   `ufw allow 7882:7889/udp`, and the matching text in
   `docs/plans/SELF_HOSTED_LIVEKIT.md` (table of ports, firewall block).
3. **Add a line under "Applied to production"** in
   `docs/plans/SELF_HOSTED_LIVEKIT.md` section 4, "Resize the box", the way the
   2026-09-08 one reads: time, occupancy at the time, downtime in seconds, what
   `nproc` said, backup directory.
4. **The capacity review note's plan field** (operator copy,
   `~/.config/pqp/ops/capacity-review-2026-10-22.md`, summary row for
   `sfu-pqp`): "SAO `vhp-8c-16gb-amd` since <date>", cost $172.80 a month with
   VAT, and the next trigger below. Do not edit the repo for this one: the
   number lives in the operator copy.
5. **The transfer allowance gauge.** `PQP_EGRESS_ALLOWANCE_BYTES` in
   `tools/sfu-monitoring/pqp-box-metrics.py` defaults to the 4c plan (about
   6.0e12). Set it to the 8c plan (8192 GB, about 8.0e12 bytes) and run
   `bash /opt/sfu-monitoring/install.sh` again as the monitoring README says
   (it never touches the containers). Until then the 60% and 80% allowance
   alerts are wrong in the unsafe direction. (The 2026-10-22 review also found
   they are false alarms while Vultr pools transfer across the account: ask Vultr
   once, in writing.)
6. **Absolute thresholds that assumed 4 cores** and are not in the capacity
   file because they live in the Grafana UI: the rule `sfu box: load average
   above 6 for 10m` (`node_load5`, change to about 12) and the **pqp SFU box**
   dashboard's load panel (orange at 4, red at 6; double both, as
   `tools/sfu-monitoring/README.md` says). The CPU rules in `pqp-capacity` and
   `sfu box: CPU above 85%` are fractions and scale on their own.
7. **Re-read the two absolute capacity alerts.** `LiveKit participants above
   240` and `transmit above 600 Mbit/s` do not move with the core count. After a
   resize the participants number is no longer the trigger it was (8c has
   about double the cores); either double it in the capacity file (to about
   480, a PR that edits one number and the annotation) or leave it as a "look
   at it" alert. The tx threshold is the network, which a bigger CPU does not
   change, so it stays.
8. **The next trigger, for 8c:** the same shape, scaled. Evening 5-minute CPU
   busy fraction above **0.60** (about **4.8 of 8 cores**) on 3 evenings is the
   next decision point, and the rules in `pqp-capacity` already say it because
   they are fractions. There is no bigger in-place plan worth naming:
   `/upgrades` offered `vhp-12c-24gb-amd` as well on 2026-10-25, and past 8c
   the answer is section 9.
9. **The video admission budget does not change by itself.**
   `VOICE_PROMOTION_MAX_SFU_MBPS` (600) is a software constant, measured for the
   4c box, and the 2026-10-22 review said to recalibrate it from a week of
   evidence, not hardware. Do not bump it in the same window, and never as part
   of this procedure (it is an API restart).

---

## 8. It cannot be undone

Vultr offers no in-place downsize: `/upgrades` listed only larger plans on every
check (2026-10-03, 2026-10-22 and 2026-10-25), and the reason is the disk, which
grows to 350 GB and cannot shrink. **Rollback means a rebuild**, not a button:

1. Provision a new `vhp-4c-8gb-amd` in São Paulo (new IP).
2. Run the installer from this repository: `docs/plans/SELF_HOSTED_LIVEKIT.md`
   **section 7** ("Rebuilding the box from scratch"), which is the runbook for
   exactly this: key pair copied off the old box first so the API's three
   `LIVEKIT_*` values stay valid, `tools/sfu/install.sh`, `tools/sfu-monitoring/`.
3. Repoint DNS on Cloudflare, both **DNS only (grey cloud)**: `sfu.pqp.gg` and
   `turn.pqp.gg` to the new IP.
4. Every call on the box drops at the cutover, so do it in the trough, with no
   party.

It saves $86.40 a month and costs a cutover. Not worth it unless the money
matters more than an evening, which the review does not expect.

---

## 9. After 8c

CPU is the cheap, boring constraint; the things a bigger box does **not** fix
are the network path (transmit has a ceiling measured in September, operator
copy), the monthly transfer (a bill, not a cliff, `docs/CAPACITY.md` section 6b),
and "it is one machine": a reboot, a bad kernel or a provider incident takes
every LiveKit room with it.

The next step when 8c is not enough, or when the resilience matters more than
the headroom, is **a second SFU in São Paulo registered as another region id**
(`LIVEKIT_REGIONS`, the mechanism `mia` and `lhr` already use,
`docs/voice-backends.md` and `docs/plans/SFU_REGIONS.md`), with its own key pair,
its own `/ready` check and its own exporter. Rooms stay pinned to one box for
their lifetime (a room fits one node), Postgres stays the only shared store,
and there is **no Redis and no LiveKit multi-node**: both were decided against
on 2026-10-22 and 2026-10-25. This is a later resilience project, not part of
this runbook, and nothing here designs it. The 2026-10-22 review's one line on
it: it splits rooms, not one big room.
