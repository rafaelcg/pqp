# SFU box monitoring

Everything that watches the self-hosted LiveKit box (Vultr, São Paulo,
`216.238.114.79`, serving `sfu.pqp.gg` and `turn.pqp.gg`). The prose version,
including the thresholds and why each choice was made, is in
[`docs/MONITORING.md`](../../docs/MONITORING.md) under "The SFU box".

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
