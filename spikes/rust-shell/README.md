# Rust desktop spike (2026-11-05)

Throwaway measurement code, not product code. Nothing here is wired into the
workspace, CI, or any build. The question it answers: would moving the desktop
app off Electron (to a Tauri shell or a native GPUI client) make pqp faster,
and by how much, compared with fixing the web client?

| Directory | What it is |
|---|---|
| `bench/electron-bench.mjs` | Launches the real `electron/main.js` (unchanged) through Playwright against a local build, and measures startup, memory, idle CPU, channel switches, a 2000-row history and joining a call |
| `bench/electron-profile.mjs` | CPU and sampled-heap profiles of the same hot spots (run against an unminified build) |
| `bench/electron-retention.mjs` | Whether a channel's memory comes back after leaving it (forced GC) |
| `gpui-chat/` | A native GPUI (Zed's UI framework) window that reads the same channels from the same local API and draws them in a virtualized list |
| `bench/gpui-bench.mjs` | Drives `gpui-chat` over stdin through the same steps |
| `tauri-shell/` | The same web client in a Tauri 2 window (WKWebView on macOS), with `src/probe.js` injected to report timings and WebRTC capabilities |
| `bench/tauri-bench.mjs` | Collector and driver for `tauri-shell`; counts the WebKit helper processes too |
| `bench/footprint.mjs` | macOS `phys_footprint` per process (what Activity Monitor shows), so Chromium and WebKit helpers are compared fairly |

## Running it

Local stack per `CLAUDE.md` with the dev auth bypass, then a production build
of the client served on a fixed port:

```bash
createdb pqp_rustspike
DATABASE_URL=postgresql://$USER@127.0.0.1:5432/pqp_rustspike PORT=3011 DEV_AUTH_BYPASS=true \
  pnpm --filter @pqp/server exec tsx src/index.ts
# seed 5000 messages into the Sandbox's off-topic channel:
psql pqp_rustspike -c "INSERT INTO messages (channel_id, author_id, body, created_at)
  SELECT '<off-topic id>', (SELECT user_id FROM server_members ORDER BY user_id OFFSET (g % 16) LIMIT 1),
    CASE g % 7 WHEN 0 THEN 'mensagem ' || g || ' com **negrito** e um \`codigo inline\`'
      WHEN 1 THEN 'alguém joga hoje? ' || g
      WHEN 2 THEN E'bloco de código:\n\`\`\`ts\nconst x = ' || g || E';\nconsole.log(x)\n\`\`\`'
      WHEN 3 THEN 'uma mensagem mais longa, número ' || g || ', com texto bastante para quebrar a linha duas ou três vezes em uma janela normal de desktop.'
      WHEN 4 THEN '> citação ' || g || E'\nresposta embaixo'
      WHEN 5 THEN 'kkkkkkk' ELSE E'- item a\n- item b ' || g END,
    now() - ((5000 - g) * interval '20 seconds')
  FROM generate_series(1, 5000) g"
VITE_DEV_AUTH_BYPASS=true VITE_API_URL=http://localhost:3011 VITE_WS_URL=ws://localhost:3011/ws \
  pnpm --filter @pqp/client exec vite build --outDir /tmp/pqp-dist
pnpm --filter @pqp/client exec vite preview --outDir /tmp/pqp-dist --port 4183 --strictPort --host 127.0.0.1
```

Electron:

```bash
BENCH_SERVER_ID=<sandbox id> BENCH_LIGHT_CHANNEL=<general id> BENCH_HEAVY_CHANNEL=<off-topic id> \
  node spikes/rust-shell/bench/electron-bench.mjs full        # or startup-cold 5 / startup-warm 5
```

GPUI (needs a Rust toolchain; `runtime_shaders` is on because Xcode 26 ships the
offline Metal compiler as a separate download):

```bash
cd spikes/rust-shell/gpui-chat && cargo build --release
GPUI_BIN=target/release/pqp-gpui-spike PQP_SERVER_ID=<sandbox id> \
  node ../bench/gpui-bench.mjs full                            # or startup 5
```

Tauri (built with plain `cargo`, no Tauri CLI; `Info.plist` is embedded into
the binary in this mode, and WKWebView hides `navigator.mediaDevices` entirely
without its microphone and camera keys):

```bash
cd spikes/rust-shell/tauri-shell && cargo build --release
TAURI_BIN=target/release/pqp-tauri-spike \
PQP_APP_URL="http://127.0.0.1:4183/app/server/<sandbox id>/channel/<general id>?lang=en" \
  node ../bench/tauri-bench.mjs probe                          # or startup 5 / full
```

The screen must be unlocked and awake: GPUI draws nothing and WebKit throttles
timers while the session is locked, which turns every timing into noise.
