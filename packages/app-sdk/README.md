# @pqp/app-sdk

The SDK for apps that run inside [pqp](https://pqp.gg) text and voice channels: a poll, a game room, a shared counter. An app is a small web page that pqp shows in a sandboxed frame. This package is the other half of the conversation: it does the handshake with the pqp page and gives your code a typed object to read the session and write to it.

- No dependencies, runtime or type. About 6 KB minified, 2.3 KB gzipped.
- Works in the sandbox: no network, no storage, no same-origin access needed.
- TypeScript first. The types are in the package.

Docs, a tutorial and the full reference live in the pqp repository under [`docs-apps/`](https://github.com/rafaelcg/pqp/tree/main/docs-apps).

## Install

```sh
npm install @pqp/app-sdk
```

The types use the DOM (`MessagePort`, `MessageEvent`), so your `tsconfig.json` needs `"lib": ["ES2022", "DOM"]`, which any browser project has.

## Quickstart

A shared counter. Everybody in the session sees the same number.

```ts
import { applyTheme, connect, PqpAppError } from "@pqp/app-sdk";

const app = await connect(); // handshake with the pqp page, rejects outside a pqp frame
applyTheme(app.hello.theme); // pqp's colors as CSS custom properties
app.on("theme", (theme) => applyTheme(theme));

const label = document.querySelector("#count")!;
const show = ({ value }: { value: unknown }) => {
  label.textContent = String((value as { count?: number } | null)?.count ?? 0);
};
app.state.on(show); // listeners first...
show(await app.state.get()); // ...then the value from before them

document.querySelector("#plus")!.addEventListener("click", async () => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { rev, value } = await app.state.get();
    const count = (value as { count?: number } | null)?.count ?? 0;
    try {
      await app.state.patch({ count: count + 1 }, { baseRev: rev }); // a merge patch, written against the revision we read
      return;
    } catch (error) {
      if (!(error instanceof PqpAppError) || error.code !== "stale-rev") throw error; // somebody was faster: read again
    }
  }
  console.warn("too many writes at once, that click was not applied"); // all four attempts lost a race: say so, never drop it silently
});
```

An app is also a manifest and a build. Those live in the pqp repository today: [Getting started](https://github.com/rafaelcg/pqp/blob/main/docs-apps/guide/getting-started.md) builds one from nothing.

## What you get

| | |
|---|---|
| `connect(options?)` | The handshake. Resolves with the app object, rejects with `PqpAppError("unavailable")` outside a pqp frame or when pqp does not answer. |
| `app.hello` | Locale, theme, reduced motion, who you are in the session (`self`), the app id and version. |
| `app.participants` | `get()` and `on()`: the people in the session, as seat ids, names and avatars. |
| `app.state` | `get()`, `patch()` and `on()`: one shared JSON value, at most 16 KB, written with JSON Merge Patch. |
| `app.events` | `send()` and `on(name)`: ephemeral messages for the others, at most 1 KB each. |
| `app.assets`, `app.files` | Big files the manifest lists, and the person's own files through pqp's picker. |
| `app.ui`, `app.share`, `app.end()` | Resize and fullscreen the frame, share the pane, end the session (host only). |
| `applyTheme(theme)` | Writes pqp's design tokens onto your page. |
| `PqpAppError` | What every rejected call throws, with a `code`. |

## Versions and compatibility

This package speaks **platform API 1**: the `platformApi` in your app's `manifest.json` must be `1`. A future platform API 2 will be a new major version of this package; apps on 1.x keep working for as long as pqp serves platform API 1. While the version is `0.x`, a minor release may change the API. The policy is in [`CHANGELOG.md`](./CHANGELOG.md).

## License

AGPL-3.0-only, the same as pqp. See [`LICENSE`](./LICENSE).
