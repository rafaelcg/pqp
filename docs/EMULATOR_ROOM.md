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
   so plainly in all three languages.
2. **The game file never leaves the browser.** It is picked from the player's
   own disk with a file input and handed, in memory, to the emulator. It is
   never uploaded, never sent to any pqp endpoint, never stored (the emulator's
   databases and settings storage are switched off), and its name is never read
   into a log, an analytics event or a request. There is no upload path to add.
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
7. **The server knows nothing but the flag.** `GET /api/emulator/config?serverId=`
   answers `{ enabled }` and there is no other emulator route
   (`server/src/lib/flag-client-contract.test.ts` pins that).

## How it works

- Entry: the server menu (the header of the channel list) shows "Locadora" (the
  product's name in every language; it was "Sala de emulador" before the apps
  platform) only when the flag answers yes for the open server
  (`useEmulatorEnabledFor`). Off, no entry and no emulator code is asked for.
- The room (`components/emulator/emulator-room.tsx`) is a dialog with a file
  input (`.nes .gb .gbc .gba`). The system is chosen by the extension.
- The emulator runs in an iframe, `public/emulator/frame.html`, with a
  Content-Security-Policy that allows the network to this origin only
  (`connect-src 'self' blob: data:`), no form submission and no remote host of
  any kind. That is why "the file cannot leave" is a property the browser
  enforces and not only a promise in our code. `frame.js` takes the `File` from
  the embedding page with a `postMessage`, gives it to the emulator as an
  in-memory object (no URL, no fetch) under a fixed name (`rom.<ext>`), and does
  nothing else with it. It answers only the window that embedded it, from the
  origin it was told.
- **The frame is sandboxed into an opaque origin**: `sandbox="allow-scripts"`,
  never `allow-same-origin`. The emulator is a third party runtime and a game
  file is untrusted input, so if a hostile file ever got code running in it, that
  code still could not read the app's cookies or storage, touch the parent page
  or call the API as the signed-in person. The cost: the frame fetches its own
  files with CORS, so `/emulator/ejs/*` (public static files) carries
  `Access-Control-Allow-Origin: *` in `_headers` and in the dev middleware, and
  the frame has no web storage at all. A test fails if the sandbox ever gains
  `allow-same-origin`.
- A frame that never says it is ready (its script failed to load) is given 10
  seconds, and one that is ready but never finishes starting (core or game
  failed to download) 90 seconds; the frame also reports the emulator's own
  error text. Either way the file is dropped and the room says the emulator
  could not start. A failed read of the flag counts as off, like an old API.
- **A residual risk, stated plainly.** The policy blocks every request the page
  could make (fetch, XHR, sockets, forms, images, fonts), and the sandbox keeps a
  compromised emulator away from the app. It does not stop a document from
  navigating itself: the one control for that (`navigate-to`) was removed from
  browsers, and there is no supported replacement. So the guarantee "the file
  cannot leave the browser" holds against pqp's own code and against ordinary
  requests; it is not a proof against a hypothetical code-execution flaw in the
  emulator triggered by a hostile file, which could navigate its own frame to
  somewhere with the bytes of the very file the player chose from their own
  disk. The asset that sandbox protects (the signed-in session, the app's data)
  is the one that matters, and it is out of reach. Counts as a point for the
  lawyer and for the privacy copy: do not promise more than this.
- The files come from npm and are copied to `/emulator/ejs/` by the `pqp-emulator-room`
  plugin in `client/vite.config.ts` (served by middleware in dev, emitted as
  assets in a build). They are not precached by the service worker.
- Tests: `components/emulator/emulator-room.test.tsx` (flag off draws nothing;
  the picked file reaches the frame and no `fetch`, XHR or beacon is ever made;
  the source has no way to send a file), `lib/emulator-frame.test.ts` (the
  policy, `frame.js`, what is shipped, no game file under the new paths),
  `lib/emulator/emulator-allowlist.test.ts` (empty), and the contract test above.

What it is verified against: the two cores were run in a real browser behind the
policy with two tiny test images written from scratch (not games, never
committed): an NES image that paints the screen, and a GBA image that loops,
both again inside the sandboxed frame. No request other than the emulator's own
static files was made. Real games were not used.

## Locadora, the same emulator as an app of the apps platform

`apps/locadora/` runs the same two cores and the same frontend as an app
(`docs/APPS.md` has the platform and the build in full). Every rule above holds
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
  half-patched. The cores themselves are still unmodified; only their archive is
  repacked.
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

**Source for what we serve.** The cores are served unmodified. Corresponding
source: FCEUmm at https://github.com/EmulatorJS/libretro-fceumm (upstream
https://github.com/libretro/libretro-fceumm) and mGBA at
https://github.com/EmulatorJS/mgba (upstream https://github.com/mgba-emu/mgba),
at the versions in `pnpm-lock.yaml` (`@emulatorjs/core-*` 4.2.3). The frontend:
https://github.com/EmulatorJS/EmulatorJS (served with the four build-time edits
of `apps/locadora/build/patch.mts` in the app; the dialog serves it as it is).
The notices file with every license text and these links is in the Locadora
bundle and in its "Licenças" panel (item 4 below). The old dialog has no panel of its
own: it is what the menu entry opens only while the apps platform is off.

### SNES and Mega Drive: what could replace the refused cores

Not in this change, not verified, and none has a ready WebAssembly build on npm,
so each is a separate piece of work (build from source, license re-read):

- SNES: bsnes (its license file says GPL version 3).
- Mega Drive: clownmdemu (AGPL-3.0 per its repository).

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
   does the web client need a page of its own? The cores are unmodified (only
   repacked); the frontend carries four small build-time edits, and the
   corresponding source is upstream plus `apps/locadora/build/patch.mts`.
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

Until 1 to 4 are answered in writing, `emulator_room` stays off everywhere.
`locadora_share` also waits for 7 and the multiplayer flag for 8.
