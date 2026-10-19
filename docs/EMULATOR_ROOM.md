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

- Entry: the server menu (the header of the channel list) shows "Sala de
  emulador" only when the flag answers yes for the open server
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
  seconds, then the file is dropped and the room says the emulator could not
  start. A failed read of the flag counts as off, like an old API.
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
https://github.com/EmulatorJS/EmulatorJS. A notices page for the web client is
still to do before the flag goes on (item 4 below).

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
4. **License obligations of shipping GPL-2.0+/MPL-2.0 binaries**: the notices page
   and the source offer (links above) before the flag is on. The binaries are
   unmodified.
5. **Before any allowlist entry**: how each entry is verified, and who signs it.
   That is a separate review per entry, after this one.
6. **Before anything shared** (netplay, watching somebody play, a streamed
   screen): out of scope here by decision, and a screen share of a running game
   is a different legal question. Do not build it on this change.

Until 1 to 4 are answered in writing, `emulator_room` stays off everywhere.
