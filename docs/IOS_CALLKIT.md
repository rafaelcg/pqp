# iOS CallKit

A pqp voice call, a DM ring or a server voice channel, reports itself to
iOS's own telephony stack: system call UI on the lock screen, answer/decline
from there or from CarPlay, background/screen-off survival, and correct
`AVAudioSession` routing (Bluetooth, CarPlay, AirPods buttons) handed to the
OS instead of guessed at by the app. This is CallKit, and it is what makes a
pqp call behave like a phone call rather than a video-chat tab that happens to
be on a phone.

Read this alongside `ios/pqp/Sources/Voice/CallKitCoordinator.swift`, which is
the whole implementation in one file, and `docs/PARITY.md`'s "Background audio
while the app is hidden" row.

## What works today, with no server change

- **Outgoing report.** Placing a DM call (`CallModel.start`) or joining a
  server voice channel (`VoiceModel.join`) registers a `CXStartCallAction`
  with CallKit before the room itself connects. The lock screen and CarPlay
  show it as "Calling…"; `reportConnected` moves it to "Connected" the moment
  somebody else is actually in the room.
- **Incoming report.** A `call-incoming` frame arriving over the already-open
  WebSocket, the app running or backgrounded with the socket alive, reports a
  `CXCallUpdate` via `reportNewIncomingCall`. The system rings it with pqp's
  own caller name, on the lock screen, on a paired CarPlay head unit, and on
  Apple Watch. While CallKit is presenting the ring, the in-app
  `IncomingCallBanner` is **suppressed** rather than drawn alongside it: two
  incoming-call surfaces for one call is the "double ring" a caller saw (the
  system call pill with Accept/Decline *and* a separate in-app banner at
  once). The ring still lives in `CallModel.incoming` so a lock-screen
  answer/decline can find it; the presentation rule is `incomingCallBannerRing`
  in `CallState.swift`, driven by `CallModel.presentedByCallKit`, which
  `reportIncomingCall`'s completion fills. If CallKit *refuses* the report
  (Screen Time, every call slot in use, the simulator, or no coordinator), the
  in-app banner takes over as the fallback ring exactly as before.
- **Answer, end and mute, system to app.** `CXProviderDelegate`'s
  `performAnswerCallAction`, `performEndCallAction` and
  `performSetMutedCallAction` are the only door the lock screen, CarPlay,
  Apple Watch and Siri have into this app, and they call straight into
  `CallModel`/`VoiceModel` through one small protocol,
  `CallKitRoomHandling`. Answering from the lock screen joins the room the
  same way tapping the in-app banner does; ending from there leaves the room
  the same way the in-app Hang Up button does; muting from there, including an
  AirPods media-button mute (which CallKit turns into this same action), maps
  straight onto pqp's own mute.
- **Audio session handed to CallKit.** `RTCAudioSession.useManualAudio` is
  switched on once, at launch (`CallKitCoordinator.init`), which stops
  WebRTC's mesh engine from calling `AVAudioSession.setActive` itself.
  `VoiceClient.startAudio()` now skips that call under manual audio; the
  session only actually goes live in `provider(_:didActivate:)`, via
  `RTCAudioSession.audioSessionDidActivate(_:)`, the hook WebRTC ships
  specifically for a host that hands activation to something else. This is
  the classic CallKit mistake the brief called out: activate the session
  yourself ahead of CallKit, under manual audio, and you get two callers
  fighting over one `AVAudioSession`, with the losing side silent. If CallKit
  itself refuses the registration (a Screen Time restriction, every call slot
  already in use), the coordinator activates the session directly as a
  fallback, see `activateAudioWithoutCallKit`, so a refused report degrades to
  "no lock-screen card" rather than "no audio at all".
- **Configuration.** `supportsVideo = false` (CallKit's own chrome does not
  offer a video surface; the in-app camera button is untouched by this),
  `maximumCallGroups = 1`, `maximumCallsPerCallGroup = 1`,
  `includesCallsInRecents = true`, and a ringtone slot that picks up
  `ringtone.caf`/`.wav`/`.aiff` from the bundle the day one ships. There is
  none today, so CallKit falls back to its own.
- **Background modes.** `audio` and `voip` were already in
  `ios/pqp/Info.plist`'s `UIBackgroundModes` before this work (`docs/IOS.md`),
  and neither needed to change: `audio` is what lets the mesh's audio engine
  keep running with the screen off or the app backgrounded, `voip` is what a
  cold-start VoIP push (below) will need once the server leg exists. No new
  entitlement was required: CallKit itself does not gate on one, unlike Sign
  in with Apple or associated domains.

## What is gated on the server: cold-start incoming calls (PushKit)

Everything above only rings while this device already holds a live WebSocket,
the app foregrounded, or backgrounded with the socket still connected. A
phone that has been killed, or backgrounded long enough for iOS to suspend
the network connection, needs a **VoIP push** to wake it, and Apple's rule
for that push is absolute: the app's `PKPushRegistryDelegate` must report the
call to `CXProvider` **immediately**, synchronously, in the handler that
receives the push, with no `await` for a network round trip first. A build
that does not is terminated by iOS and, after repeated offenses, has its
ability to receive VoIP pushes revoked for the install.

### Client-side, built and flagged off

`PKPushRegistry` registration is not wired up in this PR. It needs the
server leg below to be worth anything (a client that asks iOS for a VoIP
push token with nowhere to send it is dead code), so it is left as a
follow-up rather than half-built behind a flag with no way to test it. When
it lands, gate it the way every other server-dependent capability in this
app is gated (`server.pushConfig()`, the same shape `PushDelegate` already
reads for ordinary APNs), so a deployment without the VoIP cert stays exactly
as it is today.

### Server contract for the follow-up PR

**Topic.** VoIP pushes use a **separate APNs topic** from ordinary
notifications: `gg.pqp.app.voip` (`server/src/services/apns.ts`'s
`APNS_DEFAULT_TOPIC` is `gg.pqp.app` today; a VoIP push is not "the same
topic with a different payload", it is a distinct topic Apple treats
differently for delivery priority and reliability). This needs either a
second APNs auth key scoped to the same team (the existing `APNS_KEY_ID` /
`APNS_TEAM_ID` / `APNS_PRIVATE_KEY` .p8 key can usually sign for any topic on
the team, so the same credential may already work; confirm against Apple's
docs for the auth-key flow specifically, which differs from the older
per-app-id certificate flow) or a **separate VoIP Services certificate**,
provisioned on the same App ID (`gg.pqp.app`) in the developer portal, which
is the traditional cert-based path and the one most existing guides assume.
Either way this is a new secret, not a rename of an existing one: do not
reuse `APNS_PRIVATE_KEY` silently for a topic Apple bills and rate-limits
separately.

**Payload.** A VoIP push is not required to carry `aps` at all, it can be a
bare custom dictionary, since `PKPushRegistryDelegate` receives it directly
rather than through the notification-center presentation path ordinary
`aps.alert` pushes go through. The minimum this app needs to report a call:

```json
{
  "conversationId": "<the DM/group channel id, same value call-incoming carries>",
  "callerUserId": "<caller's user id>",
  "callerName": "<display name, matches call-incoming.caller.displayName>",
  "callerAvatarUrl": "<optional>",
  "kind": "dm" // or "group", matches call-incoming.kind
}
```

Deliberately the same shape as `call-incoming`'s `caller` object
(`RealtimeClient.swift`'s `.callIncoming` decode): reusing it rather than
inventing a second shape for the same ring.

**Timing rule.** Send the VoIP push **only when `call-ring` would otherwise
reach nobody live**, i.e. exactly the population `sendCallRing`
(`server/src/ws/voice.ts` or wherever the ring fan-out lives; check the
current call site before wiring this) already computes as "not connected".
Sending it unconditionally, on every ring, double-rings anybody with the app
foregrounded (the socket's own `call-incoming` plus a VoIP push landing a
moment later), with no way for the client to de-duplicate a push that beat
the socket frame, since a VoIP push has no delivery-order guarantee relative
to a WS frame either way.

**Cancellation.** A ring that ends before it is answered (the caller hangs
up, the 45s timeout, the callee answers on another device) needs its own
push (or the client needs another way to know), because CallKit's own rule
means the call is ALREADY on the lock screen by the time the app's code runs
at all: `reportNewIncomingCall` cannot be un-reported by simply not acting on
it. The clean shape: mirror `call-ring-cancelled` as a second VoIP push
naming the same `conversationId`, and have the `PKPushRegistryDelegate`
report the call as `.reportCall(with:endedAt:reason:.unanswered)`
immediately on receipt, the same synchronous-report rule as the ring itself.

**Failure modes to handle before shipping this, not after:**

- **The push arrives after the ring already ended.** Ordering across a push
  gateway and a live socket is not guaranteed. If `reportNewIncomingCall`
  fires for a call the WS has already told this device is over, the app
  reports it and then immediately ends it (`reportCall(endedAt:.unanswered)`)
  rather than leaving a phantom ring on the lock screen for the timeout to
  clear.
- **No APNs VoIP cert configured.** Exactly like every other provider secret
  in this app (Steam, Twitch, TURN): missing means off, not 500. `push.ts`'s
  existing pattern, read the env and return `null`/skip silently when unset,
  is the one to copy.
- **The push is throttled or dropped by APNs.** VoIP pushes are
  high-priority and immediate by design, but "sent" is not "delivered": a
  caller who rang and got no answer because the push never arrived has no
  visibility into that from the server side today, and this PR does not
  change that. Worth a counter on the operator dashboard once this ships,
  the same way `voice.hlsPlaylistRejected` exists so a silent failure has
  somewhere to show up.
- **Must-report-or-be-terminated is not optional and not soft.** Apple
  enforces this at the OS level (the app is killed the moment a VoIP push
  handler returns without reporting a call) and treats repeat violations as
  grounds to revoke the app's own VoIP push entitlement outright. There is no
  graceful degrade to build around this, only "always call
  `reportNewIncomingCall` synchronously, on every push, with no branch that
  skips it."

## Testing on a device

Every path above needs a **physical iPhone** (the simulator's CallKit support
is real for `reportNewIncomingCall` bookkeeping but does not present the
system lock-screen UI a person would actually see and does not carry
CarPlay/AirPods hardware at all) and, for the incoming path, a socket that
stays connected while the phone is locked or the app is backgrounded (the
`audio` background mode already covers this; nothing new to configure).

1. Build to a device, sign in, and place a DM call from a second account
   (the `pqp:dev-user-suffix` trick in `CLAUDE.md`, or a second physical
   phone) while this one is foregrounded. The lock-screen/CarPlay card
   should appear alongside the existing in-app banner.
2. Lock the phone (screen off, app backgrounded, socket still connected) and
   place the call again from the other side. The lock screen should ring on
   its own, and answering from there should land in the call exactly like
   answering the in-app banner does, with no separate "open the app first"
   step.
3. Answer with wired or Bluetooth headphones (or a Mac/CarPlay simulator
   acting as a Bluetooth audio device) and confirm routing follows the
   accessory rather than the speaker, and that the system mute control on the
   headset maps to pqp's own mute (visible as the mic icon changing in the
   in-app stage).
4. Force-quit the app mid-call from the app switcher and confirm CallKit
   does not leave a dangling lock-screen card. `providerDidReset` is what
   this exercises, but only the OS actually calling it, on a real process
   kill, proves it.
5. Kill the app entirely and have somebody call. **This step does not work
   yet.** It needs the PushKit leg above; today a killed app simply does not
   ring, the same as before this PR.

Unit coverage for everything that does not need a device,
`CallKitCoordinatorTests.swift`, runs in the simulator or CI with no
telephony entitlement at all, by swapping the real `CXProvider` /
`CXCallController` for fakes behind `CXProviding` /
`CXCallControllerProviding`. It pins: a call UUID is assigned once per room
and reused rather than duplicated on a second report; a room CallKit was
never told about is a safe no-op everywhere (`reportConnected`,
`reportCallEnded`); a system end forgets the room *before* calling the room
owner, so the owner's own follow-up report is a no-op rather than a double
report; and a system mute action reaches the correct room's owner
(`CallModel` for a `.conversation`, `VoiceModel` for a `.channel`) with the
correct value. What it does not cover: `provider(_:didActivate:)` /
`didDeactivate`, which are a two-line pass-through into the real
`RTCAudioSession` singleton with no branching of this file's own to pin.
Asserting WebRTC's internal audio-session state would make the suite depend
on the simulator's actual audio hardware for no benefit.

## Why in-app buttons do not round-trip through CallKit

`CallModel`/`VoiceModel`'s existing `accept`/`decline`/`hangUp`/`isMuted` API
is untouched: the in-app banner, the call stage's Hang Up button and its
mute toggle all still call those directly, exactly as before this PR. Each of
those call sites additionally, directly, tells the coordinator what happened
(`reportOutgoingCall`, `reportIncomingCall`, `reportCallEnded`) rather than
funnelling the tap through `CXCallController.request(...)` first and waiting
for the resulting `CXProviderDelegate` callback to do the real work. That
keeps this a small, additive layer over two already-large models instead of
a rewrite of either, at the cost of one honestly-scoped gap: **an in-app-only
mute never re-syncs CallKit's own mute icon**, since `CXCallUpdate` carries
no mute field and the only way to push a mute state back to the system is a
full `CXSetMutedCallAction` round trip. Muting from the lock screen or
CarPlay works correctly in both directions; muting from inside the app while
looking at the lock screen's own icon (an unusual thing to be doing at the
same moment) can show a stale icon until the next system-initiated mute
toggle. Worth fixing if it turns out to bother anyone; not worth the
round-trip's added surface for a first pass.

The **reported end reason** sent to CallKit for an app-initiated hang-up is
similarly an honest simplification: `CXCallEndedReason` has no "the local
user hung up through the app's own UI" case (`.failed`, `.remoteEnded`,
`.unanswered`, `.answeredElsewhere`, `.declinedElsewhere` are the whole set),
so `CallModel.hangUp` reports `.remoteEnded` for every ordinary hang-up
regardless of which side actually ended it. This can only ever show up as a
slightly-wrong label in CallKit's own Recents entry for the call; it has no
effect on the call itself.

## CarPlay

A CallKit-integrated app is already most of what CarPlay needs for **calls**
specifically: a paired CarPlay head unit shows this app's calls in its own
phone UI with no extra code, because that surface is CallKit's, not this
app's. A dedicated **CarPlay communication app** (the `CPTemplateApplicationSceneDelegate`
surface that would let someone start a NEW pqp call from the car's own
screen, browse recents, or see a channel list without touching their phone)
is a separate, entitlement-gated step: it needs Apple's CarPlay entitlement
specifically for communication apps (requested per-app from Apple, not
available by simply enabling a capability in Xcode), a `CPTemplateApplicationScene`
target, and its own recents/favorites data source. Worth doing once this
CallKit layer has been through a real call or two on hardware; building it
on an unverified foundation would mean debugging two new surfaces (CallKit
and CarPlay) with one bug report.
