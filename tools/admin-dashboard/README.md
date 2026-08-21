# pqp-admin: the operator dashboard

One static page (`site/index.html`) and one small Cloudflare Worker
(`src/index.ts`) in front of it, deployed as the existing `pqp-admin` Worker at
`https://pqp-admin.rafaelcg-a0a.workers.dev/`.

It is a read-only view of the hosted instance for the person running it. It is
not part of the product and it is not linked from anywhere.

## What it shows

Live, from `GET https://api.pqp.gg/api/admin/metrics` (proxied as `/metrics`):

- users (total, new in 24h, new per hour), servers (total, new in 24h)
- messages in 24h and per hour, last hour, delta against the previous 24h,
  distinct senders, active text channels
- channel composition (text / voice / category / thread)
- voice: rooms open now, people in them, largest room today (process-local;
  the payload says since when it has been counting, and it resets on deploy
  and at São Paulo midnight)
- the five most active servers of the last 24h: name, tagline, channel and
  member counts, messages
- the deployed API commit (`APP_VERSION`)

Live, from `GET https://api.pqp.gg/status.json` (proxied as `/health`): the
component health tiles, the headline pill, the database latency.

Everything else on the page (recent voice rooms, moderation and feedback
counts, the incident timeline) has no live source yet. It keeps the seed
numbers and is badged **dados representativos** as soon as anything live
arrives. If `/metrics` cannot be reached the whole page falls back to seed
numbers and the header chip says so.

Webhook pseudo-accounts and character (house cast) accounts are excluded from
every user and message count, the same way the acquisition report excludes
them; their message volume is reported separately as `messages.automated24h`.

## Why it is behind a password

The repo is open source and a `workers.dev` hostname is guessable. The page
shows aggregate counts only, but the "most active servers" table carries the
**names of private servers**, which is more than the public status page is
ever allowed to say. So the Worker gates **every** request (the page, `/metrics`,
`/health`) behind HTTP Basic Auth, compared in constant time, and refuses to
serve anything at all (503) while the password is unset. Every response is
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag:
noindex`, and `/robots.txt` disallows everything.

Recommended upgrade: put the Worker behind **Cloudflare Access** (free for up
to 50 users). Add an Access application for the `workers.dev` hostname (or a
custom hostname), allow your own email, and the login page replaces the Basic
prompt with a real identity check, MFA, and an audit log. Nothing in this
directory needs to change for that; keep the Basic Auth on as a second layer
or drop it once Access is in front. This is not configured yet.

## Secrets and variables

Nothing secret lives in this directory, in `wrangler.jsonc`, or in the HTML.

| Where | Name | Kind | What |
|---|---|---|---|
| Worker | `ADMIN_DASH_PASSWORD` | secret | Basic Auth password. Unset: the Worker serves nothing. |
| Worker | `ADMIN_DASH_USER` | var (in `wrangler.jsonc`) | Basic Auth username, default `operador`. |
| Worker | `ADMIN_METRICS_TOKEN` | secret | Bearer token sent to the API on `/metrics`. Never reaches the page. |
| Worker | `API_ORIGIN` | var (in `wrangler.jsonc`) | `https://api.pqp.gg` |
| API (Fly) | `ADMIN_METRICS_TOKEN` | secret | The same value. At least 16 characters or the API treats it as unset. |

Generate the token once (`openssl rand -hex 32`) and set it on both sides:

```bash
# Fly (the API). This restarts the machine.
fly secrets set ADMIN_METRICS_TOKEN=... -a pqp-api

# Worker
cd tools/admin-dashboard
npx wrangler secret put ADMIN_METRICS_TOKEN
npx wrangler secret put ADMIN_DASH_PASSWORD
```

An instance moderator (`INSTANCE_MODERATOR_CLERK_IDS`) can also read the same
endpoint with their own Clerk session; the token exists because the Worker has
no session. Everybody else gets a 404, the same answer as a route that does not
exist. Server side: `server/src/services/metrics.ts`, gate in
`server/src/api/index.ts`, tests in `server/src/api/metrics.test.ts`. The
payload is cached in memory for 30 seconds.

## Deploy

```bash
cd tools/admin-dashboard
npm install                     # wrangler + types, local only
npm run check                   # tsc over the Worker
npm run dry-run                 # bundles without deploying
npx wrangler deploy             # updates the existing pqp-admin Worker
```

`wrangler deploy` keeps secrets already set on the Worker; only `vars` in
`wrangler.jsonc` are overwritten. To run locally, put the two secrets in a
`.dev.vars` file here (git-ignored) and `npm run dev`.

Test the API side directly, with the token:

```bash
curl -s -H "Authorization: Bearer $ADMIN_METRICS_TOKEN" https://api.pqp.gg/api/admin/metrics | jq .
# without it: 404
```

## Not in the pnpm workspace

Like `tools/ambient`, this directory has its own `package.json` and its own
`npm install`. The repo's root lint covers the TypeScript here; the repo's
typecheck and tests do not, which is what `npm run check` is for.
