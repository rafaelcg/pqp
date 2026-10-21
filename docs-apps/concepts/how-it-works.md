# How an app works

This page is the whole picture in one place. Every other page in Concepts zooms into a piece of it.

## Three parties

```text
 ┌─────────────────────────┐          ┌──────────────────────────┐          ┌────────────────────────┐
 │  Your app               │          │  The pqp page            │          │  The pqp server        │
 │  an iframe, sandboxed   │◄────────►│  "the host"              │◄────────►│  Postgres, WebSocket   │
 │  on the apps origin     │ Message  │  pqp.gg, in the browser  │  /ws     │  seats, state, events  │
 │  UNTRUSTED              │  Port    │  checks every message    │  frames  │  checks every frame    │
 └─────────────────────────┘          └──────────────────────────┘          └────────────────────────┘
```

- **Your app** is a static bundle (HTML, JS, CSS) served from a separate site, the *apps origin*, and shown in an `<iframe>`. pqp treats it as untrusted code, because it is written by someone else.
- **The pqp page** is the web client a person already has open. It is called **the host** in the protocol. It owns the iframe, is the only thing that talks to it, and talks to the server for it.
- **The pqp server** is the source of truth: who is in the session, what the shared state is, in what order writes happened.

Your code only ever talks to the middle one. It never makes a network request, and it never learns who anybody is beyond a name and an avatar.

::: tip Two meanings of "host"
In the bridge protocol **the host** is the pqp page. In a session, **the session host** is the person who started it (`isHost` on a participant, `app.hello.self.isHost`). These pages say "the page" and "the session host" to keep them apart.
:::

## One session, start to finish

1. **Somebody starts it.** In the composer, the apps launcher lists what can run in this channel. Starting one sends `POST /api/channels/:id/app-sessions`. The server checks that the person may (the `USE_APPS` permission, and that the app is [available](/publishing/review) here), creates the session, pins the app **version** that is current right now, and posts a card into the conversation. The starter is the session host.
2. **Others join.** Tapping the card sends a join frame. The server gives each person a **seat**: a random id that is theirs for this session, a role (`player`, or `spectator` past the player limit), and a place in the roster.
3. **The page mounts your app.** It creates `<iframe sandbox="allow-scripts">` pointing at `<apps origin>/<id>/<version>/index.html`. The frame is on another site, so it cannot reach into the page, and the page cannot be reached from it except through one channel.
4. **Your app connects.** `connect()` posts a hello to its parent. The page answers with one end of a `MessageChannel` and checks that the hello came from *that* iframe. Everything from here on travels on the port. The page's first message on it is `hello`: your seat, the locale, the theme.
5. **Your app reads and listens.** `participants.get()`, `state.get()`, and listeners for what changes.
6. **Your app writes.** `state.patch({ count: 6 }, { baseRev: 5 })` goes to the page. The page checks it against **your manifest** (is this person allowed to write, is the result under `state.maxBytes`, are they under the rate limit), then sends it to the server as a frame. The server applies the merge patch under a lock, bumps the revision, and broadcasts the whole new value to every seat. Each person's page pushes it into their own app.
7. **It ends.** The session host ends it, or a moderator does, or it idles out, or everybody leaves. The shared state is **cleared**; what you want to remember in the conversation, you leave in `state.result` before it ends. The card turns into a quiet record.

```text
 click +1 in your app
   → state.patch({count:6}, {baseRev:5})      port ── the page: manifest check, bucket, size
   → app-state-patch frame                     /ws ── the server: lock, merge, rev 6, size
   ← app-state {rev:6, value:{count:6}}        /ws ── to every seat
   ← state push                                port ── into every person's app
```

## Why each party checks

The page and the server both enforce the manifest, and the page also parses every message with a strict schema. It looks redundant. It is deliberate: your app is untrusted, so the page does not forward what it is told; and the page itself runs in the person's browser, so the server does not trust the page. A malicious app can lie to the page and gets `invalid` or `not-allowed`. A modified client can lie to the server and gets nothing.

## Where each piece is in the repository

| Piece | Where |
|---|---|
| The SDK your app imports | `packages/app-sdk/` |
| The manifest schema and validator | `packages/shared/src/apps/manifest.ts` |
| The message protocol (the bridge) | `packages/shared/src/apps/bridge.ts` |
| The page's side: iframe, bridge host, theme | `client/src/lib/apps/`, `client/src/components/apps/` |
| The server's side: sessions, seats, state | `server/src/apps/`, `server/src/ws/apps.ts` |
| The packager and dev server | `tools/apps-build/` |
| The internal reference this site grew from | `docs/APPS.md` |

Next: [the sandbox](/concepts/sandbox), then [the bridge](/concepts/bridge).
