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
| `app/src/main/kotlin/gg/pqp/app/social` | Friends, blocks, conversations: wire shapes, endpoints, the live repository |
| `app/src/main/kotlin/gg/pqp/app/social/ui` | The three-tab home, the inbox, the friends screen, the two people pickers |
| `app/src/main/kotlin/gg/pqp/app/push` | FCM registration, the notification payload, deep links, per-channel settings |
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
arithmetic, the stats parsing, deep-link parsing and push presentation. There
are still **no instrumented tests**, and nothing proves a new `stringResource`
has a Portuguese counterpart.

Built and **verified against a live local server**: personal data export and
in-app account deletion, including the 409 that lists the communities blocking
deletion by name. The Play requirement is met. The detail, and the two things
about it that are not proven, are in **Your data** above.

**Not built:** attachments, reactions, replies, editing, pinning, threads,
search, members and moderation surfaces, profile editing, communities, game
connections. Invites can be redeemed from a link but not created or shown. No
camera (send or receive), no screen-share audio, no speaking indicators, no
per-peer volume, no push-to-talk. LiveKit rooms are refused rather than joined.
`assembleRelease` signs with the debug key and needs a real keystore before it
goes anywhere near Play.
