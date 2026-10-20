# Versions and the catalog

The rule that shapes everything else on this page: **a released `(id, version)` never changes its bytes.** Two builds with the same id and version must be identical, and the build fails when they are not.

## Why

- A session **pins** the version that was current when it started, and people join a running session for up to 12 hours. A late joiner must load exactly what the first person loaded.
- The bundle is served with `Cache-Control: immutable` for a year. A changed file under a published version folder would be served from caches indefinitely, to some people and not others.
- Review approves a **version**. If bytes could change underneath an approval, the approval would mean nothing.
- The integrity hashes (`sha384` on the script and stylesheet, `sha256` of the entry) tie the manifest to the code. They only mean something if both are fixed.

## How it is enforced

The server's catalog entry for a version carries a `manifestSha256`: the hash of the built manifest's canonical JSON (every object's keys sorted, no whitespace), so it does not depend on key order. The built manifest contains `entry.sha256`, which covers the entry page, which carries the integrity hashes of the script and stylesheet. So **any change to your code changes the manifest hash.**

- **At build time.** `pnpm apps:build` and `pnpm apps:check` compare the catalog they produce with the catalog on `origin/main`. An `(id, version)` that is already there must come out with the same `manifestSha256`, or the build fails with "bump the version". A fork or clone without `origin/main` skips the comparison with a warning; CI requires it.
- **At boot.** The server merges the catalog insert-only. The same `(id, version)` with a different `manifestSha256` is refused with a loud log, and nothing about an existing row (its status, switches, review fields or `current_version`) is ever changed by the load.

## What changes the bytes

Anything that changes what is built:

- your own source, markup and styles;
- **`@pqp/app-sdk`**, which is bundled into your app. A new SDK release is a new app version, for every app that adopts it;
- the toolchain: the Vite version is pinned exactly, and a bump of it (or of esbuild) can change the output of every app.

So the answer to "I fixed a typo" is the same as to "I changed the whole game": bump the version.

## Choosing a version number

It is SemVer 2.0, without `+build` metadata (two builds that differ only there would be one version to SemVer but two strings to the pin). A convention that works:

| Change | Bump |
|---|---|
| A bug fix, a copy fix, a style tweak | patch: `1.0.0` to `1.0.1` |
| A feature, a new locale string, a bigger state cap | minor: `1.0.1` to `1.1.0` |
| A different app, or a manifest change that breaks something people rely on (fewer players, a removed capability) | major: `1.1.0` to `2.0.0` |

pqp does not interpret the number beyond ordering. The newest version a load inserts becomes `current_version` only for an app that has none; after that, promoting a version to current is the operator's decision, not the catalog's.

## Keep released versions buildable

A Pages deploy replaces the whole apps site. A version that is no longer built from `apps/` stops being served, and a session pinned to it (at most 12 hours old) cannot load the frame for a late joiner. So **do not delete an old version's source while a session on it may still be running**, or accept that those late joiners fail. In practice a version stays buildable until the next one is current and the last session on it is over.

## `platformApi` is not your version

`platformApi` in the manifest is the version of the **message API**, and today it is `1`. Your app's `version` is yours. They move independently: a platform API 2 would be a manifest change you opt in to, and apps on 1 keep working for as long as pqp serves platform API 1. The SDK follows the same line: [`@pqp/app-sdk` 1.x speaks platform API 1](/sdk/#versioning).

## Releasing, step by step

1. Change the code. `pnpm apps:dev` while you work.
2. Bump `version` in `manifest.source.json` (and `package.json`, by habit).
3. `pnpm apps:build`, then commit the changed `server/src/apps/catalog.json` with your change. A stale catalog fails CI.
4. Open the pull request. After review and merge, the apps workflow publishes the bundles and the API loads the new version as `pending` review.
5. An operator approves it and promotes it to the app's current version. New sessions then start on it; running sessions keep the one they pinned.
