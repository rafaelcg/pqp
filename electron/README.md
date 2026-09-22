# Electron shell

Desktop wrapper around the pqp web client. No duplicate UI — loads the same React app with a secure Electron main process.

## Quick start (dev)

From the **repo root**, start the web stack, then the shell:

```bash
# Terminal 1 — client + server
pnpm dev

# Terminal 2 — Electron (waits for Vite, then opens /app)
pnpm electron:dev
```

Or from this package:

```bash
pnpm --filter @pqp/electron install
pnpm --filter @pqp/electron dev
```

The main process polls Vite at `http://localhost:5173` until it responds, then loads **`http://localhost:5173/app`** (the main app, not the marketing landing page).

## Environment

| Variable | Purpose |
|---|---|
| `VITE_APP_URL` / `PQP_APP_URL` | Remote or local URL to load (takes precedence over static). Root paths (`/`) are rewritten to `/app`. |
| `PQP_LOAD_STATIC=1` | Serve a built client from disk over a local loopback server (opens `/app`). Opt-in only — see below. |
| `PQP_DISABLE_AUTO_UPDATE=1` | Turn off the shell's update check in a packaged build |

A **packaged build loads the hosted app** (`DEFAULT_PROD_URL` in `main.js`, currently `https://pqp.gg/app`), not the client bundled into `resources/client`.

That is a hard requirement, not a preference: the loopback static server binds an **ephemeral** port, so its origin changes on every launch, and the production API's CORS allowlist (`CORS_ALLOWED_ORIGINS`) plus Clerk's allowed origins and `azp` check are all origin-shaped. A packaged build serving itself would render and then fail every API call — in production only, because the allowlist falls open to `*` when the env var is unset, which is the local-dev configuration. Full reasoning in [`docs/DESKTOP.md`](../docs/DESKTOP.md).

`PQP_LOAD_STATIC=1` stays for offline / self-host use, where the operator controls the allowlist.

Examples:

```bash
# Dev against Vite → http://localhost:5173/app (default)
pnpm electron:dev

# Point at a deployed instance (root becomes /app)
PQP_APP_URL=https://pqp.gg pnpm electron:dev
# → loads https://pqp.gg/app

# Explicit path is preserved
PQP_APP_URL=https://pqp.gg/app pnpm electron:dev

# Packaged-style local static (build client first)
pnpm --filter @pqp/client build
PQP_LOAD_STATIC=1 pnpm electron:dev
# → http://127.0.0.1:<port>/app
```

## Window chrome

On **macOS**, the shell uses `titleBarStyle: "hiddenInset"` (traffic lights only). The React app draws a slim drag region when `window.pqpDesktop.hasCustomTitleBar` is true.

On Windows / Linux, the native title bar is kept (minimal).

## Global push-to-talk

The web client can only hear a key while its window is focused, so browser
push-to-talk stops the moment you alt-tab into a game. The shell offers two
mechanisms, both feature-detected and layered so nothing regresses:

### Tier 2: the native hook (`bindPushToTalkNative`)

`lib/native-ptt-hook.js` wraps `uiohook-napi`, a real global keyboard/mouse
hook (an N-API binding over libuiohook, ships prebuilt binaries for every
target platform, no compiler needed at install or package time). Real
key-down / key-up and mouse-button-down/up, not an inference:

- The renderer sends the full binding (device, code, chord, plus the
  Electron-accelerator spelling for the fallback below) and a release-delay
  in milliseconds to `pqpDesktop.bindPushToTalkNative(binding, releaseDelayMs)`.
  Main tries the native hook first and falls back to `globalShortcut` itself
  when the hook is unavailable, denied, or the binding is a mouse button (see
  below); the promise resolves `{ registered, via: "native" | "shortcut" | "none", reason? }`.
- `lib/release-delay.js` is the whole point of the upgrade: after the
  PHYSICAL release, the mic stays open for a configurable delay (default
  20 ms, 0-2000 ms, `settings.voice.pttReleaseDelay` in Voice & Video) before
  actually closing, so word endings do not get clipped. A press inside that
  window cancels the pending release: a quick up-then-down never closes the
  mic in between. This is Discord's own model.
- **Mouse buttons.** `uiohook-napi` reports mouse buttons too, so PTT can be
  bound to middle click or either of the two "extra" side buttons a mouse
  ships (`electron/lib/uiohook-key-map.js`, `BINDABLE_MOUSE_CODES` in
  `client/src/components/voice/push-to-talk.ts`). Left and right click are
  never offered, since binding either would make ordinary clicking a
  transmission. A mouse binding has no `globalShortcut` equivalent at all
  (there is no such thing as a "global mouse shortcut" API), so it only ever
  works out-of-window through the native hook; in-window it works everywhere,
  including the web, via plain `mousedown`/`mouseup`.
- **The hook is held only while the app window is NOT focused**, the exact
  same rule `globalShortcut` already followed, for the same reason: a
  registered global hook swallows the key/button system-wide, our own
  renderer included, and the renderer's own down/up pair is the precise one.
  `main.js`'s `syncNativePushToTalk` runs on every focus/blur.
- **uiohook-napi issue #54.** On Windows there is a reported case where the
  low-level keyboard hook stops delivering events once `getUserMedia()`
  starts capturing the microphone *while the window that called it is
  focused*. The focus rule above means this never has a window to occur in
  for us: the hook only runs while unfocused, and a focused mic capture is
  never racing it for the same keystroke. This is a structural argument, not
  a verified fix; nobody on this change reproduced #54 on real Windows
  hardware to confirm it.
- **macOS permission.** Global key/mouse capture needs **Accessibility**
  under Privacy & Security: libuiohook refuses to start without it
  ("Accessibility API is disabled", verified 2026-09-23), and Input
  Monitoring may be asked for as well. The settings dialog checks silently
  (`systemPreferences.isTrustedAccessibilityClient(false)`; Electron has
  **no** query API for Input Monitoring at all) and shows an in-app nudge
  whose button first calls `isTrustedAccessibilityClient(true)`, which is
  what makes macOS list pqp in the Accessibility pane at all (an app that
  never asked with the prompt flag is simply absent from it), then
  deep-links to both panes (`pqpDesktop.openPttPermissionSettings()`,
  `MAC_ACCESSIBILITY_SETTINGS_URL` / `MAC_INPUT_MONITORING_SETTINGS_URL`).
  It never fails silently: a denied/unknown permission still tries the
  `globalShortcut` fallback for a keyboard binding, and the UI says which
  mechanism (if any) is actually holding the key
  (`settings.voice.pttHintDesktop*` strings).
- **Linux/Wayland.** libuiohook has no Wayland backend at all (its source
  tree has only `x11`, `darwin` and `windows` implementations), and the
  compositors that matter (GNOME, KDE) deliberately restrict the legacy X11
  global-input extensions XWayland would otherwise relay, for the reason
  Wayland exists in the first place. `nativeHookPlatformSupport` detects a
  Wayland session (`XDG_SESSION_TYPE` / `WAYLAND_DISPLAY`) and refuses
  outright rather than trying and silently receiving nothing; the settings
  UI says so and suggests Voice Activity mode instead. Same ceiling Discord
  hits. Linux/X11 has no such gate.
- **Packaging.** `uiohook-napi` is a native addon; `asarUnpack` in
  `package.json` keeps its whole directory out of the asar archive (a native
  `.node` binary cannot `dlopen` from inside one), and `npmRebuild: false`
  stops electron-builder from trying to recompile it from source, since it ships
  N-API prebuilds for every target platform already, which is the entire
  point of choosing it, and compiling for another OS from this host would
  not work anyway.

### Tier 1 fallback: `globalShortcut` (`bindPushToTalk`)

Kept exactly as it was, verbatim, for two reasons: it is what runs when the
native hook is unavailable/denied/unsupported on a keyboard binding, and it
is the whole bridge a shell built before `bindPushToTalkNative` existed still
offers. The packaged shell loads the *hosted* client, so a client deployed
today can be running inside a shell built weeks ago, and that shell must keep
working exactly as it always did.

- The renderer converts its binding (a `KeyboardEvent.code` plus a chord) into
  an Electron accelerator (`client/src/components/voice/push-to-talk-accelerator.ts`)
  and calls `pqpDesktop.bindPushToTalk(accelerator)`. It resolves `false` when
  the OS refuses the key, and the client silently stays in-window only.
- Rebinding calls it again; `null` gives the key back. `will-quit` unregisters
  everything.
- **The accelerator is held only while the app window is NOT focused**, same
  rule as above.
- **`globalShortcut` reports key-down and nothing else.** There is no key-up
  and no way to poll. `lib/global-ptt.js` infers the release from auto-repeat:
  the first press engages, repeats extend the deadline, and a gap ends the
  transmission. A tap therefore holds the mic for up to ~1.1 s (the initial
  repeat delay every OS applies), and a held key lets go ~250 ms after the
  finger. On a desktop that does not repeat global hotkeys at all, a hold is a
  single ~1.1 s pulse. This is exactly the crudeness Tier 2 exists to fix.

**macOS.** `globalShortcut` does **not** need the Accessibility permission (it
uses Carbon hotkeys, not an event tap), so there is no TCC prompt and nothing
to grant on this tier specifically. What it *is* subject to is conflicts: a
key the system or another app already owns cannot be registered, `register`
returns false, and pqp falls back to in-window PTT rather than pretending.
Cmd chords collide with system shortcuts most often; the default `` ` ``
binding does not.

**Modifier-only bindings** (Left Ctrl on its own) are the one case where the
two tiers genuinely differ in reach. `globalShortcut` requires a
non-modifier key, so on the Tier 1 fallback a modifier held alone only ever
works in-window. The native hook has no such limit: `uiohook-napi` reports
a bare modifier's own down/up like any other key, and `matchesEngage` /
`matchesRelease` in `lib/native-ptt-hook.js` special-case a modifier code the
same way the renderer's `isModifierCode` does, so on Tier 2 a modifier held
alone works globally too, wherever the hook itself is available.

## Global mute/deafen hotkeys

Toggle Mute and Toggle Deafen (`pqpDesktop.bindGlobalVoiceHotkeys`) work the
same way, minus the hold-tracking PTT needs:

- While connected to a call, the renderer converts its current toggle-mute
  and toggle-deafen key bindings into Electron accelerators (the same
  `push-to-talk-accelerator.ts` conversion, generalized in
  `client/src/lib/global-voice-hotkeys.ts`) and calls
  `bindGlobalVoiceHotkeys({ toggleMute, toggleDeafen })`. Leaving the call, or
  a rebind in Settings, sends `null` for whichever accelerator no longer
  applies.
- **Held only while the app window is NOT focused**, exactly like
  push-to-talk, and for the same reason: a registered `globalShortcut` is
  swallowed system-wide. While focused, the app menu's fixed
  Cmd/Ctrl+Shift+M/D or the renderer's own key listener (for a remap) already
  owns the chord, so letting the global registration go is what stops one
  press from toggling twice.
- **No release to infer.** These are plain toggles: each accelerator is a
  single `globalShortcut.register(accel, cb)` that fires `pqp:voice-command`
  once per press (`main.js` `syncGlobalVoiceHotkeys` / `setGlobalVoiceHotkeys`),
  the same channel the tray menu already sends. There is no hold tracker
  involved, unlike push-to-talk's auto-repeat inference above.
- **Gated to calls.** Registering a global accelerator swallows it for every
  other application too, so the shell only holds it while `inCall`. Someone
  who is not in a voice channel never loses Cmd/Ctrl+Shift+M to pqp.
- A key another app already owns, or a modifier-only remap, behaves exactly
  like push-to-talk's equivalent case: `register` (or the probe while
  focused) returns `false` for that action and it stays in-window only.

## Tray

`lib/tray-icon.js` paints four 16 px glyphs (idle, live, muted, deafened) at 1x
and 2x and encodes them as PNG at runtime — template images on macOS, colour
elsewhere, with a red slash on mute and deafen. No binaries to commit.

The menu (`lib/tray-menu.js`, strings in `locales/`) is: call state, mute /
unmute, deafen / undeafen, leave call, show window, "keep in tray while in a
call", quit. Mute, deafen and leave are IPC to the renderer
(`pqpDesktop.onVoiceCommand`) and are greyed out when no call is up. The
renderer mirrors its call state back with `pqpDesktop.setVoiceState`, which is
what repaints the icon.

Closing the window **during a call** hides to the tray instead of quitting,
because quitting hangs up. Out of a call, and whenever the tray checkbox is
off, close behaves as it always did. The preference lives in
`userData/tray.json` and is toggled from the tray menu.

## Screen sharing

`getDisplayMedia` in the renderer resolves nothing until the main process answers it, so the shell owns "which surface?" entirely (`setDisplayMediaRequestHandler` in `main.js`).

One path, on purpose. From 0.1.6 the handler is registered with **`useSystemPicker: false`** and answers every request on every platform with our own picker (`electron/picker/`).

It used to be `true`, which reads as "prefer the nicer native list on macOS 15+" and means "on macOS none of the code below runs": Electron does not call the handler at all when the OS picker takes over, so the screen-recording diagnosis, the labels, the auto-pick and the loopback mapping were unreachable there and `lib/display-sources.test.mjs` was testing a path that platform never took. It also let the renderer's request reach Chromium untouched, which is how an audio ask macOS has no device for took the video with it (3 Sep 2026), and how a request for a surface this embedder does not have (a browser tab, which a watch party asks for) failed the whole capture with "Invalid capture constraints" (13 Sep 2026).

The trade: macOS now needs the Screen Recording grant, which the OS picker could do without. `screenPermission` opens the right pane when it is missing. Flipping the option back to `true` is the one-line rollback.

Our picker is a small `file://` window owned by the shell, **not** a React screen in the client. The packaged shell loads the *hosted* client, so a picker over there would mean the main process waiting on a reply from a renderer that may have been deployed before the message existed, and a reply that never comes is a `getDisplayMedia` that never settles. Version skew between the two is normal here; a page inside the bundle cannot skew.

| Piece | File |
|---|---|
| Listing, permission, labels, callback payload | `lib/display-sources.js` (unit-tested, no display needed) |
| Picker page | `picker/index.html`, `picker/picker.js`, `picker/picker.css` |
| Picker bridge (`window.pqpPicker`, separate from `pqpDesktop`) | `picker/preload.js` |
| Copy (`share.*`, en + pt-BR) | `locales/` |

Notes:

- Sources are fetched as `["screen", "window"]` with thumbnails. Thumbnails are not decoration: several windows routinely share a title and the picture is the only way to tell them apart.
- The first surface (the primary display) is preselected and **Share** is focused, so a one-monitor user presses Enter.
- A list of exactly one surface skips the picker entirely (Wayland portals hand back one pre-picked surface).
- Cancelling, Escape, and closing the window all answer `null`, which Chromium turns into `NotAllowedError`, which the client already words as "blocked or cancelled".
- **macOS screen recording**: `desktopCapturer` does not fail without it, it returns a plausible list of nothing useful. The status is read again *after* listing (the listing is what raises the OS prompt) and a dialog offers `x-apple.systempreferences:…Privacy_ScreenCapture`. The grant only takes effect after a relaunch, and the copy says so.
- Loopback audio is Windows-only in Chromium. Asking for it elsewhere fails the whole request rather than degrading to a silent share. The picker's own checkbox is the consent; `captureResponse` ANDs it with what the page asked for. `loopbackWithMute` is never used: it silences the machine while it taps it, so the presenter loses the call and the film. Keeping *our* audio out of the tap is `restrictOwnAudio`, which Electron 43.4+ turns into `loopbackWithoutChrome`.
- The renderer is told all of this rather than guessing it: `preload.js` publishes `capabilities` (`displayMedia`, `systemAudio`, `restrictOwnAudio`, `pickerOffersAudio`, `version`) and the client reads it in `client/src/lib/screen-capture-audio.ts`. `lib/share-capabilities.test.mjs` fails if a promise there stops matching this binary (an Electron downgrade below 43.4, a `loopbackWithMute`, a system picker creeping back).
- `picker/**/*` is in `build.files`. Leaving it out ships a shell whose picker cannot load.

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Preload exposes only `window.pqpDesktop` (mute toggle, deep-link helpers, desktop auth)
- External `window.open` / off-origin navigations open in the system browser
- Sign-in / sign-up on a current shell open the system browser (`/desktop-login`) and return via a one-shot `127.0.0.1` listener. Old shells have no `startDesktopAuth` and keep the in-app Clerk modal. MFA (TOTP / SMS / backup codes) is completed in the renderer after the ticket lands; `needs_client_trust` falls back to the in-app Clerk modal.
- The four desktop-auth `ipcMain.handle` channels refuse callers whose `event.senderFrame` origin is not the loaded app origin. Game-connection hosts reuse this preload in-window and must not mint or read a ticket.
- Exception: game-connection OAuth hosts (`lib/nav-policy.js`) still navigate in-window. A provider missing from `AUTH_HOST_SUFFIXES` bounces to the system browser and the session lands in the wrong place.
- Local static mode serves on `127.0.0.1` with a restrictive CSP
- Remote URLs keep the server’s own CSP (Electron does not rewrite it)
- Media / notification permissions are allowlisted for voice UX; on macOS the shell also requests the *system* mic/camera permission (`systemPreferences.askForMediaAccess`), which is separate from the Chromium one and fails silently when missing

### Renderer bridge

```ts
interface PqpDesktop {
  platform: NodeJS.Platform;
  isElectron: true;
  hasCustomTitleBar: boolean;
  onToggleMute(cb: () => void): () => void;
  onToggleDeafen?(cb: () => void): () => void;
  onDeepLink(cb: (appPath: string) => void): () => void;
  getPendingDeepLink(): Promise<string | null>;
  startDesktopAuth?(mode: "sign-in" | "sign-up"): Promise<{ ok: boolean; url: string }>;
  cancelDesktopAuth?(): Promise<void>;
  getDesktopAuthStatus?(): Promise<{ active: boolean; url: string | null }>;
  getPendingDesktopAuthTicket?(): Promise<string | null>;
  onDesktopAuthTicket?(cb: (ticket: string) => void): () => void;
  onDesktopAuthEnded?(cb: (reason: "expired" | "cancelled") => void): () => void;
}

declare global {
  interface Window {
    pqpDesktop?: PqpDesktop;
  }
}
```

Mute accelerator: **Cmd/Ctrl+Shift+M** (View → Toggle Mute). Deafen: **Cmd/Ctrl+Shift+D**. The client toggles when connected to a voice channel. Remapped chords live in the renderer; the menu keeps the Discord defaults.

## Deep links (`pqp://`)

Protocol `pqp://` is registered via `app.setAsDefaultProtocolClient` and electron-builder `protocols` / macOS `CFBundleURLTypes`.

- macOS: `open-url` event
- Windows / Linux: second-instance argv

Deep links are mapped to **`/app/...`** (never marketing `/`):

| Deep link | In-app path |
|---|---|
| `pqp://` / `pqp://open` | `/app` |
| `pqp://server/<id>/channel/<id>` | `/app/server/<id>/channel/<id>` |
| `pqp://invite/<code>` | `/app/invite/<code>` |

The main process sends the mapped path over IPC; the React router navigates there.

> On macOS, unsigned / non-notarized builds may need Gatekeeper approval; protocol registration works for local/dev installs but distribution still needs signing for a smooth UX.

## Packaging

Local builds are always unsigned — signing happens in CI from secrets. See [`docs/DESKTOP.md`](../docs/DESKTOP.md) for signing, notarization and releases.

```bash
# Build the web client into client/dist (copied as extraResources)
pnpm --filter @pqp/client build

cd electron
pnpm install
pnpm run dist          # current platform
pnpm run dist:mac      # dmg + zip, arm64 + x64
pnpm run dist:win      # nsis + portable
pnpm run dist:linux    # AppImage + deb
pnpm run pack          # unpacked dir only (faster smoke test)
pnpm run icons         # regenerate build/icon.{icns,ico,png} from the SVGs (macOS)
```

`pnpm pack` is pnpm's own tarball command — use `pnpm run pack`.

Artifacts land in `electron/release/`.

`CSC_IDENTITY_AUTO_DISCOVERY=false` in every script is what skips code signing locally; macOS will show an "unidentified developer" prompt (right-click → Open, or `xattr -cr`).

Packaged apps load the hosted app (see **Environment** above). `resources/client` is still shipped and used when `PQP_LOAD_STATIC=1`.

**The one native dependency, `uiohook-napi`** (global push-to-talk hook, see above): ships prebuilt N-API binaries for win/mac/linux, so nothing here needs a C++ toolchain. `pnpm install` on any host is enough: `node-gyp-build`, its install script, only verifies the right prebuild is present, and pnpm's workspace `allowBuilds` list has to say so explicitly (pnpm 10 blocks unlisted install scripts by default; see `pnpm-workspace.yaml`). `build.asarUnpack` keeps the whole module out of the asar archive (a native `.node` file cannot `dlopen` from inside one) and `build.npmRebuild: false` stops electron-builder from trying to recompile it for the Electron ABI, unnecessary for an N-API module, and it would not cross-compile for another OS from this host regardless. Building `dist:win` / `dist:linux` from a macOS host still works because every platform's prebuild already ships inside the one npm package; nothing is fetched per-target.

## Electron-ready client conventions

- `VITE_API_URL` / `VITE_WS_URL` — absolute backend URLs when not same-origin
- No `window`-only assumptions in core hooks (`lib/api.ts`, `lib/realtime.ts`)
- Clerk: add the desktop origin (and `http://127.0.0.1:*` for static mode if used) to allowed origins
- Detect `window.pqpDesktop?.isElectron` for desktop-only UX (title bar, mute IPC, deep links)
- Feature-detect each bridge method, never the shell version: `bindPushToTalk`, `onPushToTalk`, `bindPushToTalkNative`, `onPushToTalkNative`, `getPttPermissionStatus`, `openPttPermissionSettings`, `getPttNativeCapability`, `bindGlobalVoiceHotkeys`, `setVoiceState` and `onVoiceCommand` are absent in a browser **and** in shells built before they landed, and the packaged shell loads the hosted client, so a client deployed today runs inside a shell built weeks ago

## Remaining gaps

| Item | Status |
|---|---|
| Code signing (macOS) | Wired in CI; needs `CSC_LINK` / `CSC_KEY_PASSWORD` secrets — [`docs/DESKTOP.md`](../docs/DESKTOP.md) |
| Notarization (macOS) | Wired in CI; needs the App Store Connect API key (or Apple ID) secrets |
| Code signing (Windows) | Not configured — SmartScreen warns. Needs an OV/EV cert; `WIN_CSC_LINK` is already read |
| Auto-update | Implemented (`lib/updater.js`, electron-updater → GitHub Releases). macOS updates need a signed build |
| App icons | `build/icon.{icns,ico,png}`, generated from `build/*.svg` |
| Bundled client origin | Loopback static mode cannot satisfy a production CORS allowlist; the fix is a stable `app://` protocol |
| Tray, minimize to tray during a call | Implemented (`lib/tray-icon.js`, `lib/tray-menu.js`, `lib/tray-state.js`) |
| Global push-to-talk | Tier 2 implemented (`lib/native-ptt-hook.js`, `uiohook-napi`): real key/mouse down-up, configurable release delay, mouse-button binding, macOS permission nudge; Wayland has no native-capture backend at all (documented, falls back). Tier 1 fallback kept verbatim (`lib/global-ptt.js`, release inferred from auto-repeat) for an unavailable/denied hook and for a shell built before Tier 2 landed |
| Global mute/deafen hotkeys | Implemented; plain toggles, no release to infer, gated to calls, see above |
| Start at login | Implemented (`lib/login-item.js`, Settings → Appearance). macOS and Windows only, Electron has no Linux login-item API |
| Native notifications, click-through, taskbar/dock flash | Implemented (`showNotification` in `main.js`, IPC via `pqpDesktop.notify` / `onNotificationClick`). Message and mention banners were already wired end to end (`client/src/lib/notifications.ts`); an incoming DM/group call rang the in-app card and the ringtone only, with nothing for a backgrounded window — `notifyIncomingCall` closes that gap. `flashFrame` bounces the dock / flashes the taskbar on any native banner shown while unfocused, cleared on refocus |
| Deep-link → select server/channel state | Path navigates to `/app/...`; selection state still in-memory |
