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
