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

Disable, delete, or rotate the secret from the same panel. Rotation keeps the
previous secret valid for about 24 hours and sends both signatures.

## Headers

Every delivery is `POST` with `Content-Type: application/json` and:

| Header | Meaning |
|---|---|
| `webhook-id` | Delivery UUID. Stable across retries. |
| `webhook-timestamp` | Unix seconds. |
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
- the author is an incoming webhook or a character account
- the body is empty
- no active hook lists that channel (a thread still fires if its parent
  channel is on the allowlist)

Incoming `executeWebhook` does not enqueue.

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
key>`. pqp still sends the HMAC headers above. Verify both if you want; the
Bearer header is how Grok authenticates the sender, and the HMAC is how you
know the body came from this pqp server.
