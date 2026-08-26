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

### Consequence for update cadence

Because the shell loads the hosted client, **the product updates itself on
reload.** A web deploy reaches every desktop user through the service-worker
prompt (`client/src/components/layout/update-prompt.tsx`), same as the browser.
Auto-update (§5) only ships changes to the *shell* — main process, menus, deep
links, permissions, entitlements. That is a much rarer event, which is why the
shell updater is allowed to be patient.

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
(the `altool` path is deprecated and being turned off); electron-builder 25 uses
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
| `network.client` / `network.server` | API, WS, WebRTC; loopback static server |
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

---

## 4. Windows

Builds are **unsigned**. SmartScreen shows "Windows protected your PC" on first
run until the download builds reputation. Acceptable for launch; the app works.

To fix it later, the workflow already reads `WIN_CSC_LINK` /
`WIN_CSC_KEY_PASSWORD` (deliberately separate names — `CSC_LINK` is scoped to
the mac job so an Apple .p12 can never reach the Windows signer). What it needs:

- An **OV** code-signing certificate (~$200–400/yr, DigiCert / Sectigo / SSL.com).
  Cheapest path, but it does *not* clear SmartScreen immediately — reputation
  still has to accrue.
- Or an **EV** certificate (~$400–700/yr), which clears SmartScreen from the
  first signed build. Since June 2023 the private key must live on hardware
  (HSM/token) or in a cloud signing service, so it cannot simply be exported to
  a `.p12` and pasted into a GitHub secret — CI signing needs the provider's
  cloud service (e.g. DigiCert KeyLocker, SSL.com eSigner) and a different
  electron-builder configuration (`win.sign` hook).
- Either way the organisation must be verifiable — an EV certificate is issued
  to a legal entity, not a person.

Not a launch blocker. Revisit if Windows becomes a meaningful share of installs.

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
- [ ] `electron/package.json` `version` bumped to match the tag.
- [ ] Draft release contains the `latest*.yml` feed files.
- [ ] Sign in on a signed build. In particular **sign in with each social
      provider that is enabled in Clerk** — a provider redirects the top-level
      window off-origin, and the shell only permits that for the hosts in
      `AUTH_HOST_SUFFIXES` (`electron/lib/nav-policy.js`). A provider missing
      from that list bounces the user into the system browser mid-sign-in and
      the session lands in the wrong place. Add its host if so.
- [ ] Join a voice channel and confirm the mic prompt appears and audio flows.
- [ ] `pqp://` deep link from a browser focuses the app on the right route.
- [ ] Install an older version, publish a newer one, confirm the update prompt
      appears and Restart actually lands on the new version.
