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
| `PQP_LOAD_STATIC=1` | Force loading a built client from disk via a local loopback server (opens `/app`) |
| `PQP_LOAD_STATIC=0` | Never use static; always use URL |

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
- Local static mode serves on `127.0.0.1` with a restrictive CSP
- Remote URLs keep the server’s own CSP (Electron does not rewrite it)
- Media / notification permissions are allowlisted for voice UX

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

Unsigned builds (no Apple notarization / Windows cert required):

```bash
# Build the web client into client/dist (copied as extraResources)
pnpm --filter @pqp/client build

cd electron
pnpm install
pnpm dist          # current platform
pnpm dist:mac      # dmg + zip
pnpm dist:win      # nsis + portable
pnpm dist:linux    # AppImage + deb
pnpm pack          # unpacked dir only (faster smoke test)
```

Artifacts land in `electron/release/`.

`CSC_IDENTITY_AUTO_DISCOVERY=false` and `mac.identity: null` skip code signing. macOS users will see an “unidentified developer” prompt (right-click → Open, or `xattr -cr`).

Packaged apps load `resources/client` over a loopback HTTP server at **`/app`** when no `PQP_APP_URL` is set. To ship a thin shell that only loads a remote host, set `PQP_APP_URL` at runtime or omit `client/dist` and always pass a URL.

## Electron-ready client conventions

- `VITE_API_URL` / `VITE_WS_URL` — absolute backend URLs when not same-origin
- No `window`-only assumptions in core hooks (`lib/api.ts`, `lib/realtime.ts`)
- Clerk: add the desktop origin (and `http://127.0.0.1:*` for static mode if used) to allowed origins
- Detect `window.pqpDesktop?.isElectron` for desktop-only UX (title bar, mute IPC, deep links)

## Remaining gaps

| Item | Status |
|---|---|
| Code signing (Apple / Windows) | Not configured — needs certs + CI secrets |
| Notarization (macOS) | Not configured — paid Apple Developer account |
| Auto-update | Not implemented (electron-updater / forge publishers) |
| App icons | No custom `.icns` / `.ico` yet (`build/` optional) |
| Tray / push-to-talk | Future |
| Native notifications deep-link | Future |
| Deep-link → select server/channel state | Path navigates to `/app/...`; selection state still in-memory |
