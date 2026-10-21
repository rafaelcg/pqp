# Locadora

Eco shows the basics. **Locadora** is the other end: a real app that uses almost every capability the platform has. It is an NES and Game Boy emulator where every person opens their own game on their own computer, and it is the app the platform's hardest limits were designed around.

::: info Where it is
Locadora is **not on `main` yet**. It is a pull request in review ([#1411](https://github.com/rafaelcg/pqp/pull/1411), with the share control and the licenses in the PRs stacked on it), and it is `category: "emulator"`, which is first-party only and gets extra review. Everything below is read from that branch's `manifest.source.json` and sources as they stand today, and may change before it merges. The [fixture manifest](https://github.com/rafaelcg/pqp/blob/main/packages/shared/fixtures/app-manifests/valid-locadora.json) that is already on `main` is an earlier sketch of the same app.
:::

## What it asks of the platform, and why

| In the manifest | What it is | Why Locadora needs it |
|---|---|---|
| `category: "emulator"` | A category with its own review and a server flag (`emulator_room`). | An emulator needs a legal and safety look that a poll does not. First-party only. |
| `capabilities.localFiles` | `accept: [".nes", ".gb", ".gbc", ".gba"]`, `maxBytes` 32 MiB. | The person picks their own game. The page opens the picker and reads the bytes; the **file name never crosses and nothing is uploaded**. The app gets `{ bytes, ext }` and picks a core from the extension. |
| `assets` | Four files: two emulator cores (`.pqpc`) and their reports. | A WebAssembly core is megabytes. The content security policy forbids fetching, so the app asks the page for them with `app.assets.get(name)`, and the page checks each one's length and sha256 against the manifest first. |
| `sandbox.wasm: true` | Adds `'wasm-unsafe-eval'` to `script-src`. | The cores are WebAssembly. |
| `sandbox.localBlobs: true` | Adds `connect-src blob:`, still no network. | The picked bytes become a blob the emulator can read. |
| `capabilities.share: "pane"` | The session host may screen-share the app pane into a voice channel. | Others watch the game, and the manifest allows spectators for them. |
| `state.maxBytes: 0`, `events.maxPerSecond: 0` | No shared state, no events. | Nothing about the game is shared through pqp's state. Each person runs their own copy, and others see it through the screen share. |
| `content.userImages: true` | Declares that pictures the app did not make appear in it. | Our reading: the game's pictures come from the person's own file, and the community lock needs that said. |
| `notice` | A one-line notice shown in the join sheet. | "pqp does not provide games: only open one you have the right to play. The file stays on your computer and is never sent." |
| `license` | An SPDX expression for four licenses, and a `notices` file. | The cores bring their own licenses, and the manifest must say so. |

## What it shows you how to do

- **A narrow slice of the app object.** Its tape loader (`src/tape.ts`) is written against `{ files: { pickLocal }, assets: { get } }`, not the whole `PqpApp`, so a test hands it a fake with two methods.
- **Big files as assets**, fetched once and verified by the page.
- **`app.ui.fullscreen()`** from a button, since the sandbox gives the frame no fullscreen of its own.
- **Honouring `ended` and `connection`**, the same terminal-ended rule as Eco.
- **Nothing that needs the network.** Every limitation of the sandbox is a design input here rather than something worked around.

## Read it

Once it is merged: `apps/locadora/` in the [repository](https://github.com/rafaelcg/pqp). Until then, the pull request has the whole app, including the build step that repacks the cores into the `assets[]` format.

If you are designing something that is more than a counter, the manifest above is the best map of which capabilities cost what in review: `identity: "display"`, no files, no assets and an unchanged policy is the cheapest; `wasm`, `localBlobs` and a file picker are each reviewed on their own.
