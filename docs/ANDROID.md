# Android app

A native Kotlin + Jetpack Compose client in `android/`. It talks to the same
server as the web and iOS apps: no mobile backend, no BFF, no protocol change.

**Read the state of it before quoting it.** Auth, servers, channels, text chat,
direct messages and the friends list are built and verified end to end against a
live local server. Voice carries audio between two clients, measured at both
ends rather than inferred from a connection state. Screen sharing sends and
receives, and the resolution was checked where it arrives rather than where it
was asked for. Push is built on the client and has **no server leg at all**. The
honest boundaries, including the one thing about audio that is still not proven,
are in **What is real** at the bottom, and what the integration itself fixed is
in **What the integration fixed** below.

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
4. Push via FCM, as the third leg of `server/src/services/push.ts`. **Client
   built; the server leg is specified and unwritten, and it needs a Firebase
   project that does not exist. See the push section below.**
5. DMs and the friends list. **Done, and verified between two clients.**
6. Attachments, reactions, invites, everything on the parity list.

Data export and account deletion are not on that list because they are not a
feature to be cut from it: **Play refuses a submission without in-app account
deletion.** Both are built. See **Your data** below.

If time runs short, cut from **6 upward**.

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
./gradlew :app:assembleDebug     # build (localhost API, `.debug` applicationId)
./gradlew :app:installDebug      # build and install on the running emulator
./gradlew :app:assembleSideload  # prod API, beta-signed; what CI puts on GitHub
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

The cause turned up later, and it is not the emulator. API 36 added local
network protection: an app needs the `ACCESS_LOCAL_NETWORK` app op before it may
open a socket to an RFC 1918 address, and `10.0.2.2` is one. The same `nc` call
succeeds from `adb shell` and times out under `run-as gg.pqp.app.debug`, which
is the tell; `appops get gg.pqp.app.debug ACCESS_LOCAL_NETWORK` reads `ignore`
on a fresh install and the uid-level mode overrides anything set per package.
Loopback is exempt, so the reverse tunnel sidesteps the whole thing rather than
working around it.

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
| `app/src/main/kotlin/gg/pqp/app/social` | Friends, blocks, conversations: wire shapes, endpoints, the live repository |
| `app/src/main/kotlin/gg/pqp/app/social/ui` | The three-tab home, the inbox, the friends screen, the two people pickers |
| `app/src/main/kotlin/gg/pqp/app/push` | FCM registration, the notification payload, deep links, per-channel settings |
| `app/src/main/kotlin/gg/pqp/app/invites` | The invite link shape and the invite sheet: make, copy, share, revoke |
| `app/src/main/kotlin/gg/pqp/app/account` | Data export and account deletion: the confirmation rule, the two endpoints, the two screens |
| `app/src/test/kotlin` | JVM unit tests for the pure parts: capture sizing, stats parsing, deep links, push presentation |
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

## The bug that made every real channel look empty

Worth writing down in full, because the symptom pointed at the wrong layer and
two passes read it that way.

**Symptom.** A channel with more than about a dozen messages rendered as
"Nothing here yet. Say something." A channel with a handful rendered fine. The
threshold tracked **response size**, roughly 5 KB working and 10 KB not, which
is what made it look like emulator networking: no client code branches on size.

**It was not networking.** Putting a logging proxy between the device and the
API settled it in one observation. The device asked for
`/api/channels/:id/messages?limit=50` and the proxy delivered **28197 bytes of
`application/json`, complete, status 200**. The bytes arrive. The same payload
decodes to 50 messages in a JVM unit test. The failure is entirely ours and
entirely after the socket.

**Cause.** `ApiClient.execute` used `suspendCancellableCoroutine` around
OkHttp's `enqueue`. `continuation.resume` resumes on the *coroutine's*
dispatcher, and every caller is a `viewModelScope.launch`, which is
`Dispatchers.Main`. So `response.body.string()` inside `decode` ran on the main
thread, and `SocketInputStream.read` on the main thread is
`android.os.NetworkOnMainThreadException`.

**Why size mattered, which is the whole trick.** A small body is already sitting
in okio's buffer by the time the response headers have been parsed, so reading
it touches no socket and StrictMode never sees a thing. A body past that buffer
has to go back to the socket for the remainder, and *that* read throws. The
buffer boundary is the "threshold", and it is why the bug looked like a
transport problem and why it never appeared in a test channel with three
messages in it.

**Why it was silent.** `ChatViewModel.loadInitial` recorded `error = it.message`
and `ChatScreen` never rendered `error` at all, so a failed fetch fell through
to the empty-channel state. Worse, `NetworkOnMainThreadException.getMessage()`
returns **null**, so even code that checked `error != null` would have seen no
error. Two independent silences stacked on one exception.

**Fix.** `execute` now reads the body inside OkHttp's `onResponse`, on OkHttp's
own dispatcher thread, and hands back a response carrying an in-memory copy. No
caller can reach the socket from the wrong thread whatever it does afterwards,
and `close()` / `use {}` stay correct. `loadInitial` falls back to the exception
class name when the message is null, and `ChatScreen` renders the error instead
of claiming the channel is empty.

**Blast radius, before the fix.** Every response over the buffer, not just chat:
the servers list for anybody in several servers, the friends list, the DM list,
and `GET /api/me/export`, which is the data export behind account deletion and
is never small. Any of them would have failed silently.

**Regression cover.** A JVM test cannot catch this: `NetworkOnMainThreadException`
comes from Android's StrictMode and the unit-test `android.jar` is stubs. It
needs an instrumented test or a device. Until there is one, the check is: open a
channel with a hundred messages in it.

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

**There is no ack. There is a refusal.** A malformed frame is still dropped
server-side in silence, but since PR #204 a well-formed `message-create` the
server will not land is answered with `message-rejected` (sender only, same
`nonce`, a reason token, `retryAfterMs` for slow mode and rate limits), and a
timed-out sender gets `sanction-notice` with the sentence already written. The
`nonce` echoed back on `message-broadcast` is what retires an optimistic row;
the same nonce on `message-rejected` is what removes it, hands the text back to
the composer and puts the reason under the box. The optimistic row borrows the
nonce as its id, which makes both a filter. For months Android had no branch for
either refusal, so a refused message looked sent on the phone until the app was
restarted. `WireProtocolTest` now fails when the server grows a client-bound
frame Android neither handles nor lists as deliberately ignored.

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

## How it looks, and why

The visual language lives in its own document: **[`ANDROID_DESIGN.md`](./ANDROID_DESIGN.md)**.
Read it before touching anything under `ui/`.

The short version. The first build carried pqp's palette onto stock Material 3
and stopped there, so the app was idiomatic Android and not designed: Roboto,
Material's density, Material's shapes and `Icons.Default`. It has since been
given two shipped typefaces (Instrument Sans and Gabarito, the web's pair), a
stated type scale, a surface hierarchy in which chrome is **deeper** than
content, Material's tonal elevation switched off so no surface drifts off that
ramp, a Lucide icon set drawn from checked-in path data, and row heights chosen
per row rather than inherited. The palette itself did not change. What changed
is where each colour is allowed to appear, and the lime signal now has a written
list of the places it may show up.

None of that touched navigation, gestures or platform behaviour, which were
already right and are listed below.

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

## What the integration fixed, and how each fix was checked

Four branches (#103 foundation, #106 DMs and friends, #105 the FCM client,
#107 voice audio and screen sharing) are one branch here. The conflicts were
small and are listed in the PR; the bugs each branch's review had found were
not, and they are fixed on the integrated branch rather than in whichever branch
happened to notice them.

Every claim below was checked on a running emulator against a live local server,
and where a check needed a third party it was measured **on the wire** rather
than inferred from the UI. The one thing no emulator can prove is at the bottom.

**Mute and deafen survive a join.** The server creates a voice peer
`muted: false` and waits to be told otherwise; `server/src/ws/voice.ts` says so
in a comment. Android only ever sent `set-voice-state` from the two toggles, so
a standing mute, a channel switch, or a room rebuilt after a dropped socket left
everyone else's roster saying a person with their microphone off was live.
`onWelcome` now re-declares both, as `voice-state-sync.ts` does on the web.
*Checked* by joining as a third account on a plain WebSocket and reading the
roster: on rejoin the frames were `peer-joined muted=false` at `00:48:18.816`
and `voice-roster muted=true` at `00:48:18.828`, twelve milliseconds later,
which is the re-declaration arriving and correcting the server.

**A send during a reconnect no longer cancels the reconnect.** `socket` is
non-null from the moment `newWebSocket` returns, right through the auth
handshake, so "there is no socket" was never true while an attempt was in
flight; every frame sent during one cancelled the attempt that was about to
succeed. `RealtimeClient.fallbackFor` now waits on an attempt in flight and
tears down only a socket that is `Ready` and still will not take the frame.
*Checked* by putting a killable TCP proxy between the phone and the dev server:
with the proxy down, thirty keystrokes and a send produced **no**
`send could not leave; reconnecting` lines at all, and the retry timestamps
(17.2s, 17.8s, 19.1s, 22.0s, 27.7s, 36.8s) are the plain backoff, untouched.

**Typing is throttled to 2.5 seconds**, the web's own figure, because
`ChatScreen` calls `typing()` per keystroke and that is what made the bug above
so much worse. *Checked* on the wire: a third account watching the channel
counted **one** `typing-broadcast` for thirty-six characters typed.

**A failed send keeps the typed text.** `ChatViewModel.send` answers whether the
frame left the phone and the composer clears on that, rather than clearing first
and dropping the optimistic row a moment later. *Checked* with the proxy down:
the sentence stayed in the box under *Offline. Trying to reconnect…*, survived
the reconnect, and sent on the next tap.

**`pqp://` links are read.** The manifest has advertised the scheme since the
first commit and nothing ever looked at `intent.data`. Links are now consumed
like a notification's extras, an invite code is validated before it becomes a
URL path (any app on the phone can fire that intent), and redeeming is
idempotent server-side so following a link twice just takes you there. A refusal
is shown in the server's own words. *Checked* both ways on a second emulator:
`pqp://invite/<code>` landed on the server's channel list with its name filled
in from the redeem response and the membership row present in Postgres;
`pqp://invite/NOPENOPE` showed *That invite did not work / Invite not found*.

**The chat subscription is owned, not global.** There is one `join-channel` per
connection and there are now two chat surfaces. `leaveChannel` takes the channel
it is leaving and ignores a subscription somebody else has taken, and a chat
returning to the foreground re-asserts its own, because popping a screen off the
top does not hand the subscription back. *Checked* by opening `#general`,
stacking a conversation on it through a notification-shaped intent, popping it,
and then watching a message sent from the other phone arrive live. Without the
fix the screen underneath stays subscribed to nothing and shows nothing, with no
visible symptom until somebody notices the messages stopped.

From the DM review, all four:

- The comment claiming a closed conversation comes back "the instant either side
  speaks" now says *which* conversations. A group has no `dm_pairs` row, so
  `restoreDmParticipants` matches nothing and no frame is sent. The strings were
  always right; only the comment lied, which is worse than saying nothing.
- `refreshConversations` runs one at a time, coalescing rather than dropping a
  request that arrives during one, because the in-flight read may predate the
  row it is being asked about. Five fast messages into a closed DM used to open
  five concurrent reads of the whole inbox.
- A locally bumped `lastMessageAt` is written in the server's format and floored
  at the newest timestamp the server has given us. `Instant.now().toString()`
  prints more fractional digits than `toISOString()` does and these strings are
  compared lexicographically, so a row this client bumped sorted *under* a
  server row from the same millisecond; and a phone running slow filed a message
  that had just arrived into the middle of the list. Six unit tests.
- `markRead` holds the badge it cleared until a snapshot started *after* the
  server confirmed the read. The hold releases itself, so there is no timer to
  tune and no set to remember to empty. Four unit tests.

Also: a notification tap on a conversation opens the conversation destination
rather than the `#channel` screen, which titled a DM "Conversation" and left its
unread badge standing.

## Voice

Two transports, and the server picks which one a room runs on. Full-mesh WebRTC
(`io.github.webrtc-sdk:android`) and LiveKit SFU audio
(`io.livekit:livekit-android`), behind one `VoiceTransport` interface that
`VoiceController` swaps at `welcome`. Signalling, presence and the roster are
the same `/ws` socket the chat uses on both; only the media moves.

The SFU path is **audio only** and its credentials come from
`POST /api/voice/token` after `welcome`, never from `welcome` itself. See
*What voice is verified to do* for the (short) list of what has actually been
observed on it.

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
- **`transports: ["mesh", "livekit"]` is declared on `join-voice-room`.** The
  room's transport is decided by the server and is binding; declaring up front
  lets it refuse *before* creating a peer, so a client never appears in the
  roster of a room it cannot run as somebody who can neither hear nor be heard.
  Widening that array is the one line that turns a clean refusal into a silent
  ghost, so it is also the last line to change, and `WireProtocolTest` pins both
  literals. Omitting the field entirely is worse again: the server reads an
  absent `transports` as "both".
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

### A room promoted mid-call is followed, and it is the one thing that is not a rebuild

Everything above says a call is rebuilt rather than resumed. There is exactly
one exception, and it is not a socket drop: the server may move a live mesh
room onto the voice server, so that a fourth camera, a third screen, a ninth
person, or simply a fourth seat, fits. `MESH_ROOM_PROMOTION_SIZE` is 4, so an
ordinary five-friend call meets this.

Before this, the phone was **dropped out of the call** when that happened. The
server only sends `voice-transport-changed` to a socket that declared
`SOCKET_CAPS.voiceTransportChanged` at `auth`; every other seat is released and
told with `voice-transport-unsupported { reason: "promoted" }`. Measured on
production over 24 hours: five rooms promoted, nine seats followed the move,
**nine seats were released**, and every one of those was a person whose call
ended mid-sentence.

Android now declares the capability (`RealtimeClient.WIRE_CAPS`) and follows
the frame. The seat, the peer id, the mute and the place on the roster are all
kept: only the media path changes, so nobody sees a leave and a join. The
branches that decide whether to move are a pure function in
`voice/TransportChange.kt` and the swap is `VoiceController.onTransportChanged`,
which stops any outgoing screen share (this client publishes one on mesh only),
disposes the mesh engine, and brings `LiveKitEngine` up against the same peer
id.

**Declaring the capability is a promise with teeth.** In exchange for it the
server stops releasing this seat, so a build that asks for the frame and then
fails to act on it leaves the person listed in everybody's roster in a room
whose media they cannot reach: a silent dead call instead of a visible drop.
That is why the frame is on `WireProtocolTest`'s cannot-work-without list
rather than its ignore list, and why `declaring the promotion capability means
the frame is handled` also asserts the branch still reaches
`transportChangePlan`, still calls `swapTransport(plan.transport)` and still
starts the engine on `plan.peerId`.

Be clear about what that last test is. It is a **call-graph assertion read off
the source**, not a behavioural one, because no JVM test can start
`LiveKitEngine`: it wants a `Context`, a token from the API and a real SFU. It
catches the two regressions that actually happen, deleting the branch and
stubbing it out, and it would not catch a handler that kept all three calls
behind an early return. The first version of this guard was weaker still and
missed even the stub: the whole 565-test suite passed with the body replaced by
`if (true) return`, which is exactly the "green without exercising anything"
shape this repo keeps getting bitten by. The device check below is what the
assertion stands in for, not a formality.

**Audio does cut, briefly.** The mesh is disposed before the SFU leg exists,
and that leg is an HTTP token mint plus a LiveKit handshake away, so the call
goes quiet for that round trip and the bar says "Joining…" until the SFU
reports it is publishing. The web client has the same gap for the same reason.
A pause in a call that continues, rather than a hang-up.

**Not verified on hardware.** The decision logic is covered by
`TransportChangeTest`, and every branch of it was proven by breaking the code
on purpose. The actual mid-call swap needs a room of four real clients against
a real LiveKit deployment, which no emulator pair here can produce. What a
device has to show: the phone stays in the call, the participant count does not
flicker, audio comes back, and the notice reads *Essa call virou uma sala
grande…*.

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

**Swiping pqp out of Recents during a call does not end the call.** The manifest
sets no `android:stopWithTask`, so Android delivers `onTaskRemoved` to a running
foreground service and then leaves it running: the call carries on behind its
ongoing notification, and the Hang up action on that notification is how it
ends. This is what every other voice app does, so `VoiceService` deliberately
does not hang up on task removal, and there is a comment at the site saying so.

`POST_NOTIFICATIONS` is requested alongside `RECORD_AUDIO`. Only the microphone
gates the call, but a refused notification leaves a call running that nothing on
screen mentions.

Audio uses `MODE_IN_COMMUNICATION` with a `USAGE_VOICE_COMMUNICATION` focus
request, which is what puts the volume rocker on the call stream and turns on
the platform's echo cancellation.

### DM calls ring, and the ring is foreground only

A conversation call is an ordinary voice room on the conversation's channel id:
same `join-voice-room`, same pinned transport, same roster. What makes it a
call is the ring, and that is five frames in `packages/shared/src/signaling.ts`
(`call-ring`, `call-decline`, `call-incoming`, `call-ring-cancelled`,
`call-declined`).

Three rules carry over from the web client and each one is a bug if it is
broken:

1. **The ring waits for the room.** The server only accepts `call-ring` from a
   live peer of exactly that room, so it is sent when the voice state says the
   join is connected, never on the tap. Sent early it is dropped in silence and
   nobody's phone rings.
2. **Answering is joining.** There is no accept frame. `CallEffect.JoinCall`
   is the whole answer, and the server stops ringing the account's other
   devices itself.
3. **Dismissing the card sends nothing.** Decline tells the caller no; the
   cross is silence on this device only, and the call stays joinable while the
   caller keeps ringing.

The decisions live in `CallMachine`, a pure function with no Android in it, so
they are pinned by plain JVM tests (`CallMachineTest`, 25 of them) rather than
by an emulator. `CallController` owns the socket, the clocks and the ringtone
and does what the machine says. `CallFramesTest` reads the shared schemas off
disk the way the rest of `protocol/` does, so a renamed frame fails the Android
build instead of becoming a phone that never rings.

The ringtone is the phone's own, on the ringtone stream, so the volume rocker
and the silent switch apply as they would to a phone call. Silent is silent,
vibrate is vibrate, and Do Not Disturb wins outright; the card appears in every
case, only the noise is gated.

**Foreground only.** A ring with the app closed needs a push that wakes the
process, and the FCM server leg does not exist (see the push row above). Nothing
here is verified on hardware yet: it compiles, the state machine is tested, and
no two phones have rung each other.

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
volume, no push-to-talk, no camera **to send**, and no screen-share audio.
Receiving somebody else's camera arrived later and is described below.

**LiveKit rooms are now joined rather than refused, and the join has been run
for real on an emulator (6 Sep 2026).** Against a local server with the
`livekit` compose profile: `welcome` said `livekit`, the app minted a token,
connected, and LiveKit listed the participant under the WS peer id with one
`MICROPHONE` publication (`audio/red`, DTX). The mute button flipped that
publication to `muted: true` on the SFU. An `lk room join --publish tone.ogg`
bot was subscribed to (LiveKit's own log shows the phone's downtrack for that
one track) and an `lk room join --publish-demo` video bot was not, which is
the audio-only rule doing its job. Hanging up removed the participant from the
SFU and logged `voice.leave`, and walking straight into a `mesh`-pinned channel
logged `voice transport LiveKit -> Mesh; disposing the old engine` and came up
Connected with the screen-share button back. What was **not** heard: audio
itself, because the emulator has no microphone input and nothing was listening
on the host, so the claim is "tracks flow", not "voices flow". Publishing a
screen is deliberately absent on this transport (the button is hidden rather
than left to fail) and `statsFor` answers null, because LiveKit's stats arrive
in the *other* libwebrtc's types. Mesh is untouched.

Watching somebody else's share on this transport was added afterwards and is
**unverified on hardware**: it compiles, the subscription rule and the layer
ceiling are unit-tested, and the wiring is verified by reading, but no phone
has yet drawn a frame that came from an SFU. What that verification needs is
the rig two paragraphs down plus a web participant presenting into the same
`livekit`-pinned channel.

The failure path was also exercised, by accident first: with `LIVEKIT_URL`
pointing at the host's LAN IP the app refused the SFU leg (`CLEARTEXT
communication to 192.168.50.245 not permitted by network security policy`),
left the WS room (server: `voice.join` then `voice.leave`, no ghost) and showed
the "could not reach the voice server" snackbar. It never built a mesh.

**Local LiveKit rig for a debug build.** The debug network security config
allows cleartext only to `localhost`, `127.0.0.1` and `10.0.2.2`, and the SFU
URL the app dials is whatever the server's `LIVEKIT_URL` says. So run the API
with `LIVEKIT_URL=ws://localhost:7880`, add `adb reverse tcp:7880 tcp:7880` and
`adb reverse tcp:7881 tcp:7881` next to the existing 3001 tunnel, and start
the LiveKit container with `--node-ip <host LAN IP>` so its ICE candidates
point somewhere the guest can route to. The media then goes to that LAN IP
over UDP 7882 (or TCP 7881), which on API 36+ needs the local-network app op:
`adb shell appops set --uid gg.pqp.app.debug ACCESS_LOCAL_NETWORK allow`. A
production build talks `wss://` to a public host and needs none of this.

Two properties of that path are worth stating precisely, because both are the
kind of thing that is easy to believe without checking:

- **It subscribes to audio, screen shares and cameras, and to nothing else.**
  The room is joined with `autoSubscribe = false` and each publication is asked
  for by kind and source, so a source LiveKit adds later is refused by default
  rather than decoded into a `return`. The first version of this path
  auto-subscribed and dropped the frames in the callback, which looks identical
  on screen and is not identical on a mobile bill. `livekitSubscribesTo` is the
  whole decision and is unit-tested. Cameras were refused here until
  `feat/android-livekit-cameras`; what makes them affordable now is not the
  subscription but the delivery rules below.
- **The people already in the room are read from the join response.** LiveKit
  builds them without emitting `ParticipantConnected`, so joining a call in
  progress relies on seeding from `room.remoteParticipants` right after
  `connect()` returns. That is also what subscribes to their microphones.
  `LiveKitPeerIndex.seedAll` is unit-tested; the call site that feeds it is
  verified by reading, because nothing in the module can build a `Room` without
  a device.

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
Smaller than the web's 5 Mbps starting budget and 4 Mbps cap on purpose: this is a phone,
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

**Both transports.** Sending is mesh-only, watching is not: a phone in a
LiveKit room sees the share and hears it. That is where watch parties happen,
and being able to hear the room but not see the film was the gap.

The mesh's ordinary video path came first, plus a renderer, and it was built
**before** sending was called done because it is the only honest way to see
what sending produces.

On the mesh, an incoming video track carries nothing but a stream id, and the
roster's `cameraStreamId` is what says which one is a camera; everything else
from that peer is a screen (`RemoteVideoIndex`, the same elimination
`classifyVideo` does on the web). On the SFU there is no elimination to do,
because LiveKit labels the publication `SCREEN_SHARE` or `CAMERA`. Either way,
when a participant's roster entry says
`sharingScreen` **and** a track has actually arrived (two conditions, because
the roster is the faster of the two and offering a viewer on it alone puts a
black rectangle in front of people), the call bar grows a "*Name* is sharing a
screen / Watch" row.

Watching opens a full-screen `Dialog` around a `SurfaceViewRenderer`, not a
navigation destination. A share starts and stops on somebody else's schedule, so
it must not be a place in the back stack that outlives it. The renderer is
scaled `SCALE_ASPECT_FIT`: cropping a shared screen to a phone's aspect ratio
hides whatever the presenter was pointing at.

**Two renderers, and the compiler picks.** There are two libwebrtc builds in
this process (`org.webrtc` for the mesh, `livekit.org.webrtc` for the SFU) and
a renderer initialised on one cannot draw the other's frames: it compiles and
then fails at the first frame. So a video leaves a transport as a
`RemoteVideoFeed`, a sealed type with one case per namespace, each carrying the
GL context or the `Room` its own renderer needs, and `RemoteVideoView` is a
`when` over the two. The LiveKit case uses LiveKit's own `SurfaceViewRenderer`
initialised through `Room.initVideoRenderer`, which is the only way to get the
SFU's GL context, and attaches with `addRenderer`. Cameras go through the same
type and the same two renderers; the only thing they change is the scaling,
`SCALE_ASPECT_FILL` for a small tile and fit everywhere else.

**What the SFU is asked for, and when.** Two rules, both about the bill, and
both mirroring the web:

- **Nothing flows until somebody taps Watch.** The publication is subscribed
  and immediately `setEnabled(false)`, and only the open viewer lifts it
  (`VoiceTransport.setWatchingScreen`, driven by a `DisposableEffect` around
  the dialog). So a share in a room this phone is only listening to costs a
  signalling frame and no video. The back gesture, the presenter stopping and
  the call ending all pass through the same dispose, so a share cannot be left
  flowing to nobody.
- **The layer is capped at 720p, or 360p on a metered link**
  (`screenReceiveLayerFor`, tested). The presenter publishes simulcast layers,
  so there is a phone-sized copy on the server to ask for. `HIGH` is never
  asked for, because it is the SDK's resting value and means "whatever the
  publisher's top layer is". The metered signal is
  `ConnectivityManager.isActiveNetworkMetered`, read each time a layer is
  chosen, so a phone that leaves Wi-Fi mid-call is noticed by the next share it
  opens.

**Adaptive stream is off here, and that is the opposite of the web's setting.**
It is a difference between the two SDKs, not a preference. In livekit-client
the two compose: the library measures the element and a manual
`setVideoQuality` is a ceiling over that measurement. In livekit-android 2.28.1
they do not compose, they replace each other:
`RemoteTrackPublication.setEnabled` and `setVideoQuality` both begin
`if (isAutoManaged()) return`, and `isAutoManaged` is the track's
`autoManageVideo`, which the room sets from `adaptiveStream` (read from the
2.28.1 bytecode). With adaptive stream on, both controls above would compile,
run, and do nothing. The thing that most needs controlling is also the case a
measurement cannot see: a share nobody has opened has no renderer, so it has no
computed visibility and is delivered until one is attached and removed. The
viewer is a full-screen dialog, so there is little else for a measurement to
find that `screenReceiveLayerFor` does not already know.

**A share's sound is carried on the SFU**, and only there: the mesh path
never announced an `audioStreamId` from this client and the web's
`screenAudioStreamId` is not read yet. The `SCREEN_SHARE_AUDIO` publication is
subscribed with the voice, silenced by deafen like everything else, never
counted as the presenter being audible, and gated on the roster having
announced the share, exactly as `audibleScreenPeerIds` does on the web: an
unannounced publication stays silent.

`set-sharing-screen` is sent **after** the capture is alive, and
`screen-share-denied` (the server's `SCREEN_SHARE_LIMIT`, 2 on mesh) tears the
capture down rather than leaving a live projection nobody can see.

### Sending on the SFU, which is where a watch party actually happens

The share button used to be hidden on a LiveKit room, and `screenShareSupported`
was literally `transport == mesh`. That hid it on exactly the rooms a watch
party runs in: `server/src/voice/transport-policy.ts` pins a listed community
or a server of ten or more to the SFU, so a host on Android could not present
at the one event the feature exists for. Both engines publish a screen now.

**The button follows the permission, not the transport.** `welcome.canStream`
is the answer, and the server has already decided which question it was: STREAM
in a plain voice channel, START_WATCH_PARTY in a `watch_party` one
(`canStartWatchPartyStream`). This client asks one thing and never compares
channel types. Absent on the wire reads as `canSpeak`, which is the shared
schema's own rule and the safe direction, since a listen-only seat must not be
offered a share button. `voice-speak-changed` carries the same bit optionally,
so a moderator can stop a broadcast mid-party; absent there leaves the answer
alone rather than retiring the button on every self-host whose server predates
the field.

**Not `setScreenShareEnabled`.** The one-line SDK entry point starts LiveKit's
own foreground service to carry the `mediaProjection` type, and this app already
runs one that already juggles that type for the mesh path. Two services fighting
over one projection is either a duplicate notification or a lost grant. So the
track is built by hand: `createScreencastTrack`, then `startCapture()`, then
`publishVideoTrack`. The ordering rule is unchanged and is the same one the mesh
path obeys: consent, then a foreground service already carrying
`mediaProjection`, and only then may the projection be created.

**`Track.Source.SCREEN_SHARE` is not cosmetic.** The HLS egress lists the room's
participants and takes the first track whose source is `SCREEN_SHARE`
(`defaultFindTracks` in `server/src/voice/hls-egress.ts`). Publishing the same
pixels under any other source is a share every human in the room can see and no
watch party can transcode.

**The token is a ceiling, never a permission.** This is the correction that
matters most, and it was a moderation bypass before review caught it.

`VoiceSessionResponse.stream` is minted once, at connect, and the SFU token
carrying it is never re-minted. So when a moderator takes the stage away
mid-party, the server stops relaying the roster claim and stops the egress, but
the LiveKit grant this phone is holding stays valid. An engine that remembered
only that grant let the revoked presenter press share again and go straight back
on air: the revocation was a suggestion they took once. At a hosted event, where
the host deciding who broadcasts is the entire point, that is the worst place
for it.

So publishing needs **both** answers, every time (`canPublishScreenNow`): the
token's ceiling AND the roster's live answer, which arrives on `welcome` and on
every `voice-speak-changed` through `VoiceTransport.setCanPublishScreen`, the
twin of `setCanPublishAudio`. Revoking also takes down a share already running,
because the moderator's decision has to reach the wire rather than only the
button. A fresh engine starts out refusing until it has been told, so the
promotion path cannot hand the stage back to somebody who lost it just because
the room grew.

Mesh implements that method as a no-op, and that is the difference between the
transports rather than an omission: a mesh share is a track on peer connections
this device owns, with no server-side grant to outlive a revocation.

**One publish at a time, and the room never keeps what nobody is driving.**
Publishing is a capture, a track and an awaited publish, and four ordinary
things can happen in between: the person stops, the room promotes (at four
participants, which this client follows, so an engine swap mid-share is a
Saturday event rather than an edge case), the share is restarted quickly, or the
old capturer's `onStop` arrives late. Each one used to be able to publish a
stopped track, publish into a room being disconnected, or tear down the share
that was working. `ScreenPublishGuard` is a generation counter answering one
question for all four: is the thing that just finished still the thing we are
doing. A publish that lands stale is undone rather than left in the room.

**A failed unpublish is retried.** It used to be logged and forgotten, which is
the quietest bad outcome here: the presenter's UI says they stopped, their
capture really has stopped, and everybody else keeps a frozen rectangle with no
way to know it is stale. Bounded and short, because by then the local track is
already stopped and this is chasing a server-side row, not keeping a feature
alive.

**Simulcast off, `MAINTAIN_RESOLUTION`, 2 Mbps.** The web publishes a screen the
same way and for the same reason: the egress transcodes from the published
track, so a second low layer buys the ladder nothing and costs this phone a
second encoder. The ceiling does not scale with the room, unlike
`meshScreenBitrate`, because on the SFU the phone uploads exactly once however
many people watch. `StageRuleTest` pins that difference.

**A promotion still stops the share, and now the button comes back.** The mesh
engine is disposed with its capture, and from Android 15 a fresh projection
grant is required per capture session anyway, so a share cannot be carried
across. What changed is that `screenShareSupported` survives the promotion, so
the host presses the button again instead of watching it disappear for the rest
of the call.

**What is not verified: any of it, on a device.** No screen has been published
to a LiveKit room from this code. The moderation rule, the generation guard and
the retry policy are pure and tested, and the fact that every permission path
tells the transport both halves is checked by reading `VoiceController.kt`;
what none of that proves is the behaviour of a real `MediaProjection`, a real
SFU and a real moderator pressing the button. It compiles, it is shaped like the web's
publisher and the LiveKit API it calls was read out of the 2.28.1 bytecode
rather than from memory, and the pure rules around it are tested. Whether a
phone's capture actually reaches the SFU, whether the egress finds it, and
whether the picture that comes out is watchable all need a phone, a LiveKit
room and somebody looking at the result.

### What screen sharing still does not do

No **screen audio out of this device**. `MediaProjection` can record device
playback from Android 10, but only from apps that allow it, so a system-audio
track nobody can rely on would be worse than an honest silent share.
`audioStreamId` is therefore always null, which the protocol already treats as
the common case. Hearing somebody *else's* share is a different question and is
answered above, on the SFU.

No window or app picker of our own: Android's consent dialog offers "one app"
or "entire screen", and that is the platform's choice to present, not ours. No
quality menu: there is one rung, and it is 720 lines.

## Watch party, the HLS path

A watch party's audience does not join the call. That is the entire economy of
the feature: a viewer costs one playlist reader and nothing on the media
server, so six hundred people can watch a room that seats eight. On 5 September
a Twitch watch party sent 212 signups in twenty minutes at a mesh room with a
limit of eight, and every one of them was refused. Android had no watch surface
at all until this: the two frames arrived and nothing drew them.

### The seam, exactly

The server transcodes the presenter's LiveKit screen share into an HLS
playlist (`server/src/voice/hls-egress.ts`) and tells clients about it on two
frames, both defined in `packages/shared/src/live-hls.ts`:

| Frame | Who gets it | Carries |
|---|---|---|
| `voice-stream` | seats in the room | `{ channelId, stream \| null }` |
| `channel-live` | everybody with VIEW on the channel, seat or not | `{ channelId, stream \| null, watching }` |

`channel-live` arrives at socket auth for every live channel this account may
see, again whenever the egress starts, stops or changes URL, and on the
server's audience keyframe clock (30 s) while the channel is live or watched.
`GET /api/channels/:id/live` answers the same thing over HTTP, for a screen
opened before the socket said anything.

To be counted, a client sends `watch-live { channelId, watching }`. That is the
**only** frame the audience path sends. No `join-voice-room`, no
`POST /api/voice/token`, no `PeerConnection`, no LiveKit `Room`, and therefore
no microphone permission: watching asks for no device at all. The server checks
VIEW, counts the *socket*, and refuses to double count one that already holds a
seat. `gg.pqp.app.watch.WatchLiveStore` is that path and it has no reference to
`VoiceController`, which is what makes "seatless" structural rather than a
promise. `WatchLiveStoreTest` asserts the exact frames that leave the phone, by
type, in order, because a regression that quietly joined the call would still
play a picture on a laptop with two viewers and would only show up at the
event.

### The URL is a credential, and it changes every thirty seconds

`hlsUrl` is `/api/voice/hls-playlist/<channel>/<startedAt>?t=<token>`, and the
token is minted **per recipient**, bound to that user, channel and session
(`server/src/voice/hls-viewer-token.ts`). Two consequences that shape the
player:

- **No `Authorization` header, anywhere.** The `?t=` exists precisely so no
  header is needed. A Media3 `DefaultHttpDataSource` applies its default
  headers to every request it makes, and the segment lines inside the playlist
  are presigned absolutes on the bucket's own origin, so a bearer set on the
  data source would send a user's Clerk-derived token to R2. The player sets
  none.
- **A new URL is not a new stream.** The audience keyframe restamps the token
  twice a minute, so `hlsUrl` is a different string every thirty seconds for a
  stream nobody touched. `watchSourceChanged` compares `startedAt` (the egress
  session) and nothing else. Re-attaching on the URL would rebuffer every
  viewer twice a minute for the whole party, and would read as a bad
  connection rather than as one line of code.

### The player

`media3-exoplayer-hls`, a new artifact: `media3-exoplayer` alone has no `.m3u8`
parser at all. It is told twice that this is HLS, because the path has no
`.m3u8` extension for anything to sniff: `MimeTypes.APPLICATION_M3U8` on the
media item, and an explicit `HlsMediaSource.Factory` on the player.

The second one is the load-bearing half. `DefaultMediaSourceFactory` finds the
HLS source by **reflection**, so nothing in this module would reference it and
R8 is entitled to strip it out of the release build: debug plays, the signed
sideload APK does not, and the only symptom is a playback error. Naming the
class is a reference. Same reasoning as registering the GIF decoder by hand in
`PqpApplication` rather than trusting a `META-INF/services` entry through the
shrinker.

`HlsWatchdog` is a port of the web's `client/src/lib/hls-stall.ts`, with the
same numbers on purpose, and it exists because Media3's own retry cannot fix
the failure that actually happens: the *session* changed. Four triggers, each
one something seen at a party:

- a fatal `PlaybackException`;
- `STATE_ENDED`, which is `#EXT-X-ENDLIST`. LiveKit writes it when the egress
  stops, and a reused `live.m3u8` stays that finished VOD until the next share
  overwrites it. A player handed one plays to the end and freezes on a black
  frame, which is exactly what the web hit on 7 September;
- buffering for more than 8 s with nothing playing;
- the playlist's media sequence not advancing for 15 s, which is what a dead
  egress looks like while the playlist still answers 200.

Each of those refetches `GET /api/channels/:id/live` for the new session. Three
inside five minutes and the stream is called dead: a button, not a spinner,
because a phone retrying forever is somebody's data plan.

**The token is renewed on a clock, not on a failure.** `HLS_VIEWER_TOKEN_TTL_MS`
is an hour and a film is longer, so the token stamped into the attached URL
expires mid-party if nothing is done: the proxy answers 401 and the recovery is
a fatal error plus a reconnect. That recovery works and is not good enough, so
the swap is scheduled at fifty minutes instead, re-attaching with the URL the
audience keyframe has already restamped. iOS renews at the same moment for the
same reason (`WatchStreamSwap`), and the two were written without either side
reading the other. `WatchSourceTest` pins the margin against the TTL and
against the keyframe cadence that supplies the replacement.

Backgrounding pauses and coming back seeks to the live edge, rather than
resuming ten minutes behind everybody else. This app's foreground-service
exemption is for a *call*; a film does not get one.

### A hardcoded live offset held the playhead on the tip, and it stalled once a second

**#480 (2026-09-12) sat the player 6 s behind live and stalled it every four
seconds in production**, hours after shipping, because the numbers assumed
the wrong segment length. `HlsLiveEdge.kt` set an explicit
`MediaItem.LiveConfiguration` — `TARGET_OFFSET_MS = 6_000`,
`MIN_OFFSET_MS = 4_000`, `MAX_OFFSET_MS = 8_000` — applied in
`ui/WatchPane.kt` right before `player.prepare()`. Those were three, two and
four **segments** at the 2 s `LIVE_HLS_SEGMENT_SECONDS` production ran that
day. `LIVE_HLS_SEGMENT_SECONDS` moved to 4 s the same day (#495), and nobody
touched these millisecond constants, so in real segment terms they silently
became 1.5, 1 and 2 segments: a band hugging the bleeding tip of the
playlist instead of sitting comfortably behind it.

**The mechanism, exactly.** Media3's `DefaultLivePlaybackSpeedControl`
continuously adjusts playback rate (up to `MAX_PLAYBACK_SPEED = 1.5`) to
hold the actual live offset inside that band. A live playlist only grows one
segment at a time, once per target duration, so a player pinned to a single
segment's distance from the edge exhausts that one segment of runway in
about one target duration (4 s) and then has nothing published left to
decode — genuinely nothing exists there yet, not a bug in the request path.
It stalls (`Player.STATE_BUFFERING`), the next segment appears on the next
playlist refresh, playback resumes (`Player.STATE_READY`) for another ~4 s,
and the cycle repeats: play a segment, hit the tip, wait for the next one,
forever. That reads to a viewer as "plays a few seconds, pauses, reloads,
over and over," and the period is one target duration because the band was
never wider than one segment to begin with.

This is a **different** failure from `HlsWatchdog`'s reconnect
(`stallMs = 8_000`, `sequenceStuckMs = 15_000`, both above): each micro-stall
here is a real, short, genuine rebuffer that Media3 resolves on its own well
under 8 s, so `watchdog.onPlaying()` keeps resetting the stall clock and a
full reconnect (a new `MediaItem`, `attempt += 1`) never fires. Nothing was
"broken" in the sense of an exception or a dead stream; the configured band
was simply the wrong width for the segment length actually running.

**Fixed** by not fighting the playlist with a guessed constant at all.
`ui/WatchPane.kt` no longer calls `setLiveConfiguration`. With none set, and
with no `#EXT-X-SERVER-CONTROL` in this playlist (there is none), Media3
resolves `targetLiveOffsetUs` itself as `3 * targetDurationUs`, read off the
manifest it is actually playing (confirmed against the androidx/media
source, `HlsMediaPeriod`'s live-offset fallback,
[PR #8764](https://github.com/androidx/media/pull/8764)) — the same ratio
`HlsLiveEdge.kt` documents, computed from the real segment length instead of
one baked in at build time. Correct at 2 s segments, correct at 4 s, correct
at whatever `LIVE_HLS_SEGMENT_SECONDS` is set to next, with no client
release required to follow it.

**To confirm the mechanism from a live device** (no app rebuild needed,
since this build has no `AnalyticsListener`/`EventLogger` wired in, so there
is no per-event Media3 log line to grep for):

```
adb logcat --pid=$(adb shell pidof -s gg.pqp.app) -v time
```

Watch the timestamps of the stalls in the UI against this stream while a
watch party is live. A tight, near-exact ~4 s (one `LIVE_HLS_SEGMENT_SECONDS`)
period between pauses, each one resolving on its own within a second or two,
is this mechanism. A period of 8 s or more, coinciding with the picture
jumping to a new live position rather than continuing forward, is
`HlsWatchdog`'s reconnect path instead
(`ui/WatchPane.kt`, the `WatchdogDecision.Reconnect` branch) — a different
bug with a different fix. Attaching `androidx.media3.exoplayer.util.EventLogger`
as an `AnalyticsListener` would turn this from a timing inference into a
`state [... BUFFERING]` log line per transition; it is not wired in today
and is a reasonable fast follow, not part of this fix.

Pinned by `HlsLiveEdgeTest`, which asserts the ratios rather than a
millisecond figure, and by a source check that `ui/WatchPane.kt` does not
reintroduce `setLiveConfiguration`.

### What it looks like

An `AO VIVO` pill on the channel row, so a person scrolling the list can find
the party. Opening the channel puts a 16:9 player above the transcript with the
audience count and the delay under it, and a tap on the corner takes it full
screen. Watching is one tap, costs nobody a seat, and is the whole offer on
this screen for anybody who is not running the party: the join button in the
app bar is drawn only for somebody who may actually have a seat. See "The seat,
and who is offered one" below.

The pane draws **nothing** on a voice channel with no watch party. Not a
placeholder, not an apology for a stream that was never running.

### What it says when it cannot work

Every state has words, in Portuguese, and none of them is a black rectangle:

| State | pt-BR |
|---|---|
| live, no picture yet | Esperando a imagem chegar |
| stalled, refetching | A transmissão travou, reconectando |
| given up | A transmissão caiu, plus **Tentar de novo** |
| the stream stopped | A transmissão acabou / Quem estava na call continua lá. |

A stream the server says is over outranks both trouble states, so nobody is
offered a retry button for something no retry can bring back.

### What is verified, and what is not

On this machine: the module compiles debug and release, R8 and the resource
shrinker survive the new artifact, `lintVitalRelease` passes, and the unit
suite is green including 40 new tests. Every one of those was proven by
breaking the code it covers and watching it fail by name.

On a Pixel 10 Pro emulator (API 37) against a local API with the dev bypass:

- **The seatless path, measured rather than argued.** Opening the seeded voice
  channel took `GET /api/channels/:id/live` from
  `{"watching":0,"participants":0}` to `{"watching":1,"participants":0}`, and
  leaving it put the count back. A watcher, and no seat.
- **The player decodes a real HLS playlist.** With a temporary local patch
  feeding the pane a public test playlist (reverted; not in the branch), video
  rendered above the transcript with `AO VIVO`, `3 assistindo` and `~10s de
  atraso` on a device set to pt-BR, and fullscreen handed the same player
  between two `PlayerView`s without dropping playback.
- **A channel with nothing live is untouched.** No pane on a plain voice
  channel and none on a text channel, which is the check that matters for the
  `ChatScreen` restructure.
- **No crash.** `logcat` carries nothing from the app across the whole session.

**Not verified: our own stream, end to end.** That test played somebody else's
playlist. Untested against the real thing: the `?t=` viewer token at the
playlist proxy, the master playlist and its rungs, ladder switching, whether
the delay badge is honest about our transcode, and whether a share that dies
and restarts mid-party is followed (the `startedAt` rule and `HlsWatchdog` are
unit-tested, and the wiring around them has never seen a real session change).
Also untested: a real phone on mobile data with the screen off, because an
emulator's lifecycle and network are not a phone's. Say so rather than
reporting green.

### The seat, and who is offered one

A watch party's audience is seatless, and until this the phone enforced that on
the way **out** and not on the way **in**. `Channel.isVoice` answers true for
`watch_party` as well as `voice`, so `chat.joinVoice` in the app bar was drawn
for a watch party: a green button putting a viewer on the media box for
something the pane right above it plays for free. At five hundred viewers that
is the exact cost the HLS path exists to avoid. The web stopped offering it in
#436; this client had not followed.

**It could not be a blanket removal.** The host is the reason the screen-share
work exists, and the phone could not tell a host from a viewer before joining:
`welcome.canStream` is the answer and `welcome` only arrives once the seat is
already taken.

`watch-party-update` is what closes that, and it is why the frame came off the
deliberately-ignored list. It carries `viewerRole`, resolved **per recipient**
by the server, and `catchUpWatchParties` sends one at socket auth for every
active party this account may see, so the answer is here before anybody can tap
anything. `stage.invited` rides along and is public on the wire (who is UP is
public, who is ASKING is not), so an invited guest recognises themselves with no
second request.

The rule itself is `mayTakeWatchPartySeat` in
`android/.../watch/WatchPartySeat.kt`, a transcription of the function of the
same name in `packages/shared/src/watch-party-session.ts`: the one the server
refuses `join-voice-room` with, and the one the web panel draws from. Three
implementations of a permission rule is how they drift, so this one is meant to
read as a copy: same name, same terms, same order. Who is let in: the host and
co-hosts by name, anybody invited up to speak, and everybody once a host turns
voice on. A channel with **no active party is not a closed room** and joins like
the ordinary voice room it is.

Two things it gets deliberately wrong, both stated rather than hidden:

- **`canStartWatchParty` is always false here.** The phone models no permission
  bits. Staff who hold `START_WATCH_PARTY` and are neither the host nor a
  co-host of the party currently running see no join button while it runs. A tap
  they never get is a smaller failure than a seat sold to five hundred viewers,
  and the parameter is kept so wiring a real answer in later is one line.
- **A `draft` party is invisible to a viewer**, so the phone sees no party and
  offers the button, and the server refuses. That is not new and the web has the
  same blind spot; what makes it survivable is the deadline below, which turns
  it into a sentence instead of a spinner.

**`voiceEnabled` arrives with the change that turns voice off by default.** A
server that has never heard of it sends no such key, and it ran watch parties as
ordinary voice rooms, so the decoder reads an absent key as **on**
(`LEGACY_VOICE_ENABLED`). Reading it as off would hide the button on exactly the
servers that would have honoured the join, which is the mirror of the bug being
fixed. Pinned by `a party from a server that has never heard of voiceEnabled
reads as voice on`.

### A join that is refused now says so

`join-voice-room` has no acknowledgement, and **most refusals send no frame at
all**: `refuseResume()` in `server/src/ws/voice.ts` sends `voice-join-refused`
only when the join carried a `resumePeerId`, and this client never sends one. So
a timed-out account, a lost CONNECT bit, a blocked DM, a channel that went away,
a seat in a watch party that is not yours, and an ordinary dropped packet all
produced the same thing here: silence, and a call bar reading `Entrando…` until
somebody killed the app.

`JoinWatchdog` ends every one of them. Twelve seconds, the same
`JOIN_TIMEOUT_MS` the web client uses and asserted against that file so the two
cannot drift. It covers the socket leg only; the media leg after `welcome` keeps
its own 45 s deadline inside `LiveKitEngine`, which ends in
`Refusal.VoiceBackendUnreachable`. On expiry the app sends `leave-voice-room`
first, because "nothing came back" is not "the server never saw it" and a lost
`welcome` leaves a seat on everybody's roster; then it stops and says *Não deu
para entrar na call. Tenta de novo.*

It does not retry. The likeliest causes are not transient, and a person told
what happened taps the button again in one gesture, while a phone retrying a
refusal in a loop cannot be told to stop.

The generation counter is the whole of the correctness argument: a socket drop
rebuilds the call from scratch, so a second `enter` happens while the first
attempt's deadline is still asleep, and firing it would hang up the room that
had just come back. `claim` is one-shot for the same reason a refusal must not
be delivered twice.

`voice-join-refused` is handled as well, and came off the ignore list with it.
It is a floor rather than a live path today, and it turns a twelve second wait
into an immediate answer the day the server starts answering a cold join.

### Still not done

- **Sending a screen on the SFU.** See the section above; the button is still
  hidden on a LiveKit room, which is the transport every watch party runs on.
  A host cannot present from Android yet.
- **The watch party *event*, as a surface.** `watch-party-update` is read now,
  but only for `viewerRole` and `options` (see below); `watch-party` is still
  ignored. The phone draws the stream, not the party's name, host, co-hosts or
  state machine, and has no create surface.
- **Picture in picture**, and playing on with the screen off. Both want a media
  session and a service, which is a different piece of work with its own
  battery argument.

## Cameras, receiving

A phone in the 5 Sep watch party saw the film and not one face. Every other
client drew the webcams; Android refused the publications by rule
(`livekitSubscribesTo` answered false for `CAMERA`) and said so in its own
source. That is now the other way round on both transports.

**What it looks like.** The call bar grows a strip of faces along its bottom
edge when somebody in the room turns a camera on, and a tap on a face makes it
full screen. That is the whole interface; nothing is announced and nothing has
to be explained. It is deliberately not a row of "*Name* turned their camera
on" lines like the Watch row above it: opening a share is a decision worth a
sentence because it takes the whole phone, while a camera is something you want
to *see*, and there can be a dozen at once. It lives on the call bar because a
call outlives the screen that started it, so reading a channel next door does
not hide the room's faces.

**What the SFU is asked for, and when.** The same shape as the share rules, and
tighter, because a room can hold many more cameras than screens.

- **Only what is on screen is delivered.** A camera arrives *flowing* (the
  opposite of a share, which arrives paused) and is paused a second later if
  nothing has bound it, so the tile that appears one frame after the track is
  never a black rectangle. Each tile and the viewer tell the transport they are
  drawing that camera through `LifecycleStartEffect`, so being composed is not
  enough: the app going to the background pauses every camera, and coming back
  resumes them within a round trip. A `LazyRow` composes what fits and no more,
  which makes scrolling the strip the thing that starts and stops paying for a
  face.
- **The claims are counted, not flagged** (`CameraDemand`, unit-tested). The
  viewer is a `Dialog`, so the tile behind it stays composed and bound the whole
  time it is open. With a boolean, closing the viewer would pause a camera that
  is still on screen in the strip: a face that goes black when you stop looking
  at it closely, and stays black. The *largest* surface still bound decides the
  layer.
- **The layer is capped per surface** (`cameraReceiveLayerFor`, tested): the
  bottom layer for a tile, 360p for the viewer on Wi-Fi, the bottom layer again
  on a metered link. `HIGH` is never asked for, for the same reason it is never
  asked for of a share. Stated honestly: against a **web** publisher this
  ceiling buys nothing, because `livekit-session.ts` publishes the camera with
  `simulcast: false` and there is one layer on the server to give. iOS
  publishes through `setCamera`, which does simulcast. The ceiling is applied to
  both rather than remembered as something to switch on later.
- **`setEnabled`, never `setSubscribed`.** Unsubscribing tears the receiver down
  and re-subscribing renegotiates: a second of black and a new track for the
  tile to rebind. Pausing is one signalling frame each way. Same call the web
  makes in `remote-video-delivery.ts`, whose one-second grace period this also
  copies so that a tile scrolled just past the strip's edge and back does not
  blink.

All of that needs `adaptiveStream = false`, for the reason spelled out under
screen sharing: on this SDK the two controls are ignored outright on an
adaptively managed track.

**Lifecycle, the four cases that are easy to get wrong.**

- **A camera for somebody already sharing a screen.** Separate slots, per peer,
  on both transports. One slot per peer is exactly how the presenter in the
  watch party would have lost one of her two pictures.
- **A camera turned off and on again.** Every pqp client *unpublishes* rather
  than muting, so the ordinary case is an unsubscribe and a fresh subscribe, and
  the index accepts the new sid because the old one cleared its slot. The other
  route, a publisher who mutes, drops the tile and the delivery until the
  unmute; the subscription is left alone.
- **A peer leaving mid-render.** The tile, the delivery claim and any pending
  pause are all dropped together, and a stale `onDispose` arriving afterwards is
  absorbed rather than driving a counter negative.
- **A reconnect.** The SFU keeps neither the subscriptions nor the track
  settings across one, so `RoomEvent.Reconnected` re-seeds the participants and
  re-states delivery for every video this client holds, including which share a
  viewer is open on. The index accepts a re-subscribe of the *same* sid for the
  same reason: refusing it as a duplicate would leave the tile holding the track
  from before the drop, which never receives another frame.

**On the mesh there is nothing to ask for**, and that is why it was cheap to
draw there too. A mesh sender encodes one stream per receiver and pushes it, so
the camera was already arriving down the peer connection and being filed
correctly by `RemoteVideoIndex`; it was simply shown to nobody. Rendering it
costs no bytes that were not already being paid, and `setCameraViewer` is a
no-op on that transport.

**Not verified on hardware.** No phone has drawn a camera from either transport
on this branch. The pure rules are unit-tested and every one of those tests was
checked against a deliberately broken copy of the module it covers; the wiring
is verified by reading. Confirming it needs the local LiveKit rig above plus a
web participant with their camera on: expect the strip to appear, a face in it,
the layer to rise when the tile is tapped, and the delivery to stop when the app
goes to the background.

## Reactions

Built and verified between two emulators and the web client. The transcript
already decoded `reactions` off every message and drew none of them, and the
socket already carried both halves of the protocol; this is the client that
uses them.

- The pills sit under a message and wrap, because eight people can pick eight
  emoji and a single row would push the last of them off a phone.
- Tapping a pill toggles that emoji. Adding a *new* one is on the long press,
  which now opens a small actions sheet instead of going straight to the report
  flow. **Report keeps a labelled row in that sheet**: it is a Play requirement
  rather than a feature, and burying it behind an icon would be how it gets
  lost.
- The quick set is `QUICK_REACTIONS` from
  `client/src/lib/emoji-shortcodes.ts`, read off that file by a test, so a
  channel does not have two vocabularies depending on which client somebody is
  holding.

### The one thing worth reading before changing it

`reaction-broadcast` is a **delta**: "this person added or removed this emoji".
Everything a pill shows is the client's own running total, and the server only
re-sends the true list on the next page load. So a fold applied twice is wrong
forever, on that device, with nothing erroring anywhere.

This client is optimistic where the web client is not: the pill moves the
instant it is tapped, because a control that waits for a socket round trip
reads as dead and gets tapped again, which sends a second toggle and undoes the
first. That optimism is what makes the double fold reachable here and not on
the web, and it is why `applyReactionBroadcast` has a guard the web version
does not: **a broadcast about us that agrees with `me` has already been
applied.**

That is not a theoretical hazard. It shipped in this branch and two emulators
found it in about ten seconds: taking your own reaction back off a message two
people had liked took the count from 2 to 1 optimistically, and then the echo
of your own frame ran the reducer again, saw `count <= 1`, and deleted the
pill. The other person's reaction vanished from your screen until the next page
load. Every unit test passed the whole time, because the one that covered
idempotent removal only covered the case where the count was already 1.

### Verified by running

Two emulators plus the web client, one message:

- Ana reacts. Both emulators show the pill; hers is filled, Bruno's is
  outlined. One row in `message_reactions`.
- Bruno taps the pill. Both show 2, both filled. Two rows.
- Bruno taps again. Both show **1**, Ana's filled, Bruno's outlined. One row.
  (This is the case that was broken; before the fix Bruno's pill disappeared.)
- The web client shows "You and Ana Beatriz reacted with 🔥" and 🔥 2, and a
  reaction made from the web appears on the Android transcript live.

A message that has not been acknowledged yet cannot be reacted to: its id is
the client's own nonce, which names nothing server-side, so the frame would be
dropped in silence and the pill would sit there looking applied. The web client
refuses the same case. That guard is written, and it is the one part of this
that was **not** exercised on a device, because reproducing it needs a message
to sit un-acknowledged for as long as it takes to long-press it.

**Not verified:** that guard, and the server's cap on how many distinct emoji
one message may carry.

## Chat basics: markdown, edit, delete, reply, pins, mentions, GIFs

The gap this closes is the one `docs/PARITY.md` ranked ninth: the transcript
could send, receive, react and report, and could do nothing else the web has
been doing since the first month.

**Markdown is parsed here, not by a library.** `ui/chat/ChatMarkdown.kt` reads
a body into blocks and styled runs; `ui/chat/MessageBody.kt` draws them. No
markdown dependency was added, and that is deliberate: chat markdown is
Discord-shaped rather than CommonMark-shaped, so every general-purpose parser
would have to be *disabled* into the right shape. `# announcement` is a
sentence, a single newline is a line break rather than a space, and a blank
line survives. A CommonMark renderer gets all three wrong by default, which is
exactly what `client/src/lib/chat-markdown.ts` spends its length undoing.

The vocabulary is the web's: `**bold**`, `*italic*`, `_italic_`,
`~~strike~~`, `` `code` ``, ``` fences, `> quotes`, links (bare and
labelled) and `@mentions`. Headings, indented code, HTML and `---` rules stay
literal, which is the same set `remarkDisableChatBlocks` turns off. Keeping the
parser out of Compose is what makes it testable: `ChatMarkdownTest` is 20 cases
over strings, no device and no screenshot.

**A mention is marked when the server would resolve it**, not when it looks
tidy. `MENTION_PATTERN` in `packages/shared/src/api.ts` has no word boundary,
so `me@example.com` really does notify an account called `example` if one
exists, and the renderer marks it for that reason. The *picker* is stricter and
refuses an `@` mid-word, because that is a different question: what to offer
while somebody types, not what they typed. `ChatMarkdownTest` reads the shared
pattern off disk and fails when the copy drifts.

**Edit, delete and pin are HTTP, not socket frames.** There is no
`message-edit` on this wire: it is `PATCH /api/messages/:id`,
`DELETE /api/messages/:id` and `POST` / `DELETE /api/messages/:id/pin`, and the
socket's only part is relaying the `message-update` (or `message-delete`) that
follows. `ChatActionsApiTest` pins the verb and the path of each against a real
socket, because a wrong one is a 404 the view model catches and turns into a
dialog: nothing crashes, and nothing works.

None of the three is optimistic, unlike a reaction. A reaction is a pill that
has to move under the finger; an edit that reverts a second later, or a deleted
message that comes back, reads as a haunting. The local state changes when the
server has agreed, and the broadcast that follows is then a no-op.

**Who is offered what** is `ui/chat/MessageActions.kt`, restating the server's
own rules so the sheet cannot show a row that always 403s. Only an author
edits, ever, including a moderator looking at somebody else's words. An author
deletes their own anywhere; a moderator deletes anyone's *in a server channel*.
A conversation has no moderators at all, so `serverId` being null is an answer
rather than a missing lookup, and anybody in one may pin. This is the shape iOS
got wrong in both directions at once, which is why `canManageMessages` lives in
shared; `MessageActionsTest` reads it off disk.

The screen learns which server it is in from `ChatRoute.serverId`. A chat
opened by a notification tap carries ids and no membership, so it behaves as a
plain member there and `@` offers no names: quieter than it could be, never
wrong.

**Replying and editing share the composer**, because a phone has nowhere else
to put them. A strip above the box says which of the two is happening and
offers a way out; cancelling an edit puts back whatever draft was in the box
before it started. The send button becomes a tick while editing, since an edit
changes a message rather than adding one.

**The GIF picker** goes through `/api/gifs/config`, `/search` and `/trending`,
so the provider is whatever the API is configured with (Klipy today) and no
provider key is ever on the phone. A picked GIF is *staged as an attachment*
(`POST /api/channels/:id/attachments/gif`) exactly as the web does it: nothing
is uploaded, the bytes stay with the provider, and the message can therefore
carry a caption and be edited afterwards. The button is gated on the GIF key
alone and not on `attachmentsEnabled`: a deployment with no `S3_*` at all can
still send a GIF.

**Not verified on a device or an emulator.** This is compiled, and the pure
parts are covered by 59 new JVM tests, but nobody has watched a pin sheet open
on a phone. Two emulators and a web client would settle it in ten minutes,
which is what the reactions work above cost and what it found.

## Direct messages and the friends list

Three peer destinations behind a bottom `NavigationBar`: **Servers**, with the
list #103 built, unchanged; **Messages**, the conversation list; and
**Friends**. Both new tabs carry a live count, which is the whole reason the bar
exists rather than a link somewhere: a friend request and a DM both arrive as
socket frames while you are looking at something else, and a badge nobody can
see is a badge that does not work.

Everything lives in `gg/pqp/app/social/` (`SocialModels`, `SocialApi`,
`SocialRepository`) and `gg/pqp/app/social/ui/`. Outside that package the branch
touches four files, on purpose: two lines of `PqpApp.kt` (the start destination
renders `HomeScreen`, and `conversationDestination(...)` registers one route),
one default parameter on `ChatScreen`, and an append to each `strings.xml`.

### A conversation is a channel, so it is the same chat screen

`channels.kind` is `dm` or `group` instead of `server`, and everything a
conversation carries after that point is the ordinary channel protocol:
`join-channel`, `message-create`, `message-broadcast`, the same paging endpoint,
the same nonce. So `ChatScreen` and `ChatViewModel` are reused as they are. The
only difference a conversation needs is its title, which is why `ChatScreen`
gained a `title` parameter that defaults to `#$channelName`: a conversation has
no name of its own, and `#` in front of a person's name is wrong.

`channels.name` is stored empty server-side, deliberately, because any name
invented there would be wrong the moment somebody renamed themselves. The
participant list is the title, and the server has already left the viewer out of
it.

### The rule that is easy to get wrong

**Closing a conversation deletes only your own `channel_members` row.** The
channel, its history and the other person are untouched, and the server puts you
back in it the instant either side speaks: `restoreDmParticipants` in
`server/src/services/dms.ts`, run *before* the message is written so that you
are in its audience for the badge.

The consequence for a client is one branch. A `channel-activity` frame naming a
conversation this client has never heard of is **not** a frame to drop; it is a
conversation that has just come back, and only the server knows who is in it, so
the answer is to re-read `GET /api/dms`. Drop it and a reopened DM reaches
nobody: the sender watches their message land, and it never appears on the other
phone until somebody pulls to refresh. `SocialRepository.onChannelActivity`
carries that branch and the comment saying why.

This is also why the repository is not a `ViewModel`. The frames arrive when
neither tab is on screen, so something has to be listening then; it lives for
the process the way `VoiceController` does, and empties both lists on sign-out.

### What the protocol does and does not offer

- `GET /api/friends` is the whole relationship surface in one read: friends with
  a status, requests waiting on you, requests you have standing.
- **A refusal is not an oracle.** Every rejected friend request and every
  refused conversation answers with one sentence, whichever reason it was.
  The server's wording is shown verbatim, and the sheets show it *inside*
  themselves rather than on a snackbar the sheet is covering, which was a real
  bug found while testing: the refusal was posted to a screen nobody could see,
  so the button read as broken.
- **Declining is silent**, and so are cancelling and unfriending. All three are
  one `DELETE` and the other side is never told.
- **Pending entries carry no presence.** Until you accept, the other person is a
  stranger, and the server sends no status for one, so there is no dot to draw.
- **`friend-activity` is content-free.** It names nobody: the client re-reads
  the bounded endpoint it was already entitled to read. It fires for a new
  request and for an acceptance, and deliberately never for a decline, a cancel,
  an unfriend or a block.
- **Presence has no frame of its own.** A friend's status only changes here when
  `GET /api/friends` is read again, so the Friends tab polls every 15s while it
  is on screen and stops when it leaves. Same cadence as iOS.
- **Discovery has two paths**, and both are budgeted server-side: a prefix
  search over handles, and an exact `name#1234` lookup for somebody who already
  knows the full tag. The field is debounced by 300ms and refuses to search
  below two characters, because that endpoint is the tightest-budgeted one in
  the API and a request per keystroke gets rate limited inside a word. A tag
  that matches nobody is a 404, which is an answer and not an error.
- **A group is always created new.** There is no canonical identity for a set of
  people, so two taps make two groups. That is the server's intent, not a bug.
  The picker stops at nine others because the server caps a conversation at ten.

Blocking is offered from a friend row and ends the friendship through a database
trigger, so no separate unfriend call is issued beside it. The blocked list
itself has no screen yet.

### Verified, with two emulators and two accounts

Two dev-bypass accounts against a live local server, driven through the UI on
both phones rather than through curl:

- Adding by exact tag, the request landing in the other client's **Pending** tab
  with a live badge, accepting it there, and the acceptance arriving back on the
  first phone as a snackbar plus a friend row with a green dot. Both sides
  confirmed in `GET /api/friends`.
- **A DM in both directions.** Sent from one phone, rendered on the other, and
  the row present in Postgres as `kind = 'dm'`. The reply arrived live on the
  first phone without a refresh.
- **The reopened conversation.** One side closed the conversation (its
  `GET /api/dms` then answered `{"conversations":[]}`), the other side sent a
  message, and the conversation came back in the closed side's list with its
  unread badge and all three messages of history, live and with no manual
  refresh.
- A group of three, created from the picker, titled by its participants, with
  the row showing a stacked avatar and "3 people" on the far side.
- Unread badges clearing on open, and the refusal path: a stranger the server
  will not let you message shows "Cannot open a conversation with this user"
  inside the sheet.
- pt-BR, through `cmd locale set-app-locales`. The system supplies the relative
  timestamps ("Há 2 min."), so those follow the locale for free.

**Not verified:** a conversation with somebody who has blocked you (the block
path is server-side and untried from this client), attachments in a DM, and
anything about how the list behaves at a few hundred conversations. There are
still no instrumented tests. Blocking is wired but was not exercised end to end.

## Attachments

Sending a file is built and verified end to end. Receiving already worked: the
transcript has rendered images and file chips since the first PR, because
`messageSchema` carries them and `mapMessage` mints a presigned GET per row on
every read.

The client half is the flow in [`ATTACHMENTS.md`](./ATTACHMENTS.md), unchanged:
`POST /api/channels/:id/attachments` to mint, a `PUT` straight to object storage,
then `message-create` carrying `attachmentIds`. No protocol was added and nothing
server-side was touched.

Three things about it are worth knowing before quoting it.

**The attach button is absent, not disabled, when the deployment has no
storage.** `GET /api/attachments/config` decides, the same switch the web
composer uses. A self-host with no `S3_*` shows no paperclip at all.

**A message cannot be sent while an upload is running or after one failed.**
That is not politeness, it is the only thing standing between a user and a
message that arrives with the picture missing: the server HEADs each object
before the claim transaction opens and silently drops the rows that are not
there. A failed chip says "Did not upload", stays put, and retries on tap.

**The upload does not go through `ApiClient`.** The `PUT` is addressed to object
storage and signed in the query string, so adding our `Authorization: Bearer`
header makes S3 refuse it as doubly authenticated. It is built against the raw
OkHttp client, on `Dispatchers.IO`, and both facts are load-bearing.

### Verified by running

Two emulators against a local server with MinIO, plus the web client in the same
channel:

- An image alone, an image with a caption, and a PNG plus a PDF in one message.
  Every one of them arrives on the other emulator, and the row in
  `message_attachments` has `message_id` set (claimed), the right content type,
  the right byte size, and the width and height read off the file.
- The **web client** renders the Android upload at its true 900x600, which is
  the cross-platform half.
- The failure path, by removing the `adb reverse` for MinIO's port: the chip
  turns red, the send button greys out, and tapping the chip after restoring the
  tunnel uploads it and re-enables the send.

**Not verified:** R2 rather than MinIO (the presigned PUT has been proven against
R2 from the server's own test suite, not from this client), a file large enough
to make the in-memory read hurt, and the image-scanning path in
[`CONTENT_SAFETY.md`](./CONTENT_SAFETY.md), which is off on this machine.

Local dev note: debug builds reach the API through `adb reverse tcp:3001`, and
the presigned upload URL points at `S3_ENDPOINT`, which is `localhost:9000` for
MinIO. So local attachment testing needs a second tunnel,
`adb reverse tcp:9000 tcp:9000`. Hosted builds do not, because R2 is a public
host.

## Push notifications: the client is built, the server leg is not

The client half is here and works. The server half does not exist, cannot be
faked from the client, and is **not** in this PR. Read the boundary before
quoting either half.

### What the server does today, and why Android cannot register

`server/src/services/push.ts` already decides *who* gets told: no live socket
anywhere in the cluster, not on do-not-disturb, and a per-channel notification
level that allows it. That decision is made once and handed to two transports,
Web Push (VAPID) and APNs. FCM would be the third leg of the same feature, and
the client re-decides none of it.

Three things stop an Android device registering against the server as it stands,
and all three are server-side:

1. **`PushPlatform` is `"web" | "apns"`.** There is no third value.
2. **`pushRegistrationSchema` is a two-member zod union**: an APNs body
   (`platform: "apns"` plus a lowercase-hex token) or a Web Push body (an https
   endpoint plus ECDH keys). An FCM registration token is neither. It is a long
   mixed-case opaque string containing a `:`, so `POST /api/push/subscriptions`
   answers 400.
3. **The database would refuse it anyway.** `push_subscriptions_platform_shape`
   in `server/src/schema.sql` is a CHECK constraint that enumerates the two
   shapes, so an `fcm` row is rejected at the storage layer even if the types
   allowed it.

There is no client-side way around this, and squeezing an FCM token into the
`web` shape would be a lie that looks like it works. So the client is built up
to that boundary and stops there.

### What the server needs, precisely

Seven edits, in the shape the existing APNs leg already established. `apns.ts`
is the template throughout: FCM is the same job with a different envelope.

The blast radius is `server/src/` plus `server/src/schema.sql`, and **nothing
else**. In particular `packages/shared/` is not involved: `PushPlatform` and
`pushRegistrationSchema` live in `server/src/services/push.ts`, and there are no
push schemas in shared at all.

**1. `server/src/schema.sql`** gains an `fcm` branch on the CHECK constraint,
identical in shape to the `apns` one (a token, no endpoint, no keys), plus its
own partial unique index:

```sql
ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_platform_shape;
ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_platform_shape CHECK (
    (platform = 'web'
      AND endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL
      AND token IS NULL)
    OR
    (platform IN ('apns', 'fcm')
      AND token IS NOT NULL
      AND endpoint IS NULL AND p256dh IS NULL AND auth IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_fcm_token
  ON push_subscriptions (token) WHERE platform = 'fcm';
```

A **separate** index, and the reason runs the opposite way to the obvious one.
`ON CONFLICT` inference does not need the index predicate to *match* the
restated one, it needs the index predicate to be *implied* by it. So widening
the existing index to `WHERE platform IN ('apns', 'fcm')` would **not** break
`saveApnsSubscription`: Postgres proves `platform = ANY('{apns,fcm}')` from
`platform = 'apns'` and the upsert keeps working. This was tested against the
project's own Postgres 16 container, not reasoned about.

What actually fails is the other direction. An FCM upsert restating
`WHERE platform = 'fcm'` cannot infer an index predicated on
`platform = 'apns'`, because that implication does not hold, and it errors with
"no unique or exclusion constraint matching the ON CONFLICT specification".
Hence a second index scoped to `fcm`, which the FCM upsert then restates the
same way `saveApnsSubscription` restates its own.

**2. `PushPlatform`** gains `"fcm"`, and a `saveFcmSubscription` mirrors
`saveApnsSubscription` exactly, upserting on the token for the same reason: one
device has one token, and if two accounts sign in on one phone the token must
follow whoever is signed in now.

**3. `pushRegistrationSchema`** gains a third member, tried **before** the Web
Push member for the same compatibility reason the APNs one is:

```ts
export const fcmSubscriptionSchema = z.object({
  platform: z.literal("fcm"),
  // Registration tokens are ~150-200 chars today, of the form
  // "<instance-id>:APA91b<...>", but Google documents the length as not
  // fixed. Bounded generously and checked for shape, not pinned.
  token: z.string().min(64).max(4096).regex(/^[A-Za-z0-9_:.-]+$/),
});
```

**4. A new `server/src/services/fcm.ts`**, mirroring `apns.ts`. Config from a
service account (`FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`), a
self-signed JWT exchanged for an OAuth2 access token against
`https://oauth2.googleapis.com/token` with scope
`https://www.googleapis.com/auth/firebase.messaging`, then
`POST https://fcm.googleapis.com/v1/projects/<project>/messages:send`. Cache the
access token for its hour rather than minting one per push. `isFcmEnabled()`
answers whether all three variables are set, exactly as `isApnsEnabled` does.

**5. The send body must be DATA-ONLY. This is the part that is easy to get
wrong and expensive to get wrong.**

```jsonc
{
  "message": {
    "token": "<registration token>",
    // NO "notification" key. See below.
    "data": {
      "title": "<payload.title>",
      "body":  "<payload.body>",
      "path":  "<payload.path>",
      "tag":   "<payload.tag>"
    },
    "android": {
      // BOTH OF THESE COME FROM `PushDeliveryOptions`, WHICH ALREADY EXISTS.
      // Do not hardcode either. `MESSAGE_DELIVERY` is urgency "normal" and TTL
      // 24h; `CALL_DELIVERY` is urgency "high" and TTL 50s, because a ring
      // delivered at minute two is not late, it is wrong. Hardcoding "HIGH"
      // would send every mention and DM at ring urgency and make Android
      // diverge from web by accident.
      "priority": "<delivery.urgency === 'high' ? 'HIGH' : 'NORMAL'>",
      "ttl": "<delivery.ttlSeconds>s",
      "collapse_key": "<payload.tag>"   // same job as apns-collapse-id
    }
  }
}
```

The four `data` keys are the ones `buildApnsBody` already carries to iOS under
exactly those names, so the three clients keep one vocabulary.

The reason is **control of how the notification is drawn**, not suppression.

It is worth being exact, because the tempting justification is wrong. With a
`notification` key, `onMessageReceived` *is* still called while the app is in
the foreground; the SDK only draws the message itself when the app is
backgrounded. And backgrounded is precisely the case where
`PushPresentation.shouldNotify` returns true unconditionally, because nothing is
being read. So "a `notification` block would smuggle a push past the redundancy
check" describes a failure that cannot actually happen.

What a `notification` block really costs is everything about the notification
this client decides:

- **The channel.** The SDK draws on whatever
  `default_notification_channel_id` names, not on `pqp.messages` with its
  importance and description.
- **The tag, and therefore collapsing.** One live notification per conversation
  is a `notify(tag, id)` call; the SDK does not make it.
- **The tap.** The PendingIntent carrying `path` and `tag` into `MainActivity`
  is what lands a tap on the right channel. The SDK's default launches the
  activity with none of it.

Two shapes of the same event drawn two different ways, depending on whether the
app happened to be backgrounded, is a worse outcome than either. Data-only makes
the client the only thing that draws.

Note also what is *not* a cost of this choice: a force-stopped app receives no
FCM message of any kind, `notification` or `data`, so that is not a trade-off
data-only makes. Delivery to a dozing device is governed by `priority`, which is
set above.

**6. Wiring.** `isAnyPushEnabled()` gains `|| isFcmEnabled()`. `PushTransports`
gains an `fcm` leg and `readTransports` reads it. `deliverToUsers` gains one
branch, next to the APNs one, and that is the only place the platforms diverge.
`GET /api/push/config` gains `fcm: isFcmEnabled()`, and the POST route's
two-way `isApns ? ... : ...` guard becomes a three-way switch so a server with
no FCM config refuses tokens it can never send to.

**Prune on `UNREGISTERED` (404) and `SENDER_ID_MISMATCH` (403), and on nothing
else.** Specifically **not** on `INVALID_ARGUMENT`: that is FCM's answer to a
malformed *message body*, not only to a bad token, so pruning on it means one
payload bug deletes every Android subscription in the table on the next fan-out.
`isApnsTokenGone` in `services/apns.ts` is careful about exactly this class of
ambiguity for APNs, and documents why; inherit that care rather than the shape
of the code. An `fcmTokenGone` helper with the same comment is the right place
for it.

**7. Unregistering, which is the one that is a security bug if it is skipped.**

`deleteApnsSubscription` is hard-scoped to one platform:

```sql
DELETE FROM push_subscriptions
 WHERE user_id = $1 AND platform = 'apns' AND token = $2
```

and `DELETE /api/push/subscriptions?token=...` routes to it **unconditionally**
whenever a `token` parameter is present. So an FCM token sent to that endpoint
matches zero rows and the route still answers `{ ok: true }`. Silent, and it
looks like it worked.

That is not cosmetic. The Android client calls this endpoint on sign-out and on
switching notifications off, in that order and before the credential goes, for
the reason written at the call site: **the row has to go before the credential
does, or the next person to hold this phone gets the last one's
notifications.** Leave this edit out and that is exactly what happens: sign out,
hand the phone over, and the previous account's DM pushes keep arriving on it.

The fix is to widen the delete rather than add a parallel route, because the
client sends only a token and the server cannot tell the platform from it:

```sql
DELETE FROM push_subscriptions
 WHERE user_id = $1 AND token = $2 AND platform IN ('apns', 'fcm')
```

Still scoped by `user_id`, so nobody can delete another account's row, and
`platform IN ('apns', 'fcm')` keeps a `web` row (whose token is null) out of
reach. Renaming it to something like `deleteDeviceSubscription` says what it now
covers. **No client change is needed**: the Android client already sends
`?token=`, the same shape iOS does.

**Deploying this drops every live voice call**, because `server/` redeploys the
API. It is not urgent and should ride along with something else.

### What Rafael has to create

Nothing in this repo can produce these, and none of them may be invented:

1. **A Firebase project** on the Google account that will own it, with an
   **Android app** added to it. It needs **two** package names registered, since
   debug builds carry a suffix: `gg.pqp.app` and `gg.pqp.app.debug`.
2. **`google-services.json`**, downloaded from that project, dropped at
   `android/app/google-services.json`. It is **gitignored** (it names a live
   project on somebody's billing account, and this repo is public), and its
   absence is what keeps the whole surface switched off.
3. **A service account key** for the same project, with the Firebase Cloud
   Messaging API enabled, for the server's `FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL`
   / `FCM_PRIVATE_KEY`. Those are Fly secrets and never go near the client.

Until (2) exists the app compiles, runs, and says so on the You screen. Until
(3) exists the server answers `fcm: false` and the client offers no toggle.

### How the client is gated

The same posture as the web client's analytics: absent config means the feature
is absent, not broken.

`app/build.gradle.kts` applies the `com.google.gms.google-services` plugin
**only when `google-services.json` exists**, because the plugin fails the build
outright when it does not, and turns that into a `BuildConfig.PUSH_AVAILABLE`
flag the Kotlin side reads. `firebase-messaging` is a dependency either way: it
compiles and links with no config, and every call into it is behind the flag.
With no config Firebase logs `FirebaseApp initialization unsuccessful` once at
launch and nothing else happens.

The second gate is the server's. `GET /api/push/config` has no `fcm` member
today, so `PushServerConfig.fcm` defaults to false, the switch is disabled and
says "This server cannot send notifications to Android yet." The day the server
answers `fcm: true`, already-installed builds start offering it with no client
change.

### What the client does

| Piece | Where |
|---|---|
| Route parsing, shared vocabulary with the web worker and iOS | `push/DeepLink.kt` |
| The FCM data frame | `push/PushMessage.kt` |
| Whether to draw, and what is on screen | `push/PushPresentation.kt` |
| The tray, the channel, the tap intent | `push/PushNotifier.kt` |
| Token, registration, session and foreground tracking | `push/PushController.kt` |
| The FCM entry point | `push/PqpMessagingService.kt` |
| The switch on the You screen | `push/PushSettings.kt` |

**Notification channel ids** are a shared surface, so they are namespaced:
`pqp.messages` (mentions, replies, DMs; IMPORTANCE_HIGH) is this feature's, and
the only one it creates. `voice` belongs to `VoiceService` and its ongoing
`category=call` notification. The two must never converge: they want opposite
settings, and a ringing-call push would want a third id rather than either.

**Mute, notification level and do-not-disturb are not re-decided here.** All
three are settled server-side at send time, in `shouldPush`, because the client
that would normally suppress an interruption is by definition not running. The
one decision the client makes is local: is the person already looking at this.

**That check cannot repeat the web client's #79 bug.** The frame is
self-describing: the channel id and the server id are parsed out of the push's
own `path`, with no reference to any channel list the app happens to hold. That
was the actual fault in #79 (the server id was discarded and recovered from a
directory that only ever held the selected server's channels), and there is no
directory here to miss. The second half is that "visible" means foregrounded
**and** parked on that channel: `ChatScreen` reports through a
`LifecycleStartEffect`, so a chat sitting in the back stack behind a locked
screen does not count as being read.

### What is verified, and what is not

Verified on an emulator (API 37, Play Store image), against a live local server,
with a debug-only receiver (`src/debug/.../PushDebugReceiver.kt`) that feeds a
frame into `PushController.onMessageReceived`, the exact method
`PqpMessagingService` calls, with the data map the server's FCM leg would send:

- A push for a channel not on screen draws one notification on `pqp.messages`,
  id 2, tagged with the channel id, `category=msg`, importance 4.
- Tapping it lands on that channel, titled `#general`, with the channel list
  behind it.
- The same push while that channel is open draws **nothing**.
- A push for a different channel, while the first is open, still draws.
- The same push with the app backgrounded draws, which is the case a stale
  "visible channel" would silently swallow.
- 21 unit tests over the route parser and the presentation rule. Neutering the
  foreground guard fails exactly the test that names it.

**Not verified, and not verifiable here: FCM itself.** No Firebase project
exists, so there is no registration token, no delivery, and no round trip. Every
line above the transport is exercised; the transport is not. Do not write
"Android push works" until a real device has received a real message from a real
server.

Also unbuilt: no toggle for `dmDetails` (the server owns it and the client only
reads it), no ringing-call notification, and no notification actions such as
reply or mark-as-read.

## The connection check

"Fica conectando" (2 Sep 2026): one person, the PC app and the phone app, two
networks, and a spinner on both while the API was healthy for everybody else.
From the client that could have been a refused session, a token fetch that
never returns (Clerk behind a DNS filter), a firewall that lets HTTPS through
but not WebSockets, or a network with no path to a TURN relay. All four look
identical on screen. The web shipped a check that tells them apart (#187,
`client/src/lib/connection-doctor.ts`); this is the Android half of it.

**Where it is.** Two entry points. The connection strip, which is now app-wide
(`ui/components/ConnectionBanner.kt`, mounted in `PqpApp` under the call bar)
rather than a strip inside the chat screen alone, so somebody stuck on the home
screen sees it too. It carries **Tentar agora** and **Verificar conexão**, and
after two refused connects in a row swaps its wording and offers **Entrar de
novo**. And Settings, under **Voz**, because a call is what people notice
failing first and the banner is only on screen while the socket is down.

**What it checks.** Five bounded steps, each result shown as it lands
(`core/ConnectionDoctor.kt`): `GET /health` over HTTPS (any status counts; the
question is reachability, and a 503 is a real answer with a real code); a
session token from the provider within eight seconds; the realtime socket as
`RealtimeClient` sees it, with the last close code and reason; a STUN probe
(server-reflexive candidate, against the API's list or a public fallback); a
TURN probe with the transport policy set to relay only, so the only candidate
that can appear is one that went through the relay. The two ICE probes use a
throwaway `PeerConnectionFactory` with a data channel and no media
(`voice/IceProbe.kt`), so they work with no call up and do not disturb one that
is. The verdict rules and the advice strings are the web's, key for key, so a
report from either app reads the same in the QG.

**The report.** **Copiar relatório** puts plain text on the clipboard in the
web's `formatReport` shape: a header with the timestamp and app version, one
line per check (`OK ` / `FAIL` / `SKIP`, the check id, a short detail, the
milliseconds), the advice, and the Android version and device model where the
browser puts its user agent. It never contains the token, a relay credential
or a URL; the details are fixed words (`present`, `null`, `timeout`) rather
than the thing itself, and a test pins that.

**What changed underneath, and why.** A `4401` close used to end the reconnect
loop for good, on the theory that a refusal needs a human. It mostly does not:
the server closes 4401 for an auth frame that arrived late (a slow network),
and for a token Clerk would not verify, which on a phone is usually one that
expired between `currentToken()` and the handshake, because the device was
asleep. Both are fixed by the next attempt with a fresh token, which is what
the web does. Android now does the same: 4401 and a null token both count
toward `unauthorizedStreak`, retry on the throttled schedule (five seconds and
up, the same as a 4429, so a genuinely dead session is not hammered), and two
in a row is the cue for the banner and the check to say **sign in again**
rather than **wait**. `ready` clears the count; an ordinary drop between two
refusals leaves it alone. A call held through a single refusal is rebuilt on
the next `ready` like any other drop; two refusals hang it up
(`VoiceController`). Pinned by `UnauthorizedStreakTest` and
`ConnectionDoctorTest` on the JVM; the ICE probes themselves are not, since
they need the native WebRTC library.

**Not verified on a device yet.** The change was written on a machine with no
Java runtime, so CI is the only thing that has compiled it. The probes should
be run once on a phone on mobile data and once on a network known to block
UDP, and the report compared with the web's from the same network, before
anybody quotes the advice to a user.

## Invites: making one, and the https links that open the app

Before this, an Android user could redeem an invite but could not produce one:
the answer to "how do I get my friend in" was "ask somebody on a desktop".
Both halves are here now.

**Making one.** The overflow menu on a community row has *Invite people*, which
opens a sheet over the three routes the web's `invite-panel.tsx` already uses:
`GET /api/servers/:id/invites` to list, `POST` the same path to make one,
`DELETE /api/servers/:id/invites/:inviteId` to revoke. Copy puts the link on the
clipboard; Share hands it to the system share sheet (`Intent.ACTION_SEND`), so
where it goes is the phone's business.

The two permissions are not the same, and the sheet is shaped around that.
Listing needs MANAGE_SERVER; creating needs CREATE_INVITE, which every member
has by default. So a plain member opens the sheet to an empty list and a working
button, and the 403 from the list call is swallowed rather than shown: it is not
an error, it is the role. Every other refusal is printed in the server's own
words, because only the server knows which refusal it was.

**The link is the web's link.** `InviteLinks.link` builds
`https://pqp.gg/app/invite/<code>`, the exact string `inviteLink` in
`client/src/components/layout/invite-panel.tsx` builds. That matters because it
is also the path the manifest claims and the path `DeepLink` parses back, so
three places have to agree on one shape. `InviteLinksTest` asserts the round
trip (build a link, parse it, get the same code back) rather than the string, so
a change in either half fails a test instead of a friend's tap.

The origin is a build input (`pqp.appUrl`, defaulting to `https://pqp.gg`) and
it does **not** follow `pqp.apiUrl`. A debug build talks to `localhost:3001`
through `adb reverse` and still shares `https://pqp.gg/...` links, because the
person receiving the link has no tunnel to the laptop.

### App Links

`https://pqp.gg/app/invite/<code>` is claimed by an `autoVerify` intent filter,
the Android twin of iOS's `applinks:pqp.gg`. Only that path prefix is claimed.
Claiming `/app` would swallow every pqp.gg link somebody taps into an app that
has no screen for most of them.

`MainActivity` is `singleTask` now. A notification tap already asked for
SINGLE_TOP on the intent it built; a browser's VIEW intent cannot be asked to,
and without this a link tapped while the app was running would stack a second
`MainActivity`, with a second NavHost and a second call bar, on top of the
browser's task. Cold start and warm start both end in
`PushController.onActivityIntent`, which is the one place that reads
`intent.data`, consumes it and parks a target for the NavHost to pick up.

**The web half is `client/public/.well-known/assetlinks.json`.** It has to list
the SHA-256 of the certificate that signs the APK a person actually installed.
That APK is the sideload build, signed with a key that lives in Actions secrets
and has never existed on any laptop, so the value cannot be computed from a
checkout.

The value committed is read from the artifact itself, which is the one source
that cannot be wrong about what people have installed:

```bash
curl -sL -o pqp.apk https://github.com/rafaelcg/pqp/releases/download/android-beta/pqp.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs pqp.apk
# Signer #1 certificate SHA-256 digest: cdd20531...  (colon-separate it, upper case)
```

The Android workflow reads the fingerprint back off the signed artifact and
checks it against `SIDELOAD_CERT_SHA256`, pinned at the top of
`.github/workflows/android.yml`, in the *Verify the sideload signature* step;
it also puts it in the job summary under *Sideload signing certificate*. A
build signed by anything else is red. Nothing about the number is secret: a
certificate fingerprint is public by construction, every installed APK exposes
its own.

`sha256_cert_fingerprints` lists **two** keys, and the order is the point. The
first is the durable sideload key from Actions secrets, which is what every
build now signs with and what the workflow verifies. The second is the
throwaway debug key that a build signed while the keystore lived in an
`actions/cache` entry, before the durable key existed: GitHub evicts a cache
after seven days without a hit, so a quiet week rotated the signing key and the
0.3.0 publish went out signed by a stranger (see *Why the cache approach broke*
below). Testers holding that APK cannot update over it and have to reinstall,
but until they do, the second entry keeps their App Links verifying. Drop it
once nobody is on that build. A rotation is always added rather than swapped
while the old build is still out there.

With the right fingerprint in place, the phone verifies at install and the link
opens the app with no chooser. With the wrong one, nothing breaks: the link
opens the web client in the browser, which is the same page, and a person who
wants the app instead turns on *Open supported links* for it in system
settings.

To check verification on a device:

```bash
adb shell pm get-app-links gg.pqp.app
# and to re-run it after fixing the file
adb shell pm verify-app-links --re-verify gg.pqp.app
```

*Not verified:* no device has yet opened an `https://` invite link into this
app, because that needs a real fingerprint in the deployed file. The parsing,
the sheet and the three routes are unit-tested and compile; the verification
handshake is the part that is still on paper.

## Your data: export and account deletion

**This is a Play Store submission blocker, not a nicety.** Google requires an
app that supports account creation to let the account be deleted from inside
the app, which is the same rule that held the iOS build at App Store Guideline
5.1.1(v) until build 12. Before this, `YouScreen` offered Sign out and nothing
else, and the only route to deletion on an Android phone was to email an
address and wait for somebody to run SQL by hand.

Nothing was needed on the server. `GET /api/me/export` and `DELETE /api/me`
have existed since the privacy policy promised them (LGPD art. 18, IV and VI),
and this is the same flow the web client and iOS use against the same
endpoints. `gg/pqp/app/account/` holds it, in its own package rather than as
more lines in `ui/screens`, and it is its own section on the profile screen
rather than a footer at the end of a scroll: the right to leave belongs
somewhere a person can find it on purpose.

### The confirmation rule lives in three languages, and must not drift

`AccountDeletion.confirmationMatches` is a Kotlin mirror of
`deleteConfirmationMatches` in `packages/shared/src/api.ts` and of
`ios/pqp/Sources/Core/AccountDeletion.swift`. Its whole job is that the button
lighting up and the request being accepted can never disagree: the server
refuses with a 400 when the typed value does not match, and a client that
enabled the button on a looser rule would produce a refusal the user could do
nothing about.

The fallback phrase for an account with no `name#1234` yet is
`delete my account`, **in English even in Portuguese**, because the server
compares against that exact string. It is drawn in a monospace face for the
same reason: it is a value to copy, not a sentence to read.

### The refusals are acted on, not printed

- **400**, the confirmation does not match. Cannot happen from this client,
  because the button is disabled until it does; the rule above is what
  guarantees that.
- **409**, `code: "owned_servers"`, the caller owns communities other people
  are in. The body lists them **by name** with a member count, and the screen
  renders them under *Do one of these first, for each community you own* with
  the two remedies. A delete button that fails silently on this is worse than
  no delete button at all, which is why `ApiException` now carries the whole
  refusal body rather than only its sentence.
- **502**, Clerk would not delete the identity. Nothing local was touched and
  retrying is safe; the server's own sentence says so and is shown verbatim.

### Export goes through the system file picker

The web client mints a blob URL and clicks an invisible link; iOS writes a temp
file and hands it to the share sheet. Android's own answer is
`ActivityResultContracts.CreateDocument`, which needs **no** `FileProvider`
entry in the manifest and no storage permission, and which lets somebody put the
file where they will find it again rather than where the app chose.

The bytes are fetched **before** the picker opens. The other order is a file the
user has already named and filed away that turns out to be empty.

### What is verified

On an emulator against a live local server:

- The export saved as `pqp-my-data-2026-08-26.json` through the system picker,
  4494 bytes, valid JSON, `format: "pqp.personal-data-export.v1"` with
  `account`, `messages`, `servers`, `conversations`, `blockedUsers`,
  `auditEntries` and `reportsYouFiled` present.
- *Delete for ever* stayed disabled for an empty field and for
  `dev_user_integ1#617`, one character short, and lit up on the exact tag.
- The 409 rendered the blocking community by name (*Integracao*, *2 other
  members*) with the remedy, rather than failing quietly.
- A throwaway account deleted itself for real: the app dropped to the sign-in
  screen and the `users` row and every `server_members` row for that id were
  gone from Postgres.

**Unverified:** the 502 path, which needs Clerk to refuse, and deletion under a
real Clerk session rather than the dev bypass. One dev-bypass artefact worth
knowing about: the bypass token is a fixed string that mints an account on any
authenticated request, so a socket that reconnects in the moment between the
delete returning and the sign-out landing creates a *fresh* account with the
same `clerk_id` and a new id. That cannot happen with Clerk, where the identity
itself is gone and no token works.

## The sideload signing key

The APK on the `android-beta` release tag, the one `pqp.gg/android` hands out,
is signed by a key that has to stay the same forever. Android refuses to install
an update over an app signed by a different key: the install simply fails, the
message a tester sees is not worth reading, and the only way out is to uninstall
and lose whatever the app kept on device. So the signing key is not an
implementation detail of the build, it is the thing that decides whether an
update is an update.

### Why the cache approach broke

CI used to sign the sideload variant with `~/.android/debug.keystore`, the
throwaway key the Android tooling generates on any machine that does not have
one, and keep the runner's copy alive between runs with `actions/cache` under
the stable key `android-sideload-debug-keystore-v1`.

That cannot be durable, and the reason is in GitHub's own rules: **a cache entry
is evicted after seven days without a read**. This workflow only runs when
`android/**`, `packages/shared/src/**`, `server/src/ws/**` or
`client/src/lib/peer-connection-manager.ts` changes. A quiet fortnight on the
Android side is completely ordinary, and every one of them silently threw the
signing key away. The next publish generated a fresh one, went out green, and
every tester holding an older APK simply could not update. Nothing in the build
noticed, because from the build's point of view nothing had gone wrong.

That is what happened to the 0.3.0 publish: the cache was gone, and the APK on
`android-beta` was signed by a key that had existed for about four minutes.

### What replaces it

A real keystore, generated once, held in repository secrets, and pinned by its
certificate fingerprint so it cannot change quietly again.

| Actions secret | What it holds |
|---|---|
| `ANDROID_SIDELOAD_KEYSTORE_B64` | `base64 -i pqp-sideload.jks \| tr -d '\n'`, one line |
| `ANDROID_SIDELOAD_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_SIDELOAD_KEY_ALIAS` | `pqp-sideload` |
| `ANDROID_SIDELOAD_KEY_PASSWORD` | the key password (the same value here) |

The key itself: PKCS12, RSA 2048, 10000 days, alias `pqp-sideload`, subject
`CN=pqp sideload, OU=pqp, O=pqp.gg, L=Sao Paulo, ST=SP, C=BR`. Certificate
SHA-256, which is public by construction and is what the assetlinks file below
publishes on purpose:

```
EE:28:41:C9:89:FD:20:0D:27:8B:32:D4:30:A3:63:A1:E7:D2:2E:20:0F:86:19:E2:82:D6:F0:6B:DA:46:BB:F3
```

`.github/workflows/android.yml` decodes the secret into `$RUNNER_TEMP`, hands
the path to Gradle as `PQP_SIDELOADKEYSTOREFILE` and friends, and then does two
things the old version could not:

1. **Refuses to publish without it.** On a `push` to `main` or a
   `workflow_dispatch`, an empty `ANDROID_SIDELOAD_KEYSTORE_B64` is an
   `::error::` and a failed job, not a fallback. A publish that breaks every
   tester's update should be a red build, not a green one.
2. **Reads the signature back off the artifact.** `apksigner verify
   --print-certs` on the built APK, compared against `SIDELOAD_CERT_SHA256`
   pinned in the workflow's `env:` block. Checking the artifact rather than the
   config is the only version of this check that would have caught the cache
   eviction, because the config was fine; it was the file underneath it that
   disappeared.

`android/app/build.gradle.kts` creates a `sideloadRelease` signing config only
when those inputs are present, and the `sideload` build type falls back to the
local debug key when they are not. So `./gradlew :app:assembleSideload` still
works on a laptop with no secrets and no keystore, and on a fork PR, which gets
no secrets at all. The fallback is a convenience for local builds only; the loud
check is in the one place it matters, the publishing run.

### The local backup, which is the only recoverable copy

GitHub Actions secrets are write-only. Once set, nobody, including the repo
owner, can read the value back. If the keystore is lost, it is lost, and every
tester uninstalls.

So it also lives at **`~/.config/pqp/android-sideload-keystore/`** on the
maintainer's machine (`pqp-sideload.jks`, `password.txt`, `README.txt`, all mode
0600). That directory is the durable copy. Back it up wherever the things that
cannot be regenerated are backed up. It is not in this repo and must never be:
no keystore, no password, in git, ever.

To build a signed sideload APK locally with it:

```bash
cd android
PQP_SIDELOADKEYSTOREFILE=~/.config/pqp/android-sideload-keystore/pqp-sideload.jks \
PQP_SIDELOADKEYSTOREPASSWORD="$(cat ~/.config/pqp/android-sideload-keystore/password.txt)" \
PQP_SIDELOADKEYALIAS=pqp-sideload \
PQP_SIDELOADKEYPASSWORD="$(cat ~/.config/pqp/android-sideload-keystore/password.txt)" \
./gradlew :app:assembleSideload
```

### App Links

`client/public/.well-known/assetlinks.json` has to list this fingerprint for
`https://pqp.gg/app/invite/<code>` to open the app instead of a browser chooser.
It is the same value as `SIDELOAD_CERT_SHA256`, in the same colon-separated
uppercase form. When the Play listing opens, the Play App Signing certificate
goes in that array **as well**, not instead: a store install and a sideload
install are different signatures and both have to be claimed.

### Rotating it, deliberately

Only for a real reason (a leak, or moving to Play signing). It costs every
tester a reinstall, the same as losing it, so it is not a tidy-up.

1. `keytool -genkeypair -v -keystore pqp-sideload.jks -storetype PKCS12 -alias
   pqp-sideload -keyalg RSA -keysize 2048 -validity 10000` in a directory
   outside the repo.
2. Replace all four `ANDROID_SIDELOAD_*` secrets (`gh secret set NAME --repo
   rafaelcg/pqp < file` keeps the value off your screen and out of your shell
   history).
3. Replace the copy in `~/.config/pqp/android-sideload-keystore/`.
4. Update `SIDELOAD_CERT_SHA256` in `.github/workflows/android.yml` **and** the
   fingerprint in `client/public/.well-known/assetlinks.json`. The verify step
   fails the build if you forget either.
5. Tell testers to uninstall and reinstall before they will get another update.

### The one-time cost of this fix

Every tester who installed a beta before this landed has an APK signed by some
evicted-cache key. The first correctly signed publish cannot update over it.
They uninstall pqp once, install the new APK from `pqp.gg/android`, and every
update after that is an ordinary in-place update.

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

Built and **verified between two clients**: direct messages, group
conversations, and the friends list. The detail, including which parts were
exercised and which were not, is in **Direct messages and the friends list**
above.

Built and **partly verified**: push. Everything downstream of delivery is
exercised on a device, including the guard that keeps a notification off a
channel already on screen; FCM delivery itself is not, because no Firebase
project exists and the server has no FCM leg. **Do not write "Android push
works"** until a real device has received a real message from a real server.

There are JVM unit tests over the pure parts worth pinning: the capture sizing
arithmetic, the stats parsing, deep-link parsing, push presentation, the chat
markdown grammar and who may edit, delete or pin. There
are still **no instrumented tests**, and nothing proves a new `stringResource`
has a Portuguese counterpart.

Built, unit-tested and **not yet exercised on a device**: chat markdown, edit,
delete, reply, the pinned list, mention autocomplete and the GIF picker. See
**Chat basics** above for what each one is and what would settle it.

Built and **verified against a live local server**: personal data export and
in-app account deletion, including the 409 that lists the communities blocking
deletion by name. The Play requirement is met. The detail, and the two things
about it that are not proven, are in **Your data** above.

### Media in a message

This is about **rendering**. Sending is its own section (**Attachments**
above) for files, and **Chat basics** for the GIF picker, which now exists here
too: a picker GIF may have come from any of the three clients.

- **GIFs animate.** They did not before `coil-gif` was added, and nothing said
  so: Coil decodes a still image with no help, so an `ImageLoader` with no
  animated decoder registered answers a GIF with its first frame and no error
  anywhere. Both attachment routes are covered, because both arrive as
  `image/gif` and go through the same decoder: the picker's (`POST
  /api/channels/:id/attachments/gif`, a row holding a GIF provider URL) and a `.gif`
  uploaded as a file, which since **Attachments** can now be uploaded from here
  too. `AnimatedImageDecoder` is registered from API 28 and `GifDecoder` below
  it, because `minSdk` here is 26 and the former is `@RequiresApi(28)`.
- **A pasted GIF link renders as the GIF**, the way
  `client/src/lib/gif-media.ts` does it, so a Tenor URL somebody typed does not
  read as a hundred characters of text on the phone and a picture everywhere
  else. The host allowlist is copied from `packages/shared/src/gifs.ts` into
  `ui/media/GifLinks.kt` and pinned against it by `MediaContractTest`.
- **Video plays, in the app.** Before this there was no player in the module at
  all, so a `video/mp4` fell through to the download chip: not broken, never
  written. It is a full-screen Media3 player opened by tapping the attachment,
  and the card itself fetches nothing until then, which is what `preload="none"`
  buys the web. The honest consequence is that there is no poster frame, since
  producing one means downloading the video to decide whether to download the
  video. The cheaper hand-off to the system player was rejected on two grounds:
  the read URL is presigned and expires, and `toPublicAttachment` signs
  everything that is not an image with `Content-Disposition: attachment`, so an
  external handler is as likely to download it as to stream it.
- **One player at a time**, and only while the dialog is open. A per-row
  `ExoPlayer` means a `MediaCodec`, a surface and a buffer per visible video in
  a `LazyColumn`, all bidding for the same audio focus as a call.
- **It costs 0.72 MB.** `media3-exoplayer` plus `media3-ui` plus `coil-gif`,
  measured as the difference between two shrunk release APKs rather than from
  the artifact sizes, on what was then a 55 MB APK that is mostly the WebRTC
  native libs. It is a 103 MB APK now: LiveKit ships a second, prefixed
  libwebrtc (`liblkjingle_peerconnection_so.so`, 47.6 MB compressed across the
  four ABIs) alongside the app's own. Play splits an AAB per ABI so a phone
  downloads roughly 12 MB more; the universal GitHub-beta APK carries all of it.
- **Audio attachments are still a download chip.** The web renders an `<audio>`
  element with `preload="none"`; this does not. That is the next obvious piece,
  and `MediaContractTest` pins it as a decision rather than an oversight.

**Not built:** a GIF picker, replies, editing, pinning, threads,
search, members and moderation surfaces, profile editing, communities, game
connections. No camera **to send**, no screen-share audio *out of* this device,
no speaking indicators, no per-peer volume, no push-to-talk. LiveKit rooms are
joined and can now be watched in: an incoming screen share renders, with the
presentation's sound, at a capped layer, and remote cameras render as a strip
of tiles under the call bar. No audio has been heard over that path from this
client and no SFU frame has been drawn on hardware. Publishing a screen stays
mesh-only.
`assembleRelease` is unsigned unless a Play upload keystore is provided
(see [`ANDROID_RELEASE.md`](./ANDROID_RELEASE.md)). The GitHub beta APK is
a separate `sideload` build type, debug-signed on purpose.
