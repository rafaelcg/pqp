# The manifest and capabilities

Every version of every app is described by one JSON file. Where a normal web app would have a settings page, an app has a manifest: it is how pqp knows what the app is, how it behaves and what it is allowed to ask for, **before running any of its code**.

You write `manifest.source.json`. The packager hashes your bundle and writes the built `manifest.json` (the same file plus the hashes), which the server stores and which nobody edits afterwards. The field-by-field table is in the [manifest reference](/sdk/manifest); this page is about the ideas.

## What the manifest is for

1. **Telling people.** The launcher tile, the join sheet, the presence line under a name and the card on the timeline are all drawn from it, in the viewer's language (`i18n`, with `pt-BR`, `en` and `es` all required).
2. **Gating.** `channelTypes` says where the app may start. `requires` says what permission starts it and what permission joins it. `players` says how many.
3. **Limiting.** `state` and `events` set the caps for this app. They can only be tighter than the platform's hard ceilings (16 KB state, 1 KB events), never looser.
4. **Declaring capabilities.** What the app asks of the platform beyond the basics, below.
5. **Reviewing.** A reviewer reads one file to see what the app does with people's data.

The manifest is enforced, not advisory. The page and the server both check every state write and every event against it, so a capability you did not declare is a call that gets `not-allowed`.

## Capabilities

`capabilities` has four members. The default for each is "none", and an app that asks for nothing is the easiest to approve.

### `identity`

- **`display`**: you see each person as a display name, an avatar and a random seat id that exists only for this session. This is what almost every app wants.
- **`user-id`**: you also get a stable, **per-app** derived id (`appUserId`) for people who consent to it. It is not the pqp user id, cannot be linked to one, and is different for every app. Only people who ticked the consent box have one, so you must work without it for the rest. Because an app has no storage and no network today (see [What an app can keep](/concepts/storage)), there is little to key it on yet. Most apps should stay on `display`.

### `share`

- **`none`**, or **`pane`**: the session host may screen-share the app's pane into a voice channel through pqp's own sharing flow (`app.share.request(true)`). Requires `voice` in `channelTypes`. Emulator apps need an extra server flag on top.

### `localFiles`

`{ allowed: false }`, or `{ allowed: true, accept: [".nes", ".gb"], maxBytes: 33554432 }`. When allowed, `app.files.pickLocal()` asks the page to open the system file picker (the page opens it, not you), read the file, and hand your app `{ bytes, ext }`. The **file name never crosses**, only the extension (taken from your `accept` list, never from the name), and the file is **never uploaded**: it goes from the person's disk to your frame's memory.

### `peer`

`none` is the only value accepted on platform API 1. A `datachannel` option is reserved for a future version, and the validator refuses it today.

## Two numbers you will tune

**`players`**: `min`, `max`, `spectators`, `maxSpectators`. People beyond `max` become spectators if the app allows them and there is room (`maxSpectators`, default 50), and otherwise are refused (`full`). A spectator sees everything and writes and sends nothing.

**`state`**: `maxBytes` (0 to 16 384), `maxWritesPerSecond` (1 to 10), and `writers`: `participants` (players and the session host, never spectators) or `host` (only the session host). A turn-based game where one person is the referee wants `host`; a poll wants `participants`. Set `maxBytes` to what you need and a bit: the cap is on the merged value, and a smaller cap is a smaller thing to review.

## Rules a schema cannot say

On top of the schema, `validateAppManifest` runs rules like "every key you reference exists in all three languages", "`presence.phrase` has exactly one `{name}`", "no em dash in any string", "pt-BR says `tu`, never `voce`", "ids that start with `pqp-` belong to the `pqp` publisher". Each failure has a stable code and a path, and `pnpm apps:build` prints them. They are in the [reference](/sdk/manifest#rules-beyond-the-schema).

## Content flags and communities

`content.userText` and `content.userImages` say whether people put their own words or pictures into your app that other people then see (a poll's question, a drawing). **Every app is off listed public communities until the operator records a safety decision for it**, and these two flags are what that decision reads: an app that shows user text or images gets a harder look. A reviewer can check the flags against your source.

## A JSON Schema for tools

`packages/shared/schemas/app-manifest-1.schema.json` is the same format as a JSON Schema for editors and third-party tooling. A test runs both it and the validator over the same fixtures, so they cannot drift apart. Point your editor at it for completion while you write `manifest.source.json`.

Next: [sessions and participants](/concepts/sessions).
