# The bridge

The bridge is the message API between your app and the pqp page. You almost never touch it directly, because [`@pqp/app-sdk`](/sdk/) is a typed wrapper over it. This page explains what is underneath, because it explains the behaviours that surprise people: why a call can reject, why pushes are not replayed, why a reply must match its request.

The contract is `packages/shared/src/apps/bridge.ts`. It is version **1** (`platformApi: 1`), and only version 1 exists.

## The handshake

The frame has an opaque origin, so there is no origin to compare. Two messages travel on plain `window.postMessage`, and nothing else ever does:

1. The app posts `{ pqp: "app-hello", platformApi: 1 }` to `window.parent`, with target `"*"`, and again every second until answered.
2. The page answers `{ pqp: "app-port", platformApi: 1 }` and **transfers one end of a `MessageChannel`**.

Both sides verify the sender instead of an origin: the page accepts the hello only when `event.source` is the iframe it created; the SDK accepts the port message only when `event.source` is `window.parent`, takes the first one, and ignores everything else (a sibling frame, a browser extension). After that, every message is on the port, which only those two parties hold.

The page's first message on the port is a `hello` push. `connect()` resolves when it arrives.

## Requests and responses

Everything your app asks for is a request: `{ id, type, ...params }`, with an `id` of 1 to 32 characters. The SDK numbers them for you. The answer is either `{ id, ok: true, type, result }` or `{ id, ok: false, error }`.

A successful answer **echoes the request's `type`**. The SDK checks that the type is the one it asked for and that every field has the right kind of value, and rejects with `unavailable` if not. So a write can never look done on the strength of somebody else's reply.

| Request | Params | Answers |
|---|---|---|
| `participants.get` | | `{ participants }` |
| `state.get` | | `{ rev, value }` |
| `state.patch` | `patch`, `baseRev?` | `{ rev }` |
| `events.send` | `name`, `data` | `null` |
| `assets.get` | `name` | `{ name, bytes }` |
| `files.pickLocal` | | `{ bytes, ext }` |
| `ui.resize` | `height` (120 to 2000) | `{ height }` |
| `ui.fullscreen` | `on` | `{ on }` |
| `share.request` | `on` | `{ on }` |
| `session.end` | | `null` (session host only) |

## Pushes

Pushes have no id. The page sends them when something changes, and the SDK turns them into the callbacks you register.

| Push | Arrives when | SDK |
|---|---|---|
| `hello` | once, right after the port | `app.hello`, resolves `connect()` |
| `participants` | anybody joins, leaves, is held, or comes back | `app.participants.on` |
| `state` `{ rev, value }` | the shared state changed, including your own write | `app.state.on` |
| `event` `{ fromSeatId, name, data }` | another person sent an event | `app.events.on(name)` |
| `connection` `{ status }` | the page lost or regained the session | `app.on("connection")` |
| `session.ended` `{ reason }` | the session is over | `app.on("ended")` |
| `theme` `{ theme }` | the person changed brightness, skin, contrast or accent | `app.on("theme")` |

**A push that arrives before you registered a listener is gone.** That is why the pattern is always: register listeners, then read the current value with a `get` call.

## Strict toward the app, tolerant toward a newer page

Messages **from the app** are parsed with a strict schema: an unknown key, a wrong type, a name that does not match the pattern is a rejection (`invalid`), because the app is untrusted and must not smuggle anything past the page. A request with no usable id is dropped.

Messages **to the app** use the default of stripping unknown keys: a field the page adds later is dropped, never rejected, so an app pinned to platform API 1 keeps working when the page learns new tricks, and a stripped key can never reach the app.

## Limits

| What | Limit |
|---|---|
| State value, and one state patch | 16 384 bytes serialized (the manifest may lower it) |
| One event payload | 1 024 bytes serialized (the manifest may lower it) |
| Events per person | 20 per second (the manifest may lower it) |
| State writes per session | 10 per second, coalesced (the manifest may lower it) |
| JSON nesting | 32 levels |
| Event name | `^[a-z][a-z0-9.-]{0,31}$` |
| Participants in one push | 264 |
| Avatar, one data URL | 65 536 characters |
| Avatars in one roster | 4 MiB of characters; the page downsizes until the list fits |
| Display name | 64 characters |
| `ui.resize` height | 120 to 2000 CSS pixels |

JSON values must survive `JSON.stringify` unchanged: no `undefined`, functions, `NaN`, `Infinity`, class instances (`Date`, `Map`, typed arrays) or sparse arrays. Sizes are UTF-8 bytes of the serialized value. A call that carries something the structured clone refuses rejects with `invalid`, locally.

A flood is answered `rate-limited` without even being parsed, and if it keeps going the page ends the frame.

## Error codes

Every rejected call is a [`PqpAppError`](/sdk/errors) with one of nine codes.

| Code | Means | Typical cause |
|---|---|---|
| `not-allowed` | The manifest or the person's role does not permit this. | A spectator writing. Sending events when the manifest sets events to 0. Share or files without the capability. A picked file of the wrong type. |
| `not-host` | Only the session host may. | `end()` from a player. A state write when the manifest says `writers: "host"`. |
| `too-large` | Over a cap. | A state value or event past `maxBytes`, or a picked file past the manifest's `maxBytes`. |
| `rate-limited` | Too fast. | More writes or events per second than allowed. A second file picker while one is open. |
| `stale-rev` | The state moved on. | A `baseRev` write after somebody else wrote. Read again and retry. |
| `cancelled` | The person cancelled. | The file picker. (`files.pickLocal()` turns this into `null`.) |
| `unavailable` | Nobody answered, or it did not work. | Not inside pqp, no answer in 15 s, the page is reconnecting, an unusable reply, an asset that failed its hash check. Often worth a retry. |
| `ended` | The session is over. | Any call after `session.ended`. After it, every call fails this way at once. |
| `invalid` | The request is not valid. | A bad event name, an oversized or non-JSON value, a height out of range, an asset name that is not in the manifest. |

Next: [the manifest and capabilities](/concepts/manifest).
