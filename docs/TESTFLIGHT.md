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
| Version | `ios/pqp/Info.plist` and `ios/pqp/Broadcast/Info.plist`, which must agree. `1.0` since build 10; `CFBundleVersion` is what moves. Build 18 is the latest uploaded |
| App Store Connect app id | `6799265799` |
| Release API | `https://api.pqp.gg` + live Clerk publishable key in Release config |
| Public App Store listing | Not yet |

## Cutting a build

There is **no CI workflow for iOS**. `.github/workflows/` builds the web, the
API, Electron and Android; the iOS build is produced on a Mac by hand, with the
commands below. They are the ones that produced build 18, in order, and they
work unattended.

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

## Related

- `docs/IOS.md` — run the app, APNs, universal links
- `docs/superpowers/specs/2026-08-20-vs-discord-and-testflight-design.md` — product claims + path
- Marketing: `/vs-discord`, footer “Join the iOS beta”
