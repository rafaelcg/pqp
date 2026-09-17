# TestFlight (iOS beta)

How to offer the native iOS app via **TestFlight**, and what App Store Connect
means by **Sign-in information**.

The web CTA (“Join the iOS beta”) reads `VITE_TESTFLIGHT_URL` at build time. Until
that secret is set, the site links to `/vs-discord#ios-beta` with a short hint
instead of a dead join URL.

## What you already have

| Item | Status |
|---|---|
| Bundle ID | `gg.pqp.app` (`ios/project.yml`) |
| Team | `WXBFUF9WMA` |
| Version | `ios/pqp/Info.plist` and `ios/pqp/Broadcast/Info.plist`, which must agree. `1.0` since build 10; `CFBundleVersion` is what moves. The repo carries **21**. What is actually UPLOADED is a different question and only the API answers it (`GET /v1/builds?filter[app]=6799265799&sort=-version`); this row has been stale before, and a number that disagrees with App Store Connect is a refused upload after a 30 MB transfer |
| App Store Connect app id | `6799265799` |
| Release API | `https://api.pqp.gg` + live Clerk publishable key in Release config |
| Public App Store listing | Not yet |

## CI builds

`.github/workflows/ios.yml` has two jobs. **build-and-test** runs on every PR
and push to `main` that touches `ios/**`: it regenerates the Xcode project
with `xcodegen generate` (same as a contributor's laptop, since the
`.xcodeproj` is gitignored), builds `build-for-testing` against an iOS
Simulator destination with `CODE_SIGNING_ALLOWED=NO`, and runs
`test-without-building` on the `pqpTests` bundle, skipping `pqpUITests`
(needs a running local server and a seeded Postgres, see
`ios/pqp/UITests/TestSeed.swift`) and `AttachmentUploadTests` (the one file
in `pqpTests` that actually opens a socket and calls a real server with S3
storage; everything else that constructs a `.local` client only feeds it
bytes directly). This is the check that would have caught the
missing-localization break: the same `check-localization.py` script that
broke `main` runs as a build phase, so a literal that never reached
`Localizable.xcstrings` fails this job the same way it should have failed
then.

**testflight** runs on a push of a tag matching `ios-v*`, or a manual
`workflow_dispatch`, and only after **build-and-test** passes, so the tests
that gate a PR gate a release too. It skips cleanly with a job-summary note
(not a red run) when its signing secrets are not set.

### One-time setup (Rafael)

Three secrets `testflight` needs beyond the App Store Connect API key trio
that already exists (`APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`, the same ones Electron notarization uses):

1. **Export the Apple Distribution certificate as a `.p12`.** Keychain
   Access → My Certificates → find `Apple Distribution: Rafael Cammarano
   Guglielmi (WXBFUF9WMA)` → expand it, select both the certificate and its
   private key → right-click → Export 2 items… → File Format `.p12` → set a
   password (this becomes `IOS_DIST_CERT_PASSWORD`, not the login keychain
   password).
2. **Download the two App Store provisioning profiles** from
   [the developer portal](https://developer.apple.com/account/resources/profiles/list):
   `pqp appstore` (app, `gg.pqp.app`) and `pqp broadcast appstore` (the
   ReplayKit extension, `gg.pqp.app.broadcast`). Both are needed, since a
   profile is scoped to one bundle id and the archive step signs both
   targets.
3. **Base64 everything and set the secrets** (`gh secret set NAME --repo
   rafaelcg/pqp` reads from stdin, so nothing touches shell history):

   ```bash
   base64 -i DistributionCert.p12 | tr -d '\n' | gh secret set IOS_DIST_CERT_P12_B64 --repo rafaelcg/pqp
   gh secret set IOS_DIST_CERT_PASSWORD --repo rafaelcg/pqp   # the password chosen in step 1
   base64 -i "pqp appstore.mobileprovision" | tr -d '\n' | gh secret set IOS_PROVISIONING_PROFILE_B64 --repo rafaelcg/pqp
   base64 -i "pqp broadcast appstore.mobileprovision" | tr -d '\n' | gh secret set IOS_BROADCAST_PROVISIONING_PROFILE_B64 --repo rafaelcg/pqp
   ```

Until all four are set, `testflight` skips the archive/export/upload steps
entirely and says which secrets are missing in the job summary, rather than
failing red or building something with the wrong identity.

Optional: create a GitHub Environment named `ios-testflight` (Settings →
Environments) with a required reviewer, the same protection PR 679 put on
Android's `play-production` environment. With no environment configured, the
job just runs unattended on a matching tag or dispatch, same as before.

### Per-release flow

```bash
git tag ios-v1.1 && git push origin ios-v1.1
```

Watch the "iOS" workflow: build-and-test, then archive, export and upload to
TestFlight (the internal `Team` group gets it automatically; the public
`Beta` group still needs the manual Beta App Review and group-add steps under
"Put it in front of testers" below, which CI does not do). The `.ipa` is
also attached to the run as the `pqp-ios-ipa` artifact, in case it needs
inspecting or uploading by hand.

A `workflow_dispatch` run does the same thing without a tag, for a one-off
build.

### Build numbers

CI computes `CFBundleVersion` as `100000 + <run number of the iOS workflow>`
and writes it into both `ios/pqp/Info.plist` and
`ios/pqp/Broadcast/Info.plist` before archiving; it does not read or bump the
committed value, so the two numbers in git stay whatever they were last set
to by hand. The offset exists so a CI-cut build number can never collide
with a hand-cut one: this repo's `CFBundleVersion` is 32 as of this writing,
and App Store Connect's own build list is the authoritative answer to "which
number is highest" (`GET /v1/builds?filter[app]=6799265799&sort=-version`),
not this file. Before the very first CI-cut upload, confirm 100000 is still
comfortably above whatever ASC's highest build actually is. If a very long
run of CI builds ever approaches six digits, raise the offset in `ios.yml`
rather than letting it collide.

## Cutting a build by hand

The commands below are what produced build 18, in order, and they still work
unattended if CI is ever unavailable, or for a build that needs a
non-default option CI does not offer.

### 1. Bump both build numbers

`CFBundleShortVersionString` has been `1.0` since build 10 and stays there;
`CFBundleVersion` is the number that moves, one per upload. It lives in **two**
Info.plists and they must match, or App Store Connect refuses the upload:

```bash
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 18" ios/pqp/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 18" ios/pqp/Broadcast/Info.plist
```

What is already uploaded is the authoritative answer to "which number is next":

```bash
# 6799265799 is the app's App Store Connect id
GET /v1/builds?filter[app]=6799265799&sort=-version
```

### 2. Archive and export

The `.xcodeproj` is generated, so regenerate it first.

```bash
cd ios && xcodegen generate

xcodebuild -project pqp.xcodeproj -scheme pqp \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath /tmp/pqp.xcarchive \
  archive

xcodebuild -exportArchive \
  -archivePath /tmp/pqp.xcarchive \
  -exportOptionsPlist ios/ExportOptions.plist \
  -exportPath /tmp/pqp-export
```

`ios/ExportOptions.plist` is committed: `app-store-connect`, manual signing,
team `WXBFUF9WMA`, and the two profiles named per bundle id. Signing needs, in
the login keychain and in `~/Library/MobileDevice/Provisioning Profiles/`:

| Thing | Value |
|---|---|
| Certificate | `Apple Distribution: Rafael Cammarano Guglielmi (WXBFUF9WMA)` |
| App profile | `pqp appstore` (expires 30 Mar 2027) |
| Extension profile | `pqp broadcast appstore` (expires 30 Mar 2027) |

Check the archive before uploading it. Both bundle versions, and the four
entitlements that a Release build has silently shipped without before:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" /tmp/pqp.xcarchive/Products/Applications/pqp.app/Info.plist
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" /tmp/pqp.xcarchive/Products/Applications/pqp.app/PlugIns/pqpBroadcast.appex/Info.plist
codesign -d --entitlements :- /tmp/pqp.xcarchive/Products/Applications/pqp.app
```

`aps-environment` must read `production` (Xcode rewrites it on export),
`com.apple.developer.applesignin` must be present, and
`beta-reports-active` is what makes it a TestFlight build.

### 3. Upload

Uploading needs an **App Store Connect API key**: a key id, the team's issuer
id, and the `.p8`. None of it is in the repo and none of it ever should be.

| Piece | Where it lives |
|---|---|
| `.p8` | `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8` (the path `altool` searches; keep it out of any repo) |
| Key id | The filename |
| Issuer id | Not on this machine under any pqp path. It is the same issuer for every app on team `WXBFUF9WMA`, and it is in GitHub as the `APPLE_API_ISSUER` secret, which Electron notarization uses |

```bash
xcrun altool --validate-app -f /tmp/pqp-export/pqp.ipa -t ios \
  --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID"

xcrun altool --upload-app -f /tmp/pqp-export/pqp.ipa -t ios \
  --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID"
```

Validate first. It catches the mismatched-bundle-version case in seconds
instead of after a 30 MB transfer and an email from Apple.

Processing takes a few minutes. Poll it rather than watching the web UI:

```bash
GET /v1/builds?filter[app]=6799265799&sort=-version   # processingState PROCESSING then VALID
```

### 4. Release notes

The "What to Test" text is per build and per locale, and it is what a tester
actually reads in the TestFlight app:

```bash
POST /v1/betaBuildLocalizations   # locale pt-BR, whatsNew: the notes, build: the build id
```

Write it in plain Brazilian Portuguese, aimed at somebody holding a phone, with
no jargon and no em dashes. Say what changed and what to poke at.

### 5. Put it in front of testers

Uploading is not shipping. There are two audiences and they behave differently:

| Group | Kind | Gets a new build |
|---|---|---|
| `Team` | internal | Automatically. `hasAccessToAllBuilds` is true, so an upload is enough |
| `Beta` | external, public link `https://testflight.apple.com/join/envnP5vV` | **Only when the build is submitted for Beta App Review and added to the group.** Nothing about uploading does this |

That distinction went unnoticed for a month: builds 12 through 17 were uploaded
and every one of them reached the internal group only, while the public link the
website advertises still handed out **build 11 from 8 August**. Check it after
every upload:

```bash
GET /v1/betaGroups/4d8af414-c4f2-4fe1-8299-01b77e5fde89/builds?fields[builds]=version
```

Two calls fix it, and they need no human step when Test Information is already
filled in (it is: contact plus a demo account):

```bash
POST /v1/betaAppReviewSubmissions          # { build: <build id> }
POST /v1/betaGroups/<group id>/relationships/builds   # [ { type: builds, id: <build id> } ]
```

Build 18's review came back `APPROVED` in under a minute, which is what a
subsequent build of an already-approved app usually does. `autoNotifyEnabled`
is on, so testers are emailed without a further step.

## Sign-in information ≠ Apple ID

App Store Connect → Test Information / App Review asks for **Sign-in information**.
That is a **demo account inside pqp** (Clerk email + password) so Apple’s
reviewers can open the app. It is **not**:

- your Apple Developer login
- Sign in with Apple (which pqp does offer, and does need: see below)

### Create the demo account (Rafael)

1. Clerk Dashboard → Users → create user with **email + password** (OTP-only will
   block reviewers).
2. Suggested email: something like `appstore-review@<inbox you control>`.
3. Sign in once on **production** (web or TestFlight), complete the **18+ age
   gate** with an adult date of birth.
4. Join or create a small private community with a few messages and a second
   dummy user (so Report / Block are exercisable).
5. Paste email + password into ASC → TestFlight → **Test Information** → Sign-in
   information.
6. Notes template (paste and edit):

```
18+ age gate already completed on this account.
After sign-in you land in the seeded community.
UGC: long-press / message menu → Report; profile → Block.
Privacy: https://pqp.gg/privacy
Terms: https://pqp.gg/terms
Contact: <your abuse email>
```

## External TestFlight (public / invite link)

1. Confirm distribution profiles (`pqp appstore`, `pqp broadcast appstore`) are valid.
2. Archive, export and upload: **Cutting a build** above.
3. Internal testing first — smoke the demo account on a device.
4. Fill Test Information (above).
5. External group → add build → **Beta App Review**.
6. When Apple approves, copy the public link:
   `https://testflight.apple.com/join/XXXXXXXX`
7. Set it for the website:

```bash
# GitHub Actions → Pages build
gh secret set VITE_TESTFLIGHT_URL --body 'https://testflight.apple.com/join/XXXXXXXX'

# Local client/.env (optional)
VITE_TESTFLIGHT_URL=https://testflight.apple.com/join/XXXXXXXX
```

Redeploy the web app (`Deploy Web` after CI on `main`, or `workflow_dispatch`).

## Sign in with Apple

**Settled: it is required, and it is offered.** The question this section used to
leave open is answered by the live Clerk instance. `clerk.pqp.gg` has both
`oauth_google` and `oauth_apple` enabled and authenticatable, which you can read
back at any time:

```bash
curl -s 'https://clerk.pqp.gg/v1/environment?__clerk_api_version=2021-02-05&_clerk_js_version=5.0.0' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["user_settings"]["social"])'
```

Google being enabled is what makes Sign in with Apple mandatory under Guideline
4.8. Apple being enabled is what satisfies it: the app's sign-in sheet is Clerk's
`AuthView`, which renders one button per enabled provider, so both appear with no
code of ours involved.

**Build 12 and earlier shipped that button broken.** Clerk's iOS SDK takes the
native path for Apple (`ASAuthorizationAppleIDProvider`), and the app carried no
`com.apple.developer.applesignin` entitlement, so the request fails. Google was
fine, because it goes through `ASWebAuthenticationSession`, which needs no
entitlement. The entitlement is now declared in `ios/project.yml`.

Before the next archive, on the developer portal:

1. App ID `gg.pqp.app` → enable the **Sign in with Apple** capability.
2. Re-mint the **`pqp appstore`** provisioning profile so it carries it.
3. Otherwise Release signing fails with "provisioning profile doesn't include the
   com.apple.developer.applesignin entitlement". Debug and simulator builds do
   not sign and are unaffected.
4. Then tap **Continue with Apple** on a device once. That is the only way to
   know it works.

A review account with **email + password** (below) keeps a reviewer off the
social path entirely, which is why this was never caught. That is luck, not a
mitigation: reviewers do test Sign in with Apple.

## Build 17 and later: LiveKit rooms

Production voice runs on LiveKit for most rooms, and every build before this one
declared `transports: ["mesh"]`, so the server refused it from those rooms with
"This voice channel runs on livekit, which the iOS app cannot join yet". From
the build carrying `feat/ios-livekit` the app joins them. Two things a tester
should know:

- **Screen share from the phone now publishes into LiveKit rooms too**, and
  has never been run on a phone on either transport. The control is hidden
  only where a broadcast cannot happen (the simulator) or where the channel
  denies SPEAK. Receiving somebody else's share, sound included, works and is
  verified. If a share produces no picture at the far end, say which transport
  the room was on: the two publish paths are different code.
- **The app now links two WebRTC builds** (the mesh's and LiveKit's, whose
  symbols are `LKRTC`-prefixed). The IPA is larger. If a TestFlight build
  crashes on joining voice, the first thing to check is which of the two the
  crash log names.

Nothing in App Store Connect changes: same bundle id, same entitlements, and
the demo account below still works for a reviewer, who will land in a LiveKit
room on production.

## Watch party on a TestFlight build

Client-only. No API restart. After this build is on a phone:

1. Sign in on production.
2. Open a server that has a live Watch party (clapperboard section, AO VIVO
   pill). Opening the channel is watching; do not tap a green phone.
3. The film should keep playing past the first few seconds. If it stalls,
   tap the picture and **Pular pro ao vivo**.
4. Expand is native fullscreen (landscape, film fills the screen, chat is
   gone). Quality, jump to live, AirPlay and collapse stay on the overlay.

Simulator: `cd ios && xcodegen generate`, then the pqp scheme. Needs a live
playlist; there is no physical iPhone in CI.

## App Store assets

Screenshots (`ios/app-store/screenshots/<locale>/6.9-iphone/`, pt-BR then
en-US, dark-only since the app has no light theme, one size since iOS has no
iPad target) and listing text
(`ios/app-store/metadata/<locale>/{name,subtitle,promotional_text,description,keywords,release_notes,privacy_url,support_url}.txt`)
live in the repo, captured with the app's own
`ios/pqp/UITests/StoreScreenshotUITests.swift` against a local dev server. See
`ios/app-store/screenshots/README.md` for how to redo them. Nothing here
uploads to App Store Connect automatically — paste the text fields in by hand
and drag in the screenshots under **App Store** → **iOS App** → the version
row → **App Store Connect** screenshots section for each localization.

## Related

- `docs/IOS.md` — run the app, APNs, universal links
- `docs/superpowers/specs/2026-08-20-vs-discord-and-testflight-design.md` — product claims + path
- Marketing: `/vs-discord`, footer “Join the iOS beta”
