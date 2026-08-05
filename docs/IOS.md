# iOS app

A native SwiftUI client in `ios/`. It talks to the same server as the web app —
no mobile-specific backend, no BFF.

## Running it

The Xcode project is **generated** and gitignored; `ios/project.yml` is the
source of truth.

```bash
brew install xcodegen           # once
cd ios && xcodegen generate
open pqp.xcodeproj
```

Debug builds point at `http://localhost:3001` and authenticate with the
dev-bypass token, so bring the server up first:

```bash
# root .env
DEV_AUTH_BYPASS=true
```
```bash
docker compose up -d postgres && pnpm dev
```

Release builds point at the hosted API (`Backend.hosted`), which requires a
Clerk key — see **Auth** below.

## Layout

| Path | What |
|---|---|
| `Sources/App` | Entry point, root phase switch, splash |
| `Sources/Design` | Palette, type scale, motion, shared components, the vector mark |
| `Sources/Core` | Models, REST client, WebSocket client, session |
| `Sources/Onboarding` | The three-beat intro |
| `Sources/Home` | Servers / conversations / profile tabs |
| `Sources/Chat` | Channel list, transcript, composer |
| `UITests` | End-to-end against a **running** local server |

## Auth

Two modes, chosen at launch by whether a publishable key is present:

| `CLERK_PUBLISHABLE_KEY` | Mode | Reaches |
|---|---|---|
| unset (default) | dev bypass | local server only |
| `pk_…` | Clerk | any deployment |

The key is a build setting written into `Info.plist`, so a fork changes it
without editing Swift. Clerk publishable keys are public by design — the web
client ships one in its JS bundle — but it is still not committed:

```bash
cd ios
xcodebuild -project pqp.xcodeproj -scheme pqp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CLERK_PUBLISHABLE_KEY=pk_test_… build
```

Or set it once in Xcode under the target's build settings.

Sign-in uses Clerk's own `AuthView` as shipped rather than a hand-built form.
It covers email codes, OAuth and MFA, none of which can be exercised here
without a real inbox — a bespoke version would be unverifiable code on the one
path where being wrong locks everybody out.

`ClerkTokenProvider` reads a **fresh** token per request. Clerk session tokens
live about a minute, so caching one — or capturing it at launch — makes
everything work for sixty seconds and then 401 forever. That exact bug already
shipped once on the web client.

**Configuring Clerk is not enough: it must also be put into the SwiftUI
environment.** Clerk's views read `@Environment(Clerk.self)`, and a missing
environment value traps inside SwiftUI with a stack that never mentions Clerk —
`PqpApp` injects it via `ClerkEnvironment`.

## Decisions worth knowing

**Sending a message is a WebSocket frame, not an HTTP call.** There is no
`POST /api/channels/:id/messages` — the protocol only offers `message-create`
over `/ws`. That makes the socket load-bearing rather than an enhancement, which
is why `RealtimeClient` reconnects with capped backoff instead of giving up.

**There is no ack and no error frame.** An invalid frame is silently dropped
server-side. The only correlation the protocol offers is the `nonce` echoed back
on `message-broadcast`, so that is what retires an optimistic row.

**Dates need a custom decoding strategy.** The server emits
`Date.toISOString()`, which always carries milliseconds, and
`JSONDecoder.DateDecodingStrategy.iso8601` *rejects* fractional seconds — using
it would fail on literally every message. `Coding.decoder` tries both formats.

**`Message.blocked` is on the wire but not in the zod schema**, and
`Server.role` is genuinely absent (not null) outside `/api/servers`. Both are
decoded defensively; see the comments in `Models.swift`.

**`presence-update` uses `name`, every other payload uses `displayName`.** One
struct cannot serve both, hence `PresenceUser`.

**Two Swift names had to avoid SwiftUI's.** `Layout` and `Environment` are both
SwiftUI symbols; same-named types resolve to *those* at use sites and fail with
errors that do not mention shadowing at all. They are `Metrics` and `Backend`.

**Onboarding is gated on a stored flag, not on "is there a session".** A
restorable session does not mean the person has seen the product explained — and
with the dev bypass a session *always* restores, which would have made
onboarding unreachable and therefore untested. Signing out clears the flag,
which is how to see the intro again.

## Tests

The UI tests run against a **live local server** rather than mocks. That is the
point: a decode mismatch on one field name is the most likely thing to ship, and
a mocked test cannot see it. `testSendingAMessageEchoesBackFromTheServer` covers
the whole round trip — connect, auth, join, send, broadcast, render.

```bash
cd ios
xcodebuild -project pqp.xcodeproj -scheme pqp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

They will fail without the server running. That is intentional.

## Not built yet

This is the foundation, not the finished app.

- **A completed Clerk sign-in.** The flow is wired and the sheet renders against
  the real Clerk application, but finishing a sign-in needs a working inbox, so
  the post-authentication path (token → `/api/me` → `.ready`) is unverified on
  device. Everything after that point is the same code the bypass already
  exercises.
- **Voice.** Channels are listed and marked `SOON`. Needs WebRTC (mesh) or the
  LiveKit Swift SDK, plus the signalling frames already defined in
  `signaling.ts`.
- **Attachments** — upload is a three-step presign/PUT/claim dance; the app
  currently renders received attachments as chips but cannot send them.
- **Push notifications** — needs APNs and a server-side sender, which does not
  exist for web either.
- **Reactions, editing, pinning, search, moderation, DM creation, invites.**
  Reactions and pins *render*; none of them can be performed yet.
- **iPad layout.** The target builds universal but the layout is phone-first.
