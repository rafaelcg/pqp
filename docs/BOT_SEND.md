# Character HTTP send

An authenticated `POST` so an external bot (Caio, the QG support bot, an
ambient persona) can put a message in a channel or thread without opening a
browser or holding a WebSocket.

This is not a second messaging system. It is the same `createMessage` +
fan-out path the WebSocket `message-create` frame uses. Incoming Discord-style
webhooks (`POST /api/webhooks/:id/:token`) are unchanged: they still post as a
pseudo-user and skip notifications. The one thread they can reach is a forum
post, through `?thread_id=` on the forum's webhook (see "Incoming webhooks into
a forum" below).

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

Slow mode applying to a character is deliberate. A character is a resident: it
has a name, a face and a seat in the room, people answer it, and the wait is
there to make a busy channel readable for whoever is reading. A resident that
posts through the wait is exactly the flood a moderator turned slow mode on to
stop. An **incoming webhook** (`POST /api/webhooks/:id/:token`) is exempt for
the mirror-image reason: it is a pipe, not a resident, its URL is configured
once by someone who already held MANAGE_CHANNELS on the channel, and what
comes out of it is a build result or an alert that is useless late. It carries
its own per-webhook budget instead (burst 20, 1/s) and never touches
`postChannelMessage`, which is where slow mode is decided.

A character in a **forum** is a person, not a pipe. It opens a post through
the people's route, `POST /api/channels/:forumId/posts`, with every gate a
member's post goes through (AutoMod on the title, slow mode on the forum, the
post bucket). A `POST /api/channels/:forumId/messages` into the forum id itself
is refused like any message into a forum. Replying in a post works as above:
the post is a thread, so POST to the post's id.

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

The member list treats a socketless character as online while that server has
an `active` outgoing hook, and offline once the hook is `failing` or
`disabled`. See [`OUTGOING_WEBHOOKS.md`](./OUTGOING_WEBHOOKS.md).

Characters still cannot DM, join voice, create servers, or delete/export
themselves. This route does not change that.

## Incoming webhooks into a forum

Not the character route, but the same question comes up. A webhook is created
on a channel's settings (or `POST /api/channels/:channelId/webhooks`) by
someone holding MANAGE_CHANNELS **on that channel**: a channel overwrite
counts, and the same check covers listing, deleting and the forum settings
below. On a forum, each execute becomes a post, so an RSS tool pointed at the
URL as if it were a Discord webhook makes one post per item.

| Payload | In a forum |
|---|---|
| `thread_name` | The post title (trimmed, cut to 100 characters) |
| no `thread_name` | The first embed's `title`, else the first line of `content` with markdown and bare links stripped |
| no title anywhere | `400` with Discord's `code: 220001` |
| `applied_tags` | Tags by id or by name (case and accents ignored), at most 5. A webhook never creates a tag; unknown or disallowed entries come back in `ignored_tags` |
| `content`, `embeds`, `username`, `avatar_url` | The opening message, as in a text channel |
| `?thread_id=<postId>` | A reply in that post. `404` unless it is a post of this forum, `403` when the post is locked. `thread_name` and `applied_tags` are ignored on a reply (Discord would refuse the pair with a 400) |
| `Idempotency-Key` header | The dedupe key (pqp extension) |

The answer is `200 { message, post, ignored_tags? }`. A repeat of the same item
inside the webhook's dedupe window (default 72 h) answers the existing post with
`X-Pqp-Deduplicated: 1` and writes nothing; the key is the `Idempotency-Key`
header, else the title plus the item's first link with `utm_*` and the
fragment removed. Posts have a cluster-wide budget of 10 burst then 1 a minute
per webhook; a `429` carries `Retry-After` and Discord's `retry_after` (seconds)
in the body. With the `forum_channels` flag off for the server a new post is
`403` and nothing is written; `?thread_id=` replies still land.

Per webhook, `PUT /api/webhooks/:webhookId/forum-settings` (same permission,
audit `webhook.forum_settings`) sets `{ allowedTagIds, defaultTagIds,
dedupeWindowHours }`: `allowedTagIds: null` allows every tag that is not staff
only, and a staff-only tag has to be listed by id; `defaultTagIds` apply when
nothing the payload names resolves; `dedupeWindowHours: 0` turns dedupe off.
The full design is `docs/plans/FORUM_CHANNELS.md` section 7.

## Follow-ups

No in-app key manager. Minting stays a database script. An operator UI would
be a second, permanent credential-minting surface on the API; the existing
scripts are the right amount of friction for a secret of this class.
