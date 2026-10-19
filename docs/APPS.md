# Apps

An app is a small interactive thing, a poll or a game room, that someone starts in a text or voice channel and others join. The platform owns everything around it (launcher, card, presence line, permissions, moderation); the app itself is a sandboxed bundle that talks to the page through a narrow message API.

This page covers the part that exists so far: the manifest every app ships, its validator, the presence line, and the bridge contract.

## The manifest

Every version of every app is described by one JSON file, `manifest.json`. An author writes the source shape (no hashes); the packager hashes the bundle and writes the built shape, which the server stores as it is and never takes from a client.

Fields, in the order they appear:

| Field | Meaning |
|---|---|
| `manifestVersion` | Version of the manifest format. Always `1` for now. |
| `id` | Permanent, globally unique app id (lowercase letters, digits, hyphens, 3 to 32 characters). Never reused. Ids starting with `pqp-` belong to the first-party publisher. |
| `version` | Semantic version of this build, without `+build` metadata (two builds that differ only there would be one version to SemVer but two strings to the pin). Two builds with the same id and version must be byte-identical. |
| `publisher` | The publisher that owns the id. `pqp` is first-party. |
| `platformApi` | Version of the sandbox message API the app is written against. Only `1` exists. |
| `name`, `description` | i18n keys for the display name and the one-line launcher description. |
| `icon` | One icon id from the pqp set (`APP_ICON_IDS`). Never an upload or a URL. |
| `category` | `game`, `tool` or `emulator`. `emulator` gets extra review and is first-party only. |
| `channelTypes` | Where the app can start: `text`, `voice`, or both. |
| `players` | `min`, `max` (players above it become spectators when `spectators` is true, otherwise the join is refused) and `maxSpectators` (default 50). |
| `requires` | Permission to start (`USE_APPS` or `MANAGE_CHANNELS`) and to join (`VIEW_CHANNEL` or `CONNECT`). |
| `capabilities` | What the app asks of the platform, shown in the join sheet. See below. |
| `hostBound` | When true the session's truth lives on the host's machine, so it ends after the host-gone grace instead of passing the host role on. |
| `state` | `maxBytes` of shared session state (0 to 16384), `maxWritesPerSecond` (1 to 10, default 10) and `writers` (`host` or `participants`, default `participants`). |
| `events` | Ephemeral relay limits per participant: `maxPerSecond` (0 to 20) and `maxBytes` (0 to 1024). |
| `presence` | i18n keys of the status line for someone in the app: `phrase` (has one `{name}`) and `short` (no placeholder). |
| `content` | `userText` and `userImages`: whether participants put content in the app that other people see. Drives the community lock. |
| `notice` | Optional i18n key of one line shown in the join sheet. |
| `entry` | `path` of the entry HTML in the bundle, plus `sha256` in the built shape. |
| `assets` | Optional big files the page hands to the sandbox on request: `name`, `path`, and in the built shape `sha256` and `bytes`. |
| `sandbox` | Optional narrow knobs over the fixed CSP: `wasm` (adds `wasm-unsafe-eval`), `blobWorkers` (adds `worker-src blob:`; not needed by Locadora, kept for apps that run their own workers, reviewed) and `localBlobs` (adds `connect-src blob:` only, never the network). There is no free-text CSP and no network knob. |
| `platforms` | Where it runs: `web`, `desktop`, `ios`, `android`. Default `web` and `desktop`. |
| `license` | `spdx` expression, `source` URL (https) and an optional `notices` path. |
| `store` | Optional listing fields: `summary`, `screenshots` (path, alt, and a hash in the built shape), `homepage`, `support`. |
| `i18n` | Strings for `pt-BR`, `en` and `es`, all three required. Plain text, 240 characters at most per value. |

Capabilities:

| Capability | Values |
|---|---|
| `identity` | `display` (name, avatar and a random per-session seat id) or `user-id` (also a stable per-app derived id, only for people who consent). |
| `share` | `none`, or `pane` to let the host screen-share the app pane (voice channels only). |
| `localFiles` | `allowed`, and when allowed the `accept` extensions and a `maxBytes`. The page opens the picker and reads the bytes; the file name never crosses and nothing is uploaded. |
| `peer` | `none` or `datachannel`. Only `none` is accepted on `platformApi` 1. |

## Rules beyond the schema

`validateAppManifest` runs the schema and then these rules. Each failure has a stable `code` and a `path`.

| Code | Rule |
|---|---|
| `players-range` | `players.max` is at least `players.min`. |
| `i18n-missing-key` | Every referenced key (name, description, notice, both presence keys, store summary, screenshot alt) exists in pt-BR, en and es. |
| `presence-placeholder` | `presence.phrase` has exactly one `{name}` and no other braces, in every locale. |
| `presence-short-placeholder` | `presence.short` has no `{`, in every locale. |
| `em-dash` | No i18n value contains an em dash. |
| `pt-br-voce` | No pt-BR value uses the word "você" or "voce" (pqp speaks "tu"). |
| `publisher-reserved-id` | An id starting with `pqp-` requires publisher `pqp`. |
| `publisher-emulator` | Category `emulator` requires publisher `pqp`. |
| `peer-unsupported` | `capabilities.peer` is `none` while `platformApi` is 1. |
| `local-files-accept-required`, `local-files-max-bytes-required` | When `localFiles.allowed` is true, `accept` and `maxBytes` are present. |
| `local-files-unexpected` | When it is false, they are absent. |
| `share-needs-voice` | `share: "pane"` requires `voice` in `channelTypes`. |
| `state-writers-no-state` | `state.writers: "host"` with `state.maxBytes: 0` has nothing to write. |

Schema failures use `schema-unknown-key`, `schema-required`, `schema-type`, `schema-enum`, `schema-format`, `schema-range` and `schema-unique`.

## The presence line

`formatAppPresence(template, displayName)` puts a person's name into the app's translated phrase ("Raf tá na Locadora"). The name is untrusted text a stranger typed, so control characters and bidi override and isolate characters are removed, it is trimmed and capped at 32 characters, and the substitution is a plain splice: `$&` stays literal and a name containing `{name}` is not expanded. An empty name becomes `?`. `resolveAppPresence(manifest, locale, displayName)` picks the locale (exact, then base language, then English) and returns the `phrase` for places where the line stands alone and the `short` for places under a name that is already shown.

## Availability

An app may run in a place only when every gate holds. `appAvailability(serverId, appId, { channelType })` in `server/src/apps/availability.ts` answers `{ available, reason }`, and `reason` is the FIRST gate that fails, in this order:

| Reason | Gate |
|---|---|
| `flag-off` | The runtime flag `apps` is off for the server. |
| `not-live` | `apps.status` is not `live`, or the app has no current version. |
| `global-off` | `apps.global_enabled` (the operator's master switch) is off. |
| `not-allowed-here` | `server_apps.operator_enabled` is not TRUE for this server. |
| `owner-off` | The server's owner set `server_apps.owner_enabled` to FALSE. The owner can only remove what the operator allowed. |
| `community-locked` | The server is a public community (`servers.is_community`) and the app has no `community_unlocked` safety decision. |
| `emulator-off` | `category: "emulator"` also needs the flag `emulator_room` on the server. |
| `channel-type` | The channel's type (`text` or `voice`) is not in the manifest's `channelTypes`. |
| `no-origin` | The deployment has no `APPS_ORIGIN`, so no app can run. |

D14: `appShareAllowed(serverId, app)` is true for every app except `category: "emulator"`, which also needs the flag `locadora_share` on the server (per server, default off, waiting for the lawyer's answer). The config carries it as `shareAllowed` and the session engine refuses `share.request` and spectator joins without it.

### The apps origin

`APPS_ORIGIN` names the separate, cookieless site that serves bundles (hosted: `https://pqp-apps.pages.dev`, local: `http://localhost:5175`). Unset, the config answers `origin: null` and every app is `no-origin`. Bundle addresses are `<origin>/<id>/<version>/<path>`, built by the server from the stored manifest, never from a request.

### The catalog

`server/src/apps/catalog.json` (`{ "apps": [ { "manifest": <built manifest>, "manifestSha256": "<hex>" } ] }`, written by the packager) is merged into `apps` and `app_versions` at boot by `loadAppCatalog`, on the API and the worker. The merge is insert-only: a new app arrives as `draft`, off everywhere, and a new version as `pending` review; the same (id, version) with a different `manifestSha256` is refused with a loud log; nothing ever changes the status, switches, review fields or `current_version` of an existing row, except that an app with no `current_version` gets the newest version the load inserted. Every insert writes an `app_admin_audit` row (`catalog-load`). The build copies the file into `dist/apps/`.

On a dev box only (`DEV_AUTH_BYPASS=true` and `NODE_ENV` not `production`) apps of the `pqp` publisher are made `live`, `global_enabled` and `community_unlocked` at load, and the dev seed releases them on its Sandbox server, so a local checkout needs no dashboard. Turn the platform itself on with `APPS=true` in `.env`, and set `APPS_ORIGIN`.

### The config route

`GET /api/apps/config?serverId=` (member of the server, otherwise 404) answers `{ enabled, origin, apps }`, typed by `appsConfigSchema` in `packages/shared/src/apps/config.ts`. With the flag off, or with no `serverId`, it is `{ enabled: false, origin: null, apps: [] }`. Each `live` app is listed with `available` and `reason`, the entry and asset URLs, `shareAllowed`, and only the i18n keys a client draws (name, description, notice, presence) in all three locales.

### Who may start

`USE_APPS` is on `@everyone` of every server created from now on (`PERMISSION_NEW_SERVER_EVERYONE`), and on the moderator, manager and admin staff roles, which is what a new server is seeded with. It is not in `PERMISSION_DEFAULT_EVERYONE`, so a community only has it when its owner grants it.

## The bridge

The bridge is the message API (v1, `APP_PLATFORM_API = 1`) between the pqp page, the host, and a sandboxed app frame. The app is untrusted. Contract: `packages/shared/src/apps/bridge.ts`. The WebSocket frames between the pqp client and the API are in `packages/shared/src/apps/frames.ts`, listed in the chat unions as the session engine ships them (see "Sessions").

### Handshake

Two messages travel on `window.postMessage`, nothing else does:

1. The app posts `{ pqp: "app-hello", platformApi: 1 }` to its parent.
2. The host answers `{ pqp: "app-port", platformApi: 1 }` and transfers one end of a `MessageChannel`.

The frame is an opaque origin, so there is no origin to compare. The host checks `event.source === iframe.contentWindow` and ignores every other message. The app checks that the port message came from `window.parent`. Everything after that is on the port.

**Strict toward the less trusted side, tolerant toward a newer peer.** Messages from the app (`app-hello`, every request) and client to server frames are strict: an unknown key is a rejection. Messages to the app (`app-port`, responses, pushes) and server to client frames use zod's default strip: an unknown key is dropped, never passed through. A field added later therefore does not make an app pinned to platform API 1, or an older client, reject the whole message, and a stripped key can never reach the app.

### App to host (requests, `{ id, type, ...params }`, `id` 1 to 32 characters)

- `participants.get`: the current participant list.
- `state.get`: the session state and its revision.
- `state.patch { patch, baseRev? }`: a JSON Merge Patch (RFC 7396) over the state. `baseRev` makes it conditional.
- `events.send { name, data }`: an ephemeral event for the others. `name` matches `/^[a-z][a-z0-9.-]{0,31}$/`.
- `assets.get { name }`: the bytes of one of the manifest's `assets[]`, checked by the host.
- `files.pickLocal`: the host opens the picker (the manifest decides accept list and size cap) and transfers the bytes. The file name never crosses.
- `ui.resize { height }`: 120 to 2000 pixels.
- `ui.fullscreen { on }`
- `share.request { on }`: share the app pane through pqp's own flow (apps whose manifest allows it).
- `session.end`: host only.

### Host to app

Responses carry the request `id`, and a successful one also echoes the request `type`, so its `result` is read as the answer to that call and never guessed from its shape. A call with nothing to return (`events.send`, `session.end`) answers `result: null`: `{ id, ok: true, result }` or `{ id, ok: false, error }`, with `error` one of `not-allowed`, `not-host`, `too-large`, `rate-limited`, `stale-rev`, `cancelled`, `unavailable`, `ended`, `invalid`.

Pushes have no id:

- `hello`: platform version, app id and version, locale, theme, reduced motion, `self` (seat, role, host), connection. Sent once after the port is handed over.
- `participants`: seat id, display name, avatar as a data URL (or null), role, host flag, `connection` (`present`, or `reconnecting` while the seat is held for its 90 second resume window), and `appUserId` only for people who consented. The same `connection` field is on the participants of `participants.get`, of the `app-session` frame and of the `channel-app` summary.
- `state { rev, value }`
- `event { fromSeatId, name, data }`
- `connection { status }`: `online` or `reconnecting`.
- `session.ended { reason }`: one of the `end_reason` values of the data model.
- `theme { theme }`: up to 64 CSS custom properties.

### Caps

| What | Cap |
|---|---|
| State patch and state value | 16384 bytes serialized (`APP_STATE_MAX_BYTES`) |
| Event payload | 1024 bytes serialized (`APP_EVENT_MAX_BYTES`) |
| Events per participant | 20 per second (`APP_EVENT_MAX_PER_SECOND`) |
| State writes per session | 10 per second, coalesced (`APP_STATE_MAX_WRITES_PER_SECOND`) |
| JSON nesting | 32 levels |
| Participants in one push | 264 |
| Avatar data URL | 65536 characters |
| Avatars in one participant list | 4 MiB of characters in total (`APP_PARTICIPANTS_AVATAR_BUDGET_CHARS`); the host downsizes avatars until the list fits |
| Display name | 64 characters |

JSON values must survive `JSON.stringify` unchanged: no `undefined`, functions, `NaN`, `Infinity`, class instances or holes in arrays. Sizes are UTF-8 bytes of the serialized value, enforced by the schemas themselves.

### What the app never sees

A pqp user id, an email, a token, a server id or a channel id. It gets a display name, an avatar as a data URL, a random per-session seat id (16 to 32 characters of `A-Za-z0-9_-`), and, for people who ticked the consent box only, a per-app derived id. `bridge.test.ts` walks every bridge schema and fails if a key named `userId`, `user_id`, `email`, `token`, `serverId` or `channelId` appears on it. The WebSocket frames may carry user ids, because the page needs them to draw avatars; the page strips them before anything reaches the app.

## Sessions

One live session per channel, decided by the partial unique index `idx_app_sessions_one_live_per_channel`. Code: `server/src/apps/sessions.ts` (start, end), `server/src/apps/summary.ts` (the summary read from the rows), `server/src/ws/apps.ts` (fan-out), routes in `server/src/api/app-routes.ts`. Everything is behind the `apps` flag: with it off for the server, every route below answers 404 and no frame is sent.

| Route | Answers |
|---|---|
| `POST /api/channels/:channelId/app-sessions` `{ appId }` | 201 with an `AppSessionSummary`. 404 channel unknown, not a server channel, not viewable, or flag off. 403 `app_unavailable` with `reason` (see Availability). 403 `cannot_start`. 409 `session_live` with `session`, the live one. 429 `rate_limited`. |
| `GET /api/channels/:channelId/app-session` | The channel's `AppSessionSummary`, or `null`. |
| `POST /api/app-sessions/:sessionId/end` | 200 `{ ended }`: `false` when it was already over. 403 `cannot_end`. |
| `POST /api/app-sessions/:sessionId/take-host` | 200 `{ host: true }`: "Assumir agora", only for the person the host countdown named, while it runs. 404 session not visible or flag off, 409 `host_present` / `host_bound` / `host_changed`, 403 `not_next_host`. |
| `GET /api/servers/:serverId/app-sessions` | `{ sessions: [{ channelId, session }] }` for every channel of the server the caller can VIEW. The client asks on server open and on socket reconnect; the `/ws` welcome carries none of it. |

A start checks, in order: the channel exists and the person can VIEW it; the flag; the app is available for the channel's type; the person holds the manifest's `requires.start` in THIS channel (USE_APPS always, so channel overwrites apply; `MANAGE_CHANNELS` on top when the manifest says so); no live session. In one transaction it inserts the session (`server_id` from the channel row, never from the request; the version pinned to `apps.current_version` at that instant) and a system message (`system_kind = 'app_session'`, body `<name> começou um app` for clients that do not know the kind), links it as `timeline_message_id`, and after the commit tells the channel (`message-broadcast`, then `channel-app`). The starter is host and is not joined.

An end (`endSessionRow`) sets `status = 'ended'`, `end_reason`, `ended_by`, clears the state to `{}`, writes `summary = { participants, durationSeconds }` and stamps everyone still seated as left. Who may end: the host (`host`), someone with MANAGE_CHANNELS in the channel (`moderator`), an instance moderator (`operator`); the system ends with the other reasons. Ending a session that is over is a 200 no-op that tells nobody.

Frames: `channel-app` `{ channelId, session: AppSessionSummary | null }` goes to every socket whose account can VIEW the channel (decision D13), on every instance, not only to sockets looking at the channel. A start and an end are sent at once and are never dropped; changes to a count are coalesced to one summary per 250 ms per channel. `app-ended` goes to the sockets seated in the session. Row first, bus hint second: the bus carries only "this channel changed" and each instance reads the rows for its own sockets.

### Taking part: join, leave, state, events

The client frames (all strict, listed in `chatClientMessageSchema`): `app-join { sessionId, asSpectator? }`, `app-leave { sessionId }`, `app-state-patch { sessionId, baseRev?, patch }`, `app-event-send { sessionId, name, data }`. The server answers with `app-session`, `app-state`, `app-event`, `app-ended` and `app-error { sessionId, op, code }` (`full`, `not-allowed`, `ended`, `rate-limited`, `too-large`, `stale-rev`, `unavailable`). With the flag off for the session's server, or for a session that does not exist, a client frame is answered with nothing at all. Code: `server/src/ws/apps.ts` (handlers and fan-out), `server/src/apps/participants.ts` (the rows), `server/src/apps/state.ts` (the shared state).

- **Joining** (D13): VIEW_CHANNEL, plus CONNECT in a voice channel; a manifest's `requires.join: "CONNECT"` raises a text channel to the same. A person who may not is refused `not-allowed`. Over `players.max` the person is seated as a spectator if the app allows it and `maxSpectators` has room, else `full`; `asSpectator` asks for it with room to spare. D14: an `emulator` app admits spectators only where `locadora_share` is on (`not-allowed` for an explicit request, `full` when the seat was only a spillover). A person under a timeout is seated as a spectator, who writes and sends nothing. Joining takes the session row's lock, so two machines taking the last place give it to one of them.
- **Seats**: one row per person per session, however many tabs. The seat id is 22 random base64url characters and is the only identifier the app sees. A person already seated resumes the same seat id and role. `connection` is `reconnecting` while the seat is held.
- **The hold**: a socket closing with no other socket of that person seated holds the seat for 90 s (`orphaned_at`); `app-leave` releases it at once (`left_at`), and coming back after a leave keeps the seat id but not the place in line. Every 15 s each process sweeps ONLY the rows it owns (`instance_id`): a ghost (no socket in its map) is held, a held seat past 90 s is released. A close on a machine that no longer owns the row changes nothing, and a person whose seat another machine stamped as held while they still have a socket here takes it back at the next roster. Rows of a dead instance are not touched here (that is the global sweep, behind `otherLeasesTrustworthy`).
- **Roster**: every seated socket gets `app-session` again when anyone joins, leaves, is held or returns (coalesced to 250 ms), and the channel's viewers a fresh `channel-app`. The snapshot carries the state with its revision: a client applies the state in it only when `rev` is at least the one it holds.
- **State** (`app-state-patch`): JSON Merge Patch (RFC 7396) applied to the parsed state under the row's lock, `state_rev` bumped by one per write, the whole value broadcast as `app-state` (row first, bus hint second: the other machine reads the row). Writers: the manifest's `state.writers` (`host`, or `participants`, meaning players and the host, never spectators). `baseRev` is a compare-and-set (`stale-rev`) and is written alone and at once or refused as `rate-limited`. The cap is the manifest's `state.maxBytes` (at most 16 KB) on the compact `JSON.stringify` bytes of the merged parsed value, never the text the client sent. A string with U+0000 is refused (jsonb cannot store it). A session takes at most `state.maxWritesPerSecond` writes a second from one machine: patches arriving inside the window are applied one after the other in ONE write and one revision bump, so the last value wins and nothing composes inexactly. A patch that changes nothing writes nothing.
- **Events** (`app-event-send`): relayed as `app-event { fromSeatId, name, data }` to the other seats on every machine, never stored and never logged (only counters). Per participant, at most `events.maxPerSecond` a second (a token bucket) and `events.maxBytes` per event; the sender hears `rate-limited` at most once a second. Spectators send none.
- **Frame budget**: `app-state-patch` and `app-event-send` draw from their own bucket in `ws/frame-budget.ts` (120 burst, 40 a second), so a well-behaved game is not hung up by the 20 a second chat budget; joins and leaves stay on the general one.

## Sweeps, the host and retention

`server/src/apps/sweeps.ts`, registered in `jobs.ts` (so it runs where the cold jobs run, the worker when there is one) every 15 s under a one-process-per-tick lease, safe to run twice at once because every write is a compare-and-set on the state it judged. In this order, each pass seeing what the one before left:

1. `flag-off`: the `apps` flag is off for the session's server.
2. `app-disabled`: the app is no longer available there (retired, off for everyone, not released to the server, switched off by the owner, the server became a public community the app is not unlocked for, `emulator_room` went off). The apps origin and the channel type are deliberately not reasons: a worker with no `APPS_ORIGIN` must not end every session on the instance.
3. `max-duration`: twelve hours.
4. Seats lost: a participant who can no longer VIEW the channel (or CONNECT where the session needs it) is released (`left_at`, not held).
5. Seats of dead instances: held for 90 s and then released. An instance is dead when its `voice_instances` heartbeat has lapsed (or the seat names no instance), and only while this process can believe the leases (pitfall 18): never while its own heartbeat is recovering, nor for a TTL after one of its own sweeps failed, nor when there is no cluster topology (then there are no heartbeats to read; a single process adopts the seats of its earlier run at boot instead, `adoptPreviousRunSeats`).
6. The host (D7): no present seat starts `host_gone_at`. While it counts down, `channel-app` carries `handoff: { toUserId, at }` (who is next, and `host_gone_at` plus two minutes), sent again when who is next changes. After two minutes the role goes to the longest seated participant whose seat is present and who holds the manifest's start permission (`pickNextHost`, in `next-host.ts`); a `hostBound` app ends `host-gone` instead; nobody eligible with people still seated ends `host-gone`; a session nobody is in is left to pass 7. The chosen person may take it at once with `take-host`.
7. `empty`: no seat for five minutes, counted from the last release (or from the start for a session nobody joined).

A deleted channel takes its sessions with it (the foreign key cascades), so the channel delete route ends them first with `channel-gone` (`endSessionsOfChannel`) while the channel still exists to tell its viewers.

Retention: `sweepAppSessionRetention` (daily, `services/retention.ts`) deletes ended sessions more than 30 days old in batches of 500; their participants go with them; the timeline message stays.

`GET /api/admin/metrics` has an `apps` block, live: `live` (sessions, seats and sessions by app, from the table, or `null` when the database could not be asked) and `counters` since this process started: `starts`, `startsRefused` by reason, `ends` by reason, `handoffs` (`sweep`, `take`), `joins`, `joinsRefused` by code, `framesDropped` by the cap that refused them, `stateWrites`, `stateWritesCoalesced`, `events`, `hostGoneStamped`, `participantsRemoved`, `deadInstanceSeats`, `sweepRuns`, `sweepFailures`. With two instances and a worker, read each and sum.

## Where things live

- Zod schemas, validator and constants: `packages/shared/src/apps/manifest.ts`
- Presence formatter: `packages/shared/src/apps/presence.ts`
- Bridge contract: `packages/shared/src/apps/bridge.ts`; WebSocket frames: `packages/shared/src/apps/frames.ts`; shared JSON, seat id and end reason pieces: `common.ts`; roster and JSON caps beyond the manifest's: `limits.ts`
- JSON Schema for third parties: `packages/shared/schemas/app-manifest-1.schema.json`
- Fixtures: `packages/shared/fixtures/app-manifests/` (`valid-*`, `invalid-schema-*` rejected by both schemas, `invalid-rule-*` accepted by the JSON Schema and rejected by the validator)
- Tests: `packages/shared/src/apps/*.test.ts`. The parity test runs both schemas over every fixture, so the JSON file and the zod schema cannot drift apart. Change one, change the other, add a fixture.
- Availability, catalog, config: `server/src/apps/{availability,catalog,config,origin}.ts`, route in `server/src/api/app-routes.ts`, client contract `packages/shared/src/apps/config.ts`
