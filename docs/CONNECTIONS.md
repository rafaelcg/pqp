# Game connections (Steam, Battle.net, Twitch)

Linked gaming accounts on a pqp profile. Discord-style Connections, not a
second login. Clerk stays how people sign in.

Off per provider until that provider's credentials are set on the API. Same
contract as GIF search and attachments: `GET /api/connections/config` tells
the client which buttons to enable. pqp.gg is shipping Steam first. Twitch
and Battle.net stay off until configured; Settings shows them as coming soon.

## Why this shape

Steam is OpenID 2.0. Battle.net and Twitch are OAuth 2.0 authorization-code
grants. None of those flows can run through Clerk: Clerk has no Steam
provider, and using Battle.net or Twitch as a Clerk social login would create
a second way into the account.

The SPA keeps the session. The person clicks Connect, this origin goes to the
provider, the provider returns to
`/app/connections/callback/:provider`, and the SPA POSTs the query string to
the API with the existing Bearer token.

Access tokens are used once to learn who the person is, then discarded. There
is no token vault. Refreshing a nick is Connect again.

## Operator setup

Set `PUBLIC_APP_URL` to the web origin people actually use
(`https://pqp.gg` in production, `http://localhost:5173` locally). Twitch and
Battle.net must have that origin's callback registered exactly.

### Steam

1. Open https://steamcommunity.com/dev and register a Web API key for the
   domain that serves the app.
2. Set `STEAM_WEB_API_KEY` on the API.
3. Steam OpenID does not pre-register a redirect URI. `return_to` is
   `{PUBLIC_APP_URL}/app/connections/callback/steam?state=…`.

Valve documents OpenID 2.0 as the way a third-party site links a Steam
account. Steamworks OAuth is a different, partner-only product and is not
used here.

### Battle.net

1. Create a client at https://develop.battle.net/access
2. Redirect URI: `{PUBLIC_APP_URL}/app/connections/callback/battlenet`
3. Set `BATTLENET_CLIENT_ID` and `BATTLENET_CLIENT_SECRET`
4. Scope requested: `openid` only (id + BattleTag). No game profiles.

### Twitch

1. Create an app at https://dev.twitch.tv/console/apps
2. Redirect URI: `{PUBLIC_APP_URL}/app/connections/callback/twitch`
3. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`
4. No extra scopes. Email is not requested. Identity comes from
   `GET /helix/users` with the user token.

## When connecting fails

Every failure on the complete path leaves one line in the API log, and the
person never sees more than a generic sentence, so read the log first:

```
[pqp] connections.completeFailed provider=twitch userId=... step=token_exchange status=502 upstreamStatus=403 upstreamError=invalid client secret reason=Token endpoint returned 403
```

- `step` says which leg broke: `state_consume` (spent or expired state, the
  person took more than 10 minutes or reloaded the callback), `token_exchange`,
  `userinfo`, `upsert`, plus `provider_error`, `state_missing`, `code_missing`,
  `not_configured` and the Steam steps.
- `upstreamStatus` / `upstreamError` are what Twitch or Battle.net answered. The
  code, tokens, client secret and PKCE verifier are never logged.
- `status=502` means the problem is on our side or the provider's (rejected
  client credentials, provider down); the client shows "the connection service
  is having a problem on our side". `400` is something the person caused.
- `connections.start provider=... userId=...` marks each attempt, so starts
  with no matching `completeFailed` or success are people who left at the
  provider.
- `GET /api/admin/metrics` carries `connections.completeFailures`
  (`<provider>.<step>`, since boot, per process).

A rejected client secret also logs, at most once per provider per hour:
`PROVIDER CREDENTIALS REJECTED: check TWITCH_CLIENT_SECRET`. That is the line
to alert on. A callback that returns with no query at all (Clerk dropping it)
is a client-side message, not a server line.

**The Twitch app's secret is the first suspect.** It dies when someone
regenerates it in the Twitch console, and nothing else tells us. Twitch
connections use their own Twitch app, separate from Clerk's Twitch login
app: the pair lives in `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`, and
`{PUBLIC_APP_URL}/app/connections/callback/twitch` must be registered as a
redirect URL on THAT app. Test the pair from the box:

```bash
curl -s -X POST https://id.twitch.tv/oauth2/token -d "client_id=$TWITCH_CLIENT_ID&client_secret=$TWITCH_CLIENT_SECRET&grant_type=client_credentials"
```

An `access_token` means the pair is good; `{"status":403,"message":"invalid client secret"}`
means regenerate it in the console and update the secret. Battle.net is the
same shape with `BATTLENET_CLIENT_SECRET`.

## Visibility

| Value | Where it appears |
|---|---|
| `hidden` | Settings only |
| `shared` (default) | In-app profile card, for friends and people who share a server |
| `public` | Also `pqp.gg/@handle` |

A stranger who is not a friend and does not share a server gets an empty list
on the in-app card, not a 403. The public page still uses `public` only.

A Steam profile URL is a stable identifier. The public page does not get one
unless the person opts in.

Connecting the same account again keeps the visibility already chosen.
Connecting a different account on that provider resets it to `shared`.

Steam OpenID: `openid.signed` must include `claimed_id`, `return_to`,
`op_endpoint`, and `response_nonce`. An assertion that omits `claimed_id` is
refused before we POST it back to Steam.

## What is stored

`user_connections`: provider, provider user id, display name, optional
avatar/profile URL, visibility, connected-at. Cascade-deleted with the
account. Included in `GET /api/me/export`.

Adoption is on the operator dashboard: per provider, accounts linked and how
many of those are `public`, plus accounts that linked anything, all as a share
of every human account. Aggregate counts only, no names or ids
(`connectionAdoption` in `server/src/services/connections.ts`, surfaced through
`GET /api/admin/metrics`; see `tools/admin-dashboard/README.md`).

We do not keep access tokens. Linking is not account access.
Connecting does not show what someone is playing. A game open on
Steam does not appear on pqp.

One Steam (or Battle.net, or Twitch) account per pqp user, and the reverse:
one pqp user per SteamID.

## Not built

- YouTube, Riot, Roblox, and GitHub are Settings tiles only. Xbox,
  PlayStation, and Nintendo are still not shown.
- Live "now playing" / rich presence
- Linked roles that gate channels on a connected account
- iOS Settings UI (the web/PWA path works)
- Updating the legal privacy page copy (do that when this ships to pqp.gg)
