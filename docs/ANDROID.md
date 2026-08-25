# Android app

A native Kotlin + Jetpack Compose client in `android/`. It talks to the same
server as the web and iOS apps: no mobile backend, no BFF, no protocol change.

**Read the state of it before quoting it.** Auth, servers, channels and text
chat are built and verified end to end against a live local server. Voice
carries audio between two clients, measured at both ends rather than inferred
from a connection state. Screen sharing sends and receives, and the resolution
was checked where it arrives rather than where it was asked for. The honest
boundaries, including the one thing about audio that is still not proven, are in
**What is real** at the bottom.

## Why native, and not the four cheaper options

Umami puts the audience at **Windows 76%, Android 14%, iOS 6%**. Android is
more than twice iOS's reach and had no app at all while two iOS builds shipped
the same night. That is the reason to build something. It is not, on its own, a
reason to build the most expensive thing, so all four options were costed
against the four constraints that actually decide it: **background WebRTC
voice**, **screen capture**, **push**, and **one maintainer**.

| Option | Verdict |
|---|---|
| **Trusted Web Activity / PWA wrapper** | **Rejected, and it is the one that hurts.** See below. |
| **Kotlin Multiplatform** | Rejected. KMP earns its keep by sharing logic between platforms, and iOS is plain Swift with its own hand-written models, socket and mesh. There is nothing to share with. It would add a build system nobody here knows in exchange for sharing code with a target that already has its own copy. |
| **React Native / Capacitor** | Rejected, narrowly. It would genuinely reuse the web client, and its WebRTC story is a real one. But the two features that make an Android app worth having, a call that survives backgrounding and screen capture, are both native modules you end up writing in Kotlin anyway, on top of a bridge, in a third language. For one maintainer that is the worst of both. |
| **Native Kotlin + Compose** | **Chosen.** |

### The TWA case, in detail, because it nearly won

`docs/PWA.md` is not a stub. The PWA is a real installable app: manifest,
service worker, prompted updates, notification clicks routed through the worker
specifically because Chrome on Android refuses `new Notification()`, `dvh`
heights, `visualViewport`-positioned dialogs. Wrapping it in a Trusted Web
Activity is perhaps a day of work and would put *something* on the Play Store
this week.

Three things stop it, and only the third is about feel.

1. **A call cannot survive the app being backgrounded.** Chrome suspends
   timers and throttles a backgrounded tab, and a TWA is a tab. There is no way
   for web code to hold a foreground service, which is the *only* mechanism
   Android offers for "keep running, the user knows". A voice app whose calls
   drop when you check a message is not a voice app.
2. **No mobile browser can share a screen.** `getDisplayMedia` is not
   implemented on Android Chrome. Every mobile visitor today can watch a screen
   share and none can start one, and screen capture is precisely where an
   Android app beats the desktop web, because `MediaProjection` needs no
   separate extension process the way iOS ReplayKit does. This is the largest
   single win available and it is unreachable from a wrapper.
3. **It would not feel native, and would be judged as if it did.** The web
   client is a desktop-shaped layout that has been made to fit a phone. A TWA
   removes the browser chrome and changes nothing else: no Material 3, no
   predictive back, no system share sheet, no launcher-coloured icon.

A TWA remains the right answer for a *reach* problem. This is a *capability*
problem.

### Effort, and what gets cut first

Roughly three weeks of solo evenings to reach rough parity with the iOS client.
This session covers the first of them. The order below is the order to keep, and
the order to cut from the bottom:

1. Auth, servers, channels, text chat. **Done.**
2. Voice with a foreground service. **Done, and audio measured on both sides.**
3. Screen sharing via `MediaProjection`, send and receive. **Done.**
4. Push via FCM, as the third leg of `server/src/services/push.ts`.
5. DMs, attachments, reactions, invites, everything on the parity list.

If time runs short, cut from **5 upward**.

## Running it

The toolchain on the machine this was written on: **Android Studio's bundled
JDK 25**, **SDK platform 37**, **build-tools 36.0.0**, **AGP 9.3.2**, **Kotlin
2.4.10**, **Gradle 9.7.1** (wrapper committed).

There is no JDK on `PATH`, so `JAVA_HOME` has to be pointed at Android Studio's:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
```

Then, from `android/`:

```bash
./gradlew :app:assembleDebug     # build
./gradlew :app:installDebug      # build and install on the running emulator
```

Opening `android/` in Android Studio works too and needs neither variable.

### The server has to be reachable, and `10.0.2.2` did not work

Debug builds point at `http://localhost:3001`, which reaches the host machine
through a reverse tunnel:

```bash
adb reverse tcp:3001 tcp:3001
```

**Run that after every emulator boot.** It is the default rather than the
fallback because the emulator's documented `10.0.2.2` host alias did **not**
route on the Pixel 10 Pro / API 37 image here: connections to it timed out after
ten seconds with the host firewall off and the server bound to `*:3001`. The
tunnel works identically on an emulator and on a phone plugged in over USB, so
it is one instruction instead of two.

The server itself, with the dev bypass on:

```bash
# root .env
DEV_AUTH_BYPASS=true
```
```bash
docker compose up -d postgres
pnpm --filter @pqp/shared build   # the server imports the built dist
pnpm dev
```

Without it the app lands on "The server did not answer." with a Retry button,
which is the intended failure rather than a hang.

To point a build somewhere else, without editing Kotlin:

```bash
./gradlew :app:installDebug -Ppqp.apiUrl=https://api.pqp.gg -Ppqp.wsUrl=wss://api.pqp.gg/ws
```

`android/local.properties` and the environment (`PQP_APIURL`, `PQP_WSURL`,
`PQP_CLERKPUBLISHABLEKEY`) are read the same way. Nothing is committed.

### Two accounts, for the tests that need two clients

A dev-bypass suffix mints a *separate* identity server-side, exactly as on iOS:

```bash
adb -s emulator-5556 shell am start -n gg.pqp.app.debug/gg.pqp.app.MainActivity \
  --es pqp.devUser bob
```

That account is `dev_local_user_bob`. Debug builds only.

Two emulators from one AVD need `-read-only` on **both**, which means restarting
an already-running one. If somebody is using that emulator, a second AVD is
cheaper than an argument: the `.avd` directory only needs a `config.ini` and an
`.ini` pointing at it, and the emulator builds the rest on first boot.

```bash
# two instances of one AVD
emulator -avd Pixel_10_Pro -read-only -port 5554 &
emulator -avd Pixel_10_Pro -read-only -port 5556 &

# or a private clone, leaving the running one alone
mkdir -p ~/.android/avd/pqp_b.avd
sed -e 's/^AvdId=.*/AvdId=pqp_b/' ~/.android/avd/Pixel_10_Pro.avd/config.ini \
  > ~/.android/avd/pqp_b.avd/config.ini
printf 'path=%s/.android/avd/pqp_b.avd\ntarget=android-37.1\n' "$HOME" \
  > ~/.android/avd/pqp_b.ini
```

There is no `avdmanager` in this SDK install (no `cmdline-tools`), which is why
the clone is done by hand.

## Layout

| Path | What |
|---|---|
| `app/src/main/kotlin/gg/pqp/app/core` | Backend config, models, REST client, WebSocket client, session |
| `app/src/main/kotlin/gg/pqp/app/ui` | Compose screens, theme, shared components |
| `app/src/main/kotlin/gg/pqp/app/voice` | Mesh WebRTC engine, call state, foreground service, screen capture, `getStats` reading |
| `app/src/test/kotlin/gg/pqp/app/voice` | JVM unit tests for the pure parts: capture sizing, stats parsing |
| `app/src/main/res/values` | English copy |
| `app/src/main/res/values-pt-rBR` | Portuguese copy |
| `app/src/debug` | Cleartext exemption for the local server, debug builds only |

## Auth

Two modes, chosen at launch by whether a publishable key is present. Same
arrangement as iOS, and stated the same way round so that a release build with
no key is loudly unable to authenticate rather than quietly falling back to a
token only a local server accepts.

| `pqp.clerkPublishableKey` | Mode | Reaches |
|---|---|---|
| unset (default) | dev bypass | local server only |
| `pk_…` | Clerk | any deployment |

Clerk's own `AuthView` (`com.clerk:clerk-android-ui`) is used as shipped rather
than a hand-built form. It covers email codes, OAuth and MFA, none of which can
be exercised without a real inbox, and a bespoke version would be unverifiable
code on the one path where being wrong locks everybody out. iOS made the same
call for the same reason.

**Sign in with Google is what matters here.** `AuthView` renders one button per
provider enabled on the Clerk instance, and `clerk.pqp.gg` has `oauth_google`
on. Unlike iOS there is **no Sign in with Apple requirement**: Guideline 4.8 is
an App Store rule with no Play Store counterpart, so offering Google alone is
fine.

`ClerkTokenProvider` reads a **fresh** token per request. Clerk session tokens
live about a minute, so caching one makes everything work for sixty seconds and
then 401 forever. That bug has already shipped once on the web client.

**Unverified:** completing a real Clerk sign-in. No publishable key was
available in this session, so the app was built and tested on the dev bypass.
Everything after the token lands is the same code the bypass exercises.

## The age gate is not optional

`GET /api/me` answers `ageGate: "pending"` on a fresh account, and until it
reads `passed` **every other endpoint answers 403 and the WebSocket refuses the
handshake outright**. A client that treats it as an ordinary loading failure
looks broken rather than unfinished, so it is a session phase with its own
screen (`AgeGateScreen`). The date travels as a plain `YYYY-MM-DD` with no time
and no zone, because attaching an instant to a date of birth is the classic way
to refuse somebody on their own birthday.

## Decisions worth knowing

**Sending a message is a WebSocket frame, not an HTTP call.** There is no
`POST /api/channels/:id/messages`; the protocol only offers `message-create`
over `/ws`. That makes the socket load-bearing rather than an enhancement, which
is why `RealtimeClient` reconnects with capped, jittered backoff and resolves a
fresh token per attempt.

**A send that cannot leave reconnects rather than returning quietly.**
`RealtimeClient.send` returns "this left the phone", and the caller drops its
optimistic row when it did not. A client that looks online and silently discards
everything it is asked to say is the worst failure this class has, and iOS
shipped exactly that once.

**There is no ack and no error frame.** An invalid frame is dropped server-side
in silence. The only correlation the protocol offers is the `nonce` echoed back
on `message-broadcast`, so that is what retires an optimistic row. The
optimistic row borrows the nonce as its id, which makes retiring it a filter.

**Both delete spellings are live.** The server broadcasts `message-delete`;
`message-deleted` is the older name and is still relayed. Handling one leaves
deleted messages on screen for whoever is connected to the wrong instance.

**`kind` and `type` on a channel are different fields.** `kind` is what the row
*is* (`server` / `dm` / `group`); `type` is what it *carries* (`text` / `voice`
/ `category`). A category is a channel row, not a separate object, and its
children point at it through `parentId`.

**`position` is unique only within a sibling group**, and top-level text
channels, top-level voice channels and categories are three separate groups that
all carry `parentId == null`. Sorting them as one list interleaves three
sequences of 0, 1, 2, so `ChannelsScreen` renders them as sections.

**`Message.blocked` is on the wire and absent from the zod schema.** The server
adds it in `mapMessage` so a blocked author's row still travels and paging stays
correct. Decoded defensively, like iOS.

**`ignoreUnknownKeys` is not laziness.** The API grows fields (threads, embeds,
webhook embeds, permissions) faster than this client models them, and a strict
parse would turn each one into a channel that cannot load. Inbound socket frames
are dispatched on `type` as raw `JsonObject` for the same reason: an unknown
member of the union has to be ignored, not thrown on.

**There is no OkHttp `callTimeout`.** It bounds a whole exchange, and a
WebSocket *is* one exchange, so a ceiling there would kill every socket on
schedule. `docs/IOS.md` records that exact failure on URLSession, where it
looked like a live connection that dropped everything it was asked to send.

## Android conventions, deliberately

- **Edge to edge**, with `SystemBarStyle.auto` rather than `dark`. Pinning the
  bar icons light painted white icons onto the light scheme's near-white ground,
  where the clock and the battery disappeared. The emulator boots in light mode,
  which is how it was caught.
- **Predictive back**: `android:enableOnBackInvokedCallback="true"`, and
  Navigation Compose's default transitions are left alone because they cooperate
  with the gesture and a bespoke slide would not.
- **Material 3 throughout**: large collapsing app bar, extended FAB, pull to
  refresh, snackbars, date picker, filled icon buttons.
- **Not Material You.** Dynamic colour would repaint the one thing the product
  is recognised by, and pqp's identity is a lime signal on near-black. The
  Android feel comes from the components, the motion and the navigation; it does
  not have to come from the wallpaper. Discord and Slack make the same call on
  this platform. The palette is the same sRGB conversion `ios/…/Theme.swift`
  already did from `client/src/index.css`, so the three clients are one product.
- **Adaptive icon** with a themed monochrome layer, drawn as vectors. The three
  dots are punched out of the bubble with an even-odd fill so the themed variant
  survives the system's tint.
- The launcher icon is a squircle for servers and a circle for people, because
  Material draws that distinction and a server is a place.

## Copy and pt-BR

Both languages live in Android's own resource system: `res/values/strings.xml`
is the English source, `res/values-pt-rBR/strings.xml` the Portuguese. No copy
is a Kotlin literal. `androidResources.localeFilters` pins the APK to `en` and
`pt-rBR` so a dependency's forty other translations are dropped rather than
offered as a half-translated surface.

The gap versus iOS: **there is no equivalent of `check-localization.py`.**
Android has no `.stringsdata`, so nothing currently proves that a new
`stringResource` call has a Portuguese counterpart, or that a Portuguese string
is still reachable from English. A lint rule or a small script comparing the two
files' `name` attributes would cover most of it and is not written.

## Voice

Full-mesh WebRTC (`io.github.webrtc-sdk:android`), matching the server's default
backend. Signalling is the same `/ws` socket the chat uses.

**Audio has been heard end to end between two clients.** The measurement and the
rig are in *What voice is verified to do* below; the short version is that both
sides' `getStats()` show `inbound-rtp` audio bytes and packets climbing, samples
reaching the audio device, and the platform routing the call to the speaker.

### Negotiation is the whole perfect-negotiation pattern, not one line of it

**The politeness comparison matches `client/src/lib/peer-connection-manager.ts`
exactly:** `isImpolite(local, remote) = local > remote`, so the peer whose id
sorts *higher* sends the initial offer, and on a collision that same higher peer
is the one that rolls its own offer back and takes the other's while the lower
one drops the incoming offer on the floor. That is the *opposite* of the roles
the WebRTC spec gives those two words, and it does not matter: what matters is
that both clients yield in the same direction, and the web client is the one
already in production.

Getting only the *first* offer right is not enough, and an earlier version of
this file only had that. The web client offers from **either** side whenever a
track appears: a screen share, a camera, or its four-second ICE-restart
fallback. An Android peer that applied every incoming offer unconditionally
calls `setRemoteDescription(offer)` while in `have-local-offer`, and libwebrtc
fails the call. In practice that meant an Android user's call broke the moment
the web user on the other end shared a screen. What is there now:

- `makingOffer` and a signalling-state check, so a collision is detected rather
  than walked into.
- A real `ROLLBACK` on the yielding side.
- `owedOffer`, cleared **on the answer** and never on the send, because glare is
  resolved by one side dropping an offer and a debt cleared on send is forgotten
  exactly when it was not paid.
- A retrying `settleAfterExchange`, which is what gets a screen share negotiated
  when the person tapped share while the connection happened to be busy, and
  what re-offers a track that was added *before* a peer's first negotiation and
  therefore sits on a transceiver with no mid.
- Up to **three** ICE restarts rather than one, driven by the impolite side
  only, because two simultaneous restarts are glare wearing a different hat.
- Every description for one peer runs under that peer's `Mutex`, and the
  callback-shaped `SdpObserver` API is wrapped into suspend functions, because
  order rules spread across four nested callbacks are order rules nobody can
  read.

`onRenegotiationNeeded` stays `Unit` deliberately: libwebrtc fires it from
inside the operations chain, where taking a lock and starting another exchange
is a deadlock waiting to happen. Every track this client adds is added by a path
that knows it did so and asks for the offer itself.

Other things the mesh depends on, each of which is a comment at its site:

- **ICE candidates are queued until a remote description exists.** They
  routinely arrive first, and adding one early is an error rather than a no-op.
- **A `null` candidate is end-of-candidates**, not a failure.
- **Remote audio is filed per peer *and per track*.** A peer can send more than
  one audio track: sharing a screen with its sound publishes the machine's audio
  alongside the microphone. Keyed by peer alone, the second overwrites the first
  and takes the only handle on the microphone with it, so deafening silences the
  screen and leaves the presenter's voice playing.
- **Deafening forces the microphone off too.** Being heard while hearing nothing
  is a trap rather than a feature, and it is what both other clients do.
- **`transports: ["mesh"]` is declared on `join-voice-room`.** The room's
  transport is decided by the server and is binding; declaring up front lets it
  refuse *before* creating a peer, so a mesh-only client never appears in an SFU
  room's roster as somebody who can neither hear nor be heard.
- **ICE servers always exist.** A failed `/api/ice-servers` used to leave the
  peer connection with an empty server list, which is not "STUN only" but "host
  candidates only": it works on one wifi and nowhere else, and it looks exactly
  like pitfall #1 in `CLAUDE.md` arriving through a different door. The client
  now falls back to the same three public STUN hosts the API itself serves.

### The call is rebuilt on a reconnect, and that code now runs

The server drops the voice peer when the socket closes and a reconnect mints a
*new* peer id, so every connection in the old mesh addresses a peer that no
longer exists. The call is therefore **rebuilt, not resumed**.

An earlier version of this file claimed that worked. It did not. The rejoin was
gated on noticing a second `Ready`, computed as `wasReady && state == Ready`
inside the branch where `state` is by definition not `Ready`, so it was always
false and it never fired once. Even if it had, `join()` returned early at its
`channelId == channelId && isActive` guard because nothing reset the state on a
drop. Net effect: the person was out of the call while the app showed a live one
with the microphone still hot.

The flag is now set on the way *down*, in the branch that actually observes the
drop, and the rejoin goes through an internal `enter()` that the guard does not
cover. Verified by killing the server under a live two-client call: both sides
logged `CLOSED`, then `socket back; rebuilding the call in <id>`, then a **new**
peer id reaching `CONNECTED` with audio flowing again, about twenty seconds
later.

### Audio goes to the speaker, and that is not a preference

`MODE_IN_COMMUNICATION` on its own routes to the **earpiece**. That is right for
a phone call held against a face and completely wrong for a voice channel
somebody joined while doing something else: the audio is technically playing, at
a volume nobody more than three centimetres away can hear, and it presents as
"voice does not work". This cost the previous session nothing only because that
session never got as far as audible audio.

The call therefore asks for the built-in speaker explicitly
(`setCommunicationDevice` on API 31+, `isSpeakerphoneOn` below it), and the call
bar carries a toggle. Asking for the speaker *only when it is the device we
mean* leaves the platform's own preference order intact, which is what routes a
wired headset or a Bluetooth device correctly without this code knowing headsets
exist.

Confirmed with `adb shell dumpsys audio` during a live call:

```
Active communication device: AudioDeviceAttributes: role:output type:speaker
- Actual mode = MODE_IN_COMMUNICATION
```

### `voice-moderation` is handled, because ignoring it leaves a hot microphone

The server sends `voice-moderation` to the sanctioned participant **and then
drops their peer**, so the target never receives their own `peer-left`. A client
that ignores the frame keeps a frozen roster, a foreground service, and an open
microphone: somebody removed from a call is still recording. That is a safety
bug, not a missing feature, and it is why this is handled before anything
cosmetic.

- `disconnected` leaves the call outright.
- `moved` follows `movedToChannelId` with an ordinary `join-voice-room`, which
  re-runs every server-side admission check, so a forged or replayed frame can
  never place a client somewhere the server would not have admitted it anyway.
  The frame carries no channel *name* and there is no endpoint to ask for one,
  so the bar reads "In voice" until the roster names it.
- `muted` / `unmuted` are informational: the server has already applied them.
- Every action is guarded to the room this client is actually in, so a stale or
  forged frame about some other channel does nothing.
- The `message` is rendered **verbatim**. The server writes the whole sentence
  precisely so that a client which renders nothing else is a correct client.

Verified end to end: with two clients in a room, `POST
/api/servers/:id/members/:userId/voice-disconnect` produced, on the target's
phone, the snackbar "A moderator disconnected you from voice.", the call bar
gone, the foreground service gone, and `dumpsys audio` showing `rec stop` for
the app's `VOICE_COMMUNICATION` session at that second.

### The foreground service is the feature, not the plumbing

Android stops a backgrounded app's threads, and a foreground service with a
visible notification is the only sanctioned exemption. `VoiceService` is started
**before the microphone is touched**, because Android 14 and later refuse a
`microphone`-typed service started the other way round, and it holds no call
state: `VoiceController` owns the mesh and lives on the `Application`, so a
service restart cannot desynchronise the two. The service is `START_NOT_STICKY`,
because a call the system restarted without its signalling socket is a
notification with nothing behind it.

It does own one piece of *ordering*, and that is deliberate. See the screen
sharing section below.

`POST_NOTIFICATIONS` is requested alongside `RECORD_AUDIO`. Only the microphone
gates the call, but a refused notification leaves a call running that nothing on
screen mentions.

Audio uses `MODE_IN_COMMUNICATION` with a `USAGE_VOICE_COMMUNICATION` focus
request, which is what puts the volume rocker on the call stream and turns on
the platform's echo cancellation.

### What voice is verified to do, and what it is not

Tested with **two emulators in one room** on two separate dev-bypass accounts,
which is the only arrangement that exercises anything a single client cannot.

**"Connected" is not evidence, so the app measures.** `VoiceStats.kt` reads
`getStats()` every three seconds and logs one line per peer under `pqp.voice`,
naming the selected ICE candidate pair as well as the counters. A connection
that has been up for eight seconds and has received **zero** audio packets is
reported as `Silent`, which counts as unreachable and puts *Cannot reach
everyone in this call* in the call bar. `PeerConnectionState.CONNECTED` is never
allowed to stand in for "somebody can hear somebody" again.

The line, from a real two-client call:

```
peer d25cad61-… pair=srflx/srflx udp audio rx=282301B/7271pkt tx=281956B/7281pkt
  samples=6900000 concealed=1723 level=0.0001 mic=0.0000 rtt=2ms
```

Read left to right, that is: ICE chose a server-reflexive pair over UDP; 282 kB
in 7,271 packets arrived; 281 kB in 7,281 packets left; **6.9 million PCM
samples were handed to the audio device**, which is the decoder and the playout
side and not just the network; 1,723 samples were concealed, so essentially
nothing was lost; round trip 2 ms. Both clients logged the same shape at the
same time. Audio flows, in both directions, through to the speaker.

**The one thing still not proven is a human ear**, and the reason is the rig
rather than the app. `mic=0.0000` with a tone playing in the room is the
emulator's virtual microphone feeding digital silence: it is not wired to the
host's input, and the emulator console offers no audio command to wire it. So
what crosses the wire is a faithfully encoded, transported, decoded and rendered
stream of **silence**. Everything in the chain except the acoustic ends is
measured; the acoustic ends are the two the emulator does not have.

Screen sharing closes most of that gap by another route, and deliberately: the
capture is *real content* rather than silence, it rides the same peer
connection, the same ICE pair and the same DTLS transport, and it arrives at the
far end and renders. See below.

Also verified between the two clients:

- The permission flow, and the foreground service coming up with
  `types=0x00000080` (`FOREGROUND_SERVICE_TYPE_MICROPHONE`) carrying an ongoing
  `category=call` notification with a Hang up action.
- `join-voice-room` out, `welcome` back, and both call bars reaching **2 in this
  call** with each other in the roster.
- **The politeness rule**, including a mid-call renegotiation *from the polite
  side* (a screen share started by the peer with the lower id) applied cleanly
  with no glare and no dropped offer.
- The moderator eviction, the socket-drop rebuild, and speaker routing, each
  above.

Still known-missing rather than broken: no speaking indicators, no per-peer
volume, no push-to-talk, no camera (send or receive), no screen-share audio, and
LiveKit rooms are refused rather than joined.

### Getting real ICE locally, which is what unblocked all of this

The previous session's voice test failed at `FAILED` on both peers because
`GET /api/ice-servers` was serving **STUN only**: the local `.env` carries
placeholder `VITE_TURN_*` values, and two emulators on one host are on separate
NATs. That is pitfall #1 in `CLAUDE.md` word for word.

The cheapest fix is a TURN server on the host, which also gives both emulators a
STUN server that sees them on the LAN rather than from the public internet, and
that is what the candidate pair above turned out to use. `brew install coturn`,
then a config that binds everywhere and relays on the host's LAN address:

```ini
listening-port=3478
relay-ip=192.168.50.245     # the host's own LAN address, not 127.0.0.1
external-ip=192.168.50.245
min-port=49160
max-port=49220
lt-cred-mech
user=pqp:pqplocal
realm=pqp.local
fingerprint
no-tls
no-dtls
```

```bash
turnserver -c turnserver.conf
# prove it relays before blaming the app:
turnutils_uclient -u pqp -w pqplocal -e <lan-ip> -n 2 -m 1 -y <lan-ip>
```

Then start the API with the credentials in its environment, **not** in `.env`,
which is Rafael's and should stay untouched:

```bash
TURN_URL="turn:<lan-ip>:3478" TURN_USERNAME=pqp TURN_CREDENTIAL=pqplocal \
  pnpm --filter @pqp/server dev
```

`curl -H "Authorization: Bearer dev-local-token" .../api/ice-servers` must now
list a `turn:` entry beside the three STUN ones.

Two notes that cost time. The host's LAN address is a DHCP lease and **it
changes**: it moved once mid-setup here, and coturn fails to bind with
`Can't assign requested address` rather than saying so. And 127.0.0.1 does not
work as the TURN address even through `adb reverse`, because libwebrtc ignores
loopback adapters by default, so it has nothing to bind a TURN port to.

The emulator reaches the host's LAN address over both TCP and UDP, which is
worth knowing on its own: the `10.0.2.2` alias that does not route on this image
is not the only way out.

## Screen sharing, which is the point of the whole exercise

Built, and verified between two clients. **No mobile browser can share a
screen**, because `getDisplayMedia` is not implemented on Android Chrome, so
this is the one capability no pqp user on a phone had at all.

Android makes it considerably easier than iOS did. `MediaProjection` runs in the
app's own process: no broadcast upload extension, no App Group, no Unix domain
socket carrying NV12 between two processes, none of the machinery
`ios/pqp/ScreenShare` exists to work around.

### Sending

The button lives on the call bar and raises Android's own consent dialog, which
only a user gesture can raise. The grant it returns is single use: from Android
15 a fresh one is required per capture session, so nothing caches it.

**The ordering is the feature, and it is enforced by putting the grant inside
the service.** From Android 14 a `MediaProjection` may only be created once a
foreground service of type `mediaProjection` is already running, and
`startForegroundService` is asynchronous: a caller that starts the service and
then immediately builds the projection loses that race and gets a
`SecurityException` from inside `ScreenCapturerAndroid`, where it reads like a
capture failure rather than an ordering one. So the consent Intent travels
*into* `VoiceService` as an extra, and the capture starts from `onStartCommand`
after `startForeground` has returned. There is no way to lose that race.

The type is added to the **running voice service** rather than carried by a
second one, because a projection and the microphone narrating it are one
session. `startForeground` is called again with the reduced type set when the
share stops, which is how a type is dropped.

### A bitrate ceiling is not a resolution

The web client shipped a quality menu whose lower rungs all still arrived at
1920x1080: once an encoder has ramped up to the capture size it stays there and
pays a smaller allowance in artefacts rather than in pixels. The browser only
offers `scaleResolutionDownBy` over a capture it sized itself, which is what
`screenScaleFactor` in `client/src/lib/video-quality.ts` exists for.

Android hands us the knob the browser refused to. `MediaProjection` builds a
VirtualDisplay at whatever size we ask for, so `ScreenCaptureProfile` is a real
capture size. The rules, all in `ScreenCapture.kt` and all unit tested:

- The target is **720 lines on the short side**, not the height. A phone is
  shared in portrait, where the height is the long side and "720p" applied to it
  would mean a 720x322 letterbox slot of a phone screen.
- The display's aspect ratio is preserved exactly. A VirtualDisplay of a
  different shape bakes black bars into the pixels, and no layout at the far end
  can remove them.
- Both dimensions are rounded to even numbers. H.264 chroma is defined on 2x2
  blocks and some hardware encoders refuse an odd dimension outright, which
  presents as a share that starts and sends nothing.
- Never an upscale.

The bitrate ceiling is then only a ceiling, split across the mesh because the
presenter uploads a full copy per peer: 3 Mbps of budget, clamped to
500 kbps to 2 Mbps per sender, re-split whenever somebody joins or leaves.
Smaller than the web's 5 Mbps budget and 4 Mbps cap on purpose: this is a phone,
on a domestic uplink at best, spending its own battery.

**Verified at the far end, which is the only place worth measuring.** A Pixel
10 Pro emulator (1280x2856) sharing its whole screen logged
`screen capture started at 720x1606@30fps`, and the *receiving* client's
`inbound-rtp` reported:

```
video rx=58541B @720x1606@1fps
```

720x1606 is what `screenCaptureProfileFor(1280, 2856)` computes, and it is what
arrived. The frame rate sits at 1–3 fps because the shared screen was a static
channel list; that is what screen content is supposed to do.

Stopping the share removed the video from the far end's stats cleanly: the
renegotiation dropped the m-line rather than leaving a frozen last frame.

### Receiving

The mesh's ordinary video path, plus a renderer, and it was built **before**
sending was called done because it is the only honest way to see what sending
produces.

Every video track this client receives is a screen share: the roster's
`cameraStreamId` is what marks a camera and this app never sends one. When a
participant's roster entry says `sharingScreen` **and** a track has actually
arrived (two conditions, because the roster is the faster of the two and
offering a viewer on it alone puts a black rectangle in front of people), the
call bar grows a "*Name* is sharing a screen / Watch" row.

Watching opens a full-screen `Dialog` around a `SurfaceViewRenderer`, not a
navigation destination. A share starts and stops on somebody else's schedule, so
it must not be a place in the back stack that outlives it. The renderer is
scaled `SCALE_ASPECT_FIT`: cropping a shared screen to a phone's aspect ratio
hides whatever the presenter was pointing at.

`set-sharing-screen` is sent **after** the capture is alive, and
`screen-share-denied` (the server's `SCREEN_SHARE_LIMIT`, 2 on mesh) tears the
capture down rather than leaving a live projection nobody can see.

### What screen sharing does not do

No **screen audio**. `MediaProjection` can record device playback from Android
10, but only from apps that allow it, so a system-audio track nobody can rely on
would be worse than an honest silent share. `audioStreamId` is therefore always
null, which the protocol already treats as the common case.

No window or app picker of our own: Android's consent dialog offers "one app"
or "entire screen", and that is the platform's choice to present, not ours. No
quality menu: there is one rung, and it is 720 lines.

## Push notifications: not built

The server already decides *who* gets told, in `server/src/services/push.ts`,
and fans out to Web Push and APNs from one place. FCM would be a third leg of
the same feature and the client would re-decide none of it. That is server work
plus a `FirebaseMessagingService` here, and neither exists.

## CI

**Deliberately not added.** The build needs an Android SDK, an accepted licence
and a JDK, and the existing `ci.yml` is a pnpm/Node pipeline; bolting an Android
job onto it risks the pipeline that guards the API for a build nobody is
releasing yet. What it would look like, when it is wanted, as its own workflow
file (`.github/workflows/android.yml`) so a failure cannot block the web or API
deploys:

```yaml
name: android
on:
  pull_request:
    paths: ["android/**", ".github/workflows/android.yml"]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "21" }
      - uses: android-actions/setup-android@v3
      - run: ./gradlew :app:assembleDebug lint
        working-directory: android
```

Two things to know before writing it: `compileSdk = 37` is newer than AGP 9.3.2
knows about (hence `android.suppressUnsupportedCompileSdk` in
`gradle.properties`), and CI would need that platform installed or the compile
SDK lowered to 36.

## What is real

Built and **verified against a live local server on two emulators**: launch, the
dev-bypass session, the age gate, the server list with create and pull to
refresh, the channel list with categories and text/voice sections, the full
message round trip (join, send, broadcast, render, and the row persisted
server-side with a real id), reconnect handling, sign-out, and the two
languages.

**Voice carries audio.** Two clients on two accounts, `getStats()` read on both
sides: `inbound-rtp` bytes and packets climbing in both directions over a
selected `srflx/srflx` UDP pair, millions of PCM samples reaching the audio
device with almost nothing concealed, and `dumpsys audio` confirming
`MODE_IN_COMMUNICATION` routed to `type:speaker`. Also verified between the two
clients: a mid-call renegotiation from the *polite* side, a moderator eviction
that stops the microphone and drops the notification, and a call rebuilt from
scratch after the socket died.

**The one thing still not proven is a human ear.** The emulator's virtual
microphone is not wired to the host's input (`mic=0.0000` with a tone playing in
the room), so what the pipeline is faithfully carrying is silence. Every link
in the chain is measured except the two acoustic ends the emulator does not
have. Screen sharing covers most of that gap by another route: it puts *real
content* on the same peer connection, the same ICE pair and the same DTLS
transport, and it arrives and renders.

**Screen sharing sends and receives.** Capture at 720x1606 from a 1280x2856
display, and 720x1606 is what the receiving client's `inbound-rtp` reported:
checked where it arrives, not where it was asked for. Stopping the share removed
the video cleanly rather than freezing a last frame.

There are 18 JVM unit tests, over the two pure parts worth pinning: the capture
sizing arithmetic and the stats parsing. There are still **no instrumented
tests**, and nothing proves a new `stringResource` has a Portuguese counterpart.

**Not built:** push, DMs, attachments, reactions, replies, editing, pinning,
threads, search, members and moderation surfaces, invites, profile editing,
communities, game connections, data export and account deletion. No camera
(send or receive), no screen-share audio, no speaking indicators, no per-peer
volume, no push-to-talk. LiveKit rooms are refused rather than joined.
`assembleRelease` signs with the debug key and needs a real keystore before it
goes anywhere near Play.

This is a foundation with two real features on it. It is not the app yet.
