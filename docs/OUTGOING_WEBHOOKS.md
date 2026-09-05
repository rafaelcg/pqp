# Outgoing channel webhooks

Server owners and managers can subscribe an HTTPS URL to selected text
channels. After a human message commits, pqp POSTs a Standard Webhooks-signed
`message.created` event. Chat send does not wait on delivery.

This is not a bot API, an app directory, or OAuth. Incoming Discord-style
webhooks (`webhooks` table, channel-row panel) are unchanged.

## Add a hook

1. Open the community. Open server settings.
2. Open **Integrations**. You need the Manage webhooks permission.
3. Name the hook, paste an HTTPS URL, tick at least one text channel.
4. Optional: an auth header (`Authorization`, `X-Webhook-Secret`, or
   `X-Api-Key`) and its value. Grok Bot wants `Authorization` and
   `Bearer <sender key>`.
5. Create. Copy the `whsec_…` signing secret. pqp shows it once.

Disable, delete, edit the URL and channels, or rotate the secret from the
same panel. Rotation keeps the previous secret valid for about 24 hours and
sends both signatures.

Tick **Skip these members** for any helper that is a normal account (Caio
`#2160` is one). Their messages do not fire the hook. Accounts with
`users.is_bot`, `is_character`, or `is_webhook` are skipped on every hook
without being listed.

## Headers

Every delivery is `POST` with `Content-Type: application/json` and:

| Header | Meaning |
|---|---|
| `webhook-id` | Delivery UUID. Stable across retries. |
| `webhook-timestamp` | Unix seconds of this POST attempt, not the message time. |
| `webhook-signature` | `v1,<base64 hmac>` (two values, space-delimited, during rotation) |
| optional auth header | Whatever you configured |

## Verify (Node)

Signed content is `{id}.{unix_ts}.{raw_json_body}`. HMAC-SHA256, secret is
`whsec_` plus base64 of 24–64 random bytes. Compare timing-safe.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, id, ts, body, header) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = "v1," + createHmac("sha256", key)
    .update(`${id}.${ts}.${body}`, "utf8")
    .digest("base64");
  return header.split(/\s+/).some((sig) => {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
```

Sign the exact UTF-8 bytes on the wire. Do not re-serialize the JSON.

## Event

v1 sends only `message.created`. The body looks like:

```json
{
  "type": "message.created",
  "id": "<delivery uuid>",
  "createdAt": "<iso>",
  "timestamp": "<iso>",
  "serverId": "...",
  "serverName": "...",
  "channelId": "...",
  "channelName": "...",
  "messageId": "...",
  "author": { "id": "...", "username": "...", "tag": "...", "displayName": "...", "isBot": false },
  "body": "...",
  "replyToId": null
}
```

## Skip rules

No row is enqueued when:

- the channel is not a server text channel (no DMs, no voice)
- the author is an incoming webhook (`is_webhook`), a character account
  (`is_character`), or a labeled bot (`is_bot`)
- the author is on that hook's skip list (`skip_user_ids`)
- the body is empty
- no enabled hook lists that channel (`failing` still enqueues; `disabled`
  does not). A thread still fires if its parent channel is on the allowlist

Incoming `executeWebhook` does not enqueue.

`author.isBot` is `users.is_bot`. Skipped authors are not delivered, so a
receiver should not see `isBot: true` unless a future event type sends bots.

## Secrets

The HMAC signing secret and the optional auth header value (Grok sender key)
are stored in Postgres in plaintext, the same trust boundary as incoming
webhook tokens. List and get never return them. The HMAC secret is shown once
on create and rotate.

## Retry and DLQ

Success is HTTP 2xx. Redirects are not followed; 3xx is failure.

Retries: immediate, 5 seconds, 30 seconds, 2 minutes, 10 minutes, then `dead`.
429, 5xx, and timeouts retry, with jitter. Retry-After is honoured. Other 4xx
do not retry. `410 Gone` disables the endpoint.

Delivered receipts older than 7 days are pruned.

## SSRF

The URL is resolved, private/loopback/link-local/CGNAT/metadata addresses are
blocked, and the POST pins that IP. No credentials in the URL. HTTPS is
required in production. HTTP is allowed only when `NODE_ENV` is not
production. `OUTGOING_WEBHOOKS_ALLOW_PRIVATE=true` permits a local receiver
in non-production only. The same checks run at create and at every delivery.

## Grok Bot

On the desktop app, copy the POST URL and set `Authorization: Bearer <sender
key>`. That header name is what Grok Bot's panel currently offers; it is
unproven until the first live POST. pqp still sends the HMAC headers above.

A character on that server with no WebSocket is shown as online on the member
list while at least one hook is `active`. `failing` or `disabled` paints them
offline again. A live socket still wins. This is not a stored presence bit.
