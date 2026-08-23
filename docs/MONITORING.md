# Monitoring and alerting

pqp is run by one person with no ops team and no paid monitoring. This document
describes what watches production, where alerts land, how to silence one, and —
most importantly — **what is not automated**, so nobody mistakes this page for
coverage it does not have.

Everything here costs nothing and runs on GitHub Actions, which is free and
unmetered because [rafaelcg/pqp](https://github.com/rafaelcg/pqp) is a public
repository.

---

## Where alerts land: GitHub Issues

**A failing check opens an issue in this repo.** That issue emails the repo
owner and pushes a notification to the GitHub mobile app, so it reaches a phone
without anyone watching a dashboard.

Why this and not something else:

| Channel | Verdict |
|---|---|
| **GitHub Issues** | **Chosen.** Free and unmetered on a public repo. Notifies by email *and* mobile push. The issue thread is the incident history, permanently and searchably. And github.com is a separate failure domain from Fly and Cloudflare, so it still works during the outage it is reporting. |
| Email to `contato@pqp.gg` | Rejected: **it currently bounces.** Cloudflare Email Routing has the DNS records but no verified destination address, so alerts would be written into a black hole — the worst possible outcome, because it *looks* like it works. |
| A webhook into pqp itself | Rejected as circular. pqp has Discord-compatible incoming webhooks, but "the API is down" is the single most likely alert, and the API would be the thing delivering it. It fails exactly when it matters. |

### The no-crying-wolf rules

An alert that fires spuriously gets muted, and then the real one is missed. So:

1. **Every probe retries before it alerts.** Three attempts spread over ~40
   seconds. This is not politeness — `fly.toml` uses a rolling deploy with
   `max_unavailable = 1` on a single machine, so *every legitimate release*
   makes these probes fail for a few seconds. One dropped packet, one GC pause
   and one deploy all fall inside the retry window; a real outage does not.
2. **One open issue per check, ever.** Found by a hidden marker in the issue
   body, so retitling an issue mid-incident does not spawn a duplicate.
3. **Continued failure comments at most once every 6 hours** (72 hours for the
   daily checks). A restated quota is not more urgent than a stated one.
4. **Recovery closes the issue automatically**, with a comment.
5. **A check that could not run is `SKIP`, never a pass and never a failure.** A
   missing credential must not look like health, and must not close a live
   incident either.
6. **A failing check does not fail the workflow run.** The alert is the issue; a
   red X would be a second notification for the same thing, and a permanently
   red Actions tab is how people stop looking. A run only goes red when the
   *monitor itself* is broken — which GitHub then emails about, and that is the
   last line of defence.

---

## What is watched

### Availability — every 10 minutes

`.github/workflows/monitor-uptime.yml` → `node scripts/monitor/run.mjs availability`

| Check | Passes when | Why it exists |
|---|---|---|
| `api-health` | `https://api.pqp.gg/health` returns 200 with `ok:true` | The endpoint does a real `SELECT 1`, so a 200 means process **and** database. The reported `version` is the deployed commit. |
| `web-app` | `https://pqp.gg` returns 200 | The SPA on Cloudflare Pages. |
| `websocket` | `wss://api.pqp.gg/ws` upgrades (101) and answers an invalid auth frame with close code 4401 | **The one a plain HTTP check misses.** Chat, presence and voice signalling all ride this socket; `/health` can be green while every WebSocket is dead. That is CLAUDE.md pitfall #9, verbatim. Needs no credential — an invalid token is enough to prove the upgrade, the message loop and the Clerk call all work. |
| `fly-machines` | exactly **1** machine, `started`, in `gru` | A correctness invariant, not capacity. The server keeps WebSocket state, presence, voice rooms and rate-limit buckets in process memory with no pub/sub, so a second machine silently splits the userbase with no error anywhere. The deploy workflow asserts this at release time; this asserts it continuously, because a stray `fly scale count 2` or a machine Fly recreates after a host failure never goes through a deploy. |
| `status-components` | no component in `/status.json` is `degraded` or `down` | Bridges the app's own probes (`server/src/services/status.ts`, sampled every minute) to a notification. Without it, the status page is something you have to remember to look at. `disabled` components are ignored — off on purpose is not broken. |

> **Detection time is 10–30 minutes, not 10.** GitHub's cron minimum is 5
> minutes, but scheduled runs on public repos are queued at low priority and are
> routinely late. Shortening the interval does not help.

### Certificates, domain and quotas — daily at 11:17 UTC

`.github/workflows/monitor-limits.yml` → `node scripts/monitor/run.mjs limits`

| Check | Threshold | Limit and its source | Automatable? |
|---|---|---|---|
| `tls-expiry` | warn ≤ 21 days, fail ≤ 7 | `pqp.gg`, `www.pqp.gg` (Cloudflare / Google Trust Services), `api.pqp.gg` (Fly / Let's Encrypt) | **Yes**, no credential needed. Both issuers renew at 30 days out, so 21 means one automatic attempt has already failed. |
| `domain-registration` | status must be `Active`, nameservers must be Cloudflare's; warn 30 days before the annual fee date | WHOIS at `whois.gg`. **`.gg` has no RDAP service** (absent from `data.iana.org/rdap/dns.json`), and `.gg` names have no expiry date — they are *"registered until cancelled"* with a registry fee due each 7 August. | **Yes**, no credential needed. There is no countdown to read, so the check watches the *status* instead: auto-renew failing (an expired card at Porkbun — the normal way a domain is lost) shows up as the status leaving `Active` long before DNS stops resolving. |
| `postgres-disk` | warn 70%, fail 85% | **10 GB**, from `fly mpg status <cluster> --json` → `"disk": 10` (Fly Managed Postgres, Basic plan) | **Yes, with a new token.** The cluster only has a private 6PN address, so the size comes from `pg_database_size` through a `fly mpg proxy` tunnel. Needs an **org-scoped** Fly token — see below. |
| `r2-usage` | warn 70%, fail 85% | **10 GB storage, 1,000,000 Class A, 10,000,000 Class B per month**, from [developers.cloudflare.com/r2/pricing](https://developers.cloudflare.com/r2/pricing/). Egress is free at every tier, so there is nothing to watch there. | **Yes, if the token allows it.** Cloudflare GraphQL analytics; needs `Account Analytics: Read`. |
| `pages-builds` | warn 70%, fail 85% | **500 builds/month**, from [developers.cloudflare.com/pages/platform/limits](https://developers.cloudflare.com/pages/platform/limits/) | **Yes, if the token allows it.** Counted from the deployments list — Cloudflare exposes no build counter. Needs `Cloudflare Pages: Read`. |
| `clerk-users` | warn 70%, fail 85% | **50,000 monthly retained users** on the free Hobby plan, from [clerk.com/pricing](https://clerk.com/pricing). Note the unit: MRU, not MAU — a user only counts once they return ≥24h after signing up. | **Partly.** Clerk has no MRU endpoint, so this counts *total users* — always ≥ MRU, so it can warn early but cannot miss. Optional; `CLERK_SECRET_KEY` lives only on Fly. |
| `uptime-24h` | warn below 99% | The app's own 24h component uptime from `/status.json` | **Yes**, no credential needed. Catches flapping: a dependency that dies for two minutes every hour is invisible to a 10-minute probe but shows up here. |

### Published claims and mentions — daily at 12:23 UTC

`.github/workflows/monitor-social.yml` → `node scripts/monitor/run.mjs social`

**Why this group exists.** A published Reddit comment was still telling people
screen share had no audio, weeks after that stopped being true. It was found by
chance. The support bot stops the product saying something false *inside*
pqp; this stops us leaving something false *outside* it.

| Check | What it does | Automatable? |
|---|---|---|
| `published-drift` | Re-reads every URL in `scripts/monitor/published.json` and screens it against `tools/support-bot/facts.md` — the same fact file the support bot answers from, so there is one definition of what is true. `fail` on a match. | **Yes**, no credential needed. It can only re-read posts somebody wrote down, which is why an empty `published.json` is a `skip` with instructions and not a pass. |
| `reddit-mentions` | Anonymous search for new mentions in the last 24h. `warn`, never `fail` — a mention is something to go and read, not a fault. | **Yes**, no credential. Uses `/search.rss`: `/search.json` now answers anonymous callers with a flat 403 and `old.reddit.com` 302s to a login page. RSS is rate-limited hard, which is survivable at one call a day and reported as `skip` on a 429. |
| `x-mentions` | Recent mentions of `@pqpdotgg`. | **No, not today.** X has no anonymous read path and recent search is not on the free API tier, so this `skip`s until someone pays for it and sets `X_BEARER_TOKEN`. |

**The claim table is cross-checked against the fact file.** `STALE_CLAIMS` in
`social.mjs` is hand-written, and a claim listed there could become true again —
so before screening anything, the check asks `facts.md`, and any claim the fact
file now asserts is retired for that run rather than fired. That mechanism paid
for itself on the first run: "the desktop app cannot share a screen" is true of
v0.1.0 and false of v0.1.1, `facts.md` says exactly that, and the claim was
removed rather than left as a row that retires every time and only *looks* like
coverage.

The matcher is the one piece of the monitor with real branching logic, so it is
tested (`scripts/monitor/social.test.mjs`, run by CI). The first run of those
tests found a live bug: the Portuguese `sem som` did not match, which is the
most natural way to write the exact claim the check exists to catch.

---

## Setup

The uptime workflow needs **nothing new** — it uses the built-in `GITHUB_TOKEN`
and the existing `FLY_API_TOKEN`. The limits workflow degrades gracefully: each
unconfigured check reports `SKIP` with the exact credential it wants.

To turn the remaining ones on:

### 1. Postgres volume — a new org-scoped Fly token

The existing `FLY_API_TOKEN` is a **deploy** token scoped to the `pqp-api` app,
and cannot read a Managed Postgres cluster. Create a read token for the org:

```bash
fly tokens create org --name pqp-monitor --expiry 8760h
gh secret set FLY_ORG_TOKEN            # paste it
gh variable set MONITOR_MPG_CLUSTER --body 82ylg01v4n30zx19
```

### 2. R2 and Pages — check what the stored Cloudflare token can do

`CLOUDFLARE_API_TOKEN` was created for deploys and its permissions are unknown
from here. Run the limits workflow once by hand and read the two `SKIP` lines:

```bash
gh workflow run "Monitor (limits)" -f dry_run=true
gh run watch
```

If either says the token was refused, edit it (or create a new one) at
**dash.cloudflare.com → My Profile → API Tokens** with:

- `Account` → `Account Analytics` → **Read** (R2 usage)
- `Account` → `Workers R2 Storage` → **Read** (R2 usage)
- `Account` → `Cloudflare Pages` → **Read** (build count)

> The locally-installed wrangler OAuth token is not a substitute: it carries
> `account:read`, `pages:write` and `zone:read` but no R2 or analytics scope.

### 3. Clerk (optional, low value)

50,000 MRU is a long way off for a service launched today. If you want it
anyway: `gh secret set CLERK_SECRET_KEY`.

---

## Running the checks by hand

They are dependency-free Node built-ins — no `pnpm install`, no secrets for the
availability set. This is deliberate: a check you can only exercise by pushing a
workflow and waiting for cron is a check nobody debugs.

```bash
node scripts/monitor/run.mjs availability          # print a report
node scripts/monitor/run.mjs limits --json         # machine-readable
node scripts/monitor/run.mjs availability --alert --dry-run   # show what it would do to issues

MONITOR_FLY_LOCAL=1 node scripts/monitor/run.mjs availability   # include the Fly check using your own `fly auth`
```

Useful environment variables:

| Variable | Purpose |
|---|---|
| `MONITOR_RESOLVE=api.pqp.gg=66.241.125.111` | Pin a hostname to an address, for running from a network whose resolver hijacks or NXDOMAINs the domain. |
| `MONITOR_API_ORIGIN`, `MONITOR_WEB_ORIGIN` | Point the probes elsewhere — how the failure paths get exercised. |
| `MONITOR_RETRY_DELAY_MS` | Shorten the retry spacing when testing. Leave it alone in CI. |
| `MONITOR_TLS_WARN_DAYS`, `MONITOR_WARN_FRACTION`, `MONITOR_UPTIME_FLOOR` | Threshold overrides. |
| `MONITOR_MUTED` | See below. |

## Silencing an alert

Do **not** close the issue (it reopens) and do **not** disable the workflow
(that silently drops every other check too). Instead:

```bash
gh variable set MONITOR_MUTED --body "r2-usage,pages-builds"
gh variable set MONITOR_MUTED --body ""     # unmute everything
```

Muted checks still run and are still printed in the run log — the mute is
visible on every run rather than being a setting nobody remembers changing.

To stop everything (during a planned migration, say):

```bash
gh workflow disable "Monitor (uptime)"
gh workflow enable  "Monitor (uptime)"
```

---

## NOT automated — check these by hand

An honest gap list beats a dashboard that implies coverage it does not have.
These are printed at the end of every `limits` run as well.

| What | Limit | Why it cannot be automated | Cadence |
|---|---|---|---|
| **ExpressTURN relay bandwidth** | **1,000 GB/month** on the free tier ([expressturn.com](https://www.expressturn.com/)) | ExpressTURN publishes no usage API and issues no API key. The only reading is the account page. This is the quota most likely to actually bite: TURN relays *all* audio for cross-NAT peers. | Monthly, and after any busy voice weekend |
| **Clerk MRU** | 50,000 monthly retained users | The Backend API exposes a user count but not an MRU count. The automated check uses total users as a conservative proxy. | Quarterly |
| **Fly spend** | Usage-billed; no free-tier wall | Fly bills rather than cutting off, so the failure mode is a surprise invoice, not an outage. Fly's own spend alert handles this better than a probe could. | Set the spend alert once, then glance monthly |
| **Porkbun payment card** | — | No API. Auto-renew is on, and the way auto-renew fails is an expired card. The `domain-registration` check catches the *consequence*; only you can prevent the *cause*. | Yearly, in July, before the 7 August fee date |
| **Scheduled workflows still enabled** | — | **GitHub disables scheduled workflows after 60 days with no repository activity.** A repo that goes quiet loses its monitoring silently. | Monthly: confirm `Monitor (uptime)` has run recently in the Actions tab |
| **GitHub Actions minutes** | Unlimited | rafaelcg/pqp is a **public** repository and Actions minutes are free and unmetered for public repos. There is no quota to hit, so no alert was built — one would never fire. This becomes real only if the repo is ever made private. | Never, unless the repo goes private |
| **LiveKit Cloud participant-minutes** | n/a | `LIVEKIT_*` is not configured; voice is full-mesh, so there is no SFU account to meter. Add a check here if that changes. | n/a |

---

## Alerts to enable in provider dashboards

No code can create these; they are one-time clicks that add failure domains
this repo cannot reach.

**Fly.io** (fly.io/dashboard → the `personal` org)
- **Spend alert / billing notification.** The single most valuable one — the
  Managed Postgres Basic plan alone is a standing monthly cost.
- Machine and health-check alerts under the app's Monitoring tab, so a crash
  loop is reported by Fly directly rather than only inferred by our probe.

**Cloudflare** (dash.cloudflare.com → Notifications)
- **Universal SSL certificate** events (issued / expiring / errored) for the
  `pqp.gg` zone.
- **Pages deployment failure** for the `pqp` project. Our check counts builds;
  it does not tell you a *specific* deploy broke.
- **R2 storage usage** notification, as a second opinion on `r2-usage`.
- **DNS record change** — cheap insurance on a domain that is a week old.

**Clerk** (dashboard.clerk.com)
- Usage / plan-limit warning emails for the production instance.
- Make sure the billing email is one you actually read, since it is *not*
  `contato@pqp.gg` while that address bounces.

**Porkbun** (porkbun.com)
- Confirm auto-renew is on for `pqp.gg` **and** that renewal-reminder emails go
  to a working address.

**Cloudflare Email Routing** — fixing `contato@pqp.gg` is worth doing on its own
merits: several of the alerts above are delivered by email to an address that
currently bounces.

---

## Files

| Path | Role |
|---|---|
| `.github/workflows/monitor-uptime.yml` | Every 10 min; availability |
| `.github/workflows/monitor-limits.yml` | Daily; certificates, domain, quotas |
| `scripts/monitor/run.mjs` | CLI entry point |
| `scripts/monitor/net.mjs` | HTTP / TLS / WebSocket / WHOIS probes and the retry logic |
| `scripts/monitor/availability.mjs` | The "is it down" checks |
| `scripts/monitor/limits.mjs` | The daily checks, plus the not-automated list |
| `scripts/monitor/alert.mjs` | GitHub Issue open / comment / close reconciliation |
| `server/src/services/status.ts` | The app's own per-minute component probes, which `status-components` and `uptime-24h` read |
