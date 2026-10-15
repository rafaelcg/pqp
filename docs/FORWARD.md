# Encaminhar (forward)

Putting a Baú post or a chat message into another channel or a DM as a card that says where it came from. Runtime flag `forward_messages` (default off, global). Contract: `packages/shared/src/forward.ts`. Rules: `server/src/services/forwards.ts`. Tests: `server/src/api/forwards.test.ts`.

## What it is

A forward is a message. `messages.forward` is a nullable JSONB column holding a snapshot taken at forward time, validated by `messageForwardSchema`. It rides on the message object everywhere messages travel (REST history, `message-broadcast`, `message-update`, pins), and it is absent on every ordinary message. Read it as `message.forward ?? null`.

`body` is the forwarder's own comment. With no comment the server writes `Encaminhado: <title or excerpt> <url>` so a client that predates the card still shows something useful. A client that draws the card hides `body` when `isForwardFallbackBody(body, forward)` is true. A followed Baú's delivery (Seguir) that pings a role writes `@Role` alone on the first line and the fallback on the next; `isForwardFallbackBody` is true for that too, and `forwardBodyComment(body, forward)` returns the part to show (`""`, the mention line, or the forwarder's own text). Mobile: the fallback is `body` itself, or `body` after a first line that starts with `@`.

## Endpoints

`GET /api/forwards/config` answers `{ enabled }`. Clients hide the action when it is false. Cards already in history keep rendering with the flag off.

`POST /api/forwards`

```json
{
  "source": { "kind": "bau_post", "id": "<postId>", "serverId": "<serverId>" },
  "targets": [{ "channelId": "<id>" }, { "userId": "<id>" }],
  "comment": "optional, up to 1500 chars",
  "nonce": "optional, up to 64 chars, one per dialog attempt"
}
```

`source.kind` is `bau_post` (needs `serverId`) or `message`. One to five targets; a repeated target is posted once. A `channelId` is a server channel (text, thread, a voice channel's chat) or a conversation the caller is in; a `userId` opens or reuses the 1:1 DM under the rules of `POST /api/dms`.

Answer, always 200 once the request itself was valid:

```json
{ "results": [
  { "ok": true, "target": {...}, "channelId": "...", "serverId": "..." , "message": { } },
  { "ok": false, "target": {...}, "reason": "stays_in_server", "retryAfterMs": 1200 }
] }
```

`message` is the stored message in the history shape, already broadcast to the channel. Refusal reasons: `no_access`, `cannot_send`, `bad_target`, `stays_in_server`, `unreachable` (a block, a privacy setting or yourself, deliberately one answer), `slow_mode`, `rate_limited`, `automod`, `unavailable`.

Request-level failures: 400 invalid body, 404 flag off or source not found or not readable (one answer), 422 `source_not_forwardable` (a DM or group message, a system message) or `source_empty` (nothing to show), 429 with `Retry-After`.

## Rules

- The caller must be able to read the source. A post needs server membership, Baú on for the server, and `published` status. A message needs access to its channel.
- **Restricted sources stay in their server.** A members-only (VIP) post and a message in a private channel (or in a thread of one) can only be forwarded into the same server. Other servers and every DM target are refused with `stays_in_server`, and a refused person target creates no conversation. The card says `restricted: true`, and a forward of that card is restricted the same way: it stays inside ONE server, named on the card as `restrictedToServerId` (a members-only post: its own server; a free card sitting in a private channel: that channel's server, which can differ from `sourceServerId`; the copy is stamped `restricted: true` so it keeps the rule after it moves to a public channel). Clients offer only that server and the server enforces the same answer.
- A restricted post's snapshot is the locked view: title, teaser, a public YouTube poster, no body, no media, no author, even when the forwarder could unlock it.
- A forward of a forward carries the original snapshot, not the card message.
- Each target goes through the chat's own send (`postChannelMessage`): access, SEND_MESSAGES, blocks, slow mode, AutoMod (which reads the comment and the snapshot text), the closed-1:1 restore, unread, push and fan-out. Each target also spends one message from the sender's send budget, and the route has its own burst limit.
- **Nothing pings.** `@everyone` and `@here` never fire from a forward. Mentions are read from the comment only; names inside the snapshot or the fallback line mention no one. The fallback body is not unfurled. The snapshot itself is inert: `<@id>`, `<@&id>` and `<#id>` markup is turned into plain `@Nome` / `@cargo` / `#canal` when the card is made (a private channel's name is never resolved, it reads `#unknown`), and every remaining `@name` gets an invisible zero-width space after the `@`, so no client's mention scan finds anyone in the card or in the fallback body. The card's `url` is built from `PUBLIC_APP_URL` (first entry), never from the request Origin header.
- Media: `mediaKind` says what the source has, `mediaThumbUrl` is only ever a stable public URL (a YouTube poster). Signed, expiring URLs are never stored in a snapshot.
- The snapshot does not follow the source: editing or deleting the original later does not change a forward that was sent.

## Rolling it out

Off by default. The dashboard flips `forward_messages` globally with no deploy. Turn it on after the web build that draws the card is live; the phones show the fallback line until their builds ship.

## Web client

- The card is `client/src/components/chat/forward-card.tsx`, drawn by `MessageList`, so it shows wherever messages render (channels, DMs, threads, forum posts). It reads the snapshot only and fetches nothing. A forward's fallback body is hidden (`forwardCommentOf` in `client/src/lib/forward.ts`) and the message is never also drawn as a Baú link card.
- The action is "Encaminhar" in a chat message's menu and on every published Baú post (the button under the post for everyone, plus the staff menu). It opens `components/forward/forward-picker.tsx`: search, recent places first, up to five picks, optional comment, each refusal shown on its own row. A members-only post or a private-channel message is only offered its own server.
- A message in a conversation, and every message while `forward_messages` is off, keeps the old behaviour (quote into the composer). The flag is read from `GET /api/forwards/config` (`startForwardConfig`), asked again on the config refresh pass.
- A card of a free Baú post that has a public page (its `url` parses as `/c/<slug>/p/<id>`, see `forwardShareUrl` in `client/src/lib/forward.ts`) carries **Compartilhar**, the same menu as on the Baú post (`BauShareButton`, surface `forward`: copy link, X, Reddit, WhatsApp, Telegram, or the OS sheet on a touch device). It sits in a footer beside the link, not inside it. A restricted card, a forwarded chat message and a post with no page have none. The link is the one the snapshot holds, so a page taken down since reads as that page's own 404.
- Success shows a corner toast with "Ver", which opens the first place it went.
