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

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Preload exposes only `window.pqpDesktop` (mute toggle + deep-link helpers)
- External `window.open` / off-origin navigations open in the system browser
- Exception: auth hosts (`lib/nav-policy.js`) navigate in-window and may open a popup — a Clerk / OAuth redirect that finished in the system browser would put the session in the wrong place. Adding a social provider in Clerk may mean adding its host to `AUTH_HOST_SUFFIXES`.
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
  onDeepLink(cb: (appPath: string) => void): () => void;
  getPendingDeepLink(): Promise<string | null>;
}

declare global {
  interface Window {
    pqpDesktop?: PqpDesktop;
  }
}
```

Mute accelerator: **Cmd/Ctrl+Shift+M** (View → Toggle Mute). The client toggles mute when connected to a voice channel.

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

## Electron-ready client conventions

- `VITE_API_URL` / `VITE_WS_URL` — absolute backend URLs when not same-origin
- No `window`-only assumptions in core hooks (`lib/api.ts`, `lib/realtime.ts`)
- Clerk: add the desktop origin (and `http://127.0.0.1:*` for static mode if used) to allowed origins
- Detect `window.pqpDesktop?.isElectron` for desktop-only UX (title bar, mute IPC, deep links)

## Remaining gaps

| Item | Status |
|---|---|
| Code signing (macOS) | Wired in CI; needs `CSC_LINK` / `CSC_KEY_PASSWORD` secrets — [`docs/DESKTOP.md`](../docs/DESKTOP.md) |
| Notarization (macOS) | Wired in CI; needs the App Store Connect API key (or Apple ID) secrets |
| Code signing (Windows) | Not configured — SmartScreen warns. Needs an OV/EV cert; `WIN_CSC_LINK` is already read |
| Auto-update | Implemented (`lib/updater.js`, electron-updater → GitHub Releases). macOS updates need a signed build |
| App icons | `build/icon.{icns,ico,png}`, generated from `build/*.svg` |
| Bundled client origin | Loopback static mode cannot satisfy a production CORS allowlist; the fix is a stable `app://` protocol |
| Tray / push-to-talk | Future |
| Native notifications deep-link | Future |
| Deep-link → select server/channel state | Path navigates to `/app/...`; selection state still in-memory |
