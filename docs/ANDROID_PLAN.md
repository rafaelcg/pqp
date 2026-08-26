# Android plan: from PR #103 to a Play Store beta

Companion to [`ANDROID.md`](./ANDROID.md), which describes what the app **is**.
This describes what to **do next**, in what order, and, most importantly, **what
can be done at the same time by different people without trampling each other**.

Written for one maintainer with a handful of agents. A plan that assumes a team
is worthless here, so everything below is sized in solo evenings and ordered so
that cutting from the bottom always leaves something shippable.

## The three cut lines

| Line | Meaning | Rule |
|---|---|---|
| **A. Beta blocker** | Google Play will reject the release, or the app will embarrass itself in front of a tester, without it | Do all of it |
| **B. Parity** | The app is real but behind the iOS client | Do as much as fits |
| **C. Optional** | Nice, and nobody churns over it | Cut freely |

Android is **14% of the audience against iOS's 6%**, so line A is the whole
argument for this project: the reach is already there and there is nothing to
install. Line B is what stops the second week from being worse than the first.

**The one non-obvious thing on line A:** shipping a Join button that produces
silence is worse than shipping no Join button. Voice has never carried audio
(see `ANDROID.md` §What voice is verified to do). Either A7 lands or voice hides
behind a build flag for the first beta.

---

## Line A: Play Store closed beta

### A1. Release signing and Play App Signing
**What:** a real upload keystore, `signingConfigs.release` reading it from
`local.properties` or the environment, and the app registered for Play App
Signing. Today `assembleRelease` signs with the **debug key**
(`android/app/build.gradle.kts`, `buildTypes.release`), which Play refuses on
upload.
**Why:** hard blocker, and the package name and the signing key are both
permanent once the first APK is accepted.
**Size:** one evening. **Depends on:** nothing.
**Rafael only.** Do not let an agent generate or hold a keystore.

**Gradle half done, 2026-08-26.** `signingConfigs.release` reads
`pqp.keystoreFile` / `pqp.keystorePassword` / `pqp.keyAlias` / `pqp.keyPassword`
from `local.properties`, a `-P` flag or the environment, and **the debug-key
fallback is gone**: with no keystore `assembleRelease` now emits an *unsigned*
APK. That matters more than it sounds. The fallback meant a release build
printed BUILD SUCCESSFUL and produced an installable artifact, and the rejection
arrived days later at the Play upload. Verified end to end against a throwaway
keystore that was deleted immediately; `bundleRelease` produces the `.aab` too.
The keystore itself and the Console steps are in `ANDROID_RELEASE.md`, still
Rafael-only.

### A2. In-app account deletion and data export
**What:** a Settings row calling `DELETE /api/me` behind a confirmation, and
`GET /api/me/export`. Both endpoints already exist
(`server/src/api/index.ts:754`, `:1297`). Play also wants a **web** deletion
route, which `pqp.gg` can answer.
**Why:** Play's User Data policy requires in-app deletion for any app with
accounts. This was the exact blocker that held the iOS build back (see
`HANDOVER.md`, build 12), so it is a known, already-paid-for lesson.
**Size:** one evening. **Depends on:** nothing.

**Confirmed missing, 2026-08-26.** `YouScreen.kt` offers Sign out and nothing
else, and there is no `DELETE /api/me` or `GET /api/me/export` call anywhere in
`android/app/src/main/kotlin`. This is the single item on line A that is a hard
Play rejection rather than paperwork, and it is app feature code, so it belongs
to whoever holds `YouScreen.kt`. The web's confirmation semantics are in
`client/src/components/layout/settings-modal.tsx`; the expected confirmation
string is `expectedDeleteConfirmation(tag)` in `packages/shared/src/api.ts`.

### A3. Foreground service declarations in the Play Console
**What:** the FGS use case form for `microphone`, plus a demo video, plus the
privacy-policy link. `mediaProjection` gets added to the same form when B1
lands.
**Why:** since Android 14 an app declaring a foreground service type must
justify it in the Console or the release is rejected. This is paperwork that
blocks a build, which is the worst kind to discover late.
**Size:** half an evening. **Depends on:** A1.

### A4. Data safety form and store listing
**What:** data safety declarations (account data, microphone, later screen
content), plus listing assets: feature graphic, phone screenshots, short and
full description **in English and pt-BR**.
**Why:** blocker, and pt-BR is the actual audience.
**Size:** one evening. **Depends on:** A1.

### A5. Lower `compileSdk` and `targetSdk` to 36
**What:** change both in `android/app/build.gradle.kts` and delete
`android.suppressUnsupportedCompileSdk=37` from `android/gradle.properties`.
**Why:** AGP 9.3.2 has no metadata for API 37, so the build only works on a
machine that happens to have that platform installed and the warning suppressed.
That makes "it builds" a property of one laptop rather than of the repo, which
is exactly the failure the stale generated Xcode project caused on the iOS side.
Confirm Play's current target-API requirement in the Console before the first
upload; 36 should carry the next release window, but that deadline moves every
year and is not worth guessing at.
**Size:** minutes. **Depends on:** nothing. **Do it first**, because A6 cannot
be written until it is done.

**Done, as a "no", 2026-08-26.** 36 was tried and does not build: sixteen
dependencies floor at 37, including the whole Compose 2026.08.00 BOM,
`androidx.core:core:1.19.0`, `androidx.lifecycle:*:2.11.0` and
`okhttp-android:5.5.0`. Lowering `compileSdk` means downgrading all sixteen.
The half of the reasoning that was right is fixed properly instead: A6 installs
the platform by name, so "it builds" is a property of the repo rather than of
one laptop. `android.suppressUnsupportedCompileSdk` was deleted — AGP 9.3.2
knows API 37 and emitted no warning, so the flag was suppressing nothing and
would have hidden the next real one. See `ANDROID_RELEASE.md`.

### A6. `.github/workflows/android.yml`
**What:** the workflow already drafted in `ANDROID.md` §CI, path-filtered to
`android/**` so it can never block the API or web deploys. Add
`./gradlew :app:lint` and `:app:testDebugUnitTest` alongside `assembleDebug`.
**Why:** with several agents landing Android PRs, "BUILD SUCCEEDED locally" is
an unverifiable claim. Every Android PR from here should be gated by a build
that runs somewhere neutral.
**Size:** half an evening. **Depends on:** A5.

**Done, 2026-08-26.** Runs unit tests, lint, `assembleDebug` and an **unsigned**
`assembleRelease` (which is what proves R8 and the ProGuard rules survive
without the job ever holding a key). Path-filtered to `android/**` plus
`packages/shared/src/**`, `server/src/ws/**` and
`client/src/lib/peer-connection-manager.ts`, because B12's tests read those and
a protocol change has to be able to fail this build. Uploads the debug APK and
the reports.

### A7. Prove voice carries audio, or hide it
**What:** run the two-device runbook in `ANDROID.md` §What voice is verified to
do, with real TURN credentials on the API, or with two phones on one wifi.
Success criterion is **a human hearing another human**, not `CONNECTED` in
logcat and not "2 in this call" in the bar.
**Why:** the app currently reaches `connected` while no audio flows at all. See
also A8 and A9, either of which can produce the same silence for a reason that
has nothing to do with ICE.
**Size:** one evening, most of it environment. **Depends on:** TURN on the API,
which is a Rafael decision, not an agent task.

### A8. Default to the speaker, and let people change it
**What:** `VoiceController.acquireAudioFocus` sets
`AudioManager.MODE_IN_COMMUNICATION` and nothing else, which routes the call to
the **earpiece**. Add a route control (speaker / earpiece / bluetooth) via
`AudioManager.setCommunicationDevice` on API 31+, defaulting to **speaker** for
a group call, and surface it in `CallBar`.
**Why:** measure at the receiver. A call that is technically working but playing
into the earpiece of a phone lying on a desk is indistinguishable from a call
with no audio, and it will be mis-diagnosed as an ICE failure during A7. The
`BLUETOOTH_CONNECT` permission is already in the manifest and used by nothing.
**Size:** one evening. **Depends on:** nothing. **Do it before A7**, so A7 is
testing one variable.

### A9. Seven correctness bugs in the foundation
Each is small, each sits in a file another agent may be holding, so land them
early. Numbers 1, 2, 4, 5 and 6 were confirmed against `packages/shared`,
`server/src/ws/**` and the web client, not inferred.

1. **A call never rejoins after a socket drop.**
   `VoiceController.followConnection` sets `wasReady = wasReady && state == Ready`
   in its `else` branch, where `state` is by definition not `Ready`, so it always
   evaluates to false. `RealtimeClient.runLoop` always emits `Reconnecting`
   between two `Ready`s, so the `if (wasReady && wanted != null)` rejoin is
   unreachable code. Even if it fired, `join()` returns at its
   `channelId == channelId && isActive` guard, because nothing resets
   `VoiceState` when the socket drops. Meanwhile the server has already called
   `removeVoicePeerBySocket` on close, so the user is out of the call while the
   app shows a live one, with the foreground service and the microphone still
   running. `ChatViewModel.followConnection` has no such guard and is correct;
   the contrast is the tell. `ANDROID.md` states this rebuild as a working
   behaviour. It is not one.
2. **A send while the socket is down aborts the reconnect in flight.**
   `RealtimeClient.send` treats "not `Ready`" as "dead" and calls
   `socket?.cancel()`, but `socket` is non-null from the moment
   `newWebSocket()` returns, which is the whole handshake. So a send during a
   reconnect kills the attempt and bumps the backoff. Combine that with the next
   item and a person typing during a reconnect aborts one connect attempt per
   character and drives the backoff to its 30 second cap. The "reconnect rather
   than lie" rule is right; cancelling a socket that is merely not ready yet is
   not.
3. **A typing indicator is sent on every keystroke.**
   `ChatScreen`'s `onValueChange` calls `model.typing()` per character. The web
   throttles to one frame every 2.5 seconds (`TYPING_THROTTLE_MS` in
   `client/src/hooks/use-chat.ts`). The server absorbs the spam behind
   `typingLimiter` (capacity 5, refill 1/s, `server/src/ws/chat.ts:87`), so the
   damage is entirely to the client, via item 2.
4. **`voice-moderation` is not handled, and the microphone stays open.**
   `server/src/ws/voice.ts` sends `{type: "voice-moderation", action, ...}` to
   the target *before* removing the peer, and the removal broadcast goes to the
   remaining peers, so the evicted client never receives its own `peer-left`.
   `VoiceController.listen()` has no case for it. A moderator disconnecting an
   Android user therefore changes nothing on that phone: the roster freezes, the
   foreground service stays up and `RECORD_AUDIO` keeps capturing. The web
   handles this frame in `client/src/App.tsx`. **This is the one bug on this
   list that is a safety problem rather than a papercut.**
5. **Mute and deafen are lost on every join.**
   The server resets `muted` and `deafened` to false on join, with a comment
   saying the client re-declares right after `welcome`. The web does exactly
   that on every new peer id. Android only sends `set-voice-state` from
   `toggleMute` and `toggleDeafen`, and `onWelcome` re-applies mute locally
   without telling anyone. A muted Android user shows as unmuted in everybody
   else's roster, and joining muted is never announced at all.
6. **There is no ICE server fallback.**
   `VoiceController.join` does `runCatching { session.api.iceServers() }
   .getOrDefault(emptyList())`. The web merges the API answer on top of three
   default STUN hosts (`DEFAULT_ICE_SERVERS` in `peer-connection-manager.ts`),
   which the server also carries in `server/src/services/ice.ts`. On Android one
   failed or rate-limited call produces a peer connection with **zero** ICE
   servers: host candidates only, works on a LAN, dead everywhere else, and
   reported as an unreachable peer with no clue why. Pitfall #1 coming back in
   through a different door.
7. **A failed send silently eats what the person typed.**
   `ChatViewModel.send` removes the optimistic row when the frame did not leave,
   and `ChatScreen` has already cleared `draft`. Keep the row in a failed state
   with a retry, which is what the web and iOS do. Related: `send` returning
   true only means the frame left the phone. There is no `message-rejected`
   frame, so a message dropped server-side for a rate limit, a sanction or a
   missing permission leaves its bubble on screen forever. A client-side timeout
   is the only available compensation.

Two smaller ones to fold in while there, both currently latent rather than
live:

- `ChatViewModel.catchUp()` uses the newest message id as the `after` cursor,
  and an optimistic row's id **is a client-side nonce**. If a reconnect lands
  while a send is unacknowledged, the server answers `UnknownCursorError` with a
  400, `runCatching` swallows it, and the catch-up silently does not happen.
- `ApiException.isAgeGated` maps **every** 403 to the age gate. The server
  returns 403 for the age gate, the timeout sanction, ordinary permission
  refusals and character accounts. It is unreferenced today, so nothing
  misbehaves; it is a trap laid for whoever calls it next. The real
  discriminator is `GET /api/me`'s `ageGate`, which `SessionStore` already uses
  correctly.

**Size:** two evenings for all of it. **Depends on:** nothing.

### A9b. Finish perfect negotiation before anything renegotiates
**What:** port the rest of `client/src/lib/peer-connection-manager.ts` into
`VoiceEngine`: `makingOffer`, `ignoreOffer`, `setLocalDescription({type:
"rollback"})` on the polite side, `isSettingRemoteAnswerPending`, more than one
ICE restart, and the polite peer's restart fallback.
**Why:** the politeness *direction* is right (`local > remote`, and Kotlin and
JS agree on UTF-16 string ordering), but that is the only line of perfect
negotiation Android implements. `handleOffer` applies any offer
unconditionally; in `have-local-offer` libwebrtc fails the call and the only
reaction is a log line, so no answer is ever produced and the peer wedges in
`have-local-offer` forever. This is reachable **today, against the shipped web
client**, which offers from the polite side on screen share, camera,
`replaceLocalTrack` and its 4 second ICE-restart fallback. Concretely: Android
is impolite, fails, sends a restart offer; the web peer offers back; the web,
being polite, sets `ignoreOffer` and drops Android's offer; Android's
`setRemoteDescription` fails; neither offer is ever answered; Android has
already burned its single `restarted` flag so it never tries again, while the
web allows three. That leg is dead permanently.
**Size:** two evenings. **Depends on:** nothing, and **B2 cannot be correct
without it.**
**Note:** the file's own comment claims the rule "has to match
`peer-connection-manager.ts` exactly". It matches one line of it. Fix the
comment along with the code.

### A10. String and model plumbing that unblocks everyone else
See §Parallelisation. Splitting `strings.xml`, `Models.kt` and the `ApiClient`
endpoint list is a mechanical refactor with no behaviour change that removes
most of the merge conflicts the next month will otherwise generate.
**Size:** half an evening. **Depends on:** nothing. **Highest leverage item in
this document per minute spent.**

---

## Line B: parity with the iOS client

### B1. Receive a screen share
**What:** render a remote video track. `SurfaceViewRenderer` from the WebRTC SDK
inside an `AndroidView`, an `EglBase` shared with the `PeerConnectionFactory`,
and a call stage that shows the presenter.
**Why:** this is the feature the marketing already sells. `/beta` was rewritten
on 2026-08-25 to promise *watching* somebody else's share from the phone,
because that is what people away from a desk want. Android cannot do it today,
so the page is currently writing a cheque this app does not cash. It is also
strictly less work than sending, and it is the only way to verify sending later.
**Size:** two evenings. **Depends on:** A7 (a video track needs a working
transport).

### B2. Send a screen share via `MediaProjection`
**What:** the five steps in `ANDROID.md` §Screen sharing, plus the piece that
document does not mention: **the mesh has no renegotiation path**.
`VoiceEngine.onRenegotiationNeeded` is `Unit`, and only the impolite peer ever
creates an offer, so adding a track mid-call produces nothing on the wire. The
web client does manual per-peer renegotiation (`PLAN_STATUS.md`, Screen share:
"mesh: second video track + manual renegotiation per peer"); that mechanism has
to be ported before a track can be added to a live call from either side.
**Why:** the largest single capability win available. No mobile browser
implements `getDisplayMedia`, so this is something only a native Android app can
ever do, and it is something no pqp client on a phone has at all.
**Size:** three to four evenings, most of it renegotiation rather than capture.
**Depends on:** B1, A7 and **A9b**.
**Measure at the receiver:** the acceptance test is a second device *seeing* the
share at a known resolution, read off the receiver's `RTCInboundRtpStreamStats`
`frameWidth`/`frameHeight`. "We asked for 720p" is not "720p arrived", and
"we set a bitrate ceiling" is not a resolution at all. That confusion already
shipped a broken quality selector to production on the web.

### B3. DMs and friends
**What:** the DM list, group DMs, friends, and a DM channel that reuses
`ChatScreen`.
**Why:** on iOS this is a whole home tab (`ios/pqp/Sources/Home/`). Without it
the Android app is a server browser, and a person with no server has an empty
app.
**Size:** three evenings. **Depends on:** the navigation decision (see
§Decisions, D4). Do not start until that is settled.

### B4. Push via FCM
**What:** a third leg of `server/src/services/push.ts`. The server side already
has the shape: `PushPlatform` is `"web" | "apns"`, one
`POST /api/push/subscriptions` route with a zod union body, one
`push_subscriptions` table with a `platform` discriminant and a CHECK
constraint, and a payload that already carries a client-neutral `path`. Adding
Android is a third enum value, an `fcm.ts` sibling to `apns.ts` (FCM HTTP v1
uses a service-account JWT, structurally the same as the APNs provider JWT), a
third branch in `deliverToUsers`, and a third member of the union. Client side:
a `FirebaseMessagingService`, a notification channel per category, and token
registration.
**Why:** a chat app that cannot tell you something happened is a website.
**Size:** three evenings, split roughly half server and half client.
**Depends on:** nothing technical, but see D3: **this task cannot be done
without editing `server/` and `packages/shared/`.** Any rule to the contrary has
to be lifted for this one PR, explicitly, or the work will be faked.

### B5. Attachments
**What:** the photo picker, the presigned PUT, the claim, and image rendering in
`MessageRow` (which already draws them when they arrive).
**Why:** people send pictures. iOS is JPEG-only from the photo picker and it is
still the more-used half.
**Size:** two evenings. **Depends on:** nothing.

### B6. Message actions: reply, edit, delete, react
**What:** a long-press action sheet on `MessageRow`. The models already carry
`replyTo`, `editedAt` and `reactions`; nothing renders or sends them.
**Size:** two evenings. **Depends on:** nothing.

### B7. Invites and the `pqp://` deep link
**What:** the manifest already registers the `pqp` scheme, and **nothing reads
`intent.data`**. Tapping an invite link today opens the app to the server list
and loses the invite. Add intent handling, `onNewIntent`, a pending-invite stash
like `ios/pqp/Sources/Core/PendingInvite.swift`, and invite create/redeem.
**Why:** it is how anybody gets into a server, and the manifest is currently
advertising a capability the app does not have.
**Size:** one to two evenings. **Depends on:** navigation (D4).

### B8. Members, kick, ban, block, report
**What:** the member list and the moderation actions iOS has.
**Why:** an instance with no moderation reachable from the phone pushes every
report to the desktop.
**Size:** two evenings. **Depends on:** navigation (D4).

### B9. Speaking indicators and per-peer volume
**What:** `RTCAudioTrack` level polling or `audioLevel` from `getStats`, and a
per-peer gain control.
**Why:** without a speaking indicator, a silent call and a working call look
identical, which is the same class of problem as A8.
**Size:** one evening. **Depends on:** A7.

### B10. Survive a network change
**What:** a `ConnectivityManager.NetworkCallback` that triggers an ICE restart,
and removal of the one-restart-forever cap in `VoiceEngine.Peer.restarted` when
the trigger is a network change rather than a plain failure.
**Why:** wifi to mobile data is the normal case on a phone, and today the first
handover ends the call permanently with no path back.
**Size:** one evening. **Depends on:** A7.

### B11. The frames nobody reads yet
The server sends these and Android has no case for any of them:
`presence-update`, `channel-activity`, `reaction-broadcast`, `profile-update`,
`thread-update`, `sanction-notice`, `friend-activity`, `permissions-update`,
`screen-share-denied`, `call-incoming`, `call-ring-cancelled`, `call-declined`.
Most are feature gaps that resolve themselves as B3, B6 and B9 land. Two are
worth naming separately: `sanction-notice`, because a timed-out person's
messages are dropped in silence and their bubbles stay on screen, and
`screen-share-denied`, which B2 must handle since the server enforces
`SCREEN_SHARE_LIMIT` (2 on mesh, 4 on LiveKit).
**Size:** half an evening each, alongside their feature.

### B12. A protocol test that fails when the server moves
**What:** JVM unit tests under `android/app/src/test` that decode a recorded
sample of every inbound frame and every model, and encode every outbound frame.
There are currently **zero tests** in the module.
**Why:** there is no codegen and no shared contract, so every wire fact is a
hand-copy: each frame type string in three files, the politeness rule in two
places, close codes `4401` and `4429`, `DEV_AUTH_TOKEN` and its suffix alphabet,
`limit.coerceIn(1, 100)` standing in for `MESSAGE_PAGE_MAX`, the age-gate
literals, the transport name, and both channel enums. A `when` on a String
ignores an unknown type, which is the right policy and also means a **renamed**
type is ignored just as quietly. Worse, `ChatViewModel.message()` and
`VoiceController.participant()` wrap their decodes in
`runCatching { }.getOrNull()`, so a shape change drops the message with no log
at all. Tests are the only thing standing between that and a silent regression.
**Size:** one evening. **Depends on:** A6, so they actually run somewhere.

**Done, 2026-08-26.** 71 tests in `android/app/src/test/kotlin`. They do not
assert Kotlin constants against themselves: `WireProtocolTest` and
`ModelShapeTest` parse `packages/shared/src/*.ts` off disk, `PolitenessTest`
parses `isImpolite` out of the web client, and the close codes come from
`server/src/ws/index.ts`. Mutation-checked — inverting the politeness rule,
misspelling `message-broadcast` and moving the page clamp each fail. One seam
was added to app code for it: `voice/Politeness.kt`, which is the rule that
`VoiceEngine` had written out twice, now written once and called from both
sites. What is **not** covered: nothing runs on a device, so no screen, no
service lifecycle and no media path is under test.

---

## Line C: cut freely

Threads, message search, pinning, roles and permissions UI (iOS has not ported
these either), communities directory, game connections, public profile viewer,
camera in voice channels, push to talk, GIF and emoji pickers, in-app sounds,
call rating, tablet and foldable layouts, LiveKit/SFU support, drag to reorder
channels, and the localisation checker script.

Two of these deserve a note rather than silence:

- **LiveKit.** LiveKit ships an Android SDK, so Android *could* join SFU rooms
  that iOS refuses. Do not do this yet. A room's transport is pinned for its
  lifetime, so the moment an Android client can join a LiveKit room, an iOS
  client in the same community cannot. That is a product decision about the
  whole instance, not an Android feature.
- **Camera in calls.** iOS put real work into a quality ladder (size *and*
  bitrate, per PR #104 and the fixes behind it). Porting the camera without
  porting that ladder produces the exact bug the web shipped. Either port both
  or neither.

---

## Parallelisation: what can be worked at once

This is the part that decides how many agents can run. Two rules:

1. **A file has one owner at a time.** Not a directory, a file.
2. **The contended files below are a queue, not a free-for-all.** They are small
   and every feature wants to touch them, which is what makes them the
   bottleneck rather than the feature code.

### The contended set (serialise, or refactor first)

| File | Why everything wants it |
|---|---|
| `android/app/src/main/AndroidManifest.xml` | permissions, services, intent filters |
| `android/app/src/main/kotlin/gg/pqp/app/ui/PqpApp.kt` | the whole navigation graph and every route |
| `android/app/src/main/kotlin/gg/pqp/app/PqpApplication.kt` | the hand-rolled DI graph |
| `android/app/src/main/kotlin/gg/pqp/app/core/SessionStore.kt` | owns the API client, the socket and session phase |
| `android/app/src/main/kotlin/gg/pqp/app/core/ApiClient.kt` | one method per endpoint, in one class |
| `android/app/src/main/kotlin/gg/pqp/app/core/Models.kt` | one file for every model |
| `android/app/src/main/res/values/strings.xml` and `values-pt-rBR/strings.xml` | every feature adds copy, in two files |
| `android/gradle/libs.versions.toml`, `android/app/build.gradle.kts` | every dependency |
| `android/app/src/main/kotlin/gg/pqp/app/ui/theme/Theme.kt` | appearance work only |

### A10 in detail: make four of those uncontended

Cheap, mechanical, no behaviour change, and it converts most future conflicts
into clean merges:

- **Strings.** Android merges every `strings*.xml` in a `values` folder. Split
  into `strings_voice.xml`, `strings_chat.xml`, `strings_dm.xml`,
  `strings_push.xml` in both `values/` and `values-pt-rBR/`. Two agents adding
  copy then never touch the same file. Add the missing `<plurals>` while there:
  `voice_participants` and `chat_typing_one` are formatted with `%d` and `%s`
  and read wrong at 1 in both languages, and pt-BR needs real plural forms. The
  project's own i18n standard (`docs/I18N.md`, `_one` / `_other`) is not being
  met here.
- **Models.** Keep `Models.kt` for the core session, servers, channels and
  messages. New features get `DmModels.kt`, `SocialModels.kt`, `PushModels.kt`.
- **`ApiClient`.** Move per-feature endpoints out to extension functions in
  their own file (`suspend fun ApiClient.friends(): List<Friend>` in
  `core/SocialApi.kt`). The `execute` / `decode` plumbing stays put and stops
  being edited.
- **Navigation.** Give each feature a `NavGraphBuilder.dmGraph(...)` extension
  in its own file. `PqpApp.kt` then gains **one line** per feature instead of a
  block, which is a conflict a human resolves in seconds.

`AndroidManifest.xml`, `PqpApplication.kt` and the Gradle files stay contended.
That is acceptable: the edits are a few lines each and conflict resolution is
mechanical. Just do not have two agents editing them in the same hour.

### Work streams that are genuinely file-disjoint

| Stream | Owns | Contends on |
|---|---|---|
| **Voice + screen share** (A7, A8, A9.1, A9.4, A9.5, A9.6, A9b, B1, B2, B9, B10) | all of `gg/pqp/app/voice/**`, `ui/components/CallBar.kt`, new `ui/voice/**` | manifest (`mediaProjection` type, `FOREGROUND_SERVICE_MEDIA_PROJECTION`), strings, `libs.versions.toml` |
| **DMs and friends** (B3) | new `ui/screens/dm/**`, `core/SocialApi.kt`, `core/DmModels.kt` | `PqpApp.kt` navigation, `ApiClient`, strings |
| **Push** (B4) | new `push/**`, `server/src/services/fcm.ts` | manifest (service + `POST_NOTIFICATIONS`), `build.gradle.kts` (Google services plugin), `server/` and `packages/shared/` |
| **Chat depth** (A9.2, A9.3, A9.7, B5, B6, B12) | `ui/screens/Chat*.kt`, `core/Attachments*.kt` | `ApiClient`, `Models.kt`, strings |
| **Release engineering** (A1, A3, A4, A5, A6) | `.github/workflows/android.yml`, Play Console | `build.gradle.kts`, `gradle.properties` |
| **Account and settings** (A2, B7, B8) | `ui/screens/YouScreen.kt`, new settings screens, `MainActivity` intent handling | `PqpApp.kt` navigation, `ApiClient`, strings |

### The dangerous overlaps, stated plainly

- **Voice + screen share vs push:** both edit `AndroidManifest.xml`, and both
  add a foreground service concern. Land the voice stream's manifest edit first.
- **DMs vs account/settings:** both add navigation destinations in `PqpApp.kt`.
  Settle D4 before either starts, or the second one rewrites the first.
- **Push vs everything:** it is the only stream that leaves the `android/`
  directory. It touches `server/` and `packages/shared/`, which every other
  Android PR is forbidden from doing, so it needs its own explicit exemption and
  should be reviewed as a server change that happens to have a client.
- **Chat depth vs DMs:** both want `ChatScreen`. DMs should *reuse* it, not fork
  it, which means chat depth lands first or DMs takes the file.
- **`ChatViewModel.onCleared` calls `leaveChannel()` unconditionally**, and
  `leaveChannel` clears the client's single global `subscribedChannelId`. Once
  two chat surfaces can exist (DMs, threads, a pager), this unsubscribes the
  wrong one. Whoever touches channel subscription second inherits this bug, so
  fix it in the chat stream first.

### A sane three-agent setup

Three streams that can run today with no shared file, assuming A10 has landed:

1. Voice and screen share.
2. Chat depth (message actions, attachments, the two chat bugs in A9).
3. Release engineering (A5, A6, then A1 with Rafael).

DMs and push both wait: DMs on D4, push on D3.

---

## Decisions for Rafael, not for an agent

**D1. Does voice ship in the first beta at all?**
If A7 has not produced a human hearing a human by upload day, hide the Join
button behind a build flag. A silent call is a one-star review and a story that
follows the app.

**D2. Play Console account type and the tester rule.**
A personal developer account opened after November 2023 must run a closed test
with a minimum number of opted-in testers for 14 continuous days before it can
go to production. Read the current wording in the Console rather than trusting
this sentence; the rule has already changed once.
That is a calendar dependency, not an engineering one, and it should be started
the day A1 lands even if the app is half-built.

**D3. May the push PR edit `server/` and `packages/shared/`?**
It has no choice. `PushPlatform` is `"web" | "apns"` today, the subscriptions
route's zod body is a two-member union, and `push_subscriptions.platform` has a
CHECK constraint. Android push is impossible without changing all three. Decide
this before the push agent opens a PR, because the alternative is an agent
inventing a client-only workaround.

**D4. Navigation shape: drill-down or bottom bar?**
Today it is Servers to Channels to Chat, a three-level drill-down. iOS has a
home with communities, DMs and profile side by side. DMs cannot be bolted onto
a drill-down without answering this. The Android-native answer is a
`NavigationSuiteScaffold` or a plain `NavigationBar` with Servers / DMs / You,
which also earns the tablet layout for free later. It is a one-file change now
and a rewrite after DMs land.

**D5. `compileSdk` 37 or 36?**
Recommend 36. See A5. Costs nothing and makes the build reproducible off one
laptop.

**D6. Screen share: receive first or send first?**
Recommend receive. It is cheaper, it is what `/beta` already promises, and it is
the only honest way to verify sending.

**D7. TURN credentials for the API.**
A7 cannot complete without them, or without two phones on one wifi. This is the
same pitfall #1 that has now cost time on three clients.

**D8. Package name.**
`gg.pqp.app` matches the iOS bundle id, and Play fixes it permanently on first
upload. Confirm before A1, not after.

---

## Rough shape of the schedule

Assuming evenings, and that line A comes first because it is the part with a
calendar in it:

| Week | Line A | Line B in parallel |
|---|---|---|
| 1 | A5, A10, A6, A9, A9b, A8 | B1 starts |
| 2 | A1, A2, A3, A4, A7 | B1 finishes, B5 and B6 |
| 3 | closed test opens (D2) | B2, B3 |
| 4 | first production candidate | B4, B7 |

Three weeks to rough iOS parity, as `ANDROID.md` estimates, holds only if line C
stays cut and if D3 and D4 are answered in week one rather than discovered in
week three.
