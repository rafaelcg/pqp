# Runtime feature flags

Switches that used to need an env edit and a container recreate are now flipped
live from the operator dashboard (**controles → interruptores**), with no deploy
and no restart. Code: `server/src/lib/flags.ts`.

## Precedence

For `isEnabled(key, { serverId })`, first match wins:

1. **Per-server override** (`feature_flag_overrides`), only for flags whose
   registry entry says `perServer: true`.
2. **Global row** (`feature_flags.enabled`, when not NULL).
3. **Environment variable**, parsed exactly the way its old reader parsed it
   (same words, same case sensitivity).
4. **Code default.**

With no row, steps 3 and 4 are the whole answer, which is byte for byte what the
switch did before this existed. "Seguir a variável" on the dashboard writes NULL,
which returns to that.

## Adding a flag

One entry in `FEATURE_FLAGS` in `server/src/lib/flags.ts`:

```ts
my_switch: {
  description: "Uma linha pro painel.",
  env: "MY_SWITCH",               // the variable that stays the default
  parseEnv: exactTrue,            // or onUnlessOff, or words({ on, off })
  codeDefault: false,             // or "bound" + bindFlagDefault(key, fn)
  perServer: false,               // true only if EVERY reader knows the server
  clientVia: "GET /api/…/config", // optional, shown on the dashboard
},
```

then replace the env read with `isEnabled("my_switch")`. The key is the variable
in lower case. The write routes only parse registered keys, so nothing else can
be flipped. Add a line to the old-reader table in `flags.test.ts`.

A flag whose client needs to know goes out through the config endpoint that
already carries that feature (`/api/live-hls/config`, `/api/community-home/config`,
the waitlist state). The web client asks those again on focus and every 10 min
(`client/src/lib/config-refresh.ts`, at most once per 2 min). Mobile picks the
change up on its next config read.

## Caching and the cluster

Reads are synchronous: the whole table sits in one in-process snapshot.

- The instance that takes a write reloads before it answers.
- It then publishes `flags.changed` on the cluster bus (`CLUSTER_BUS=postgres`),
  and every sibling reloads as soon as the frame arrives, within milliseconds
  (proved with two real API processes in `flags-two-process.test.ts`).
- If the bus is off, the frame was dropped, or the process only publishes (the
  worker), a read that finds the snapshot older than `FEATURE_FLAGS_TTL_MS`
  (default 10 000) checks in the background. A flip is then up to one TTL late.
  That check is one index-only `MAX(id)` over `feature_flag_audit`, and the full
  reload (every row, overrides included) only runs when that number moved, when
  the bus said so, or every 5 minutes as a backstop. Every write through the API
  adds an audit row in the same transaction, which is what makes this exact.
  **A row changed by hand in SQL without an audit row is picked up by the
  5-minute backstop, not the TTL.** Use the dashboard or the API.
- Flag writes are serialised with one transaction-scoped advisory lock, held
  until commit. That keeps the audit's `previous` true, and it makes audit ids
  commit in order, which is what lets `MAX(id)` stand in for a version.
- A write answers `applied: false` if the row committed but this process could
  not reload its own copy. The dashboard shows that instead of the old value.
- **Database down:** the last snapshot keeps answering, and reloads back off for
  a TTL. Before any snapshot has loaded, the environment answers.
- Before `startFeatureFlags()` (called at boot after `initDb`) nothing touches
  the database, so unit tests that set `process.env.X` behave as before.

## Operator surface

Machine-token routes (in `ADMIN_MACHINE_ROUTES`) and the same routes for an
instance moderator's session:

- `GET /api/admin/flags`: every flag with its effective value, where it came
  from, what the environment alone would say, the overrides, and the last 50
  flips.
- `PUT /api/admin/flags` `{ key, enabled: true | false | null }`
- `PUT /api/admin/flag-overrides` `{ key, serverId, enabled: true | false | null }`

Every change goes into `feature_flag_audit` (who, or "painel" for the machine
token, when, before and after). A write that changes nothing is not recorded.
`GET /api/admin/metrics` → `flags` has every value and source, flips since boot,
flips in the last 24 h per key, and cache health (`loads`, `loadFailures`,
`busInvalidations`, `ageMs`).

## Self-hosting

Nothing to do. Without a dashboard nobody writes a row, and every flag follows
its environment variable exactly as before. The three tables are created by
`schema.sql` on boot and stay empty.

## What is converted, and what deliberately is not

Converted (global unless noted): `WATCH_PARTY_WAITLIST` (per server),
`LIVE_HLS_CAMERA`, `LIVE_HLS_CAMERA_480`, `LIVE_HLS_VOICE_TRACK`,
`LIVE_HLS_MIC_ARCHIVE`, `LIVE_HLS_REAP_ORPHANS`, `HLS_SHARER_RESUME_HOLD`,
`LIVEKIT_REGION_REQUIRE_CAP`, `VOICE_MESH_RESUME_REQUIRES_CAP`,
`SFU_REGION_SCOPED_CALLS` (`sfu_region_scoped_calls`, default **on**: SFU
moderation asks only the box a room lives on, with a per-region budget and
circuit for rooms whose box is unknown; off is the old ask-every-box-and-wait,
see `docs/plans/SFU_REGIONS.md` §"The control plane"),
`TURN_PREFER_STATIC`, `READ_CACHE`, `COMMUNITY_HOME_ENABLED`, `COMMUNITY_HOME_VIP_ENABLED`,
`PARTY_NEWCOMER_EXPERIENCE` (per server; default off; see below),
`COMMUNITY_HOME_TRANSLATION` (`community_home_translation`, **per server**,
default off; automatic translation of Baú posts, which also needs
`OPENROUTER_API_KEY` on the API: no key, no translation, no error; served to
the client as `translationEnabled` on `GET /api/servers/:id/home/posts`; see
`docs/COMMUNITY_HOME.md` §Translation).
`PARTY_FAST_START` (per server, client-only; see `docs/WATCH_PARTY.md` §"Fast first frame").
`WATCH_PARTY_SERVER_AUDIENCE` (`watch_party_server_audience`, **per server**, default
off, born as a flag): the in-app watch party count is the server's, distinct
accounts on the playlist from every API machine, instead of the sockets one
machine counted. Served as `viewers` on `channel-live` and `GET
/api/channels/:id/live`; absent with the flag off, which is the old frame byte for
byte. Turn it on for one server with `PUT /api/admin/flag-overrides
{ key: "watch_party_server_audience", serverId, enabled: true }` or from controles →
interruptores; open tabs pick it up on the next keyframe (30 s), no reload. See
`docs/WATCH_PARTY.md` §"How many people watched".

Born as a flag (no old reader): `WATCH_CAMERA_SYNC` (`watch_camera_sync`,
default off, **per server**, client-only), the presenter's camera held to the
film's wall clock in a viewer's browser (`client/src/lib/camera-sync.ts`),
served as `cameraSync` on `GET /api/live-hls/config`. Measured on the real
player (`client/e2e/camera-sync/`, numbers in `docs/WATCH_PARTY.md` §"The camera
follows the film"), and still off until a person has checked it on a real
party: turn it on for one test server (the server's override), then globally.
Off, the camera plays loose exactly as before: nothing writes its rate or its
position, and nothing reads the film's clock. Only `true` turns the variable
on. An API older than the flag sends no field, which the client reads as off.

Born as a flag (no old reader): `DESKTOP_SHARE_AUDIO_NATIVE`
(`desktop_share_audio_native`, default off, **per server**), sound on a screen
share from the Windows desktop app through WASAPI process loopback, Windows 10
included, served to the client by `GET /api/share/config?serverId=`. It only
does anything in a desktop build whose preload publishes
`capabilities.nativeShareAudio` and whose self-test opened a process loopback
stream on that machine; see `electron/lib/win-share-audio.js`. With the flag off
the client never asks the shell anything.

`CLIENT_FORCE_UPDATE` (`client_force_update`, default off, global), born as a flag:
every web or desktop client that is not on the latest build puts up the blocking
"atualização necessária" screen, served by `GET /api/client-update/config`
(`forceUpdate`). The client only asks when it already knows it is stale. Leave it on
only while the good build is the one deployed. Its sibling `CLIENT_MIN_BUILT_AT`
(ISO date or epoch ms) forces bundles built before a moment and is environment-only.
See `docs/PWA.md` §"Nobody stays on an old bundle".

Also born as a flag: `SHARE_HIGH_MOTION_GUARD` (`share_high_motion_guard`,
default off, **per server**), served to the client by the same
`GET /api/share/config?serverId=` as `shareHighMotionGuard`. A presenter whose
screen share is starved by a game at a very high frame rate (a 360 Hz CS2 at
100 % GPU) is stepped down in place (one resolution rung, then the frame rate, then
more resolution), recovers slowly with hysteresis, and in the desktop app on Windows the
shell's processes run one notch above normal while the share is live. Client and
Electron only, no user-facing copy, never applied to a watch party's share. Off,
the client behaves exactly as before: no constraint is written, the shell is told
nothing. `pqpShareHealth()` in the console works either way. Design, evidence
and the test steps: `docs/DESKTOP.md` §"A share next to a game at a very high
frame rate".

Also born as a flag: `SHARE_GAME_CAPTURE_HINT` (`share_game_capture_hint`,
default off, **per server**), served by the same `GET /api/share/config?serverId=`
as `shareGameCaptureHint`. On the Windows desktop app, the presenter's client
samples its own share for the first minute (a 32x18 luma grid every 2 s, nothing
kept or sent) and, when the picture is black, no frame arrives for 8 s, or the
capture ends by itself, asks the shell whether Windows sees a Direct3D app in
exclusive fullscreen (`SHQueryUserNotificationState`). Only a yes shows the
presenter one card with the fix (the game's "Fullscreen Windowed" or borderless
mode) and a "não mostrar de novo". It changes nothing about the capture: there is
no safe code-side fix in Electron 44 (see the doc). Off, the client samples
nothing and asks the shell nothing. Needs a desktop build that publishes
`capabilities.fullscreenAppState`; an older shell answers "cannot tell" and the
card never shows. `docs/DESKTOP.md` §"Sharing a game: Fullscreen vs Fullscreen
Windowed".

Born as a flag (no old reader): `LINUX_DESKTOP_SYSTEM_AUDIO`
(`linux_desktop_system_audio`, default off, **global only**), the computer's
sound on a screen share from the Linux desktop app, served to the client by
`GET /api/share/config` as `linuxDesktopSystemAudio`. It only does anything in a
desktop build whose preload publishes `capabilities.linuxShareAudio`; see
`electron/lib/linux-share-audio.js`. From desktop 0.2.4 the shell feeds the bus
by LINKING each app's stream on PipeWire (pinned Proton games and native
PipeWire apps such as Flathub Spotify included, which 0.2.3 could not move) and
writes what it did per stream to `~/.config/pqp/logs/linux-share-audio.json`;
`docs/DESKTOP.md` §"Linux share audio: what is captured and what is not".
Global on purpose: the client asks the
config without a server and keeps one answer per page, so a per-server override
would be accepted and never read; the registry refuses one. Turn it on from
controles → interruptores; the page asks again before every share, so there is
no reload and no desktop update. The server half once went missing from
the merge that shipped the client (#866 into desktop 0.2.3);
`server/src/lib/flag-client-contract.test.ts` now fails when a field the client
reads from `/api/share/config`, or one a flag's `clientVia` names, is not on the
server.

Staying environment-only, on purpose:

- **Boot-time wiring:** `CLUSTER_BUS`, `VOICE_REGISTRY`, `VOICE_REGISTRY_BATCH`,
  `WORKER_MODE`, `WS_COMPRESSION` (negotiated when the socket server is built),
  `PG_*`. Flipping these mid-process would leave half-built state.
- **`DB_BREAKER`:** the breaker guards the pool the flag store reads through. Its
  rollback must not depend on the database being reachable.
- **Auth and security gates:** `DEV_AUTH_BYPASS`, `LOAD_TEST_TOKEN`,
  `CHARACTER_ACCOUNTS_ENABLED`, `OUTGOING_WEBHOOKS_ALLOW_PRIVATE`,
  `LIVE_HLS_SIGNED_URLS`. A dashboard token must not be able to widen who can
  sign in or what is exposed.
- **`COMMUNITIES_ENABLED`:** changes the instance's legal category
  (`docs/CONTENT_SAFETY.md` §Communities). That should be a deliberate deploy,
  not a click.
- **Watch party master switches `LIVE_HLS_ENABLED` / `LIVE_HLS_LL`:** they need
  infrastructure configured beside them, and per-server availability is already
  live data (`servers.live_hls_enabled`, `servers.live_hls_ll_enabled`).
- **Anything that is not a boolean** (limits, URLs, allowlists, TTLs).

Per-server overrides exist only where every reader knows the server. The camera
switches, for example, are read by the egress side with no server in hand, so a
per-server value would make the config endpoint and the transcoder disagree.

## `party_newcomer_experience` (per server, client presentation only)

The newcomer's first minutes in a live watch party, behind one flag
(`PARTY_NEWCOMER_EXPERIENCE`, default off, `perServer: true`). The client learns
it from `GET /api/live-hls/config?serverId=` as `newcomerExperience` (absent on
an older API and on the deployment-wide answer, both read as off), through the
same store and refresh pass as `enabled` / `lowLatency`. Three behaviours, all
in the client (`client/src/lib/party-newcomer.ts`):

- **Phone layout**, for every seatless viewer of a live party on a narrow
  pane: the server rail leaves the flow (it returns over the page while the nav
  drawer is open) and the chat keeps a floor under the picture.
- **Context strip**, for an account whose first-run finished in the last 24 h
  (`preferences.onboardedAt`, or the session that just finished the wizard): one
  dismissible line, remembered in `pqp:party-newcomer-strip-2026-09`.
- **No get-the-app strip** for that same newcomer while the party is live.

Turn it on for one server from the dashboard (controles → interruptores, the
server's override) or `PUT /api/admin/flag-overrides
{ key: "party_newcomer_experience", serverId, enabled: true }` with the machine
token. For MoonKase's server, `serverId` is the id of the server whose community
slug or name is `moonkisticos`. `enabled: null` returns to the default. A tab
that is already open follows within the 10 minute config refresh or on focus.
