# Desktop app (Electron)

The desktop build of pqp. Native window, dock badge, OS notifications, global
mute shortcut, `pqp://` deep links, and auto-update — around the same React
client the browser runs.

- Code: [`electron/`](../electron) — see [`electron/README.md`](../electron/README.md) for the runtime/IPC surface.
- CI: [`.github/workflows/electron.yml`](../.github/workflows/electron.yml)
- Distribution: GitHub Releases on `rafaelcg/pqp`, tags matching `v*`.
- Public page: [`https://pqp.gg/download`](https://pqp.gg/download)

---

## 1. What the app actually loads

**A packaged build loads the hosted web app (`https://pqp.gg/app`) in a native
window.** It does not run the client bundled inside the `.app`.

This is not an accident, and it is the single most important thing to know
about the desktop build:

The API enforces a CORS allowlist in production (`CORS_ALLOWED_ORIGINS`,
resolved by `resolveCorsOrigin` in `server/src/lib/http.ts`). The shell used to
serve the bundled client from a local HTTP server bound to
`server.listen(0, "127.0.0.1")` — an **ephemeral** port, so the app's origin was
`http://127.0.0.1:<random>`, different on every launch. No static allowlist can
contain that. A packaged build would have rendered perfectly and then failed
every single API call, in production only, because
`resolveCorsOrigin` returns `*` when `CORS_ALLOWED_ORIGINS` is unset — which is
exactly the local-dev configuration where it was tested.

Clerk has the same problem twice over: the publishable key is bound to allowed
origins, and the server checks the token's `azp` claim against
`CLERK_AUTHORIZED_PARTIES`. Both are origin-shaped. A random loopback port
satisfies neither.

Loading the hosted origin makes the desktop app CORS-identical and
Clerk-identical to the web app. It needs no server-side change of its own.

| Mode | When | Origin |
|---|---|---|
| Hosted (default, packaged) | no env override | `https://pqp.gg` |
| Dev | `pnpm electron:dev` | `http://localhost:5173` |
| Explicit | `PQP_APP_URL=https://…` | that URL |
| Bundled client | `PQP_LOAD_STATIC=1` | `http://127.0.0.1:<random>` |

`PQP_LOAD_STATIC=1` is kept for offline use and self-hosting. A self-hoster
either leaves `CORS_ALLOWED_ORIGINS` unset (which falls open to `*`) or accepts
that the loopback origin cannot be allowlisted. It is not the launch path.

> The long-term answer is a custom `app://` protocol via `protocol.handle`,
> which gives the bundled client a stable origin that *can* be allowlisted.
> That is a real piece of work (CSP, service worker, asset resolution) and is
> not needed to ship.

### Server-side config this requires

**Nothing new.** Confirm the values the web app already needs:

| Where | Name | Must contain |
|---|---|---|
| Fly (API) | `CORS_ALLOWED_ORIGINS` | `https://pqp.gg` |
| Fly (API) | `CLERK_AUTHORIZED_PARTIES` | `https://pqp.gg` |
| Clerk dashboard | allowed origins | `https://pqp.gg` |

If the launch domain is not `pqp.gg`, change `DEFAULT_PROD_URL` in
`electron/main.js` — it is the only place the desktop default lives.

### Desktop sign-in

Current shells do not finish Google/Apple inside the `BrowserWindow`.
**Entrar** / **Criar conta** open the default browser on `/desktop-login`.
After the user confirms, the API mints a 90-second Clerk ticket and the
browser sends it to a one-shot `http://127.0.0.1:<port>/callback` listener
in the main process. Electron redeems the ticket and the age gate still
runs inside `/app`.

Older shells have no `startDesktopAuth` and keep the in-app Clerk modal.
Game-connection OAuth (Steam / Battle.net / Twitch) still hops in-window.

If the account has MFA, Clerk spends the ticket and returns
`needs_second_factor` (TOTP, SMS, backup codes) or `needs_client_trust`.
The shell completes the second factor in `/app` rather than treating that
as a failed redeem. `needs_client_trust` keeps the in-app Clerk modal as
a fallback so the ticket is not a dead end. Desktop auth IPC only answers
when `event.senderFrame` is the app origin.

Local and staging use the Clerk **development** instance. Google and Apple
are off there until someone enables them in the Clerk dashboard (SSO
connections, shared credentials, no custom OAuth apps). Production already
has both, so a packaged build against pqp.gg shows those buttons.

### Consequence for update cadence

Because the shell loads the hosted client, **the product updates itself on
reload.** A web deploy reaches every desktop user through the service-worker
prompt (`client/src/components/layout/update-prompt.tsx`), same as the browser.
Auto-update (§5) only ships changes to the *shell* — main process, menus, deep
links, permissions, entitlements. That is a much rarer event, which is why the
shell updater is allowed to be patient.

### Voice across an API restart

The main `BrowserWindow` sets `webContents.setBackgroundThrottling(false)`.
Chromium otherwise delays timers in a minimized window, and the voice resume
TTL is 90 seconds. A minimized call must still reconnect before the server
drops the orphaned peer. Auto-update that reloads the page is a tab reload:
media is gone, same as the browser. iOS and Android do not resume yet.

### Screen sharing on the desktop app

`getDisplayMedia` exists in every Electron renderer and resolves **nothing**
until the main process answers: Chromium delegates "which screen?" to the
embedder. `electron/main.js` registers `session.setDisplayMediaRequestHandler`,
and from 0.1.6 it registers it with **`useSystemPicker: false`**, so that
handler answers every request on every platform. It used to be `true`, which
reads as "prefer the nicer native list on macOS 15+" and means "on macOS none
of our code runs": the screen-recording diagnosis, the labelled picker, the
auto-pick and the loopback mapping were all unreachable there, and every test
of them was testing a path that platform never took.

**The picker** (`electron/picker/`, a `file://` page inside the bundle, strings
from `electron/locales/`) lists screens first, then windows, each with a
thumbnail and an app icon, arrow keys and Enter, Escape to cancel. One surface
and no choice to make (Wayland portals, a permission-less macOS) skips the
dialog entirely. Cancelling becomes a `NotAllowedError`, which the client words
as "blocked or cancelled" rather than as a failure.

**Audio, per OS** — `captureResponse` in `electron/lib/display-sources.js`:

| OS | What a share can carry | How |
|---|---|---|
| Windows | The machine's own output, minus pqp's | `{ video: source, audio: "loopback" }` when the page asked for audio **and** the picker's box was ticked. Electron 43.4+ remaps that to `loopbackWithoutChrome` when the page sent `restrictOwnAudio: true`, so the call playing in this window stays out of the tap (the 23 Aug 2026 echo report) |
| macOS | Video only | Chromium's loopback device is WASAPI and exists nowhere else. The client asks for no audio track at all, because an audio request the embedder cannot satisfy rejects the **whole** capture, video included (3 Sep 2026: "o picker fecha e a stream não começa") |
| Linux | Video only | Same reason; best effort, and Wayland may hand back one pre-picked surface |

`loopbackWithMute` is deliberately never used. It taps the same output and
silences the machine while it does, so the presenter stops hearing both the call
and the thing they are presenting. Keeping *our own* audio out of the tap is
`restrictOwnAudio`, a different device.

**What the client is told.** `preload.js` publishes a `capabilities` object
(`displayMedia`, `systemAudio: "loopback" | "none"`, `restrictOwnAudio`,
`pickerOffersAudio`, `version`) and the web client reads it through
`desktopShareCapabilities()` / `liveScreenCaptureEnvironment()`. Before 0.1.6
the page inferred the audio half from `process.platform`, which was correct and
still wrong in kind: the hosted client runs inside whatever binary the user
installed, so the binary has to state its own abilities. The older
`canShareScreen` and `sharePickerOffersAudio` flags stay, because absence is the
signal that tells an out-of-date shell ("update the app") apart from a browser
that genuinely cannot capture.

**There are no tab surfaces here.** `desktopCapturer` knows screens and windows,
full stop. A watch party in a browser asks for `displaySurface: "browser"`
because tab audio is the clean path; that member is a **constraint**, not a
hint, so in the shell Chromium refused the whole capture after the picker closed
("Invalid capture constraints") and `startScreenShare` did not retry, because
that name is neither `TypeError` nor `NotSupportedError`. A presenter on the
desktop app could not start a watch party at all (13 Sep 2026). So the shell
never gets the tab steer, and a desktop watch party may take Windows loopback,
which is the only sound it can carry.

**The trade this made.** macOS now needs the Screen Recording grant, where the
system picker could hand over a surface without one. `screenPermission` +
`explainScreenPermission` open the right System Settings pane when it is
missing. Flipping `useSystemPicker` back to `true` in `main.js` is the one-line
rollback if that grant turns out to be the bigger problem.

**Frame rate and size** stay the page's business, not the shell's:
`screenCaptureOptions` asks for 1080p at 30 (60 when the HLS ladder wants it)
and the watch party lowers the capture's height with `applyConstraints` while it
runs. A capture that refuses a constraint keeps running unchanged; nothing in
that path stops a track.

---

## 2. Build locally

```bash
# From the repo root: the client build is copied in as extraResources.
pnpm --filter @pqp/client build

cd electron
pnpm run pack        # unpacked .app only — fastest smoke test
pnpm run dist:mac    # dmg + zip, arm64 + x64
pnpm run dist:win    # nsis + portable  (run on Windows)
pnpm run dist:linux  # AppImage + deb   (run on Linux)
```

Artifacts land in `electron/release/` (gitignored).

Note: `pnpm pack` is pnpm's own tarball command. Use **`pnpm run pack`**.

All four scripts set `CSC_IDENTITY_AUTO_DISCOVERY=false`, so a local build is
always unsigned even though a Developer ID certificate is in the keychain.
Signing happens in CI, from secrets — see §3. To smoke-test the hosted-load
path without waiting on a deploy:

```bash
PQP_APP_URL=https://pqp-3yr.pages.dev pnpm run dev
```

### Icons

`electron/build/icon.svg` (full bleed) and `icon-mac.svg` (inset for the macOS
Big Sur grid) are the sources. The mark is the same speech-bubble-with-three-dots
as the web icons, at the same geometry — `scripts/generate-icons.py` draws the
web set, `electron/scripts/generate-icons.js` draws the desktop set.

```bash
node electron/scripts/generate-icons.js   # macOS only: needs sips + iconutil
```

That writes `build/icon.icns`, `build/icon.ico`, `build/icon.png`, which are
**committed**. Regenerate and commit only when the mark changes.

---

## 3. What the owner has to do in the Apple Developer account

Most of this is already done. Run this first:

```bash
security find-identity -v -p codesigning
```

Expected, and already present on this machine:

```
Developer ID Application: Rafael Cammarano Guglielmi (WXBFUF9WMA)
```

- **Team ID is `WXBFUF9WMA`** — the parenthesised suffix.
- The certificate already exists. **Do not create a new one.** Developer ID
  certificates are limited per account and revoking the wrong one breaks
  every build already shipped under it.
- The listing also shows an **"Apple Distribution"** identity. That one is for
  the Mac App Store / TestFlight and **will not work** for a `.dmg` people
  download from a website. Exporting it instead of the Developer ID one is the
  most common way this goes wrong. Direct distribution = **Developer ID
  Application**, always.
- **You do not need to add an app to App Store Connect.** Developer ID
  distribution has no App Store record, no app ID to register, no review.
  Notarization is a scan, not a review.

### 3.1 Export the certificate as a .p12

1. Open **Keychain Access** → **login** keychain → **My Certificates**.
2. Find **Developer ID Application: Rafael Cammarano Guglielmi (WXBFUF9WMA)**.
3. Expand the disclosure triangle. It must show a **private key** underneath —
   if it does not, the certificate cannot sign and has to be re-issued on the
   machine that holds the key.
4. Right-click the certificate row (not the key) → **Export "Developer ID
   Application: …"** → format **Personal Information Exchange (.p12)**.
5. Set a password. This is the value of `CSC_KEY_PASSWORD`. Use a generated
   password; it protects the signing key in CI.
6. Save as `developer-id.p12`.

Then base64 it for GitHub (secrets are text):

```bash
base64 -i developer-id.p12 | pbcopy   # now in the clipboard, paste as CSC_LINK
```

Delete the `.p12` from disk afterwards. It is a signing key.

### 3.2 Notarization credentials — pick one

Notarization uploads the signed app to Apple, which scans it and issues a
ticket. Without it, Gatekeeper quarantines the download and the app reads as
broken (macOS says "damaged", not "unsigned"). Tooling is `xcrun notarytool`
(the `altool` path is deprecated and being turned off); electron-builder 26 uses
notarytool via `@electron/notarize`.

**Option A — App Store Connect API key (recommended for CI).**
Does not break when the Apple ID password changes, is scoped, and can be
revoked on its own.

1. <https://appstoreconnect.apple.com/access/integrations/api>
2. **Keys** tab → **+** → name it `pqp-ci`, access role **Developer**.
3. **Download the `.p8`.** It is downloadable exactly once.
4. From the same page, copy:
   - **Issuer ID** (a UUID, above the key table) → `APPLE_API_ISSUER`
   - **Key ID** (the key's row) → `APPLE_API_KEY_ID`
5. Base64 the key file: `base64 -i AuthKey_XXXX.p8 | pbcopy` → `APPLE_API_KEY_P8`

**Option B — Apple ID + app-specific password.**
Simpler, but the password is invalidated whenever the Apple ID password
changes, and the failure is a CI break weeks later with no obvious cause.

1. <https://account.apple.com> → **Sign-In and Security** → **App-Specific
   Passwords** → **+**, name it `pqp-notarize`.
2. Copy the `xxxx-xxxx-xxxx-xxxx` value — shown once.
3. Secrets: `APPLE_ID` (the Apple ID email), `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID` = `WXBFUF9WMA`.

The workflow prefers Option A and falls back to Option B.

### 3.3 Load the secrets into GitHub

`Settings → Secrets and variables → Actions → New repository secret` on
`rafaelcg/pqp`:

| Secret | Value | Required for |
|---|---|---|
| `CSC_LINK` | base64 of `developer-id.p12` | signing |
| `CSC_KEY_PASSWORD` | the .p12 export password | signing |
| `APPLE_API_KEY_P8` | base64 of `AuthKey_XXXX.p8` | notarization (A) |
| `APPLE_API_KEY_ID` | key ID | notarization (A) |
| `APPLE_API_ISSUER` | issuer UUID | notarization (A) |
| `APPLE_ID` | Apple ID email | notarization (B) |
| `APPLE_APP_SPECIFIC_PASSWORD` | `xxxx-xxxx-xxxx-xxxx` | notarization (B) |
| `APPLE_TEAM_ID` | `WXBFUF9WMA` | notarization (B) |

Every one of these is optional to the workflow. With none of them the mac job
still succeeds and produces an unsigned build — a fork must not fail CI. It
emits `::warning::` lines saying exactly what was skipped, so an unsigned
release is visible in the run summary rather than silent.

### 3.4 What gets notarized, and why the dmg needed its own step

electron-builder's `mac.notarize` notarizes and staples **the `.app` and
nothing else**. It does that inside `signApp`, before the dmg and zip targets
run; the dmg target then wraps the already-stapled bundle and stops. It never
submits the disk image to Apple. (`dmg-builder` has exactly one signing
function, `signDmg`, gated on `dmg.sign` which defaults to `false`, and
`app-builder-lib` contains no call to `stapler` at all.)

That produced run 31183972324: a perfect `.app` inside a `.dmg` that Gatekeeper
rejects with `source=no usable signature` — and the dmg is the file people
download. Apple's rule is to notarize the artifact you distribute.

So there are now three pieces, and all three must hold:

| Artifact | Signed | Ticket | By what |
|---|---|---|---|
| `pqp.app` | yes | stapled | electron-builder (`mac.notarize`) |
| `pqp-<v>-<arch>.dmg` | yes (`dmg.sign: true`) | stapled | [`electron/scripts/notarize-dmg.js`](../electron/scripts/notarize-dmg.js) |
| `pqp-<v>-<arch>.zip` | n/a | **none, correctly** | — |

**The zip does not need a ticket and cannot have one.** `stapler` has nowhere
to write a ticket into a zip archive. It does not need to:

- Squirrel.Mac — what `electron-updater` drives on macOS — validates the
  downloaded bundle's **code signature** against the running app's designated
  requirement. That is a signature check, not a notarization check, and the
  Developer ID signature on the app satisfies it.
- `electron-updater` fetches the zip over Node's HTTP stack, so the staged file
  never gets a `com.apple.quarantine` xattr and Gatekeeper never runs a
  first-launch assessment on it.
- If a human downloads the zip from the release page, the browser *does* set
  quarantine — and the `.app` inside was stapled by electron-builder, so that
  path validates offline too.

The dmg step costs one extra Apple round trip (~90s). The arm64 and x64 dmgs
are submitted concurrently, so it is one round trip of wall clock, not two.
Ordering is load-bearing: **sign → notarize → staple**. `dmg.sign` runs when
the dmg target builds; the hook runs after every artifact exists. Signing a dmg
*after* stapling would strip the ticket.

`dmg.writeUpdateInfo` is `false` for the same reason: stapling rewrites the
dmg, so any sha512 electron-builder computed for it before the hook ran would
be stale in `latest-mac.yml`. Nothing reads it — `electron-updater`'s
`MacUpdater` selects the `.zip` and explicitly ignores `dmg`/`pkg` entries —
but a wrong hash in a published feed is worse than an absent one.

Notarization credentials: on the App Store Connect API key path (`--key`
`--key-id` `--issuer`) **notarytool needs no team id** — it resolves the team
from the issuer that owns the key, and this account has exactly one team
(`WXBFUF9WMA`), so there is nothing to disambiguate. `--team-id` is only
*required* on the Apple ID path, which is why `APPLE_TEAM_ID` is read there and
only there, and why nothing hardcodes the team id.

### 3.5 Verify a signed build

CI does this itself, in the **"Verify macOS signing and notarization"** step —
it fails the job when Gatekeeper rejects an artifact, because a green
`electron-builder` is not evidence. Run the same commands by hand on the
downloaded artifact:

```bash
gh run download <RUN_ID> -R rafaelcg/pqp -n pqp-electron-mac
```

**The dmg — this is what users download, so check it first.**

```bash
spctl -a -vvv -t install pqp-0.0.1-arm64.dmg
```

Must print:

```
pqp-0.0.1-arm64.dmg: accepted
source=Notarized Developer ID
origin=Developer ID Application: Rafael Cammarano Guglielmi (WXBFUF9WMA)
```

`rejected` with `source=no usable signature` is the exact failure this section
exists for: the app inside is fine and the disk image is not.

```bash
xcrun stapler validate pqp-0.0.1-arm64.dmg
```

Must print `The validate action worked!`. `does not have a ticket stapled to
it` means Gatekeeper has to phone Apple on first launch and an offline machine
sees "damaged".

**Then the app inside it.** Mount the dmg (or unzip the `.zip`) and:

```bash
# 1. Signed, by whom, with which entitlements
codesign -dv --verbose=4 /Volumes/pqp*/pqp.app
```

Look for:
- `Authority=Developer ID Application: Rafael Cammarano Guglielmi (WXBFUF9WMA)`
- `Authority=Developer ID Certification Authority` → `Authority=Apple Root CA`
- `TeamIdentifier=WXBFUF9WMA`
- `flags=0x10000(runtime)` — the hardened runtime. Missing = notarization
  would have been rejected.

```bash
# 2. Gatekeeper's own verdict
spctl -a -vvv -t exec /Volumes/pqp*/pqp.app
```

Must print `accepted` and `source=Notarized Developer ID`. If it says
`source=Developer ID` without "Notarized", the app is signed but not notarized:
it will still be quarantined on a machine that has not seen it before.

```bash
# 3. Is the notarization ticket stapled into the bundle (works offline)
xcrun stapler validate /Volumes/pqp*/pqp.app

# 4. Deep verification of every nested binary and framework
codesign --verify --deep --strict --verbose=2 /Volumes/pqp*/pqp.app
```

> Checking only the `.app` is how a broken release ships. The `.app` passed all
> four of these in run 31183972324 while the dmg around it was unsigned and
> unstapled. **Never sign off on a macOS build without the two dmg commands.**

Test on a machine that has **never** seen the app, or simulate the quarantine
bit the browser sets:

```bash
xattr -w com.apple.quarantine "0081;00000000;Safari;" /Applications/pqp.app
open /Applications/pqp.app
```

If it opens with no dialog, the signing chain is right.

To read notarization history when something fails:

```bash
xcrun notarytool history --key AuthKey_XXXX.p8 --key-id "$KEY_ID" --issuer "$ISSUER"
xcrun notarytool log <submission-id> --key … --key-id … --issuer …
```

The log names the exact binary that failed, which is nearly always a missing
entitlement or an unsigned nested helper.

### 3.6 Entitlements

`electron/build/entitlements.mac.plist`, applied to the app and inherited by
the helpers. Notarization requires the hardened runtime, and the hardened
runtime breaks Electron without the first three:

| Entitlement | Why |
|---|---|
| `cs.allow-jit` | V8 |
| `cs.allow-unsigned-executable-memory` | V8 writes pages it then executes |
| `cs.allow-dyld-environment-variables` | Electron's launch environment |
| `cs.disable-library-validation` | Electron's frameworks are signed by Electron, not by us |
| `device.audio-input` | **voice** — see below |
| `device.camera` | video in voice channels |
| `network.client` / `network.server` | API, WS, WebRTC; loopback static server; desktop sign-in callback |
| `files.user-selected.read-write` | attachment pickers |

### 3.7 Microphone

Three things must all be true or the mic fails, and two of them fail *silently*:

1. `NSMicrophoneUsageDescription` in the Info.plist — set via
   `mac.extendInfo` in `electron/package.json`. Without it macOS denies without
   prompting.
2. `com.apple.security.device.audio-input` in the entitlements — without it the
   hardened runtime denies, again without a prompt.
3. The TCC prompt itself. `main.js` calls
   `systemPreferences.askForMediaAccess("microphone")` on the first `media`
   permission request when the status is `not-determined`, rather than relying
   on Chromium to raise it.

All three are wired. The failure this prevents is "nobody can hear me" with no
error in any console.

To retest the first-run prompt after granting it once:

```bash
tccutil reset Microphone gg.pqp.app
```

### 3.8 The keychain unlock failure, and why it looked like a rotated secret

For two days in September 2026 the macOS job failed on every run while Windows
and Linux stayed green:

```
electron-builder --mac -c.mac.notarize=true --publish never
  ⨯ Exit code: 1. Command failed: /usr/bin/security set-key-partition-list -S apple-tool:,apple: -s -k *** <temp>.keychain
security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
```

It was read at the time as a stale `CSC_KEY_PASSWORD`, and the response was to
path-filter the workflow so it ran less often. Both halves were wrong.

**The cause.** `createKeychain` in `app-builder-lib` 25.1.8 makes a throwaway
keychain with a random password, unlocks it with that password, imports the
`.p12` with `security import -P <p12 password>`, and then runs:

```
security set-key-partition-list -S apple-tool:,apple: -s -k <p12 password> <keychain>
```

`-k` there is the **keychain's own** unlock password, not the password of the
item that was just imported. It has been the wrong argument since the line was
written. The `***` in the CI log is GitHub masking `CSC_KEY_PASSWORD`, which is
the tell: the secret is correct, it is simply being offered to the wrong door.

**Why it was invisible for years.** `set-key-partition-list` only spends the
`-k` password when the keychain is locked. While the keychain is still unlocked
from the `unlock-keychain` two lines earlier, the wrong password is never
checked and the command succeeds. Reproduce both halves on any Mac:

```bash
security create-keychain -p correctpw /tmp/kctest.keychain
security unlock-keychain -p correctpw /tmp/kctest.keychain
security set-keychain-settings /tmp/kctest.keychain

# unlocked: the wrong password is never looked at
security set-key-partition-list -S apple-tool:,apple: -s -k WRONGPW /tmp/kctest.keychain

# locked: the exact CI failure
security lock-keychain /tmp/kctest.keychain
security set-key-partition-list -S apple-tool:,apple: -s -k WRONGPW /tmp/kctest.keychain
# security: SecKeychainUnlock: The user name or passphrase you entered is not correct.

security delete-keychain /tmp/kctest.keychain
```

**What changed.** Nothing in this repo and nothing in the Apple account. The
`macos-26-arm64` runner image rolled from Darwin 25.5.0 to 25.6.0, and on 25.6.0
the keychain is locked by the time that command runs. GitHub rolls an image
across the fleet gradually, so for about a day runs landed on either version and
the failure looked like a coin flip. Every green macOS build in that window
reported `os=25.5.0` and every red one `os=25.6.0`, seven for seven. The
`electron-builder` banner line prints that version, so it is the first thing to
read when this job disagrees with itself between two runs.

**The fix.** `electron-builder` **26.16.1**, published 2026-09-07, passes the
keychain password, with a comment naming the mistake. `electron/package.json` is
on `^26.16.1`. Upstream's own trail, which took three releases to land:

| | |
|---|---|
| [#10066](https://github.com/electron-userland/electron-builder/issues/10066) | 2026-08-07, the bug reported against a macOS beta |
| [#10101](https://github.com/electron-userland/electron-builder/pull/10101) | 2026-08-27, fixed on `master` (the v27 line) |
| [#10167](https://github.com/electron-userland/electron-builder/issues/10167) | 2026-09-03, the fix is missing from 26.16.0 |
| [#10172](https://github.com/electron-userland/electron-builder/pull/10172) | 2026-09-03, backported to `release/v26` |
| 26.16.1 | 2026-09-07, first published version that has it |

That caret is load-bearing, not tidiness. npm's `latest` tag for
`electron-builder` is still **26.15.3**, which does not have the fix, and both
npm and pnpm prefer the `latest` version whenever it satisfies the range. The
first attempt at this fix asked for `^26.15.3`, resolved to 26.15.3, and would
have shipped the same bug under a version number that looks new. `latest` is
held back on purpose: `master` is a CommonJS to ESM rewrite for v27 and
publishes under `next`, while the 26 line lives on `release/v26` and publishes
under the `v26` tag ([#9864](https://github.com/electron-userland/electron-builder/pull/9864)).
So `latest` is not the newest 26, and 26.16.0 is newer than the fix report but
older than the fix. Check the resolved version, never the range:

```bash
grep 'app-builder-lib@' pnpm-lock.yaml | head -1
grep -A1 set-key-partition-list \
  node_modules/.pnpm/app-builder-lib@*/node_modules/app-builder-lib/out/codeSign/macCodeSign.js
```

The second command must print `keychainPassword`. If it prints `password`, the
bug is installed. Widening the range to `^26` puts it back.

**One other thing the 25 to 26 upgrade required.** `mac.notarize` accepted
`{ teamId }` up to 25.1.8 and is a plain boolean from 26.0.0
([#8582](https://github.com/electron-userland/electron-builder/pull/8582)),
so the Apple ID fallback in the workflow no longer passes
`-c.mac.notarize.teamId=...`. It passes `-c.mac.notarize=true` and lets
`@electron/notarize` read `APPLE_TEAM_ID` from the environment, which the step
already exports. That branch is dormant while the App Store Connect API key
secrets are set, so nothing would have failed until the day someone fell back to
the Apple ID path, which is the worst time to find out. The other 26.0.0
breaking changes do not touch this config: `win.*` signing fields moved under
`win.signtoolOptions` (this repo signs Windows through `WIN_CSC_*` env vars, not
config) and `linux.desktop` became an object (this repo does not set it).

**The second-order lesson.** Path-filtering a workflow to quieten it also cuts
how often a real failure is seen. The filter earns its place here (a macOS
runner bills at ten times the Linux rate) but it is not a substitute for
noticing: nothing today alerts when the desktop build has been red for days, and
that is why this went unnoticed for 48 hours across 48 failed runs.

---

## 4. Windows

Historically builds were **unsigned**: SmartScreen showed "Windows protected
your PC" on every first run, forever, because an unsigned binary never
accrues reputation. Windows signing now runs through **SignPath Foundation's
free code signing program for open source projects**: no certificate to buy,
no card on file. It costs an application, an identity check, and a manual
approval click on every release from here on.

Two other routes exist and were considered and rejected for this project. A
paid cloud signing service (Azure Trusted Signing, ~$10/month) works and is
simpler operationally (no per-release approval), but Rafael does not want a
recurring paid subscription for a hobby project when a free program covers
the same need. A traditional CA certificate is worse on both axes: OV
(~$200-400/yr) does not clear SmartScreen any faster than a free cert would,
and EV (~$400-700/yr) requires a legal entity and a cloud-HSM integration
since June 2023. SignPath is free, and the org already qualifies (AGPL,
public GitHub, an existing CI-built release history), so it is the only route
implemented here.

### What SignPath signs, and what it does not

SignPath's GitHub Action ([`SignPath/github-action-submit-signing-request`](https://github.com/SignPath/github-action-submit-signing-request))
signs whatever files an **artifact configuration** points it at. electron-builder's
NSIS installer is a self-extracting `.exe`, not one of SignPath's composite
formats (MSI, APPX, MSIX, ZIP) that it can open, sign the contents of, and
repackage, so SignPath cannot reach inside it.

**Signed:** the two top-level files people actually download and run: the NSIS
installer (`pqp-<version>-x64.exe`) and the portable build
(`pqp-<version>-x64-portable.exe`).

**Not signed:** `pqp.exe`, the Electron binary that ends up in Program Files
after the installer runs, and any DLLs alongside it.

This is fine for what this PR exists to fix. SmartScreen's "Windows protected
your PC" prompt is driven by Windows checking the Mark-of-the-Web on a file
that was just downloaded and is about to run for the first time, which is
exactly the installer and the portable exe. A file written to disk by a local
install never carries that mark and never triggers the same check. If a fully
signed inner binary becomes a real need later (some antivirus heuristics do
weight it), that needs electron-builder's own per-file `win.signtoolOptions.sign`
hook calling out to a *synchronous* signer during packaging, which SignPath's
asynchronous, human-approved signing requests are not built for; that would be
a materially bigger integration than this one.

### Eligibility (already met)

From [SignPath Foundation's published conditions](https://signpath.org/terms.html):
an OSI-approved license with no proprietary or dual-licensed component (AGPL-3.0,
`electron/package.json`'s `license` field), a public source repository, an
actively maintained project, and a release already published in the form that
needs signing (pqp already ships tagged Windows builds via `electron.yml`).
Every requirement is met today; no repo changes are needed to qualify.

### Application steps (Rafael, one-time)

1. **Apply** at [signpath.org/apply](https://signpath.org/apply.html). The
   form asks for the public repo URL, the OSI license name (AGPL-3.0), a link
   showing the app is downloadable for free (the GitHub Releases page, or
   `pqp.gg/download`), and a short description of what pqp is and who signs
   the releases.
2. **Wait for review.** SignPath does not publish a fixed SLA; reported
   turnarounds in the OSS community run from a few days to a few weeks. There
   is nothing to do here except wait; nothing in this PR depends on the
   review finishing before it can merge, since the whole Windows signing path
   stays gated off until the secrets below exist.
3. **On approval**, SignPath creates a project for pqp in its dashboard and
   gives Rafael access. From there:
   - **Create a signing policy** (e.g. slug `release-signing`) using the
     Public Trust certificate SignPath Foundation issues. SignPath Foundation's
     OSS terms require **manual approval on every signing request**, so this
     policy will always pause for a click, not something to configure away.
   - **Create an artifact configuration** that signs every `.exe` in the
     uploaded zip, matched by extension rather than by exact filename since
     the filename changes every release:
     ```xml
     <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
       <zip-file>
         <pe-file-set>
           <include path="*.exe" min-matches="1" max-matches="unbounded"/>
           <for-each>
             <authenticode-sign/>
           </for-each>
         </pe-file-set>
       </zip-file>
     </artifact-configuration>
     ```
   - **Publish the required "Code signing policy" statement** SignPath
     Foundation's Code of Conduct asks every project to carry on its home or
     download page: "Free code signing provided by SignPath.io, certificate
     by SignPath Foundation", plus who the Authors/Reviewers/Approvers are
     (for a solo project, Rafael is all three). This is a SignPath compliance
     requirement, separate from the one-line SmartScreen note this PR adds to
     the download page (§3 of the PR description); it is not implemented
     here and is Rafael's to add once the project is approved.
4. **Note four values** from the SignPath project: the **organization id**,
   the **project slug**, the **signing policy slug** from step 3, and mint an
   **API token** with submitter permissions (project settings, API tokens).
5. **Set them on `rafaelcg/pqp`**: three as repository **variables**
   (`Settings → Secrets and variables → Actions → Variables`, not secrets,
   since none of them are sensitive) and one as a **secret**:

| Name | Kind | Value |
|---|---|---|
| `SIGNPATH_ORGANIZATION_ID` | variable | organization id, step 4 |
| `SIGNPATH_PROJECT_SLUG` | variable | project slug, step 4 |
| `SIGNPATH_SIGNING_POLICY_SLUG` | variable | signing policy slug, step 3 |
| `SIGNPATH_API_TOKEN` | secret | the API token, step 4 |

All four are optional to the workflow. With any of them unset the Windows job
still succeeds and produces an unsigned build (or falls back to
`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` if that pair happens to be set
instead); a fork must not fail CI, same rule as macOS.

### How this fits the tag-based release flow

Cutting a release is unchanged through step 2 of "Cutting a release" (§5
below): bump the version, tag, push. What changes is what happens on the
Windows runner for that tag:

1. electron-builder builds the NSIS installer and the portable exe
   **unsigned** (SignPath needs unsigned input) and does **not** publish them.
2. The two files are uploaded as a GitHub Actions artifact and submitted to
   SignPath as one signing request.
3. The job **blocks**, waiting for a SignPath project member (Rafael) to open
   the signing request and click approve. The job timeout is set to 3 hours
   to give real headroom for this; a quiet run where nobody needs to click
   anything (WIN_CSC_LINK, or no Windows signing configured at all) finishes
   in minutes as before.
4. Once approved, the action downloads the signed files, the workflow patches
   the auto-update feed's hash to match the now-signed bytes (see
   `electron/scripts/fix-update-feed-hash.js`; skipping this would silently
   break Windows auto-update the moment signing goes live), and publishes to
   the GitHub release exactly like macOS's separate gated publish step does.

**In practice:** after pushing a `v*` tag, check the SignPath dashboard (or
the email it sends) and approve the request within the 3-hour window. Missing
the window fails the Windows job; re-running the failed job from the Actions
UI submits a fresh signing request and does not require redoing the whole
release.

### Verify a Windows release is signed

**On Windows** (PowerShell):

```powershell
Get-AuthenticodeSignature .\pqp-0.1.8-x64.exe | Format-List *
```

Look for `Status : Valid`. `NotSigned` means a fallback path ran (WIN_CSC_LINK
absent too, or the run predates this PR); `HashMismatch` or `UnknownError`
means the binary or signature is corrupted, not merely unsigned.

**On macOS/Linux** (no PowerShell available), use `osslsigncode`, which reads
an Authenticode signature without needing Windows:

```bash
brew install osslsigncode   # or: apt install osslsigncode
osslsigncode verify pqp-0.1.8-x64.exe
```

Look for `Signature verification: ok` and the certificate chain printed below
it naming the publisher (SignPath Foundation). CI itself runs the equivalent
PowerShell check as the **"Verify Windows signing"** step in
`.github/workflows/electron.yml`, and it is a real gate: "Publish Windows
release assets" only runs when it succeeds (a genuinely unsigned build still
passes it, with a warning — that is a known state, not a broken one; an
invalid signature or a signed-but-missing `.exe` fails the job outright).
Windows no longer publishes from inside "Package Electron" the way it used to
for the WIN_CSC_LINK fallback — every Windows path, SignPath included, waits
for this step before anything reaches the release.

One known gap: the update feed's `.blockmap` (used for differential/delta
updates) still describes the unsigned bytes after signing, since only the
`sha512`/`size` fields get patched. `electron-updater` falls back to a full
download when a blockmap does not check out, so the effect of the first
signed release is a bigger download for people updating, not a broken one.

Linux builds are unsigned by convention; AppImage and `.deb` are shipped as-is.

---

## 5. Auto-update

**Wired**, via `electron-updater` against **GitHub Releases**.

Why GitHub Releases: CI already builds and uploads exactly these artifacts, the
repo is public so the feed needs no credentials, and electron-builder generates
and publishes `latest-mac.yml` / `latest.yml` / `latest-linux.yml` in the same
step that uploads the binaries. An R2 bucket would need a second public bucket,
credentials in CI, and a CDN origin to maintain — for a feed that is polled a
few times a day per install. Revisit if release traffic ever justifies it.

Implementation: [`electron/lib/updater.js`](../electron/lib/updater.js).

- **Never runs in development.** Guarded on `app.isPackaged`, so
  `pnpm electron:dev` does not poll a release feed. `PQP_DISABLE_AUTO_UPDATE=1`
  turns it off in a packaged build too.
- **Fails silently.** No network, DNS failure, a release still in draft — all
  land in the `error` handler and are logged, never dialogued. An update that
  did not happen is invisible; an error box about an unreachable release feed is
  a support ticket.
- **Downloads in the background, then asks.** This matches how the product
  already treats updates: the web client's `UpdatePrompt` never reloads on its
  own because the page holds a live WebSocket, a draft, and possibly a call.
  The shell applies the same rule — a native dialog with **Restart now** /
  **Later**. "Later" is a real answer: `autoInstallOnAppQuit` is on, so the
  staged update applies on the next ordinary quit with no second download and
  no further prompting.
- First check 10s after launch, then every 6 hours.

### macOS: signing and auto-update are one piece of work

The macOS updater is **Squirrel.Mac**, which verifies that the downloaded build
carries the same valid code signature as the running one. An unsigned or
ad-hoc-signed build **fails this check silently** — the update downloads, the
prompt appears, the user clicks Restart, and the app comes back on the old
version with nothing in any log the user can see.

So: there is no such thing as shipping auto-update before signing. §3 is a
prerequisite for §5, not a parallel task.

The `zip` target is what Squirrel.Mac consumes; `dmg` is only for the human
download. Both are built — do not drop `zip` from `mac.target`.

### Cutting a release

1. Bump `version` in **`electron/package.json`**. electron-updater compares
   against this value; a release whose tag is ahead of it will never be offered.
2. Commit, tag, push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. The workflow builds all three platforms and runs
   `electron-builder --publish always`, which creates a **draft** release and
   uploads binaries plus the `latest*.yml` feed files.
4. **Check the draft contains `latest-mac.yml`, `latest.yml` and
   `latest-linux.yml`** before publishing. Without them electron-updater reads
   the feed as "no updates available" forever, and it looks like nothing is
   wrong.
5. Publish the release. Existing installs pick it up within 6 hours.

A push to `main` builds but publishes nothing (`--publish never`), so ordinary
merges cannot rewrite the feed that installed apps are polling.

macOS ships **arm64 and x64** as separate artifacts. The `${arch}` in
`artifactName` is load-bearing: electron-updater selects the right file by
matching the architecture in the filename. Removing it makes Intel Macs
download an Apple Silicon build.

---

## 6. Launch checklist

- [ ] `CORS_ALLOWED_ORIGINS`, `CLERK_AUTHORIZED_PARTIES` and the Clerk dashboard
      all list `https://pqp.gg`.
- [ ] `DEFAULT_PROD_URL` in `electron/main.js` matches the live domain.
- [ ] `CSC_LINK` + `CSC_KEY_PASSWORD` set; a tagged build shows no
      `::warning::` about unsigned macOS.
- [ ] Notarization secrets set; `spctl -a -vvv` prints
      `source=Notarized Developer ID`.
- [ ] SignPath secrets/variables set (§4); the SignPath signing request for
      this tag was approved, a tagged build shows no `::warning::` about
      unsigned Windows, and `Get-AuthenticodeSignature` / `osslsigncode
      verify` on the `.exe` prints `Valid` / `Signature verification: ok`.
- [ ] `electron/package.json` `version` bumped to match the tag.
- [ ] Draft release contains the `latest*.yml` feed files.
- [ ] Sign in on a signed build. Current shells open the system browser
      (`/desktop-login`) and hand a one-shot ticket back over `127.0.0.1`.
      Confirm Google and Apple (and email) finish there, then land in the
      app. Old shells still use the in-app Clerk modal; for those, each
      social provider must stay in `AUTH_HOST_SUFFIXES`
      (`electron/lib/nav-policy.js`). Game-connection hops still use that
      list.
- [ ] Join a voice channel and confirm the mic prompt appears and audio flows.
- [ ] Share a screen **and** a single window from the picker. On Windows tick
      "share this computer's sound" and confirm the room hears the machine and
      does **not** hear itself. On macOS confirm the grant prompt appears the
      first time, and that a share goes ahead silently rather than failing.
- [ ] Start a watch party from the app (not the browser) and confirm the picker
      opens and the stream starts. That is the 13 Sep 2026 regression.
- [ ] `pqp://` deep link from a browser focuses the app on the right route.
- [ ] Install an older version, publish a newer one, confirm the update prompt
      appears and Restart actually lands on the new version.
