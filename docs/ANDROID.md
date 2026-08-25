# Android app

A native Kotlin + Jetpack Compose client in `android/`. It talks to the same
server as the web and iOS apps: no mobile backend, no BFF, no protocol change.

**Read the state of it before quoting it.** Auth, servers, channels, text chat,
direct messages and the friends list are built and verified end to end against a
live local server. Voice negotiates between two clients and its media path is
unproven. Screen sharing is not built. The honest boundaries are in **What is
real** at the bottom.

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
2. Voice with a foreground service. **Built, and negotiating; the media path is
   unproven for an environment reason. See the caveat.**
3. Screen sharing via `MediaProjection`. **Not started, and the biggest win.**
4. Push via FCM, as the third leg of `server/src/services/push.ts`. **Client
   built; the server leg is specified and unwritten, and it needs a Firebase
   project that does not exist. See the push section below.**
5. DMs and the friends list. **Done, and verified between two clients.**
6. Attachments, reactions, invites, everything on the parity list.

If time runs short, cut from **6 upward**. The one thing not to cut is 3: it is
the only feature on this list that no pqp client on a phone has at all.

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

That account is `dev_local_user_bob`. Debug builds only. Two emulators from one
AVD need `-read-only` on **both**, which means restarting an already-running
one:

```bash
emulator -avd Pixel_10_Pro -read-only -port 5554 &
emulator -avd Pixel_10_Pro -read-only -port 5556 &
```

## Layout

| Path | What |
|---|---|
| `app/src/main/kotlin/gg/pqp/app/core` | Backend config, models, REST client, WebSocket client, session |
| `app/src/main/kotlin/gg/pqp/app/ui` | Compose screens, theme, shared components |
| `app/src/main/kotlin/gg/pqp/app/voice` | Mesh WebRTC engine, call state, foreground service |
| `app/src/main/kotlin/gg/pqp/app/social` | Friends, blocks, conversations: wire shapes, endpoints, the live repository |
| `app/src/main/kotlin/gg/pqp/app/social/ui` | The three-tab home, the inbox, the friends screen, the two people pickers |
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

**The politeness rule matches `client/src/lib/peer-connection-manager.ts`
exactly:** `isImpolite(local, remote) = local > remote`, so the peer whose id
sorts *higher* sends the initial offer. Invert it and two peers either both
offer (glare) or neither does (a silent deadlock where everyone sits in
`connecting`), and it looks fine until two *different* clients meet in one room.

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
- **A call is rebuilt, not resumed, after a socket drop.** The server drops the
  voice peer when the socket closes and a reconnect mints a *new* peer id, so
  every connection in the old mesh addresses a peer that no longer exists.
  `ready` tears it down and rejoins.

### The foreground service is the feature, not the plumbing

Android stops a backgrounded app's threads, and a foreground service with a
visible notification is the only sanctioned exemption. `VoiceService` is started
**before the microphone is touched**, because Android 14 and later refuse a
`microphone`-typed service started the other way round, and it holds no call
state: `VoiceController` owns the mesh and lives on the `Application`, so a
service restart cannot desynchronise the two. The service is `START_NOT_STICKY`,
because a call the system restarted without its signalling socket is a
notification with nothing behind it.

`POST_NOTIFICATIONS` is requested alongside `RECORD_AUDIO`. Only the microphone
gates the call, but a refused notification leaves a call running that nothing on
screen mentions.

Audio uses `MODE_IN_COMMUNICATION` with a `USAGE_VOICE_COMMUNICATION` focus
request, which is what routes sensibly, puts the volume rocker on the call
stream, and turns on the platform's echo cancellation.

### What voice is verified to do, and what it is not

Tested with **two emulators in one room** on two separate dev-bypass accounts,
which is the only arrangement that exercises anything a single client cannot.

Verified:

- The permission flow, and the foreground service coming up with
  `types=0x00000080` (`FOREGROUND_SERVICE_TYPE_MICROPHONE`) carrying an ongoing
  `category=call` notification with a Hang up action.
- `join-voice-room` out, `welcome` back, and both call bars reaching **2 in this
  call** with each other in the roster.
- **The politeness rule.** Exactly one side offered, the other answered, and
  both peer connections reached `CONNECTING`: no glare and no deadlock, which
  are the two ways the comparison can be wrong.
- **The ICE restart.** On failure exactly one side restarted (the impolite one),
  and both connections returned to `CONNECTING`.

**Not verified: audio actually flowing.** Both peer connections then went to
`FAILED`, and the reason is not the app: `GET /api/ice-servers` was serving
**STUN only**, because the local `.env` carries the placeholder `VITE_TURN_*`
values, and two emulators on one host are on separate NATs. That is pitfall #1
in `CLAUDE.md` word for word, reproduced. Everything up to and including the
candidate exchange is exercised; the media path is not.

What the failure produced, and this is the useful part: the call bar said "2 in
this call" while nobody could hear anybody. That is the exact shape of a voice
stack that looks finished and is not, so the engine now reports per-peer media
state and the bar says **Cannot reach everyone in this call** in the error
colour instead.

To settle the last step, with real TURN credentials in the API's `TURN_URL` /
`TURN_USERNAME` / `TURN_CREDENTIAL` (the `VITE_` spellings are read as a
fallback):

```bash
emulator -avd Pixel_10_Pro -read-only -port 5554 &
emulator -avd Pixel_10_Pro -read-only -port 5556 &
# on each: adb -s <serial> reverse tcp:3001 tcp:3001, then installDebug
adb -s emulator-5556 shell am start -n gg.pqp.app.debug/gg.pqp.app.MainActivity \
  --es pqp.devUser bob
```

Join the same voice channel from both. `adb logcat -s pqp.voice` must show
`peer <id> -> CONNECTED` on both, and neither bar may show the unreachable
line. Two devices on the *same* wifi would also settle it without TURN, since
host candidates route there.

Also unverified, and known-missing rather than broken: no speaking indicators,
no per-peer volume, no earpiece/speaker toggle, no push-to-talk, no camera, and
LiveKit rooms are refused rather than joined.

## Screen sharing: not built, and the point of the whole exercise

Nothing here captures a screen yet. It is the largest available win, because
**no mobile browser can share one**. `getDisplayMedia` is not implemented on
Android Chrome, so every pqp user on a phone today can watch a share and none
can start one.

Android makes it considerably easier than iOS did. `MediaProjection` runs **in
the app's own process**: no broadcast upload extension, no App Group, no Unix
domain socket carrying NV12 between two processes, none of the machinery
`ios/pqp/ScreenShare` exists to work around. The shape is:

1. `MediaProjectionManager.createScreenCaptureIntent()`, launched for a result.
   The consent dialog is the system's and must be triggered by the user.
2. A **second** foreground service type, `mediaProjection`, declared on the
   manifest and added to the `startForeground` call. From Android 14 the
   projection must be started *after* that service is already foreground, and
   from Android 15 consent has to be re-obtained for each capture session.
3. `ScreenCapturerAndroid` from the WebRTC SDK, into a `VideoSource`, into a
   track added to every peer connection, published under a stream id of
   `pqp-screen-…` so the far end classifies it (see `VoiceModel` on iOS and
   `sharingScreen` on `voiceParticipantSchema`).
4. `set-sharing-screen` on the socket so the roster carries it, and
   `SCREEN_SHARE_LIMIT` (2 on mesh, 4 on LiveKit) respected, since the server sends
   `screen-share-denied` past it.
5. Receiving is the mesh's ordinary video path and needs a renderer; the app has
   none today.

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

Six edits, in the shape the existing APNs leg already established. `apns.ts` is
the template throughout: FCM is the same job with a different envelope.

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

A **separate** index rather than widening the existing one.
`saveApnsSubscription` infers its arbitrating index by restating
`WHERE platform = 'apns'`, and inference against a partial index requires the
predicate to match exactly; widening the old index would break that insert with
"no unique or exclusion constraint matching the ON CONFLICT specification". The
FCM upsert restates `WHERE platform = 'fcm'` the same way.

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
      "priority": "HIGH",
      "ttl": "86400s",                  // CALL_PUSH_TTL_SECONDS for a ring
      "collapse_key": "<payload.tag>"   // same job as apns-collapse-id
    }
  }
}
```

The four `data` keys are the ones `buildApnsBody` already carries to iOS under
exactly those names, so the three clients keep one vocabulary.

A `notification` block would be drawn by the Firebase SDK on the tray without
ever waking the app, which takes away the one decision this client has to make:
whether the person is already reading the channel being announced. That is the
phantom "1 nova mensagem" bug (#79) in another costume, and on Android it would
be unfixable from the client. The price of data-only is that a force-stopped app
does not receive it and some OEM battery managers delay it. That trade is taken
deliberately: a late notification is a smaller failure than a wrong one.

**6. Wiring.** `isAnyPushEnabled()` gains `|| isFcmEnabled()`. `PushTransports`
gains an `fcm` leg and `readTransports` reads it. `deliverToUsers` gains one
branch, next to the APNs one, and that is the only place the platforms diverge.
`GET /api/push/config` gains `fcm: isFcmEnabled()`, and the POST route's
two-way `isApns ? ... : ...` guard becomes a three-way switch so a server with
no FCM config refuses tokens it can never send to. Prune the row on FCM's
`UNREGISTERED` and `INVALID_ARGUMENT`, which are its equivalents of APNs
`Unregistered` and a 410.

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

Built and **verified against a live local server on an emulator**: launch, the
dev-bypass session, the age gate, the server list with create and pull to
refresh, the channel list with categories and text/voice sections, the full
message round trip (join, send, broadcast, render, and the row persisted
server-side with a real id), reconnect handling, sign-out, and the two
languages.

Built and **partly verified**: voice. Signalling, roster, politeness and the ICE
restart are verified between two clients; audio flowing is not, for an
environment reason spelled out above. **Do not write "Android voice works"**
until somebody has heard somebody.

Built and **verified between two clients**: direct messages, group
conversations, and the friends list. The detail, including which parts were
exercised and which were not, is in **Direct messages and the friends list**
above.

Built and **partly verified**: push. Everything downstream of delivery is
exercised on a device, including the guard that keeps a notification off a
channel already on screen; FCM delivery itself is not, because no Firebase
project exists and the server has no FCM leg. **Do not write "Android push
works"** until a real device has received a real message from a real server.

**Not built:** attachments, reactions, replies, editing, pinning, threads,
search, members and moderation, invites, profile editing, communities, game
connections, data export and account deletion. There are no instrumented tests,
though there are unit tests under `app/src/test`. `assembleRelease` signs with
the debug key and needs a real keystore before it goes anywhere near Play.
