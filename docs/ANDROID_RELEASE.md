# Android release: from `assembleRelease` to a Play closed beta

Companion to [`ANDROID.md`](./ANDROID.md) (what the app **is**) and
[`ANDROID_PLAN.md`](./ANDROID_PLAN.md) (what to build next). This is the third
thing: **what a human has to do by hand**, in order, and nothing left implicit.

Everything here is Rafael-only. An agent must not generate, hold, upload or
paste a keystore, a service-account key or a Play Console credential. The build
side is already wired and tested; what is left is the part with the passwords in
it.

> **The clock is already running.** The Play Console account exists, and Google's
> closed-testing requirement for a new personal developer account is **12 testers
> opted in and 14 continuous days of testing** before production access opens.
> The 14 days do not start until a build is actually live on a closed track with
> testers on it, so step 4 below is the critical path and everything after it can
> happen while the clock runs.

---

## What is already done, and what is not

| | State |
|---|---|
| `signingConfigs.release` wired to `local.properties` / `-P` / env | **Done**, and verified end to end against a throwaway keystore |
| `assembleRelease` no longer falls back to the debug key | **Done**, and with no keystore it now produces an *unsigned* APK instead of a plausible-looking rejected one |
| R8, resource shrinking and `proguard-rules.pro` on the release variant | **Done and green**. CI builds release unsigned on every PR |
| `bundleRelease` (the `.aab` Play actually wants) | **Verified working** |
| `.github/workflows/android.yml` | **Done**: build, unit tests, lint, debug APK, unsigned release |
| **In-app account deletion** | **Done and exercised on a device.** See §0 |
| Data export in the app | **Done** (`GET /api/me/export`, saved through the system file picker) |
| Play Console: FGS declaration, data safety, listing | **Not started.** §5, §6, §7. Note the manifest now needs **two** FGS declarations, not one |
| Voice carrying actual audio | **Still unproven between two humans.** Join, mute, deafen, the foreground service and a clean teardown are all verified on a device; nobody has heard anybody. Decide §3 before uploading |

---

## 0. The blocker that was here, and the one that replaced it

**The old blocker is closed.** This section used to say the Android app had no
way to delete an account and that this was a launch blocker. That was true when
it was written and is now false, and a stale blocker in a runbook costs a real
day when somebody believes it.

In-app deletion and data export both exist, in `android/app/src/main/kotlin/gg/pqp/app/account/`:

- `AccountDeletion.kt` mirrors `deleteConfirmationMatches` in
  `packages/shared/src/api.ts`, so the button lighting up and the request being
  accepted cannot disagree. `AccountDeletionTest.kt` holds it to that.
- `AccountApi.kt` calls `DELETE /api/me` and `GET /api/me/export`.
- `ui/DeleteAccountDialog.kt` is a full-screen, non-dismissible dialog listing
  what is deleted **and what is kept, and why**, requiring you to type your own
  `name#1234`.
- `ui/YourDataSection.kt` puts both on the You screen.

**Exercised on an emulator against a live local server**, not read off a file
list. Both branches:

- *Ordinary deletion.* Typed the tag, pressed Delete for ever. The user row,
  the two communities that account owned alone, and the message it had sent
  were all gone from Postgres, and the app returned to the sign-in screen with
  no crash.
- *Refused deletion.* An account owning a community that still had another
  member got the 409 back, and the dialog grew a section naming the community
  and its member count.

### The new blocker: the refusal is a dead end on Android

The 409 branch renders correctly and then tells the person:

> In each community's settings, either hand it to another member or delete the
> community yourself.

**The Android app has no community settings.** No delete, no ownership
transfer, no leave. So the one in-app route to deleting your account ends in an
instruction the app cannot satisfy, which is a Play User Data policy risk in
exactly the way the old missing-deletion blocker was.

The smallest honest fix is a delete-community action on the servers list, which
`DELETE /api/servers/:serverId` already supports with no server change
(`server/src/api/index.ts:2574`; leave is at `:2585`). Ownership transfer needs
a member picker the app does not have and is not the minimum.

The **web** deletion URL Play asks for on the data-safety form is the same
Settings dialog on `pqp.gg`; give Play a URL that explains the steps rather than
one that deletes on load.

## 1. Decide the two permanent things

Both are irreversible once the first build is accepted, so decide them before
the first upload rather than after.

1. **`applicationId`.** Currently `gg.pqp.app`. It can never change for this
   listing. It is right; just be aware that it is being frozen here.
2. **The signing key.** With Play App Signing (which you want, and which is
   mandatory for new apps) Google holds the *app* signing key and you hold the
   *upload* key. Losing the upload key is recoverable through Google support;
   losing an app signing key would not have been. Opt in.

Also note the version. `versionCode = 1` / `versionName = "0.1.0"` in
`android/app/build.gradle.kts`. **A `versionCode` can never be reused**, even by
a build that was rejected, so bump it for every single upload.

---

## 2. Create the upload keystore

On the laptop, once, in a directory that is **not** this repo:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"

mkdir -p ~/keys
"$JAVA_HOME/bin/keytool" -genkeypair -v \
  -keystore ~/keys/pqp-upload.jks \
  -alias pqp-upload \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype JKS
```

It asks for a store password, a key password and a name. Use a password manager
for both passwords; there is no recovery. `-validity 10000` (about 27 years) is
what Google asks for, because a key that expires inside the app's life makes
upgrades impossible.

**Back it up somewhere that is not this laptop.** The keystore file *and* both
passwords. `~/keys` is not a backup.

**Never commit it.** `android/.gitignore` already covers `local.properties`, and
the keystore lives outside the repo entirely, which is the stronger version of
the same rule.

### Wire it up locally

Add to `android/local.properties` (already gitignored):

```properties
pqp.keystoreFile=/Users/rafael/keys/pqp-upload.jks
pqp.keystorePassword=<store password>
pqp.keyAlias=pqp-upload
pqp.keyPassword=<key password>
```

Then confirm, from `android/`:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"

./gradlew :app:bundleRelease
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs \
  app/build/outputs/apk/release/app-release.apk   # after :app:assembleRelease
```

The `.aab` to upload is `android/app/build/outputs/bundle/release/app-release.aab`.
If the four properties are absent the build still succeeds and produces
`app-release-unsigned.apk`. That is deliberate, and it is what CI does. An
unsigned artifact is a problem you notice in the same minute you caused it; a
debug-signed one is a rejection three days later.

### Optional: the same four values as GitHub secrets

Only needed if you later want CI to produce a signed bundle. The workflow does
not read them today and does not need to.

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i ~/keys/pqp-upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | `pqp-upload` |
| `ANDROID_KEY_PASSWORD` | key password |

A job would decode the first to a temp file and pass all four as `-P` flags.
Deliberately not written yet: a repo with a signing key in its secrets is a
bigger thing to protect than a repo without one, and nothing needs it while the
upload is a manual step.

---

## 3. Decide what happens to the Join button

**Voice has never carried audio between two devices.** Signalling, the roster,
the politeness rule and the ICE restart are all verified; a human hearing
another human is not (`ANDROID.md` §What voice is verified to do).

Shipping a Join button that produces silence is worse than shipping no Join
button, and a tester who hears nothing reports "the app is broken", not "voice
is beta". So before the first upload, one of:

- **A7 lands**, meaning the two-device runbook passes with real TURN credentials on the
  API, measured at the receiver. This is the good outcome and it also needs A8
  (default to the speaker) first, or an earpiece-routed call will be
  misdiagnosed as an ICE failure.
- **Voice hides behind a build flag** for the first beta, and the listing says
  text chat.

Do not upload with this undecided.

---

## 4. Create the app and get a build onto a closed track

In order, in the Play Console:

1. **Create app.** Name, default language **Portuguese (Brazil)**, app not game,
   free.
2. **App integrity → Play App Signing**: opt in (default for new apps).
3. **Testing → Closed testing → Create track.** An email list of testers. Get
   **at least 12** and get them to actually opt in through the link, because
   Google counts opted-in testers, not invited ones.
4. **Upload `app-release.aab`.** Fill the release notes in both languages.
5. Google will refuse to activate the release until the declarations in §5-§7
   are complete. Do them, then activate. **The 14 days start here.**

---

## 5. Foreground service declaration

Since Android 14, an app declaring a foreground service type must justify it in
the Console or the release is rejected. This section used to say the manifest
declared exactly one type. **It declares two**, and has since screen sharing
landed:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />
<service android:name=".voice.VoiceService"
         android:foregroundServiceType="microphone|mediaProjection" />
```

Confirmed in the built release artifact rather than in the source, because the
source is not what Play reads: `aapt2 dump xmltree` on `app-release.apk` reports
`foregroundServiceType=0xa0`, which is `MICROPHONE` (0x80) or'd with
`MEDIA_PROJECTION` (0x20).

**So the form below has to be filled in twice, once per type**, each with its
own justification and its own demo video. A declared type with no matching
declaration is a rejection, and this is the single easiest way to lose a day.

**Console → App content → Foreground service permissions**, for `microphone`:

- **What it does:** keeps a live voice call running while the person uses
  another app. The call is peer-to-peer WebRTC audio between people who joined
  the same voice channel.
- **Why a foreground service is required:** Android stops a backgrounded
  process's threads, so without it every call drops the moment the person checks
  a message. There is no alternative API for continuous audio capture.
- **Why not a user-initiated data transfer or a scheduled job:** neither can
  hold the microphone.
- **User-visible:** yes. An ongoing `category=call` notification with a Hang up
  action, shown for the whole call, and the call is started by the person
  pressing Join.

You also need a **demo video** (unlisted YouTube link is fine) showing: open the
app, join a voice channel, the permission prompt, the notification appearing,
pressing Home, the notification still there with the call still running, Hang
up. Thirty seconds is plenty. Record it on a real device with
`adb shell screenrecord`.

### And again for `mediaProjection`

- **What it does:** lets somebody share their screen into a voice call they are
  already in, so the other people in the call can watch it live.
- **Why a foreground service is required:** `MediaProjection` on Android 14 and
  later refuses to start unless a foreground service of this type is already
  running, and the capture has to survive the person leaving the app, which is
  the entire point of sharing a screen.
- **Why not another type:** `mediaProjection` is the only type that permits
  `MediaProjection`. The service holds the microphone as well, which is why the
  declaration is `microphone|mediaProjection` on one service rather than two
  services.
- **User-visible:** yes, twice over. The system's own consent dialog appears
  before any capture starts, the system screen-cast indicator stays up for the
  duration, and the app's ongoing call notification is already there.
- **No audio is captured.** The screen share publishes video only
  (`audioStreamId` is sent as null); the microphone is separate and is the other
  declared type.

Its demo video: join a voice channel, press Share, the system consent dialog,
the cast indicator appearing, another device seeing the screen, then Stop.

---

## 6. Data safety

**Console → App content → Data safety.** The app's honest answers, from the
code rather than from a template:

| Question | Answer |
|---|---|
| Does the app collect or share user data? | Yes, collects. **Shares: no**. No data goes to a third party for their own use |
| Encrypted in transit | Yes (HTTPS / WSS; the cleartext exemption is `src/debug` only and is not in a release build) |
| Can users request deletion? | **Yes**, in-app and through a web route. The in-app flow exists and was exercised on a device; see §0 for the one remaining dead end in its refusal branch |

Data types to declare:

- **Personal info → Name**: collected, required, for app functionality and
  account management. The display name.
- **Personal info → Email address**: collected via Clerk for sign-in, required,
  account management.
- **Messages → Other in-app messages**: collected, required, app functionality.
  Text messages are stored on the server so a channel has history.
- **Audio → Voice or sound recordings**: **collected: no.** This is the one
  worth getting right. Voice is peer-to-peer WebRTC and the microphone stream is
  never stored or sent to the server; TURN relays packets it cannot read.
  Declare the microphone permission and say audio is transmitted in real time
  and not collected. Do not tick "collected" out of caution: an inaccurate
  data-safety form is itself a policy violation, in either direction.
- **Photos** and **Files**: not yet. Attachments (B5) are not built on Android.
  **Revisit this form when they are.**
- **App activity / App info and performance**: no analytics SDK ships in the
  Android app. Umami is web-only.

Also required on the same screen: a **privacy policy URL**. Use the one the web
and iOS listings already use.

---

## 7. Store listing, in two languages

**Português (Brasil) is the default language, not the translation.** It is the
audience.

Assets, all mandatory:

| Asset | Spec |
|---|---|
| App icon | 512 x 512 PNG, 32-bit, no alpha. Export the adaptive icon's foreground on the brand's near-black |
| Feature graphic | 1024 x 500 PNG or JPEG, no alpha |
| Phone screenshots | 2 to 8, 16:9 or 9:16, min 320px on the short side |

Screenshots to take, in both languages, on a Pixel emulator with the status bar
clean (`adb shell cmd statusbar` or demo mode):

1. The server list
2. A channel with a real conversation in it
3. A voice channel with the call bar and two people in it (**only if §3 landed
   on "voice ships"**)
4. The channel list showing categories

Copy: short description (80 chars) and full description (4000), written for pt-BR
first and then English. Do not machine-translate the Portuguese from the
English; the product's voice is Brazilian.

Also on **App content**: target audience and content rating questionnaire. The
app has an 18+ age gate enforced server-side, which the rating questionnaire
should reflect (user-generated content, unmoderated real-time communication).
`docs/CONTENT_SAFETY.md` has the honest description of what is and is not
scanned; answer from it rather than from optimism.

---

## 8. After the first release is live

- Watch **Android vitals** for ANRs and crashes. A crash rate above Google's bad
  behaviour threshold blocks the promotion to production regardless of the 14
  days.
- Bump `versionCode` for every upload, forever.
- Re-open §5 when `mediaProjection` lands and §6 when attachments land.
- The target API requirement moves every year. Check the current one in the
  Console before each release rather than trusting `targetSdk = 37` to stay
  acceptable.

---

## Why `compileSdk` is still 37

`ANDROID_PLAN.md` A5 asked for 36, on the reasoning that 37 was newer than AGP
9.3.2 knew about and only worked because this laptop had the platform installed.
Half of that turned out to be wrong and the fix for the other half is not a
version number.

- **36 does not build.** Sixteen dependencies floor at 37 and fail the build
  outright: every `androidx.compose.*` in the 2026.08.00 BOM,
  `androidx.core:core:1.19.0`, `androidx.lifecycle:*:2.11.0` and
  `com.squareup.okhttp3:okhttp-android:5.5.0`. Lowering `compileSdk` means
  downgrading all sixteen, which is a much larger change than the one being
  avoided.
- **AGP 9.3.2 knows API 37 perfectly well.** `android.suppressUnsupportedCompileSdk=37`
  was removed and the build emits no warning at all, so the flag was suppressing
  nothing and would have hidden the next real warning.
- **The actual worry is fixed properly.** `.github/workflows/android.yml`
  installs the platform explicitly and prints what it installed, so "it builds"
  is now a property of the repo rather than of one laptop. That was the point of
  the request, and a version number was never going to deliver it.
