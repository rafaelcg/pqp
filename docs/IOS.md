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

**The sheet shows Google and Apple, and Apple needs an entitlement.**
`AuthView` renders one button per provider enabled on the Clerk instance, and
`clerk.pqp.gg` has `oauth_google` and `oauth_apple` both enabled. Clerk's iOS SDK
takes the *native* path for Apple (`ASAuthorizationAppleIDProvider`), so without
`com.apple.developer.applesignin` the button is offered and fails. Build 12 and
earlier were in exactly that state: Guideline 4.8 requires Sign in with Apple
once Google is offered, and a broken one does not satisfy it. The entitlement is
declared in `ios/project.yml`; the capability still has to be enabled on the App
ID and the `pqp appstore` profile re-minted, or Release signing fails. See
[`TESTFLIGHT.md`](./TESTFLIGHT.md).

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

**A peer can send more than one audio track.** Sharing a screen with its sound
publishes the machine's audio alongside the microphone, under the screen
capture's own stream id, which the web client has done since 2026-08-22. Remote
audio is therefore filed per peer *and per track* (`RemoteAudioMixer`, covered by
`RemoteAudioTests`). Keyed by peer alone, the second track overwrote the first
and took the only handle on the microphone with it: deafen then silenced the
screen and left the presenter's voice playing, and the per-person slider reached
half of what that person was sending. Neither logged anything.

### Cameras

Cameras work in a **server voice channel** as well as in a DM call, matching the
web client (PR #77). The mesh never cared which kind of room it was carrying:
`VoiceClient` publishes and classifies video identically either way, and until
now a voice channel simply had no button and no tiles. It filed every peer's
`cameraStreamId` correctly and drew nothing with the answer, so the app received
everyone's camera and showed none of them.

Turning one on is `VoiceModel.toggleCamera`, which is the same three calls
`CallModel` already made: publish, announce over `set-camera`, switch the audio
session to `.videoChat`. Faces take the space the speaker icon had when nobody is
sharing a screen, and a rail beside the screen when somebody is. Tapping your own
tile flips the camera, as on the DM stage.

### Quality

One picker, in Settings, governing **both** the camera and the screen share:
auto / 1080p / 720p / 480p / 360p, mirroring `client/src/lib/video-quality.ts`.
Device-local (`UserDefaults`, like the web's `LocalSettings`) rather than an
account preference, because what a phone can encode and what its uplink can carry
are facts about the phone. It applies live, to senders already on the wire.

**A label names a size, and a size is not a bitrate.** The web ladder shipped as
a `maxBitrate` and nothing else, and every rung below 1080p still arrived at the
far end as 1920x1080: a ceiling with nothing behind it does not make a smaller
picture, it makes the same picture worse. That was caught by eye and fixed in
PR #84. So every rung here also sets `scaleResolutionDownBy`, computed from the
source's own line count rather than hard-coded, because it is a divisor: a
constant 3 is 360p on a 1080-line source and 480p on a 1440-line one.

**Until now this client called `setParameters` nowhere at all.** No sender had a
bitrate ceiling, a frame rate, a size, or a degradation preference, on any track,
ever. That is almost certainly why a share documented as 720p was reported from a
phone arriving at roughly 360p: the default preference is `maintain-framerate`,
which means *shrink the picture* under pressure, and with no ceiling to reach for
there was nothing holding the encoder at the size it captured. Both senders now
state a ceiling, a frame rate and a size, and the screen's ceiling is split
across the room by `meshScreenBitrate` the way the web splits it, because a mesh
uploads one copy per peer.

Both roles ask for `maintain-framerate`. An earlier draft gave the screen
`maintain-resolution`, on the argument that a legible slideshow beats a smooth
blur; that argument assumed the 12 fps below, and Rafael's verdict on 12 fps was
"unusable". Under pressure the picture now gets smaller rather than stuttering,
which is what the web has always asked for too. The ladder is the lever: on a
link that cannot do 720p30, picking 480p buys a crisp 480p30.

`videoSource(forScreenCast:)` was considered and deliberately not used: it turns
the quality scaler off, but it also puts VP8 into `ScreenshareLayers`, whose base
temporal layer targets about 5 fps. See the comment in `startScreenShare`.

**The size ceiling is unchanged and is the real limit on the top rung.** The
broadcast extension still packs at `ScreenShareWire.maxLongSide` (1280), for the
memory reasons in that file's header, so 1080p and 720p send the same picture
with a different allowance behind it. Settings says so out loud. Raising it means
letting the extension read the choice out of the App Group, in a ~50 MB process,
on a path nobody has yet run on a phone.

### 30 fps

The wire ran at 12 fps until it was called unusable from a phone, which it is.
The old constant was defended on two grounds and neither survives contact.

"Screen content is mostly static" is a claim about the *average* frame, and the
average is what a codec already handles for free: a still page costs almost
nothing however often it is sampled. What a frame rate buys is the moments that
are not static, which is every moment anybody is scrolling, dragging, playing
something or moving a cursor. Sampling those at 12 Hz does not make them cheaper,
it makes them unreadable.

"Every frame is an encode per peer in a mesh" is true, and is an argument for a
governor rather than for this constant. The governor now exists:
`meshScreenBitrate` splits one 5 Mbps upload budget across the room, so a crowded
call spends its budget on fewer bits per frame, which WebRTC decides continuously
and well, rather than on a frame rate chosen once by a number that could not see
the room. The web has run its screen at 30 since it had one
(`SCREEN_MAX_FRAMERATE`); this was never a considered difference between the
platforms, only an unexamined one.

**What 30 costs on the local bridge.** 720p NV12 is ~1.38 MB a frame, so the
socket carries ~41 MB/s rather than ~17. An iPhone's memory bandwidth is GB/s, so
the copy was never the wall; the walls are syscalls and buffers in flight inside
a ~50 MB process, and both are now addressed where they live:

- the extension **allocates nothing per frame**. `ScreenShareScaler` keeps its
  planes and hands them out in place, and the socket writes the header and the
  planes separately. The `Data` concatenation that used to sit between them cost
  two 1.38 MB copies a frame, which at 30 fps would be 83 MB/s of pure churn in
  the one process the OS kills rather than warns;
- send and receive buffers are raised to about one and a half frames, so a
  frame's write is usually one pass instead of hundreds of kernel round trips;
- the app reads 256 KB at a time instead of 64 KB, into a buffer it keeps: six
  syscalls a frame rather than twenty two;
- a frame is **dropped whole** when the socket is not writable at all, rather
  than parking ReplayKit's thread inside a write while more frames queue behind
  it. Dropped is not failed, and only failed tears the bridge down.

**Battery and thermals are the honest open question.** 720p30 is 27.6 Mpx/s of
encode *per peer*, so a four-way mesh asks the phone for four of those. Nobody
has run it on hardware, so there is no number to quote here. What can be said is
that the rungs trade against each other almost exactly: 720p12 was 11.1 Mpx/s and
480p30 is 12.3, so somebody who finds 720p30 too warm has a real answer in the
picker rather than a regression to report.

### Reading what is actually transmitted

`VideoSendReport` polls `outbound-rtp` on the live connections and Settings shows
it: the encoded size, the frame rate, the kbps, and `qualityLimitationReason`
(your connection / this phone / the encoder). **This is an instrument, not a
readout.** What a sender asks for and what its encoder produces are different
things, only the second reaches anybody, and every check that compared a request
against a request passed while the web ladder was broken. iOS could not say what
it transmitted at all, which is why "the iOS share arrives at 360p" had to be
reported by eye and could not be confirmed by anyone without a phone.

To settle it: join a call, share the screen or turn the camera on, open Settings,
read the Video section. Numbers well under the choice with "limited by your
connection" is bandwidth; under it with "limited by this phone" is the encoder
giving up on CPU; at the choice is the ladder working.

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

Receiving works and is verified. Receiving is the mesh's ordinary video path;
**sending needs a ReplayKit broadcast upload extension**, because that is the
only way iOS lets an app capture the system screen rather than its own window.

**The sending half is built and has never been run on a phone.** Read
**Device-only** below before repeating anything about it: what is settled is
that the code exists and is wired up, and that is a different claim from "it
works".

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
socket** carrying tightly packed NV12 at ≤720p / 30fps. The reasoning for both
choices is in the header comment of `ScreenShareWire.swift`; the short version is
that a socket gives ordering and backpressure for free and a failed write tells
the extension the app is gone, and that raw NV12 avoids an encode/decode round
trip across what is local memory.

### The control that did nothing (build 12)

Reported from a real phone against build 12: tapping Share did nothing at all.
Two faults in our own composition were found and fixed, both measured rather
than reasoned about, and both pinned by `ScreenSharePickerTests`:

- **Apple's button is not where its view is.** `RPSystemBroadcastPickerView`
  lays its single `UIButton` out at `(5, 5)` with the picker's *full* width and
  height. Inside 62x62 bounds that runs from 5 to 67, so the part that both
  hit-tests and overlaps the bounds is a 57x57 square in the bottom-right
  corner: the top and left five points of the circle we paint were dead, and a
  tap there reached the picker, which has no action. `alignHitTarget` now pins
  the button to the bounds on every layout pass, so what is painted and what is
  tappable are the same square.
- **The invisibility was one rounding step from killing the control.** UIKit
  refuses to hit-test a view at alpha 0.01 or below. The picker sat at
  `.opacity(0.02)` in SwiftUI, and SwiftUI's opacity *multiplies* down the tree,
  so `VoiceView` wrapping the control in `.opacity(0.4)` while the room was
  connecting produced 0.008 and a control that could not be touched at all. The
  alpha now lives on the `UIView` itself, where UIKit reads each view's own
  value and no ancestor can multiply it under the floor.

`VoiceView` also passes its 60pt size *into* the control rather than imposing it
with an outer `.frame`, so the circle, the picker and Apple's button are one
square by construction.

**What this does not settle.** Whether iOS then finds the extension and opens
its sheet is device-only. What can be said off-device is that the tap reaches
Apple's button (asserted on a grid, corners included), the `.appex` is embedded
with the bundle id `preferredExtension` names, its `NSExtensionPointIdentifier`
is `com.apple.broadcast-services-upload`, and its principal class resolves
(`_TtC12pqpBroadcast13SampleHandler` is in the binary).

**To settle it, on a phone:** join a voice channel, tap Share. Either the system
sheet appears, which means the picker and the extension are fine and anything
still wrong is downstream, or nothing appears, which means iOS is not finding
the extension and the next thing to check is the App Group on both App IDs.
If the sheet appears and Start Broadcast produces no picture within five
seconds, the app now says so rather than sitting there: a capture that begins
within fifteen seconds of a tap on our own control, and then sends no frame, is
reported. That window is what keeps AirPlay and the built-in screen recorder,
which also set `isCaptured`, from being blamed on us.

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

**Device-only, and therefore unverified.** ReplayKit broadcast has no simulator
equivalent, so the extension itself, the App Group container socket, and the
`.left`/`.right` ↔ 90°/270° rotation mapping can only be confirmed on hardware.
Nobody has pointed a real iPhone at this yet.

What that leaves is a wiring check, not a result. All of this is true and none
of it is evidence the feature works:

- the extension target exists, is embedded in the app (`embed: true` in
  `project.yml`, without which the picker's sheet is empty), and declares
  `RPBroadcastProcessModeSampleBuffer`;
- both targets carry the `group.gg.pqp.app` App Group entitlement, which is the
  only filesystem they share and where the frame socket lives;
- the picker sets `preferredExtension` to `gg.pqp.app.broadcast`;
- `-pqp.fakeScreenShare` proves the *app-side* publish path end to end, which
  is the half after the socket.

The simulator cannot even be used to poke at it by hand: its App Group container
path does not fit `sockaddr_un`, so `isAvailable` is false there and the share
affordance hides itself.

**Do not write "iOS can share its screen" or "iOS cannot share its screen"
anywhere** — a blog post, `tools/support-bot/facts.md`, a release note — until
somebody has run a TestFlight build on a phone. Both sentences are currently
unsupported. It is cheap to settle: one build, one phone, thirty seconds.

Per-peer volume is done. Screen share receiving is done; screen share sending is
written and, as of build 12, reported broken from a phone (see above).
Camera-in-voice-channels is done, and so is the camera and screen quality ladder
that the web got in PR #84. Neither has been seen on a phone yet: the picture a
quality choice produces exists only on a live connection, which is what
`VideoSendReport` and the Video section of Settings are for.

## Copy and pt-BR

All UI copy lives inline in Swift and is collected into
`pqp/Resources/Localizable.xcstrings`, which is **keyed on the English source
string**. Three checks cover it, and each sees something the other two cannot:

| Check | Where | Catches |
|---|---|---|
| Every catalogue key still has its pt-BR | `NoEmDashTests` | a translation orphaned by editing the English literal, which renames its key |
| Every English literal is *in* the catalogue | `Check localisation coverage` build phase (`Scripts/check-localization.py`) | copy that never reached the catalogue at all |
| The compiled bundle answers in Portuguese | `LocalizationCoverageTests`, `LocalizationUITests` | a catalogue that is in the repo and not in the app |

The middle one is the one with no Xcode equivalent, and it is why
`SWIFT_EMIT_LOC_STRINGS` is on: the compiler writes one `.stringsdata` per file
naming every localised literal it saw, which is the only authority on which
strings are copy. Nothing else can tell `Text("Hang up")` from `Text(name)`. It
found **126** untranslated strings the first time it ran, on an app whose
catalogue was 100% translated by the other measure: the whole Friends screen,
the whole DM call UI, threads, screen share and every audit-log phrase.

Two ways to be wrong, both silent before that phase existed:

- **A new literal with no catalogue entry.** `Text("Hang up")` falls back to its
  own key, so a Brazilian reader gets English and nothing anywhere says so. The
  build phase now fails with the file, the line and the string.
- **A translation that is never asked for.** `Text(someString)` is the
  *verbatim* initialiser, so a picker built from a `[(String, String)]` renders
  English however good the translation is. Four settings pickers and all
  nineteen audit-log phrases were in this state. The fix is `String(localized:)`
  at the point the literal is written, and the symptom to watch for is a
  catalogue key that no `.stringsdata` mentions.

Anything that is a value rather than words takes `Text(verbatim:)`: a reaction
count, a separator, an already-localised phrase being joined to another. Left as
`Text("\(count)")` it mints a catalogue key of `%lld` that no translator can do
anything with.

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

## Your own data: export and deletion

**Account deletion is an App Store submission requirement, not a feature.**
Review Guideline 5.1.1(v): an app that supports account creation must let the
account be deleted from inside the app. Both rights live in the last section of
Settings (`Sources/Home/AccountDataViews.swift`), against the same endpoints the
web client uses.

- **Export** — `GET /api/me/export`. The bytes are written to a temp file and
  handed to the share sheet, because a phone has nowhere to "download" to. Same
  arrangement as the community export in Server settings; both go through
  `APIClient.rawGet`.
- **Deletion** — `DELETE /api/me`, with the account's own tag typed by hand.
  `AccountDeletion` mirrors `deleteConfirmationMatches` from `@pqp/shared`, so
  the button being enabled and the server accepting the request cannot drift
  apart. Three refusals matter: 400 (what was typed does not match), 409 with
  `code: "owned_servers"` (communities other people are still in, listed by name
  so the screen can say which), and 502 (the identity provider refused; nothing
  was deleted and retrying is safe). Afterwards the app calls
  `SessionStore.signOut`, which is the right local teardown even though there is
  no session left to end.

The UI test deletes a **throwaway** dev-bypass account rather than the shared
one. `PQP_DEV_USER=<suffix>` makes `DevTokenProvider` send
`dev-local-token:<suffix>`, which the server's bypass mints as a separate
identity; without that, running the suite would destroy the servers,
conversations and handle every other test reads. Debug-only, like
`PQP_API_OVERRIDE`.

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

Also done: **your own data** — the personal export and account deletion, in
their own Settings section. See below.

Still only on web, as of 2026-08-25:

| Gap | Note |
|---|---|
| **Roles and permissions** (PR #75) | 20 permission bits, role management, per-channel overwrites. iOS knows only the legacy `owner`/`admin`/`member` rank (`Moderation.swift`). **Not a leak:** `listChannels` resolves VIEW_CHANNEL in Postgres and the server evicts sockets, so a permission-blind client is never shown content it should not have. What iOS now also does is act on `permissions-update` and re-read the list, so a channel you have lost no longer sits in the sidebar until relaunch. |
| ~~Camera in a channel call~~ | **Done.** See **Cameras** above. |
| ~~Screen-share quality selector~~ | **Done**, with one platform difference: the screen is still *captured* at 1280 on the long side, so the top two rungs send the same picture. See **Quality** above. |
| **In-app sounds** (PR #62) | No cue playback of any kind on iOS. Haptics only. |
| **Game connections** (PR #58) | Steam / Battle.net / Twitch are absent entirely. |
| **Public profile viewer** | The handle can be claimed and shared from Settings, but `UserProfileSheet` shows the `name#1234` tag and never a `pqp.gg/@handle`, and there is no deep link for one. |
| Drag-to-reorder within a category | Channels move between categories, but not into a position. |
| Attachments | Outbound is JPEG-only, from the photo picker. No document picker, so no video, audio, PDF or text upload. |
| Threads | No `GET /api/channels/:id/threads` exists, so the list is derived from the last ~100 messages; no archive action. |

> Screen share used to be on that list and was left there by mistake. It landed
> the day after this file was written (`e6027ba`, "See and send screen shares on
> iOS"), which updated the detailed section above without updating this summary,
> so the document spent two weeks contradicting itself one screen apart.
>
> What git settles is only that the code exists: `e6027ba` (8 Aug) is a
> descendant of `f68bfcb` (7 Aug), which is where "still only on web" came from.
> **Receiving is verified. Sending is written and has never run on a phone** and
> must not be described either way. See **Screen sharing** above.

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
