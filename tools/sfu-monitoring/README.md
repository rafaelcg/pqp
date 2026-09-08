# SFU box monitoring

Everything that watches the self-hosted LiveKit box (Vultr, São Paulo,
`216.238.114.79`, serving `sfu.pqp.gg` and `turn.pqp.gg`). The prose version,
including the thresholds and why each choice was made, is in
[`docs/MONITORING.md`](../../docs/MONITORING.md) under "The SFU box". The box
itself, every config file on it and the installer that rebuilds it from a fresh
Ubuntu image, is next door in [`tools/sfu/`](../sfu/); that installer calls this
one at the end, so a rebuild comes up already monitored.

| File | Role |
|---|---|
| `install.sh` | Idempotent installer. Run it on the box as root. Never touches the livekit or caddy containers, so it cannot interrupt a call. |
| `config.alloy` | Grafana Alloy: node exporter + textfile collector + a scrape of LiveKit's own `:6789`, remote-written to Grafana Cloud. Installed at `/etc/alloy/config.alloy`. |
| `pqp-box-metrics.py` | Writes two textfile metric files every minute: monthly egress from vnstat, and docker container state. Installed at `/usr/local/bin/pqp-box-metrics`. |
| `pqp-box-metrics.service` / `.timer` | The systemd timer that runs it. |

## Install or update

```bash
scp -r tools/sfu-monitoring root@216.238.114.79:/opt/
ssh root@216.238.114.79 'bash /opt/sfu-monitoring/install.sh'
```

First run only (or to rotate the credential), prefix the remote command with
`GC_PROM_USER=3563744 GC_PROM_TOKEN=<metrics:write token>`. The token is the
grafana.com Access Policy token stored locally as `GRAFANA_LOGS_WRITE_TOKEN`
in `~/.config/pqp/grafana.env`; it carries both `logs:write` and
`metrics:write`. It is written to `/etc/alloy/credentials.env` (0600, root)
and is never in this repo.

## Check it is working

```bash
ssh root@216.238.114.79 'systemctl is-active alloy pqp-box-metrics.timer'
ssh root@216.238.114.79 'cat /var/lib/node_exporter/textfile_collector/*.prom'
ssh root@216.238.114.79 'curl -s localhost:12345/metrics | grep remote_storage_samples_total'
```

Then look for the numbers in Grafana rather than trusting the config:
https://smallkestrel237.grafana.net/d/pqp-sfu-box

## Changing the transfer allowance

`PQP_EGRESS_ALLOWANCE_BYTES` in `pqp-box-metrics.py`, then reinstall. The
alerts are percentages of whatever that gauge says, so they need no edit.

**Resizing the box changes the allowance and nothing here notices.** The plan
includes the transfer, so moving between plans silently invalidates this
number, in the unsafe direction if the new plan is smaller. Read the real
figure from the Vultr API rather than the pricing page:

```
curl -s -H "Authorization: Bearer $VULTR_API_KEY" \
  https://api.vultr.com/v2/plans?per_page=500 | jq '.plans[] | select(.id=="vhp-4c-8gb-amd")'
```

`bandwidth` there is the full month in GB. `allowed_bandwidth` on the instance
itself is the prorated amount accrued so far this billing period, which is what
Vultr actually measures an overage against, so it is the lower and stricter of
the two early in a month.

The dashboard's load-average thresholds also assume a core count. They are set
for the 4 vCPU plan: orange at 4 means fully busy, red at 6 means work is
queueing. Halve them on a 2-core box.
