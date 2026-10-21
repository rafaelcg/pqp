# Publishing @pqp/app-sdk to npm

Nothing here has been run. As of 2026-10-20 `npm view @pqp/app-sdk` answers 404: the name is free (or at least not taken by a package you could see), and nothing is published. This file is what Rafael does, in order, the first time and every time after.

## Why `"private": true` is still in `package.json`

On purpose, and it should stay there.

The `package.json` in this folder is the **development** manifest. Its `exports` point at `src/index.ts`, so the first-party apps, `pnpm apps:dev` and `pnpm apps:check` bundle the TypeScript source directly. That is what keeps the catalog hashes of Eco and Enquete exactly what they are: an app built from `dist/` would be a different file, and a released `(id, version)` must never change its bytes (`docs/APPS.md`, "Versions are immutable"). `private: true` is the seatbelt: with it, `npm publish` and `pnpm -r publish` refuse to upload this folder, whose `exports` would be broken for anybody who installed it (they point at `.ts` files that are not in the tarball).

What gets published is a second manifest, written by `scripts/stage.mjs` into `publish/` (git-ignored). It is the same package with the three differences a published one needs: it points at `dist/`, it is not private, and it has no scripts and no devDependencies. So there is no "remove `private`" edit to make. The step that makes the package publishable is `pnpm --filter @pqp/app-sdk package`, and the step that uploads it is `publish:npm`, which refuses to run without `PQP_SDK_PUBLISH=yes`.

## What the build guarantees

`pnpm --filter @pqp/app-sdk package` builds `dist/`, stages `publish/` and then **checks** it (`scripts/check-package.mjs`), failing on any of these:

- the staged manifest is private, or has scripts or dependencies;
- a file in the tarball imports anything but its own files, or mentions `@pqp/` or `zod` outside a comment (the leak that would make `import ... from "@pqp/app-sdk"` fail to type-check for a stranger, because `@pqp/shared` is not on npm);
- a test file is in the tarball;
- the package does not load, or exports something other than `connect`, `createApp`, `PortClient`, `REQUEST_TIMEOUT_MS`, `PqpAppError`, `applyTheme`;
- a strict TypeScript consumer (`skipLibCheck: false`, only `lib.dom`) cannot type-check a use of the package.

Why the types are written out in `src/types.ts` rather than imported from `@pqp/shared`: see its header. `src/types.parity.test.ts` keeps the copy honest.

## Before the first release

These need a person with the npm account. None of them is in the repository.

1. **Decide the license.** The package says `AGPL-3.0-only`, like the rest of pqp. The SDK is bundled into every app, so every app that ships it carries AGPL code. pqp's manifest already requires every app to name an open source license and a source URL, so this may be what you want, but it is a decision with a cost: many developers will not put AGPL code in a bundle, and a permissive license (MIT or Apache-2.0) on this one package is the usual way to remove that objection. Changing it means changing `license` in `package.json` and the `LICENSE` file `stage.mjs` copies (today the repository's root `LICENSE`). Decide before the first release; a published version's license cannot be changed.
2. **Get the scope.** `@pqp` is an npm scope, which is an npm organization or user named `pqp`. Create the organization at <https://www.npmjs.com/org/create> (free for public packages). If `pqp` is already taken on npm, the scope has to change (`@pqp-gg/app-sdk`, for example), and then the name changes in `package.json`, `README.md`, the docs site and the example imports. Check first with `npm view @pqp/app-sdk` (read-only; a 404 says only that this package does not exist, not that the scope is yours).
3. **Turn on two-factor authentication** on the npm account (it is the safe default for anything that can publish, and `NPM_OTP` below assumes it).
4. **Make a token for the workflow.** On npm, Access Tokens, "Generate New Token", granular, permission "Read and write", limited to the `@pqp` scope, with an expiry. Add it to the repository as the Actions secret `NPM_TOKEN` (Settings, Secrets and variables, Actions). Do not paste it anywhere else. After the first release you can switch to npm's "trusted publishing", configured on the package's page on npmjs.com, which needs no stored token; the workflow already asks for the OIDC permission it needs.

## Cutting a release

Everything before the last step is a dry run, and you can repeat it as often as you like.

```sh
# 1. bump the version in packages/app-sdk/package.json and add a section to CHANGELOG.md
#    (the policy at the top of CHANGELOG.md says what kind of bump it is)

# 2. build, stage, check, and list the tarball without writing it
pnpm --filter @pqp/app-sdk pack:dry

# 3. the tests and the typecheck
pnpm --filter @pqp/app-sdk test
pnpm --filter @pqp/app-sdk typecheck

# 4. the apps must not have moved: this fails if any app's bytes changed
git fetch origin main
pnpm apps:check
```

Then publish, one of two ways.

**From GitHub (preferred, with provenance).** Actions, "Release app-sdk", Run workflow, pick `main`, leave "dry run" ticked the first time and look at the log, then run it again with it unticked. It builds, checks, and runs `npm publish --provenance`, so the package page shows which commit and which workflow made it. The workflow is `.github/workflows/release-app-sdk.yml`. It runs only when you press the button.

**From your laptop (no provenance).**

```sh
npm login                      # once
PQP_SDK_PUBLISH=yes NPM_OTP=123456 pnpm --filter @pqp/app-sdk publish:npm
```

`NPM_OTP` is the current code from your authenticator, needed when the account has two-factor on writes.

After it is up:

```sh
npm view @pqp/app-sdk version pqp          # the version, and { platformApi: 1 }
mkdir /tmp/try && cd /tmp/try && npm init -y && npm install @pqp/app-sdk
git tag app-sdk-v0.1.0 && git push origin app-sdk-v0.1.0
```

## What a release does to the apps

Nothing. First-party apps import the workspace source, not the npm package, so publishing changes no bundle and no catalog hash. If you ever move an app to the published package, that is a source change like any other: its bundle changes, so its `version` must be bumped.

## When something is wrong

- A bad release: `npm deprecate @pqp/app-sdk@0.1.0 "use 0.1.1"`, then publish a fixed version. `npm unpublish` is possible for 72 hours after a publish and is the last resort, because the name and version can never be used again.
- A version number cannot be reused, ever. If a publish half-failed, bump.
- The workflow fails at "Check the package": read the list, it names the file. Do not bypass the check.
