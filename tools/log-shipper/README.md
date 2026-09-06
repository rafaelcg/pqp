# pqp-log-shipper

Forwards `pqp-api` logs from Fly to Grafana Cloud Loki so dashboards and
alert rules can run on application events. The full picture (what is
monitored, LogQL patterns, cost) is in [`docs/MONITORING.md`](../../docs/MONITORING.md),
section "Logs in Grafana Cloud (Loki)".

It is the official [`superfly/fly-log-shipper`](https://github.com/superfly/fly-log-shipper)
image (Vector reading the org's NATS log stream). Nothing here is built; the
repo only holds the `fly.toml` and this note.

## Secrets (set once, never committed)

| Name | Value |
|---|---|
| `ORG` | `personal` (the Fly org slug) |
| `ACCESS_TOKEN` | a Fly org read-only token: `fly tokens create readonly --org personal --name pqp-log-shipper-nats --expiry 8760h`. Set the output verbatim, **including the `FlyV1 ` prefix and its space**; stripping the space gives `NATS Connect Error: unexpected line while connect` |
| `LOKI_URL` | the stack's Loki host, `https://logs-prod-024.grafana.net` (the `url` of the `grafanacloud-logs` datasource; the image appends `/loki/api/v1/push`) |
| `LOKI_USERNAME` | the hosted-logs user id, `1777547` (`basicAuthUser` of that datasource) |
| `LOKI_PASSWORD` | a grafana.com **Access Policy token** with scope `logs:write`. Only the org owner can create it: grafana.com > My Account > Security > Access Policies > Create access policy (realm: the stack, scope `logs:write`) > Add token. A stack service-account token does **not** work here; the push endpoint authenticates against grafana.com, not the Grafana instance. |

All five were set and the app deployed on 2026-09-06. To rotate the Loki token:

```bash
fly secrets set -a pqp-log-shipper LOKI_PASSWORD='<access policy token>'
cd tools/log-shipper && fly deploy
```

## Check it works

```bash
fly logs -a pqp-log-shipper          # Vector should not print 401s from Loki
```

Then in Grafana, Explore, datasource `grafanacloud-logs`:
`{fly_app_name="pqp-api"} |= "[pqp]"`. Lines carry the labels `fly_app_name`, `fly_app_instance`,
`fly_region`, `event_provider` and `level`. The line body is the Vector JSON
envelope with the log text in `message`; substring filters still match it.

## Rotation

The Fly token expires after one year (`--expiry 8760h`). `fly tokens list`
shows the date; recreate it and `fly secrets set -a pqp-log-shipper ACCESS_TOKEN=...`
(that restarts only the shipper, never `pqp-api`).
