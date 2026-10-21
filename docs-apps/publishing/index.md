# Build and package

An app becomes something pqp can serve and trust by going through the **packager**, `tools/apps-build`. It turns the folder you wrote into an immutable, hashed bundle and writes the facts the server needs about it.

::: info How apps reach people today
Apps are first-party: they live in the pqp repository under `apps/<name>/`, and a pull request that adds or changes one is how it ships. When it merges, a workflow builds every app and publishes the bundles to the apps origin, and the API loads the new catalog the next time it boots. There is no submission portal, no publisher account and no listing page yet. [The appstore page](/publishing/appstore) says what that will need.
:::

## The three commands

Run from the repository root.

| Command | What it does |
|---|---|
| `pnpm apps:build` | Builds every app into `dist-apps/<id>/<version>/`, writes `dist-apps/_headers` and `server/src/apps/catalog.json`. |
| `pnpm apps:check` | Builds into a scratch folder and fails when the committed `catalog.json` differs from what the sources build to (the lockfile pattern), or when a released version would change its bytes. This is what CI runs. |
| `pnpm apps:dev` | Builds, then serves `dist-apps` on `http://localhost:5175` with the same `_headers` rules (caching off) and rebuilds when `apps/` or `packages/app-sdk/src/` change. `APPS_DEV_PORT` moves the port. |

## What a build does, per app

1. **Reads and validates `manifest.source.json`** with the source schema and all the [rules](/sdk/manifest#rules-beyond-the-schema). A bad manifest stops the build with the failing path and code.
2. **Runs Vite, deterministically.** Fixed file names (`index.js`, `index.css`, no content hash in a name, because the version folder is already immutable), no source maps, no module-preload shim, nothing inlined, one script and one stylesheet. The same sources and the same toolchain give the same bytes: a test builds twice and compares every hash, and the Vite version is pinned exactly.
3. **Refuses what the frame would silently refuse.** An inline `<script>` or `<style>`, a `style=` attribute, an `on*=` handler, `<base>`, `<meta http-equiv>`, a nested frame, or any reference that is not a relative path inside the bundle fails the build with the file named. (The frame's [content security policy](/concepts/sandbox) would drop them at runtime with no visible error, so they are caught here.)
4. **Adds integrity.** The entry page gets Subresource Integrity (`sha384`) and `crossorigin` on every script and stylesheet.
5. **Hashes every file** and writes the built manifest: your source plus `entry.sha256` and, for each asset and screenshot, `sha256` and `bytes`. It is validated again before anything is written.
6. **Writes `dist-apps/_headers`**, one rule per `/<id>/<version>/*`, with the frame's content security policy, `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: cross-origin` and `Access-Control-Allow-Origin: *`. CORS is open on the whole bundle on purpose: the frame is an opaque origin, so it loads its own module script and stylesheet in CORS mode.

Then, across all apps, it writes **`server/src/apps/catalog.json`**, sorted by id then version: `{ "apps": [ { "manifest": <built manifest>, "manifestSha256": "<hex>" } ] }`. That file is committed. The server loads it at boot and merges it in, insert-only: a new app arrives as a `draft`, off everywhere, and a new version as `pending` review.

## What the packager expects of your app folder

- `manifest.source.json`, with `entry.path` equal to `index.html`.
- A Vite-style app: `index.html` at the root of the folder, the script and the stylesheet referenced from it by relative path.
- A `package.json` that depends on `@pqp/app-sdk`.

The packager runs Vite with a **fixed configuration and no plugins** (so your own `vite.config` is not read). TypeScript, CSS and everything esbuild compiles by itself work. Frameworks that need a Vite plugin (Vue single-file components, Svelte) are not supported today; none of the first-party apps use a framework, and the SDK needs none.

## Size and speed

The bundle is loaded cold into a frame when somebody joins, so small is a feature: Eco's whole bundle is about 16 KB uncompressed, and the SDK (about 6 KB minified, 2.3 KB gzipped) is part of that. Keep big files out of the script and ship them as [assets](/concepts/storage), which the page fetches once, verifies and hands over on request.

## Local checks before you open a pull request

```sh
pnpm apps:build           # builds, writes the catalog
pnpm apps:check           # the catalog is current and released versions did not move
pnpm --filter @pqp-apps/<your-app> typecheck
```

Then read [Versions and the catalog](/publishing/versions): the rules about changing an app after it is released are the part people trip on.
