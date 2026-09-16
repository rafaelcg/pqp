# Android Telecom: pqp calls as phone calls

A native Kotlin `android.telecom` integration (`android/app/src/main/kotlin/gg/pqp/app/voice/telecom/`)
so a pqp voice call behaves like a phone call: lock-screen incoming-call UI,
answer/decline, a `CallStyle` notification while a call runs, correct audio
routing (Bluetooth, a car head unit), hardware/Bluetooth button handling, and
the call surfacing through Telecom on Android Auto. Read this after
[`ANDROID.md`](./ANDROID.md)'s **Voice** and **Push notifications** sections —
this file assumes both.

**What is real, stated the same way `ANDROID.md` states it for the rest of the
app:** built, unit-tested, and verified by `compileDebugKotlin`,
`testDebugUnitTest`, `lintDebug` and `assembleDebug`, all green. **Not run on
a device or an emulator.** `android.telecom` (`Connection`, `TelecomManager`,
`ConnectionService`) is framework surface no JVM test can build — the same
gap `LiveKitEngine` and `VoiceTransport` already have — so everything that
needs a live Telecom stack (does the system actually draw the incoming-call
card, does `placeCall` actually route audio to a paired Bluetooth headset,
does the call actually appear on an Android Auto head unit) is unverified
until somebody runs it on real hardware. See **How to test on a device**
below for exactly what to try.

## What works today, with the app in the foreground or backgrounded (not killed)

1. **Placing a call registers it with Telecom.** Joining any voice channel,
   or placing a DM call (`CallController.place`), places a self-managed
   Telecom call through `TelecomManager.placeCall`. The address is a `pqp:`
   URI carrying the room id (never a phone number — this account has none);
   the display name is the DM's own title, or `#<channel name>` for a plain
   channel (see **A known simplification**, below, for why it stops at the
   channel name).
2. **An incoming DM call ringing this device over the live WebSocket** —
   `call-incoming`, exactly as `ANDROID.md`'s Voice section describes it —
   registers an incoming Telecom call (`TelecomManager.addNewIncomingCall`)
   *and* draws a `CallStyle` full-screen notification
   (`IncomingCallNotifier`) with Answer/Decline, on top of the existing
   in-app `IncomingCallBanner`. This is the foreground/backgrounded case only:
   see **What is gated on the server** for a killed process.
3. **Answer, Decline, and hanging up** all go through
   `gg.pqp.app.voice.CallController` and `VoiceController` — the *same* path
   the in-app banner and call bar always used. Telecom is a second surface
   for the same three actions, not a second implementation of them:
   `TelecomController` reduces every framework callback
   (`onAnswer`/`onReject`/`onDisconnect`) to `calls.accept()`,
   `calls.decline()`, or `voice.leave()`.
4. **Hold and mute from the system UI, a Bluetooth headset button, or a car
   head unit** are mapped onto pqp's own mute (`VoiceController.setMuted`).
   pqp has no server-side hold, so `onHold`/`onUnhold` are treated as mute/
   unmute — the true, safe meaning "pause this call" can have with nothing
   behind it to actually pause.
5. **Audio routing** is unchanged from what `ANDROID.md`'s Voice section
   already documents (`MODE_IN_COMMUNICATION`, the explicit push to the
   speaker). `PqpConnection.onCallAudioStateChanged` is the *read* side —
   Telecom telling this app what a Bluetooth or wired button did — and
   nothing here changes how the audio route itself is chosen; Telecom
   arbitrates that across concurrent self-managed calls, which for pqp is
   always at most one.
6. **A `CallStyle` foreground notification** replaces the plain one
   `VoiceService` used to show, on API 31+ (a `NotificationCompat.Builder`
   with the same actions, unchanged, below that). Hang up and mute are both
   on it. `FOREGROUND_SERVICE_TYPE_PHONE_CALL` is declared alongside the
   existing `microphone` type.
7. **A Telecom refusal never produces a dead call.** Every `TelecomManager`
   call is wrapped and logged, never thrown; `TelecomGateway.isReady` is
   checked before `placeCall`/`addIncomingCall`; and none of it is on the
   path a call actually needs to connect — `VoiceController`/`CallController`
   know nothing about Telecom succeeding or failing. A device that refuses to
   register the account (no `MANAGE_OWN_CALLS`, a restricted profile, an OEM
   that does not implement self-managed accounts) gets the call exactly as it
   worked before this feature existed, with no system UI on top of it.
8. **Android Auto.** A call placed or answered through Telecom is what makes
   it eligible to surface on a connected head unit at all — that surfacing is
   the platform's own, through the standard in-call surface Telecom exposes,
   not anything pqp draws. **Not verified**: nothing here was run against an
   Android Auto head unit or the DHU (desktop head unit) emulator. A car-app
   template for *browsing* pqp's channels from the head unit (the
   `androidx.car.app` library, a `Screen`-based UI) is a separate, later
   feature — this PR only makes an existing call reachable from the car,
   because Telecom is what a car integration keys off in the first place.

## Architecture

```
CallController (ring)  ──┐
                          ├──► TelecomController ──► TelecomGateway (interface)
VoiceController (room)  ─┘         │                        │
                                    │                        └─► AndroidTelecomGateway (real)
                                    │                              │
                                    ▼                              ▼
                            TelecomCoordinator            TelecomManager / PqpConnectionService
                            (pure, JVM-tested)                      │
                                                                     ▼
                                                              PqpConnection (per room)
```

- **`TelecomModels.kt`** — `TelecomState`, `TelecomEvent`, `TelecomEffect`,
  and `TelecomCoordinator.reduce`, a pure function with no Android in it,
  the same shape as `CallMachine` and `transportChangePlan`. This is where
  the one invariant the feature cannot ship without lives: **one Telecom
  connection per voice room, never two, always torn down when the room is.**
  `muteChangeFrom` is the pure mute-mapping boundary, next to it.
- **`CallTelecomHooks.kt`** (in `gg.pqp.app.voice`, not `.telecom`, because it
  is a `CallController` seam) — `telecomHookEvents`, a pure diff of one
  `CallMachine` transition into what Telecom needs to hear about the ringing
  half of a call. Read its doc comment for why this is a direct hook into
  `CallController.dispatch` rather than a second collector on
  `CallController.state`: that state updates *before* the effect that calls
  `VoiceController.join()`, so a flow-based diff would see an answered ring's
  card disappear before the join it caused, and misread it as a decline.
- **`TelecomController.kt`** — the orchestrator, application-scoped, built
  once in `PqpApplication` alongside `VoiceController` and `CallController`.
  Feeds `TelecomCoordinator` from two places (`CallController` via
  `CallTelecomHooks`, `VoiceController.state` for everything about a room
  being live) and carries out its effects through `TelecomGateway`.
  Implements `TelecomConnectionCallbacks`, the framework-callback-shaped
  interface `PqpConnection` calls into through `TelecomBridge`.
- **`TelecomGateway.kt`** — the interface everything above is written
  against, and `AndroidTelecomGateway`, the real `TelecomManager`-backed
  implementation. Every method is wrapped in `runCatching`; a refusal is
  logged and nothing more.
- **`TelecomBridge.kt`** — the process-wide seam between `PqpConnection`
  objects (created by the system, inside `PqpConnectionService`, outside this
  app's control) and `TelecomController` (built by `PqpApplication` on its
  own schedule). A singleton because there is exactly one of each for the
  life of the process.
- **`PqpConnection.kt`** — one `android.telecom.Connection` per room. Thin by
  design: every decision is `TelecomController`'s, reached through
  `TelecomBridge.callbacks`. Owns exactly one piece of correctness on its
  own — `end(cause)` is idempotent (an `ended` flag), because both the
  system (`onReject`/`onDisconnect`) and pqp's own state
  (`TelecomGateway.endConnection`, reached through the coordinator) can each
  try to tear the same connection down, and which one gets there first is a
  coroutine-dispatch detail this class has no business depending on — the
  same shape as pitfall #13 in `CLAUDE.md` (two teardown paths for one
  thing), fixed the same way (refuse the second call rather than trust an
  order neither path controls).
- **`PqpConnectionService.kt`** — where the system asks for a `Connection`.
  Bound by the system (`BIND_TELECOM_CONNECTION_SERVICE`), never started
  directly; `roomId` and `displayName` travel in as request extras, set by
  `AndroidTelecomGateway`.
- **`IncomingCallNotifier.kt`** / **`CallActionReceiver.kt`** — the
  `CallStyle` incoming-call notification (`PqpConnection.onShowIncomingCallUi`,
  the framework's own request that a self-managed app draw its own
  incoming-call UI) and its Answer/Decline actions. The actions call the
  *same* `CallController` methods the in-app banner's buttons call, not
  `android.telecom` directly — one path for both surfaces.

## Manifest and permissions

- `MANAGE_OWN_CALLS` — normal permission, granted at install, no runtime
  prompt. Registers the self-managed `PhoneAccount` and is what
  `FOREGROUND_SERVICE_TYPE_PHONE_CALL` requires.
- `USE_FULL_SCREEN_INTENT` — wakes the screen for an incoming call the way a
  phone call does. Declared; not requested at runtime (there is no runtime
  prompt for it below API 34, and Play Console review is the actual gate on
  API 34+ for an app not already recognized as a calling app — worth
  revisiting if Play flags it on submission).
- **Not requested**: `READ_PHONE_STATE`. Nothing in this feature reads
  telephony state; that permission is for apps that need to know about the
  *cellular* call state (a SIM call interrupting this one), which a
  self-managed `ConnectionService` does not need Telecom to tell it via that
  API — Telecom itself is the one arbitrating concurrent calls.
- `PqpConnectionService` is declared `exported="true"` with
  `android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE"`
  — required by the platform for anything bound this way; the permission,
  not the export flag, is what actually restricts who may bind.
- `POST_NOTIFICATIONS` is already requested alongside `RECORD_AUDIO`
  (`rememberMicrophoneGate`, unchanged by this PR) for every explicit voice
  action. A device that has refused it still rings — the in-app
  `IncomingCallBanner` needs no notification permission at all — it just
  will not draw the `CallStyle` card or the ongoing-call notification.

## What is gated on the server: cold-start incoming calls

**Everything above needs the app process alive.** A DM call ringing a phone
whose pqp process has been killed needs something to wake it, and the only
thing that can is a high-priority push. `ANDROID.md`'s own **Push
notifications** section already states the general gap in full — `PushPlatform`
has no `"fcm"` member, there is no `server/src/services/fcm.ts`, no Firebase
project exists — and none of that is re-litigated here. **Do not implement
it as part of this feature**; the seven-edit plan in that section is still
the plan. This section is the one slice of it a ringing call needs, written
down so the eventual FCM work does not have to rediscover it.

### The good news: the server-side call push already exists

`server/src/services/push.ts`'s `sendCallPush` / `pushIncomingCall` already
fire for a DM call, today, to Web Push and APNs — the exact moment
`server/src/ws/voice.ts` sends the `call-incoming` WS frame this PR's
`CallController` already handles, it also calls `pushIncomingCall` with the
same `rungUserIds`:

```ts
// server/src/ws/voice.ts, ring():
pushIncomingCall({
  conversationId,
  kind: ring.kind,
  rungUserIds: [...rung],
  callerName: user.display_name,
});
```

`sendCallPush` narrows `rungUserIds` to accounts with **no live socket
anywhere in the cluster** and not on stored do-not-disturb, then sends one
`PushPayload` (`buildCallPushPayload`) through `CALL_DELIVERY` — **high
urgency, 50 second TTL** (`CALL_PUSH_TTL_SECONDS`), because a ring delivered
late is not late, it is wrong:

```ts
{
  title: callerName ?? "Someone",
  body: kind === "group" ? "Incoming group call" : "Incoming call",
  path: `/app/dm/${conversationId}`,
  tag: conversationId,
}
```

So the FCM leg does not need a *second* call-push mechanism designed for it.
It needs to be the third transport `deliverToUsers` already fans this exact
payload out to, exactly as `ANDROID.md`'s Push section's seven edits already
describe for an ordinary message push — data-only, `android.priority: HIGH`,
`android.ttl` from `delivery.ttlSeconds`, `android.collapse_key: tag`.

### The one addition a ringing call needs beyond an ordinary push

An ordinary message push and a call push carry the *same four* `data` keys
today (`title`, `body`, `path`, `tag`), because `PqpMessagingService` decides
what to draw entirely from `path` and the channel it names. A call cannot
work that way: `PushController.onMessageReceived` (the general message path)
draws a notification and stops, but a ringing call has to raise the Telecom
incoming-call UI **before** the socket has even connected, which is a
different code path than drawing a tray notification. There is nothing in
today's four keys that says "this push is a ring, not a mention."

**Add a fifth `data` key, `kind: "call"`,** to `buildCallPushPayload`'s wire
shape (all three transports, so Web Push and APNs gain it too — a fifth key
already-shipped clients ignore is free; a diverging payload per platform is
not). `PqpMessagingService.onMessageReceived` branches on it:

- `kind == "call"` → parse `path` for the conversation id (same parsing
  `DeepLink.kt` already does), read `title` as the caller's display name, and
  call straight into `TelecomController` — **not** through `CallController`,
  because there is no live socket to have sent a `call-incoming` frame yet.
  A new `TelecomController.ringFromPush(conversationId, callerName)` should
  drive the *same* `TelecomCoordinator.RingStarted` event
  `CallTelecomHooks.onIncomingCallArrived` already drives, so the "one
  connection per room, no double add" invariant this PR's tests pin covers
  the push-originated ring for free: when the socket does connect a moment
  later and the real `call-incoming` frame arrives, `TelecomCoordinator`
  already has this room in `ringing` and the frame is a no-op on the Telecom
  side (`CallMachine` still adds the card in-app, since it does not know
  about the push at all — that is fine, `IncomingCall` equality is already
  what a redundant `call-incoming` no-ops on there too).
- Any other `kind` (or its absence, for a pre-this-change payload) → today's
  path, unchanged.

**Timing.** FCM's own high-priority delivery is typically low single-digit
seconds even to a dozing device; the 50 second TTL is the budget against the
caller's `CALL_RING_TIMEOUT_MS` (45s, `CallMachine.kt`) — a push that lands
after the caller has stopped ringing should not raise a card for a call that
is already over, which is exactly what the short TTL buys: FCM drops an
expired high-priority message rather than delivering it late.

**What still needs Rafael**, unchanged from `ANDROID.md`'s Push section: a
Firebase project, `google-services.json`, and a service account for the
server's `FCM_PROJECT_ID`/`FCM_CLIENT_EMAIL`/`FCM_PRIVATE_KEY`. Nothing here
invents or requires anything beyond what that section already asks for.

## A known simplification: channel display names

A plain voice channel's Telecom display name is `#<channel name>` — never
`#<channel name> @ <server name>`, which is what the task asked for and what
Discord's own call notifications show. `VoiceController.join(channelId,
channelName)` is called from `ChatScreen`'s join button with only the
channel's own name; no call site threads the server's name down to it today.
Fixing this properly means passing the server name alongside the channel id
wherever a voice channel is joined (`ChatRoute` already carries `serverId`;
resolving it to a name needs either a small server-name lookup at the join
site or a `ChatRoute.serverName` parameter next to the id it already has),
which is a small, separate, easy follow-up rather than something folded into
this change's diff. A DM call's display name is unaffected — it is already
the conversation's own title.

## How to test on a device

Nothing below was run in this session; this is what verifying it needs.

1. **A real device or emulator with Google Play services**, not a bare AOSP
   image — self-managed `ConnectionService` behavior varies more by OEM than
   most Android APIs, and a Pixel image is the closest thing to a baseline.
2. **Two accounts** (`docs/ANDROID.md`'s dev-bypass suffix — `alice`/`bob`)
   for a DM call between two emulators, or one device and the web client for
   a one-sided check of the notification/lock-screen surfaces.
3. Join a plain voice channel: confirm the `CallStyle` notification appears
   (API 31+) with the channel's own name, Hang up and Mute both work from it,
   and `dumpsys telecom` shows one call for pqp's account.
4. Place a DM call (`docs/ANDROID.md`'s conversation call flow): confirm it
   shows as **calling**, not incoming, on the far side's Telecom state.
5. Ring a DM call from the other account while this device is foregrounded:
   confirm the `CallStyle` full-screen incoming card appears *in addition
   to* the existing in-app `IncomingCallBanner`, Answer joins the room (same
   as tapping the banner), and Decline sends `call-decline` (same as tapping
   the banner's decline).
6. Background the app (do not kill it) and ring it again: confirm the
   full-screen intent brings the app forward and the card is still there.
7. Pair a Bluetooth headset (or use a wired one) during a call: confirm audio
   routes to it, and that its hardware mute/answer/hang-up buttons work
   through `PqpConnection`'s `onCallAudioStateChanged`/`onAnswer`/`onDisconnect`.
8. **Android Auto**: connect to a head unit or the desktop head unit (DHU)
   emulator during a live call and confirm it appears on the car's call
   surface at all — this is the one item in the list above marked
   unverified, and the one most likely to surface an OEM-specific gap.
9. Kill Telecom's own ability to register (there is no clean way to simulate
   this without a restricted profile; the honest fallback check is reading
   the log line `AndroidTelecomGateway` writes on a refusal) and confirm
   voice still works with no CallStyle notification and no crash.
