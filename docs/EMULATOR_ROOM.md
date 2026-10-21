# The emulator room

A first, deliberately small emulator: **one person, one window, a game file
from their own disk**. Behind the runtime flag `emulator_room` (per server,
default off, see `docs/FEATURE_FLAGS.md`).

**Do not turn the flag on until the lawyer review at the bottom of this page is
done.** Nobody should flip it from the dashboard just because it is there.

## The rules

These are decisions, not preferences. A change that breaks one is a different
feature and needs its own review.

1. **pqp provides no game.** The repository, the app, the CDN and the servers
   never contain, fetch, link to, search for or name any ROM or game image. The
   room does not list games, suggest games or search for games. The window says
   so plainly in all three languages. Planned, not built: a small free shelf of
   games whose authors released them for redistribution; until it exists and
   has passed its own review, this rule holds exactly as written.
2. **The game file never leaves the device.** It is picked from the player's
   own disk with a file input and handed, in memory, to the emulator. It is
   never uploaded, never sent to any pqp endpoint or to any server, and its name
   is never read into a log, an analytics event or a request. There is no upload
   path to add. What changed (Rafael approved it, 2026-10-19): the Locadora app
   may KEEP the file, and the player's saves, on the player's own device, in the
   browser's own storage under the pqp web origin, so a game is still on the
   shelf at the next visit. "Never stored" is no longer a rule; "never leaves the
   device" is. Keeping a copy of the GAME on a server, an account, a sync or a
   backup in the cloud is a different feature and needs its own review (the
   "Gaveta" of the UX pass is not built). The player's SAVES are the one thing
   that may leave the device, and only behind their own flag: "Saves na conta"
   below, built dark behind `locadora_save_sync` (per server, default off). It
   never carries the game file, its name, its title or its box art. With the flag
   off nothing at all leaves the device and the copy says so. The legacy dialog
   below keeps nothing at all (the emulator's databases and settings storage are
   switched off there).
3. **Open-source cores only, license checked against AGPL-3.0**, installed from
   npm through the package manager, served from our own origin. No CDN at build
   time or run time.
4. **Single player.** No netplay, no shared state, no relay of game data, no
   "room" in the sense of a place several people play. The emulator frontend's
   netplay client library is not even shipped.
5. **The allowlist is empty.** `client/src/lib/emulator/allowlist.ts` is the only
   place a game could ever be named, and it is empty. An entry must be a
   homebrew or public-domain title, verified by a human, with the author's own
   terms linked. A test fails if the list is not empty, so an entry cannot slip
   in with an unrelated change.
6. **Honest copy** in en, pt-BR and es: it is an emulator, bring games you own,
   we do not provide games.
7. **The server knows nothing but the flag**, with one amendment behind its own
   flag. `GET /api/emulator/config?serverId=` answers `{ enabled }` and there is
   no other emulator route. The amendment is "Saves na conta"
   (`locadora_save_sync`, per server, default off): the routes under
   `/api/apps/pqp-locadora/saves` keep a person's own saves for Locadora, and with
   them the server learns, per save, a key that does not name the game, its
   size, its kind and slot, the console, the core and its version, a coarse kind
   of device and a random id of that browser, and when it was written. Never the
   game file, its name, its title or its hash.
   `server/src/lib/flag-client-contract.test.ts` pins both halves: the emulator's
   config is still its only route, and every save route lives in one file and
   passes the save gate (the flag, `apps`, `emulator_room` and a live player
   seat) first.

## How it works

- Entry: the server menu (the header of the channel list) shows "Locadora" (the
  product's name in every language; it was "Sala de emulador" before the apps
  platform) only when the flag answers yes for the open server
  (`useEmulatorEnabledFor`). Off, no entry and no emulator code is asked for.
- The room (`components/emulator/emulator-room.tsx`) is a dialog with a file
  input (`.nes .gb .gbc .gba`). The system is chosen by the extension.
- Three layers, from the app inwards:
  1. **The app** embeds our own page `public/emulator/room.html` (same origin,
     first-party). It hands it the picked `File` with a `postMessage` named to
     the app's own origin.
  2. **The room page** (`room.html`, `room.js`) carries `frame-src 'self'` and
     creates the emulator's frame, then relays its startup messages up. Why it
     exists: a frame cannot be stopped from navigating itself by its own policy
     (`navigate-to` was removed from browsers), and a hostile game file that got
     code running in the emulator could use that to send the file's bytes out in
     an address. The one control that works is the `frame-src` of the page that
     EMBEDS the frame, and the app page cannot carry it (it embeds YouTube and
     others), so this small page does. `room.js` also removes a frame that loads
     a second time, and repeats "ready" until the file arrives so the handshake
     cannot race a listener.
  3. **The emulator frame** (`frame.html`, `frame.js`) is created by the room
     page with `sandbox="allow-scripts"`, never `allow-same-origin`: an opaque
     origin. The emulator is a third party runtime and a game file is untrusted
     input, so even a code execution flaw there could not read the app's cookies
     or storage, touch the app page or call the API as the signed-in person.
     Its own policy allows no network but its own public files
     (`connect-src 'self' blob: data:`), no form and no remote host. It takes the
     `File` with a `postMessage`, gives it to the emulator as an in-memory object
     (no URL, no fetch) under a fixed name (`rom.<ext>`), and does nothing else
     with it. The cost of the opaque origin: the frame fetches its files with
     CORS, so `/emulator/ejs/*` (public static files) carries
     `Access-Control-Allow-Origin: *` in `_headers` and in the dev middleware,
     and it has no web storage at all.
- Startup is bounded: a frame that never says ready (its script failed to load)
  gets 10 seconds, one that is ready but never finishes starting (core or game
  failed to download) 90 seconds, and the emulator's own error text is relayed.
  Either way the file is dropped and the room says the emulator could not start.
  A failed read of the flag counts as off, like an old API.
- **Verified in a real browser (Chromium) with a crafted frame and a canary
  server on another port**: a frame that runs `location.href = <canary>?d=...`
  reached the canary when the room page had no `frame-src` and did not reach it
  with `frame-src 'self'`. This is the same finding as the apps program's
  sandbox spike (`spike-sandbox.md`, "Needs ONE addition on the EMBEDDING
  page"). WebKit and Firefox were not run here; the apps program runs the same
  crafted-frame test on all three.
- **A same-origin navigation still goes through.** `frame-src 'self'` keeps the
  frame from reaching any other host, but it can still navigate to a URL on our
  own static host with bytes in the query string (CSP path sources ignore the
  query, so a path allowlist would not help). That request goes to pqp's own
  static origin, never to a third party, and the room page removes the frame
  when it loads a second time. Closing it fully needs the frame on its own
  origin, which is what the apps program's Locadora does; this legacy room does
  not have one. A point for the lawyer review, not a thing to promise away.
- **What is still not a proof.** The guarantee "the file cannot leave the
  browser" now holds against pqp's own code, against every request a page can
  make (fetch, XHR, sockets, forms, images, fonts, frames) and against
  navigation, as far as the browsers' own enforcement goes. It is not a proof
  against a bug in the browser, and a WebKit `preconnect` leak of a host name
  (not a body) is documented in the spike. Do not promise more than this in the
  privacy copy.
- The files come from npm and are copied to `/emulator/ejs/` by the `pqp-emulator-room`
  plugin in `client/vite.config.ts` (served by middleware in dev, emitted as
  assets in a build). They are not precached by the service worker.
- Tests: `components/emulator/emulator-room.test.tsx` (flag off draws nothing;
  the picked file reaches the room page and no `fetch`, XHR or beacon is ever
  made; the ready handshake and both startup timeouts; a failed flag read closes
  the room; the source has no way to send a file), `lib/emulator-frame.test.ts`
  (the room page's `frame-src`, the sandbox, the second-load rule, the frame's
  policy and `frame.js`, what is shipped, no game file under the new paths),
  `lib/emulator/emulator-allowlist.test.ts` (empty), and the contract test above.

What it is verified against: the two cores were run in a real browser behind the
policy with two tiny test images written from scratch (not games, never
committed): an NES image that paints the screen, and a GBA image that loops,
both again inside the sandboxed frame. No request other than the emulator's own
static files was made. Real games were not used.

## Locadora, the same emulator as an app of the apps platform

`apps/locadora/` runs the same frontend and the dialog's two cores as an app,
plus a third core for the SNES that only the app has (bsnes, below;
`docs/APPS.md` has the platform and the build in full). Every rule above holds
for it, and the sandbox is stricter than the dialog's:

- **No network at all.** The frame's policy is `default-src 'none'; script-src
  'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src blob:` and nothing
  more: no `'self'` in `connect-src` (the dialog's frame may still fetch its own
  origin), no `'unsafe-eval'`, no `script-src blob:`, no workers, no storage, no
  forms. `blob:` is what lets the frame read the bytes the page handed over;
  it reaches nothing outside the browser. The file name never enters the frame:
  the page's picker sends the bytes and the extension from the closed list.
- **Four patches** to the vendored EmulatorJS 4.2.3 make it run under that
  policy (`apps/locadora/build/patch.mts`): the core archive is unpacked with the
  browser's own inflate instead of a worker that evals, the core's JS glue loads
  from the bundle under Subresource Integrity instead of from a blob script,
  inline style writes become CSSOM writes, and the update check is dropped. Each
  patch throws unless its needle is found exactly as often as expected, so an
  EmulatorJS upgrade breaks the build and is re-audited, never shipped
  half-patched. FCEUmm and mGBA are unmodified (only their archive is
  repacked); bsnes is built from source with two fixes, below.
- **The test is a canary.** `apps/locadora/e2e` runs the real build in the real
  frame with two generated test patterns (never games) and a server on another
  port that must record nothing, with the escape probes of the S0 spike failing
  inside the frame, in Chromium, WebKit and Firefox.
- **Sharing is built and off.** The app declares `share: pane` and spectators,
  and the platform refuses both for an `emulator` app until the flag
  `locadora_share` is on for the server (D14, `docs/APPS.md`). It waits for the
  answer to item 7 below. Nothing about anyone's game reaches anyone else today.
- **Notices.** The third-party notices (item 4) are generated into the bundle as
  `notices.txt` from what is installed (every component, its version, its
  license text and the source links of the next section). The app has a
  "Licenças" panel that shows them, since a sandboxed frame cannot open a link,
  and the file is a public file of the apps origin (`license.notices` in the
  manifest names it).

### The shelf, the saves and the screen (Locadora)

All of it lives on the player's device and none of it is ever sent. The app frame
is `sandbox="allow-scripts"` with an opaque origin and no storage of its own, so
every read and write goes through the host's device store (`store-bridge.ts`,
the `deviceStore` capability of the manifest), which keeps rows in the browser
under the pqp web origin. When the host cannot or will not keep anything (a
private window, blocked site data) the app falls back to memory: the game plays,
the shelf lasts until the page closes, and the app says so.

- **Device store limits.** 512 MB in all (`deviceStore.maxBytes` in the manifest)
  and 64 MB per file (`localFiles.maxBytes`, and the memory fallback's cap). A
  full store refuses the write with a plain message and the shelf offers to
  remove cartridges to make room. The top bar shows how much of the 512 MB is
  used. Browser storage is the browser's: a person who clears site data loses the
  shelf, and the copy never promises otherwise.
- **The library** (`library.ts`). One cartridge is a few rows keyed by the SHA-256
  of the file: the bytes, a small item record (console, size, the title read from
  the file's own header or typed by the person, added and last played, play
  time), and its saves. Box art is drawn from the title and never stored. A
  title is only ever one the person's own file carries or the person typed;
  pqp names no game (rule 1) and the item never leaves the device. The shelf
  filters by console and sorts by last played, name or console; the Continue card
  puts the last game back in one click; removing a cartridge removes its saves,
  after a confirmation.
- **Saves** (`saves.ts`). The game's own battery save is kept every 30 seconds
  when it changed, when the page goes hidden, on eject and when the session ends.
  Machine-state slots are a rolling autosave (every 2 minutes of play, on by
  default, off from the drawer) plus four manual slots, each a gzipped state, a
  small thumbnail and a record of which core wrote it, because a state from
  another build of a core may not open. The session ending says "Teus saves
  ficaram guardados neste aparelho" (en: "Your saves are kept on this device").
  Moving a shelf to another device is a `.locadora` file the person saves and
  picks themselves. It is named for what it is, a FILE and not a sync (it used to
  be "Levar pra outro aparelho", which read as a cloud feature once Saves na
  conta existed): "Exportar pra arquivo" (en "Export to a file", es "Exportar a un
  archivo"), one line that says nothing goes online, and two choices, "Só os
  saves" (small, no game) and "Fita e saves" (the big file, the game goes along),
  each with a size hint read from the store's listing. With Saves na conta on the
  sheet says the saves already follow the account, so only the cartridge needs
  the file, and picks "Fita e saves"; without it, it says the file is the only
  way to carry the saves. The way back in is "Importar de um arquivo", on the
  same sheet, through the host's picker. The game file is never uploaded and the
  export file stays on the device unless the person moves it. Nothing syncs
  unless "Saves na conta" (next section) is on for the server.
- **Scaling** (`stage.ts`, `screen.ts`). Pixel perfect is the default: the largest
  whole number of device pixels per source pixel that fits, so every source pixel
  is the same size on a 1x or a 2x screen, and a plain fit when a whole number
  would be under two device pixels. Fit fills the room instead. The aspect is the
  TV's 8:7 pixel or square pixels (handhelds are always square), and the screen
  menu has an optional CRT filter, ambient light and a TV bezel. Fullscreen is
  the browser's. The box the stage draws IS the picture: RetroArch is told to
  stretch the frame over its whole canvas (`aspect_ratio_index = 24`, "Full",
  `RETROARCH_PICTURE` in `emulator.ts`), because its default draws the frame
  inside the canvas at the aspect the core reports, a second letterbox under the
  stage's own (a SNES game in "Pixel quadrado" filled 1408x1077 of a 1408x1232
  box). The frame size the stage fits is asked of the core all game long, not
  once (`SIZE_WATCH_MS` in `game-session.ts`, and at once on a canvas size
  change), since a game switches frames while it plays. Measured with
  `e2e/geometry.spec.mts` and the card in `e2e/geometry-card.ts` (a SNES image
  written for it that changes its PPU mode on every press of B).
- **SNES: bsnes, in Locadora only.** Locadora accepts `.sfc` and `.smc` and plays
  them on bsnes (core name `bsnes`, the libretro port at
  https://github.com/EmulatorJS/bsnes-libretro, upstream
  https://github.com/libretro/bsnes-libretro). The legacy dialog stays NES and
  Game Boy (`.nes .gb .gbc .gba`). Snes9x stays refused (table below).
  EmulatorJS publishes no bsnes package on npm, and its nightly build cannot save
  or load a state or reset, so the core is built from source and vendored at
  `apps/locadora/vendor/emulatorjs-core-bsnes/` in the shape of an
  `@emulatorjs/core-*` package (`prepare.mts` reads it the same way): the built
  archive `bsnes-legacy-wasm.data` (its sha256 is in that folder's
  `package.json`, under `pqpProvenance`), the license texts it carries
  (`licenses/`: GPL-3.0, LGPL-2.1, libco's ISC, SameBoy's MIT; SPDX
  `GPL-3.0-or-later AND ISC AND MIT AND LGPL-2.1-or-later`), the build report,
  and the corresponding source under `source/`: `build.sh` (the two pinned
  commits of bsnes-libretro and of the EmulatorJS RetroArch fork it is linked
  with, emsdk 3.1.74, the exact make lines) and the two patches it applies.
  `libco-emscripten-fiber.patch` adds `co_derive` and `co_serializable` to
  libco's emscripten backend (without them a state save, a state load and a
  reset abort the runtime). `retroarch-save-state-info.patch` fixes RetroArch's
  `save_state_info`, which returned a local array by address and serialised
  inside the JavaScript call, where bsnes's fibers cannot switch; the main loop
  now makes the state at the top of its next tick. Locadora's manifest licence
  expression and its "Licenças" panel list all of it. Verified on a generated
  test pattern only (`apps/locadora/e2e/patterns.ts`), never on a game, in
  Chromium; speed on a slow phone is not measured.

### Saves na conta (`locadora_save_sync`, built dark)

Behind the runtime flag `locadora_save_sync` (per server, default off; it also
needs `apps`, `emulator_room` and the attachments bucket, `S3_*`). On, the
battery saves and the save states of a game, and the small picture of each
state, are copied to the person's account, so the same game picked on another
device finds them. What it is not: it never carries the game file, its name, its
title, its hash or its box art, and there is no field any of those could ride in
(the bridge's `sync.put` takes a save of at most 1 MiB and a picture of at most
16 KiB, strict, and the server's upload body is strict too).

- **Keyed so a save only shows up next to the same game.** The pqp page (never
  the app frame, never the server) computes `gameKey = HMAC-SHA256(salt, the
  file's SHA-256)` with a salt of 32 random bytes the server keeps for this
  account alone (`locadora_save_salts`). The raw hash never leaves the device.
  **Honest limit:** the server holds the salt, so the operator could test a
  known file's hash against a key. The policy is to never build or keep such a
  list. True blindness needs end-to-end encryption, which this phase does not do
  (a passphrase or a device pairing, and a lost key loses the saves; the data is
  progress, low sensitivity). Revisit if people ask.
- **The bytes never pass through the API.** The page PUTs and GETs them with
  presigned URLs in the attachments bucket under `locadora-saves/<user id>/`,
  and the commit checks with a HEAD that what arrived is the length that was
  signed (`docs/ATTACHMENTS.md`). The bucket's CORS must allow GET and PUT from
  the web origin.
- **Limits.** 1 MB per state (gzipped in the frame), 256 KB per battery save,
  16 KB per picture, 8 MB per account (the battery save's three older versions
  and uploads in flight included), 30 writes a minute. The autosave and the
  battery save go up at most every 5 minutes and on Ejetar; a manual save goes at
  once. A spectator has no saves: `sync.*` is refused for one.
- **Two devices.** Every save has a `rev`, and every write names the rev it
  replaces (409 `stale_rev` otherwise). Each device remembers what it last agreed
  with (`sync:<sha>` in its device store, the rev and the hash of the bytes it
  held, content and not clocks). The battery save is never resolved by itself:
  changed on both sides, the load screen asks which one stays, before the game
  boots. The autosave is rolling: a newer one written on another device is the
  "Tu parou no computador há 20 min. Bora continuar daqui?" prompt, with both
  pictures, in the place of the Start button (its "Bora" is still the click
  that starts the sound). A manual slot changed on both sides asks over the
  paused game, with both pictures: "Usar o do computador", "Usar o deste
  celular", or "Guardar os dois" (the other goes to a slot empty here and on the
  account). "Decidir depois" asks again on the next save.
- **What the person sees, and what they are told when it is not working.** The
  shelf shows the account before any game: a line under the device's storage
  meter ("Na conta: 2 KB de 8 MB") and "na conta" on Continuar's line for a game
  that has saves there. When the server has the feature on and it still does not
  work here, the app says so instead of drawing nothing (`openSync`, `SyncProblem`):
  "Conta sem resposta" with a "Tentar de novo" button on the shelf and a chip and
  note in the drawer when the status call failed or took over 6 s (logged with
  `console.warn`), and "Sem conta neste navegador" when the browser keeps nothing
  between visits. Only a refusal (flag off, a watcher, an old host) stays quiet.
  The drawer has a chip ("Na tua conta", "Subindo pra
  conta", "Conta sem resposta"), a line that says the saves and their pictures
  also go to the account and the game never leaves, how much of the 8 MB is used,
  and "Apagar tudo da conta" (asked twice; the saves on this device stay). The
  house rules gain one line ("Saves na conta: ... O jogo nunca vai.") and the
  session's end says the saves are kept on this device and on the account. The
  join sheet says the same. With the flag off none of it is drawn and every line
  says what it always said: the file stays on this device.
- **Retention.** A save not written for 365 days is deleted by a daily sweep, an
  upload never committed after an hour, and deleting the account deletes every
  object. With the flag turned off, nothing new goes up, and for 30 days after the
  person last used it with the flag on they can still take their saves back and
  delete them ("read-only"); after that the routes answer 404.
- **Not built.** The account keeps three older battery saves and the bridge
  has `sync.restore`, but no screen offers it yet. Removing a cartridge from the
  shelf does not delete its saves from the account (that is "Apagar tudo da
  conta"). The app's pictures are not scanned (`docs/CONTENT_SAFETY.md`): they
  are a frame of the person's own game, only ever shown back to that account.
- **Legal difference from keeping games.** Saves are the person's own data. The
  residual risk, said plainly: a save state is a snapshot of the console's
  memory and holds fragments of the game's own data (tiles in video memory,
  sound samples, code copied into work memory). It is not a playable copy and is
  useless without the file, comparable to a screenshot, but item 9 below asks a
  lawyer to confirm. The 8 MB quota, saves visible only to their own account
  (never shared) and the hash keying keep it a personal backup. A state is only
  ever loaded from the person's own account, inside the same sandbox.

Code: `server/src/apps/locadora-saves.ts` and `api/locadora-save-routes.ts`
(tables in `schema.sql`), `packages/shared/src/apps/locadora-saves.ts` (the HTTP
contract), the bridge's `sync.*` (`bridge.ts`), `client/src/lib/apps/save-sync.ts`
(the page's half), `packages/app-sdk/src/sync.ts`, and `apps/locadora/src/sync.ts`
with `ui/conflict-sheet.ts`. Tests: `server/src/apps/locadora-saves.test.ts`
(a scratch database and an in-memory bucket), `client/src/lib/apps/save-sync.test.ts`,
`apps/locadora/src/sync.test.ts`, `game-session-sync.test.ts`, `ui/sync-ui.test.ts`.

## The cores, and the license check

AGPL-3.0 is this repository's license. GPL-3.0 and AGPL-3.0 code, MIT/BSD and
(by the license's own secondary-license clause, section 3.3) MPL-2.0 can ship
with it. GPL-2.0-only cannot (it is not compatible with version 3);
GPL-2.0-or-later can. A license that forbids commercial use cannot be carried at
all. The checks below were read from the license text packed in each npm
package and, for the first two, the upstream source headers.

| System | Core | License | Verdict |
|---|---|---|---|
| NES | FCEUmm (`@emulatorjs/core-fceumm`, a libretro core derived from FCEUX) | GPL-2.0-or-later (the source files say "either version 2 of the License, or (at your option) any later version") | **Shipped** |
| Game Boy, Game Boy Color, Game Boy Advance | mGBA (`@emulatorjs/core-mgba`) | MPL-2.0 (plus small permissively licensed bundled libraries) | **Shipped** |
| Frontend | EmulatorJS (`@emulatorjs/emulatorjs`) | GPL-3.0 | **Shipped** (GPL-3.0 and AGPL-3.0 combine, GPLv3 section 13) |
| SNES | bsnes (built from source, `apps/locadora/vendor/emulatorjs-core-bsnes`) | GPL-3.0-or-later, with ISC (libco), MIT (SameBoy) and LGPL-2.1-or-later parts | **Shipped in Locadora** (built from the pinned source plus two patches, see above) |
| SNES | Snes9x (`@emulatorjs/core-snes9x`) | Its own license, which says "Under no circumstances will commercial rights be given" | **Refused**: non-commercial only, cannot be carried under AGPL-3.0 |
| Mega Drive / Genesis | Genesis Plus GX (`@emulatorjs/core-genesis_plus_gx`) | Its own license: "Redistributions may not be sold, nor may they be used in a commercial product or activity" | **Refused**, same reason |
| Mega Drive / Genesis | PicoDrive (`@emulatorjs/core-picodrive`) | The same non-commercial text | **Refused**, same reason |

FCEUX itself and Mesen (the other NES candidates) were not needed: FCEUmm is
FCEUX-derived and was already available as a prebuilt WebAssembly core. Mesen was
not looked at further.

**Why `pnpm-workspace.yaml` ignores `@emulatorjs/cores`.** The EmulatorJS
frontend lists that meta package as an optional dependency, and it pulls every
core, including the three refused above. It is ignored so a plain `pnpm install`
never puts a non-commercial binary in `node_modules`, where a later change could
copy it into a build by accident. The frontend's own build tooling (a minifier, a
static server, a socket.io server) is dropped with `overrides`, because only its
prebuilt `data/` folder is used.

**Source for what we serve.** FCEUmm and mGBA are served unmodified; bsnes is
served as built by `apps/locadora/vendor/emulatorjs-core-bsnes/source/build.sh`
from the commits and patches named there. Corresponding source: FCEUmm at https://github.com/EmulatorJS/libretro-fceumm (upstream
https://github.com/libretro/libretro-fceumm) and mGBA at
https://github.com/EmulatorJS/mgba (upstream https://github.com/mgba-emu/mgba),
at the versions in `pnpm-lock.yaml` (`@emulatorjs/core-*` 4.2.3). The frontend:
https://github.com/EmulatorJS/EmulatorJS (served with the four build-time edits
of `apps/locadora/build/patch.mts` in the app; the dialog serves it as it is).
The notices file with every license text and these links is in the Locadora
bundle and in its "Licenças" panel (item 4 below). The old dialog has no panel of its
own: it is what the menu entry opens only while the apps platform is off.

### SNES and Mega Drive: what could replace the refused cores

None has a ready WebAssembly build on npm, so each is a separate piece of work
(build from source, license re-read):

- SNES: bsnes. Done for Locadora (above).
- Mega Drive: clownmdemu (AGPL-3.0 per its repository). Not started.

## Needs Rafael's lawyer review before the flag goes on

1. **Is offering an emulator (not games) acceptable under the instance's legal
   posture** in Brazil and the other countries the hosted instance serves? The
   change does not alter pqp's private-messaging footing (nothing is shared), but
   a lawyer should say so.
2. **The consoles' names** ("NES", "Game Boy", "Game Boy Color", "Game Boy
   Advance") appear in copy and in this page to say what the files are. Is the
   nominative use fine, or should the copy avoid them?
3. **The "only open games you have the right to play" line.** Is it enough, or
   should it be a click-through? (Rule 6 keeps it from implying anything about
   where a file came from.)
4. **License obligations of shipping GPL-2.0+/MPL-2.0 binaries**: the notices
   and the source offer (links above) before the flag is on. The notices file
   exists now (in the Locadora bundle and its "Licenças" panel); is it enough, or
   does the web client need a page of its own? FCEUmm and mGBA are unmodified
   (only repacked); the frontend carries four small build-time edits, and the
   corresponding source is upstream plus `apps/locadora/build/patch.mts`. bsnes
   (GPL-3.0-or-later) is a binary we built ourselves with two patches: its
   corresponding source is the pinned upstream commits plus the recipe and
   patches in `apps/locadora/vendor/emulatorjs-core-bsnes/source/`. The consoles'
   names of item 2 now include "SNES".
5. **Before any allowlist entry**: how each entry is verified, and who signs it.
   That is a separate review per entry, after this one.
6. **Before anything shared** (netplay, watching somebody play, a streamed
   screen): a screen share of a running game is a different legal question from
   everything above. Netplay and any relay of game data stay out of scope. The
   share of the app's pane is built dark behind its own flag, see item 7.
7. **Legal Gate L1b: sharing a running game to viewers ("Assistir")**, before
   `locadora_share` is turned on anywhere. Is a pane share of a game the person
   opened from their own disk acceptable to show to others in a private server?
   Does it change if the viewers are in a community? What has to be said on
   screen? Does it change for allowlisted homebrew titles?
8. **Legal Gate L2: playing together (multiplayer)**, before any code of it is
   built past a prototype. Is relaying controller input between players
   (peer to peer, only for reviewed titles) acceptable? Is a hash allowlist with
   a rights record per entry sufficient? Who signs each entry? (The design is in
   the apps program plan, Phase 9; Rafael's written confirmation that his
   go-ahead covers it is also still open.)

9. **Saves na conta (`locadora_save_sync`), before it is on for real users.** A
   one-line answer is enough: is keeping a person's own save states and battery
   saves on their account (never shared, 8 MB, keyed so the server does not
   learn the game) acceptable, given that a save state carries fragments of the
   game's own data? Rafael's go on amending rule 7 is also needed (FOR-RAFAEL
   item 4 of the UX pass).

Until 1 to 4 are answered in writing, `emulator_room` stays off everywhere.
`locadora_share` also waits for 7, the multiplayer flag for 8 and
`locadora_save_sync` for 9.

**Turning any of these flags on for real users needs a written lawyer answer
first.** That covers `emulator_room`, `locadora_share` and the multiplayer flag,
and it now also covers the device library: the file and the saves stay on the
player's device and never reach a server, but a lawyer should say that keeping a
copy of a game file in the browser is acceptable, the way item 1 asks it about
offering the emulator. A flag flipped for the operator's own test server while
that is open is a test, not a launch, and says so on its face.
