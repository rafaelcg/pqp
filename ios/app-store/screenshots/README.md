# App Store screenshots

Real captures from the iOS Simulator against a local dev server with
`DEV_AUTH_BYPASS=true`, using the repo's own capture harness
(`ios/pqp/UITests/StoreScreenshotUITests.swift`). Nothing here is mocked up in
a design tool; every screen is the actual running app.

## Sizes

iOS has no iPad target (`TARGETED_DEVICE_FAMILY: "1"` in `ios/project.yml`,
iPhone only), so there is one size: **6.9-inch** (1320x2868, iPhone 17 Pro
Max class). App Store Connect in 2026 only requires the largest size you
provide and scales the rest, so this one set covers every iPhone.

The app is dark-only (`UIUserInterfaceStyle: Dark` in `ios/project.yml`,
"the app is a dark, high-contrast surface by design; letting iOS light-mode
it produces an unreadable half-theme") — there is no light theme to shoot.

## Locales

`pt-BR` first (the audience is Brazilian, per `CLAUDE.md`), `en-US` second.
Driven by `-AppleLanguages` / `-AppleLocale` launch arguments, the same
mechanism `ios/pqp/UITests/LocalizationUITests.swift` already used to prove
the app speaks Portuguese — see `PQP_SHOT_LOCALE` in
`StoreScreenshotUITests.swift`.

## The 8 screens

| File | Screen | Shows |
|---|---|---|
| 01-onboarding | First-run hero | The three-beat intro |
| 02-hub | Hub | Server rail (communities) + direct messages |
| 03-channels | Channel list | Text channels, a voice channel with people in it |
| 04-chat | Text channel | A real transcript, reactions-capable messages |
| 05-voice-call | Voice call | The call stage: roster, mute/camera/speaker/hang up |
| 06-dm | Direct message | A two-way conversation |
| 07-friends | Friends | Online friends, a pending request |
| 08-settings | Settings | Profile, message privacy, notifications |

Not captured, and why:

- **Incoming call banner.** The harness supports it (`requestRing` writes a
  `RING_NOW` marker file a host-side watcher can pick up and fire a
  `call-ring` frame at), but wiring that watcher was out of scope for this
  pass. `SHOT-SKIP: the ring never arrived` in the test log is expected.
- **Watch party viewing.** iOS only has the audience half (see
  `docs/PARITY.md`), and reaching it needs a live LiveKit HLS egress — a
  running SFU box and an active transcode, not something a local dev server
  can produce. Not reachable without that infrastructure.

## How these were made

1. Local Postgres + API with the dev bypass (`DEV_AUTH_BYPASS=true`,
   `DEV_SEED=true`), which seeds the **Sandbox** hall (`docs/HANDOVER.md` /
   `CLAUDE.md` "How to run (local)"). The iOS Debug build already points at
   `http://localhost:3001` and authenticates as `dev-local-token` with no
   changes needed — see `Backend.current` and `DevTokenProvider` in
   `ios/pqp/Sources/Core/APIClient.swift`. No code changes were required to
   get the app talking to a local dev server; that seam already existed.
2. Extra content seeded over the wire (small Node scripts using `ws`, not
   committed — the same protocol `server/src/services/dev-seed.ts` already
   uses to hold dummy presence sockets open): a few more messages in
   `#general`, a two-way DM with "Caio", three dummy accounts
   (`dev-local-token:<suffix>`) joined into the `Lobby` voice channel over
   `join-voice-room` so the call screenshot shows a populated roster, and a
   couple of friend requests in different states (accepted, pending in both
   directions) for the friends screenshot.
3. `xcrun simctl privacy <udid> grant all gg.pqp.app` before the run —
   otherwise the OS's own microphone permission sheet covers the call screen
   mid-test.
4. `cd ios && xcodegen generate`, then
   `xcodebuild test -project pqp.xcodeproj -scheme pqp -destination "id=<udid>"
   -only-testing:pqpUITests/StoreScreenshotUITests`, with
   `PQP_SHOT_DIR` / `PQP_SHOT_LOCALE` passed through as
   `TEST_RUNNER_`-prefixed environment variables (xcodebuild forwards those,
   minus the prefix, into the test process).
5. `xcrun simctl io <udid> screenshot` is not used — the harness calls
   `XCUIScreen.main.screenshot()` itself, at the simulator's native
   resolution, after a settle delay so nothing is caught mid-transition.

## Redoing this

The harness is reusable as committed. To refresh a set:

```bash
cd ios && xcodegen generate
xcrun simctl privacy <udid> grant all gg.pqp.app

# ids.json names the seeded server/channel/DM the test looks for
cat > /tmp/asc/ids.json <<'EOF'
{ "serverId": "<uuid>", "generalName": "general", "voiceName": "Lobby", "dmId": "<uuid>" }
EOF

TEST_RUNNER_PQP_SHOT_DIR=/tmp/asc/shots-en TEST_RUNNER_PQP_SHOT_LOCALE=en \
xcodebuild test -project pqp.xcodeproj -scheme pqp -configuration Debug \
  -destination "id=<udid>" -only-testing:pqpUITests/StoreScreenshotUITests
```

Swap `en` for `pt-BR` (and the shot dir) for the other locale.
