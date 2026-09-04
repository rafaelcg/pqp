# Character HTTP send

An authenticated `POST` so an external bot (Caio, the QG support bot, an
ambient persona) can put a message in a channel or thread without opening a
browser or holding a WebSocket.

This is not a second messaging system. It is the same `createMessage` +
fan-out path the WebSocket `message-create` frame uses. Incoming Discord-style
webhooks (`POST /api/webhooks/:id/:token`) are unchanged: they still post as a
pseudo-user, cannot reply in a thread, and skip notifications.

## Auth

`Authorization: Bearer character:<token>`

The token is a character account secret. Clerk JWTs and the dev-bypass string
are refused on this route (`403`). The character branch in `verifyAuthHeader`
only runs when `CHARACTER_ACCOUNTS_ENABLED=true` on the API. Off, every
character token is `401` before the database is touched.

There is no admin UI that mints keys. Provisioning is a script against
`DATABASE_URL`, on purpose: see `tools/ambient/scripts/provision.mjs` (house
cast) and `tools/support-bot/scripts/provision.mjs` (disclosed QG bot). The
secret is returned once and stored as SHA-256. The two scripts take the same
flags in different shapes: the cast script names the persona
(`provision.mjs --rotate kzin`, `provision.mjs --revoke kzin`); the support-bot
script has one account and takes the bare flag (`provision.mjs --rotate`,
`provision.mjs --revoke`).

Provisioning creates a **new** `users` row with its own id and its own
`username#dddd`. It does not convert an existing Clerk account. If the bot
already exists as a person (today's `caio#2160` is a Clerk user), the
character is a second account: invite it separately, point the runner at the
new token, and remove the old member when you are done.

1. Set `CHARACTER_ACCOUNTS_ENABLED=true` on the API (`fly secrets set` on
   `pqp-api`, or the local `.env`).
2. Mint the account. Keep the printed `character:<token>` out of git.
3. Invite the account into the server. It cannot join by itself.
4. POST with that bearer.

## Request

```
POST /api/channels/:channelId/messages
Authorization: Bearer character:<token>
Content-Type: application/json

{ "body": "markdown or plain text", "replyToId": "<optional uuid>" }
```

| Field | Required | Meaning |
|---|---|---|
| `body` | yes | 1–4000 characters after the newline clamp. Markdown is stored as text, the same as a person typing. |
| `replyToId` | no | Inline reply. Must be a message in **this** channel. A missing parent posts plain. A parent in another channel is `400`. |

A thread is a channel. To reply in a thread, POST to `thread.channelId` from
`POST /api/messages/:messageId/threads` (or from history, `message.thread.channelId`).
The outgoing `message.created` webhook already carries the channel the human
wrote in, including a thread.

Rate limits: the API-wide write budget (`writeLimiter`: burst 30, 2/s,
`RATE_LIMIT_WRITE_*`) and, on top of it, the same per-user send bucket the
WebSocket charges (burst 10, 2/s, `RATE_LIMIT_WS_MESSAGE_*`). One account has
one send budget whichever door it uses. Slow mode on the channel applies too.
A server timeout on the character blocks the send like any other write.

## Response

`201`:

```json
{
  "message": {
    "id": "…",
    "channelId": "…",
    "authorId": "…",
    "authorName": "Caio",
    "authorTag": "caio#4821",
    "authorAvatarUrl": null,
    "body": "cheguei, como posso ajudar?",
    "createdAt": "2026-09-04T17:00:00.000Z",
    "editedAt": null,
    "replyTo": null,
    "reactions": [],
    "attachments": [],
    "embeds": []
  }
}
```

`authorTag` is whatever handle the provision script allocated. It is not the
tag of any Clerk account with the same display name.

Failures:

| Status | When |
|---|---|
| `401` | No bearer, unknown token, revoked account, or the character gate is off |
| `403` | Caller is not a character; the character cannot `SEND_MESSAGES` here; the character is timed out in this server; or the character is somehow already seated in a conversation (characters cannot DM) |
| `404` | Channel does not exist, the character is not in that server/channel, or the id is a conversation they are not in (`canAccessChannel`) |
| `400` | Empty/invalid body, or `replyToId` names a message in another channel |
| `429` | Write budget, send budget, or slow mode. Honour `Retry-After` |

## Curl

```bash
# Local, with CHARACTER_ACCOUNTS_ENABLED=true
curl -sS -X POST "http://localhost:3001/api/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer character:$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"cheguei, como posso ajudar?"}'

# Inline reply in the same channel
curl -sS -X POST "http://localhost:3001/api/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bearer character:$TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"body\":\"vi sim\",\"replyToId\":\"$PARENT_MESSAGE_ID\"}"

# Thread reply: $THREAD_CHANNEL_ID is message.thread.channelId
curl -sS -X POST "http://localhost:3001/api/channels/$THREAD_CHANNEL_ID/messages" \
  -H "Authorization: Bearer character:$TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"abre Configurações e me manda o que aparece"}'
```

Hosted: replace the origin with `https://api.pqp.gg`.

## What a send does

The posted row is a normal message from the character's `users` row
(`is_character = true`). It appears in history, notifies and unread/mention
the same way a typed message would, and live clients get `message-broadcast`.

Outgoing channel webhooks skip `is_character` authors on every hook, so Caio
does not wake himself. Incoming execute tokens are a different table and are
not used here.

Characters still cannot DM, join voice, create servers, or delete/export
themselves. This route does not change that.

## Follow-ups

No in-app key manager. Minting stays a database script. An operator UI would
be a second, permanent credential-minting surface on the API; the existing
scripts are the right amount of friction for a secret of this class.
