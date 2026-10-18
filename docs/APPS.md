# Apps

An app is a small interactive thing, a poll or a game room, that someone starts in a text or voice channel and others join. The platform owns everything around it (launcher, card, presence line, permissions, moderation); the app itself is a sandboxed bundle that talks to the page through a narrow message API.

This page covers the part that exists so far: the manifest every app ships, its validator, and the presence line.

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

## Where things live

- Zod schemas, validator and constants: `packages/shared/src/apps/manifest.ts`
- Presence formatter: `packages/shared/src/apps/presence.ts`
- JSON Schema for third parties: `packages/shared/schemas/app-manifest-1.schema.json`
- Fixtures: `packages/shared/fixtures/app-manifests/` (`valid-*`, `invalid-schema-*` rejected by both schemas, `invalid-rule-*` accepted by the JSON Schema and rejected by the validator)
- Tests: `packages/shared/src/apps/*.test.ts`. The parity test runs both schemas over every fixture, so the JSON file and the zod schema cannot drift apart. Change one, change the other, add a fixture.
