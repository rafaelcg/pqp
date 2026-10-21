# Manifest reference

The manifest is a JSON file. You write **`manifest.source.json`** in your app folder; the packager writes the **built manifest** (the same file with the hashes filled in), which is what the server stores. The ideas behind it are in [The manifest and capabilities](/concepts/manifest). This page is the field-by-field reference.

The authority is `packages/shared/src/apps/manifest.ts` (the zod schema and `validateAppManifest`), and `packages/shared/schemas/app-manifest-1.schema.json` is the same format as a JSON Schema for editors. The source shape is `appManifestSourceSchema`.

## A complete example

This is Eco's, the test app pqp ships (`apps/eco/manifest.source.json`):

<<< ../../apps/eco/manifest.source.json

## Fields

In the order they appear. "Source" means you write it, "built" means the packager adds it.

| Field | Type | Meaning |
|---|---|---|
| `manifestVersion` | `1` | The manifest format version. Always `1`. |
| `id` | string | Permanent, globally unique app id: lowercase letters, digits and hyphens, starting with a letter, 3 to 32 characters (`^[a-z][a-z0-9-]{1,30}[a-z0-9]$`). Never reused. Ids starting with `pqp-` belong to the first-party publisher. |
| `version` | string | SemVer, **without** `+build` metadata. Two builds with the same id and version must be byte-identical. |
| `publisher` | string | The publisher that owns the id, same shape as `id`. `pqp` is first-party and the only one that exists today. |
| `platformApi` | `1` | The message API the app is written against. Only `1` exists, and it must match the SDK. |
| `name`, `description` | i18n key | Keys into `i18n` for the display name and the one-line launcher description. |
| `icon` | enum | One of `gamepad`, `poll`, `pencil`, `music`, `dice`, `cards`, `puzzle`, `trophy`, `sparkles`, `flask`. Never an upload or a URL. |
| `category` | enum | `game`, `tool` or `emulator`. `emulator` gets extra review and is first-party only. |
| `channelTypes` | array | Where the app can start: `text`, `voice`, or both. Unique, at least one. |
| `players` | object | `min` and `max` (1 to 64 each), `spectators` (boolean) and `maxSpectators` (0 to 200, default 50). People beyond `max` become spectators when `spectators` is true, otherwise the join is refused. |
| `requires` | object | `start`: `USE_APPS` or `MANAGE_CHANNELS`. `join`: `VIEW_CHANNEL` or `CONNECT`. |
| `capabilities` | object | See [Capabilities](#capabilities). |
| `hostBound` | boolean | When true the session's truth lives on the session host's machine, so it ends after the host-gone grace instead of passing the host role on. |
| `state` | object | `maxBytes` (0 to 16 384), `maxWritesPerSecond` (1 to 10, default 10), `writers` (`host` or `participants`, default `participants`). |
| `events` | object | Per-person relay limits: `maxPerSecond` (0 to 20) and `maxBytes` (0 to 1 024). `0` turns events off. |
| `presence` | object | i18n keys of the status line for somebody in the app: `phrase` (exactly one `{name}`) and `short` (no placeholder). |
| `content` | object | `userText` and `userImages`: whether people put their own content in the app that others see. Informs the community lock. |
| `notice` | i18n key, optional | One line shown in the join sheet. |
| `entry` | object | `path` of the entry HTML in the bundle. **Must be `index.html`** (a Vite app). Built: also `sha256`. |
| `assets` | array, optional | Big files the page hands to the sandbox on request: `name` (`^[a-z0-9][a-z0-9._-]{0,63}$`), `path`. At most 64, each at most 32 MiB. Built: also `sha256` and `bytes`. |
| `sandbox` | object, optional | `wasm`, `blobWorkers`, `localBlobs`: narrow widenings of the fixed [content security policy](/concepts/sandbox#wall-3-a-content-security-policy-the-packager-writes). Each defaults to false. |
| `platforms` | array | Where it runs: `web`, `desktop`, `ios`, `android`. Default `web` and `desktop`. |
| `license` | object | `spdx` expression, `source` (https URL of the source) and an optional `notices` path. |
| `store` | object, optional | Listing fields: `summary` (i18n key), `screenshots` (up to 6, `path` and `alt` key; built: also `sha256`), `homepage`, `support` (https URLs). |
| `i18n` | object | Strings for `pt-BR`, `en` and `es`, **all three required**. Plain text, 1 to 240 characters per value, at most 200 strings per locale. |

An i18n key looks like `name`, `presence.phrase` or `join.title`: a lowercase letter, then letters and digits, up to four dot-separated parts.

Paths in `entry`, `assets`, `store.screenshots` and `license.notices` are relative to the bundle: no leading slash, no `..`, no `//`.

## Capabilities

| Capability | Values |
|---|---|
| `identity` | `display` (name, avatar and a random per-session seat id) or `user-id` (also a stable per-app derived id, only for people who consent). |
| `share` | `none`, or `pane` to let the session host screen-share the app pane (voice channels only). |
| `localFiles` | `{ allowed: false }`, or `{ allowed: true, accept: [".nes"], maxBytes: 33554432 }`. When allowed, `accept` (up to 16 extensions, each `.` and 1 to 8 lowercase letters or digits) and `maxBytes` (up to 64 MiB) are required. The page opens the picker and reads the bytes; the file name never crosses and nothing is uploaded. |
| `peer` | `none` or `datachannel`. Only `none` is accepted on platform API 1. |

## Rules beyond the schema

`validateAppManifest` runs the schema and then these rules. Each failure has a stable `code` and a `path`, and `pnpm apps:build` prints them.

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

Schema failures use `schema-unknown-key`, `schema-required`, `schema-type`, `schema-enum`, `schema-format`, `schema-range` and `schema-unique`. The manifest is strict: **an unknown key is an error**, so a typo cannot be silently ignored.

## What the packager adds

You never write these:

- `entry.sha256`: the hash of the built `index.html`, which carries the integrity hashes of its script and stylesheet, so it covers the whole code of your app.
- `assets[].sha256` and `assets[].bytes`, `store.screenshots[].sha256`.

The server's catalog entry is the built manifest plus `manifestSha256`, the hash of its canonical JSON. That is the number [version immutability](/publishing/versions) is checked against.
