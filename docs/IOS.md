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
dev-bypass token, **so the server has to be running** — without it the app lands
on onboarding with "Could not connect to the server." rather than signing in:

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
| `Sources/Voice` | Mesh WebRTC engine, room state, call UI |
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

**Nothing on the launch path may wait indefinitely.** The splash has no
controls, so anything that hangs during `restore()` strands the app on a logo
with no way out — which shipped once, because `waitsForConnectivity` parks a
request until the network returns, bounded only by `timeoutIntervalForResource`
(seven days by default). Both clients now fail fast, and `restore()` additionally
carries a 12s deadline as a backstop. `LaunchResilienceUITests` bounds this on
*time*, not just on eventually arriving, so the backstop alone cannot satisfy it.

**Onboarding is gated on a stored flag, not on "is there a session".** A
restorable session does not mean the person has seen the product explained — and
with the dev bypass a session *always* restores, which would have made
onboarding unreachable and therefore untested. Signing out clears the flag,
which is how to see the intro again.

## Attachments

Sending a photo is the server's three-step dance: mint a presigned PUT, send the
bytes **straight to storage**, then claim by putting the id on `message-create`.
There is no HTTP route that claims — the claim *is* the message.

An uploaded-but-unclaimed attachment is deliberately invisible, and `/url` 404s
for it. Worth knowing, because a test that stops after the PUT passes while the
feature is broken for anyone actually sending a photo; `AttachmentUploadTests`
covers the whole path and downloads the bytes back.

Images are re-encoded to JPEG on the way out. An iPhone stores HEIC, which a web
client cannot display — the other end of the conversation would see nothing.

Requires storage to be configured, so locally:

```bash
docker compose --profile storage up -d postgres minio minio-init
# then the S3_* block from docs/ATTACHMENTS.md in .env
```

Without it the app hides the attach button rather than failing on tap.

## Voice

Full-mesh WebRTC, matching the server's default backend. The signalling relay is
the same `/ws` socket the chat uses; `VoiceClient` owns the peer connections.

**The politeness rule has to match `peer-connection-manager.ts` exactly.** There,
the peer whose id sorts *higher* is "impolite" and sends the initial offer.
Invert it and two peers either both offer (glare) or neither does (a silent
deadlock where everyone sits in `connecting` forever) — and it looks fine until
two *different* clients meet in one room, which is exactly the case no
single-client test covers.

Other things the mesh depends on:

- **ICE candidates are queued until a remote description exists.** They routinely
  arrive before the answer, and adding one early throws.
- **A `null` candidate is end-of-candidates**, not an error.
- **The delegate must be retained.** `RTCPeerConnectionFactory` does not hold it,
  so callbacks stop arriving mid-call if it is allowed to deallocate.
- **`RTCIceCandidate` is not `Sendable`** — its fields are copied out on the
  delegate's thread before crossing into the actor, which Swift 6 enforces.
- Audio uses `.playAndRecord` with mode `.voiceChat`, which is what turns on echo
  cancellation; `.playAndRecord` alone does neither that nor sensible routing.

Verified with **two simulators in one room**: both reached `connected`, which
exercises the real negotiation rather than one client talking to itself.

Speaking indicators come from polling each connection's `audioLevel` in the
WebRTC stats report every 300ms — there is no "is speaking" event to subscribe
to. Deafening silences remote tracks and forces the mic off, matching the web
client: being heard while hearing nothing is a trap rather than a feature. That
needs a reference to each remote track, which is why they are captured on
`didAdd stream` — WebRTC plays received audio automatically, so without one
there is no way to turn it off short of tearing the connection down.

A call survives a socket drop by being **rebuilt, not resumed**. The server
drops the voice peer when the socket closes and a reconnect mints a *new* peer
id, so the old mesh is unusable; `ready` tears everything down and rejoins.

### The socket that looked online and was not

`RealtimeClient` used `URLSessionConfiguration.timeoutIntervalForResource = 30`.
That is a ceiling on the *whole* resource load, and a WebSocket **is** the
resource — so URLSession timed out every socket thirty seconds after it opened.
The failure was invisible: frames already buffered kept arriving through the
pending `receive`, so presence, other people's messages and incoming call rings
all still worked, while every outgoing frame was dropped by the `.running` guard
in `send`. Answering a DM call therefore sat on "Connecting…" forever (the
`join-voice-room` never left the phone) and a message typed after half a minute
simply vanished.

Two things changed. A long-lived socket gets **no lifetime ceiling** — only an
idle timeout comfortably longer than the ping interval — and a send that cannot
leave now **reconnects instead of returning quietly**. This connection is the
only way the app can say anything, so a swallowed frame is a client that looks
online and does nothing.

## Screen sharing

Both directions work. Receiving is the mesh's ordinary video path; **sending
needs a ReplayKit broadcast upload extension**, because that is the only way iOS
lets an app capture the system screen rather than its own window.

| Piece | Where |
|---|---|
| Extension (`gg.pqp.app.broadcast`) | `pqp/Broadcast/SampleHandler.swift` |
| Wire format, downscale, frame clock | `pqp/ScreenShare/ScreenShareWire.swift` |
| Socket, both ends | `pqp/ScreenShare/ScreenShareSocket.swift` |
| App-side receive → `CVPixelBuffer` | `Sources/Voice/ScreenShareReceiver.swift` |
| "Am I sharing" state machine | `Sources/Voice/ScreenShareController.swift` |
| Picker, share stage, fullscreen | `Sources/Voice/ScreenShareViews.swift` |

The extension is a **separate process**, and the WebRTC peer connections live in
the app, so frames cross an App Group (`group.gg.pqp.app`) over a **Unix domain
socket** carrying tightly packed NV12 at ≤720p / 12fps. The reasoning for both
choices is in the header comment of `ScreenShareWire.swift`; the short version is
that a socket gives ordering and backpressure for free and a failed write tells
the extension the app is gone, and that raw NV12 avoids an encode/decode round
trip across what is local memory.

Things iOS makes awkward, and how they are handled:

- **Starting is the system's decision.** `RPSystemBroadcastPickerView` is the only
  door, and it must be tapped by the user — so the real control is laid over ours
  at an alpha UIKit still hit-tests, rather than reaching in for the private
  button. Nothing changes state until a frame actually arrives, so a picker that
  is opened and dismissed leaves no trace.
- **Stopping is the system's decision too**, from the status-bar indicator, and
  iOS tells the app *nothing* — frames simply stop. Going quiet is the only stop
  signal that exists, hence the two-second watchdog in `ScreenShareController`.
- **The socket path must fit `sockaddr_un`** (104 bytes). A device's App Group
  container path plus `s.sock` fits; the *simulator's* does not, which is one
  reason the share affordance hides itself there (`isAvailable == false`).

`-pqp.fakeScreenShare` feeds a synthetic moving pattern through the same publish
path, which is how the wire half is verified without a device: the far end must
see a stream id of `pqp-screen-…`, a roster with `sharingScreen: true`, and real
decoded frames.

**Device-only.** ReplayKit broadcast has no simulator equivalent, so the
extension itself, the App Group container socket, and the `.left`/`.right` ↔
90°/270° rotation mapping can only be confirmed on hardware.

Per-peer volume is done; screen share is done. Camera-in-voice-channels is not
(neither client offers it).

## Writing UI tests here

Three things this suite learned the hard way.

**Tests must be hermetic — which means cleaning up, not just seeding.** The
message-action tests originally ran against a shared channel, so every run added
to the same transcript; once it held eighteen messages *and an inline image* the
suite went from 20s to 223s and failed with "Timed out while evaluating UI
query". Seeding a fresh server per test fixed that and then reproduced it one
level up: nothing deleted them, so 24 servers accumulated and the *list* became
the slow screen. `TestSeed` now creates and deletes, and the suite is checked by
asserting the server count returns to zero after a run.

**Never poll `.value` in a loop.** Every XCUITest query snapshots the entire
accessibility tree. A 10Hz poll against a long transcript costs minutes — that
"fix" for a race made the test ten times slower and still failed.

**Screenshots find what assertions cannot.** Two separate bugs this session were
diagnosed from screenshots taken mid-run, not from failure messages: an app that
had crashed while its test still passed, and an edit race that surfaced as an
unrelated-looking assertion about a message body.

## UI test identifiers

Controls that tests drive carry an explicit `accessibilityIdentifier`
(`composer.input`, `composer.send`). This is not decoration: a SwiftUI
`TextField`'s accessibility label is its *placeholder*, which disappears the
moment the field has text — so a test that queries by `"Message"` silently stops
finding the composer exactly when it is mid-edit, and fails somewhere later with
an unrelated-looking assertion.

## Notifications (APNs)

Native pushes are the **second leg of the server's existing push feature**, not a
system of their own. `server/src/services/push.ts` decides *who* gets told —
mentions, replies, DMs and rings only, only when the person has no live socket
anywhere, respecting do-not-disturb and per-channel levels — and then fans out to
Web Push and APNs from one place (`deliverToUsers`). The iOS app re-decides none
of that.

Server env (all in `.env.example`); the leg is off entirely unless the first
three are set:

| Name | Notes |
|---|---|
| `APNS_KEY_ID`, `APNS_TEAM_ID` | from the auth key in the developer portal |
| `APNS_PRIVATE_KEY` | the PEM **contents** of the `.p8`, not a path. Literal `\n` between lines is accepted |
| `APNS_TOPIC` | the bundle id. Defaults to `gg.pqp.app` |
| `APNS_ENVIRONMENT` | `sandbox` or `production`. **Defaults to production**, which is right for TestFlight and the App Store; only a build run from Xcode needs `sandbox` |

The transport is `server/src/services/apns.ts`: an ES256 provider JWT cached 40
minutes, HTTP/2 to `api.push.apple.com` over one reused session, and no new
dependency (APNs bodies are plain JSON over TLS — there is no RFC 8291 payload
encryption to justify a library the way Web Push does). Calls go out as
`apns-push-type: alert`, priority 10, expiring with the 50s ring, collapsed on
the conversation id. **VoIP / PushKit is deliberately out of scope**: it would
let the app present the system call UI before the user touches anything, but it
needs a second push type, a `PKPushRegistry`, and CallKit reporting on every
single push or the OS kills the app.

On the device: permission is asked **once, after a real sign-in lands on
`.ready`**, behind an explainer sheet (`PushExplainerView`) — the system dialog
appears once per install and a refusal is permanent, so the timing is the
feature. The token is re-sent on **every** launch, because iOS may hand over a
different one (`registerIfAlreadyAuthorized`). A notification for the
conversation already on screen is listed but not banner-ed
(`PushPresentation.shouldInterrupt`, fed by `SessionStore.visibleChannelId`).
Tapping one routes through `DeepLink`, which parses the very same
`/app/dm/<id>` and `/app/server/<sid>/channel/<cid>` paths the server puts in the
payload and the web SPA parses in `client/src/lib/app-route.ts`.

Signing out unregisters the token first, while the call can still authenticate —
otherwise a shared phone keeps buzzing with the previous account's DMs.

### Checking a real push end to end

Simulators cannot receive APNs, so this needs a device.

1. `fly secrets list -a pqp-api` — confirm the four `APNS_*` names are present.
   A secret is only picked up by a **new** machine, so deploy after setting them.
2. `curl -s https://api.pqp.gg/api/push/config -H "Authorization: Bearer <token>"`
   → must answer `"apns": true`. False means the three required names are not all
   set, and nothing else below will work.
3. Install a TestFlight build on a device, sign in, accept the explainer, accept
   the system dialog. In the server log the registration is a plain
   `POST /api/push/subscriptions`; confirm the row exists with
   `SELECT platform, left(token, 8), created_at FROM push_subscriptions;`
4. **Force-quit the app** (swipe it away). A backgrounded app still holds its
   WebSocket, and a live socket is exactly what suppresses the push — this is the
   step that makes people think the feature is broken.
5. From another account, DM that user. The phone should show "pqp / New direct
   message" within a second or two. Tap it: the app opens on that conversation.
6. If nothing arrives, the log says which: `[apns] send failed (403
   InvalidProviderToken)` is the key/team id or the `.p8` contents; `[apns]
   pruning device token … 400 BadDeviceToken` is almost always
   `APNS_ENVIRONMENT` disagreeing with how the build was signed (Xcode build →
   `sandbox`, TestFlight → `production`); `TopicDisallowed` is `APNS_TOPIC` not
   matching the bundle id.
7. Then a ring: start a call to the same user. The push must arrive within the
   ring, and must **not** arrive a minute later — that expiry is what
   `apns-expiration` buys.

## Invite links

An invite is `https://pqp.gg/app/invite/<code>` — the same URL the web client
copies to the clipboard (`client/src/components/layout/invite-panel.tsx`).

Two ways it reaches the app:

- **Universal links.** `applinks:pqp.gg` in the entitlements (generated from
  `ios/project.yml`), plus
  `client/public/.well-known/apple-app-site-association` served by Cloudflare
  Pages, which claims **only** `/app/invite/*` — not `/*`, which would hijack
  every link on the site. Apple's CDN fetches that file, so a universal link
  cannot work until it is deployed, and can be cached stale for ~24h after a
  change.
- **`pqp://invite/<code>`**, registered in `Info.plist`, for everywhere universal
  links do not fire. During development this is the only one that works:
  `xcrun simctl openurl booted "pqp://invite/ABC123"`.

Both land in `SessionStore.requestNavigation`. Signed in: join and navigate.
Not signed in: the code is stashed in `UserDefaults` (`PendingInvite`) — not a
property, because Clerk sign-in can hand off to a web flow and come back through
a relaunch — and consumed exactly once when the session reaches `.ready`.
Already a member is a success and just navigates (the server's insert is `ON
CONFLICT DO NOTHING` and burns no use); a refusal shows the server's own
sentence verbatim, because only it knows whether the code was expired, revoked,
exhausted or the user is banned.

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

## Parity with the web client

Both clients talk to the same API — there is no mobile backend and no BFF — so
parity is a matter of building the remaining screens, not of architecture.

Done: servers, channels (create/rename/delete), text chat with reply/edit/
delete/react/pin, attachments, DMs and DM creation, invites, message search,
members with kick/ban/roles and a ban list, leaving a server, and mesh voice
with mute/deafen/speaking indicators.

Also done: link-embed cards, emoji and GIF pickers, notification preferences,
blocking, profile editing, server settings (rename, retention, SSO domain, audit
log, delete), webhook management, and speaker/earpiece routing in voice.

Also done: channel categories with move-between, the private-channel member
picker, group DMs, data export (via the share sheet), ownership transfer, and
per-peer volume.

Also done: **native push notifications** (APNs — see above) and invite links that
open the app, by universal link or `pqp://`.

Still only on web: **screen share** (needs a second video track through the
existing mesh) and drag-to-reorder within a category (channels can be moved
between categories, but not dragged into a position).

## Not built yet

This is the foundation, not the finished app.

- **A completed Clerk sign-in.** The flow is wired and the sheet renders against
  the real Clerk application, but finishing a sign-in needs a working inbox, so
  the post-authentication path (token → `/api/me` → `.ready`) is unverified on
  device. Everything after that point is the same code the bypass already
  exercises.
- **VoIP pushes (PushKit + CallKit).** An incoming call arrives as an ordinary
  notification, not as the system call screen. See the Notifications section for
  what that would cost.
- **Group DMs.** The API takes up to nine participants; the picker starts one
  conversation with one person.
- **iPad layout.** The target builds universal but the layout is phone-first.
