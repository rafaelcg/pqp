# Getting started

You will build **Tiny Eco**, a smaller cousin of [Eco](/examples/eco), the test app pqp ships: a counter everybody in the session moves together, a ping button, and the list of who is here. It touches the four things every app does: connect, read state, write state, and listen to the others. Allow 20 minutes.

::: info Why you start from a clone of the repository
Apps are built inside the pqp repository today. The packager, the dev server and the way pqp loads an app all live there, and the app folder is a workspace package next to the others. Publishing `@pqp/app-sdk` to npm is prepared but not done, and third-party submission does not exist yet. [Publishing](/publishing/) says what that means for you.
:::

## Before you start

You need Node 22, pnpm 10, git and Docker (for the local database). Then:

```sh
git clone https://github.com/rafaelcg/pqp.git
cd pqp
pnpm install
pnpm --filter @pqp/shared build
```

The second command builds `@pqp/shared`, the package that holds the manifest validator. The packager imports its built output, so `pnpm apps:build` fails with a module-not-found error until it has run once. The commands below run from the repository root.

## 1. Scaffold the app

An app is a folder under `apps/`: a manifest, a page and a script. Make `apps/tiny-eco/` with these files.

`apps/tiny-eco/package.json` depends on the SDK from the workspace:

<<< ../snippets/tiny-eco/package.json

`apps/tiny-eco/tsconfig.json` is ordinary strict TypeScript for the browser:

<<< ../snippets/tiny-eco/tsconfig.json

`apps/tiny-eco/index.html` is the page pqp opens in the frame. Two rules come from the sandbox: no inline `<script>`, no inline `<style>`, no `style=` attributes (the frame's [content security policy](/concepts/sandbox) refuses them, and the packager fails the build if it finds one), and every path is relative:

<<< ../snippets/tiny-eco/index.html

`apps/tiny-eco/src/style.css` uses pqp's tokens, with a fallback for the moment before they arrive:

<<< ../snippets/tiny-eco/src/style.css

Then link the new workspace package:

```sh
pnpm install
```

It adds your app to `pnpm-lock.yaml`. If you are only trying the tutorial, `git checkout pnpm-lock.yaml` puts it back when you are done.

## 2. The manifest

`apps/tiny-eco/manifest.source.json` is the manifest you write. It is the one place that says what the app is and what it asks of pqp.

<<< ../snippets/tiny-eco/manifest.source.json

The fields worth understanding on a first read (the [full table](/sdk/manifest) has the rest):

- **`id`** is permanent and globally unique. **`version`** is SemVer, and a published `(id, version)` never changes its bytes.
- **`publisher: "pqp"`.** Today `pqp` is the only publisher there is, and it is the one a local checkout releases for you (see step 5). Third-party publishers arrive with submission.
- **`platformApi: 1`** is the version of the message API the SDK speaks. It must match your SDK.
- **`name`, `description`, `presence.*`** are not text, they are keys into `i18n`. All three of `pt-BR`, `en` and `es` are required, because the launcher and the presence line ("Raf is in Tiny Eco") are drawn in the viewer's language. `presence.phrase` has exactly one `{name}`.
- **`players`** and **`state`**: up to 8 players, more people become spectators, and the shared state may be 1 KB. Ask for what you need: a smaller cap is easier to review and cheaper to send.
- **`capabilities`** is what the app asks the platform for. Tiny Eco asks for nothing beyond a display name and avatar. [Capabilities](/concepts/manifest) explains the rest.
- **`license`** names an open source license and the URL of the source. Every app on pqp is open source.

## 3. The script

`apps/tiny-eco/src/main.ts`:

<<< ../snippets/tiny-eco/src/main.ts

Read it in four parts.

**`connect()`** does the handshake with the pqp page and resolves with the app object once pqp has said hello. It rejects when the page is not inside a pqp frame, which is how the "Open Tiny Eco inside pqp" message appears if you open the file in a browser by itself.

**`app.hello`** is what pqp told you at the start: your seat in the session (`self`), the locale, the theme, the app id and version. `applyTheme` writes the theme onto the page as CSS custom properties, and `app.on("theme", ...)` keeps it current when the person changes theme.

**Listeners first, then `get`.** A push that arrives before its listener exists is not replayed. So the script registers `state.on`, `participants.on` and `events.on` right after `connect()`, and only then reads the current value with `state.get()` and `participants.get()`. The `rev` check keeps an older snapshot from overwriting a newer one.

**Writing state.** The shared state is one JSON value, and `state.patch` is a JSON Merge Patch: `{ count: 5 }` sets one key and leaves the others alone, `null` deletes a key. "+1" is read, add, write, so two people clicking at once could overwrite each other. Passing `baseRev` makes the write conditional on the revision you read, and the host answers `stale-rev` when somebody was faster. The loop reads again and retries. Events (`app.events.send`) are different: ephemeral, never stored, delivered to the other people in the session.

## 4. Build and check

```sh
pnpm apps:build
```

The packager builds **every** app in `apps/`, so you get a line for each one:

```text
apps: built pqp-eco@1.0.0 (3 files, manifestSha256 501caa5b6b83)
apps: built pqp-enquete@1.0.0 (3 files, manifestSha256 ff28778e33af)
apps: built tiny-eco@1.0.0 (3 files, manifestSha256 04d23496efb5)
apps: wrote server/src/apps/catalog.json and dist-apps/
```

That wrote three things. `dist-apps/tiny-eco/1.0.0/` holds `index.html`, `index.js` and `index.css`. `dist-apps/_headers` holds the content security policy that bundle will be served under. `server/src/apps/catalog.json` has gained an entry for your app, and that file is what the pqp server loads at boot. (`pnpm apps:check` rebuilds in a scratch folder and fails when the committed catalog is stale, which is what CI runs.)

::: tip Check the bundle against the sandbox
Open `dist-apps/tiny-eco/1.0.0/index.html`. Every `<script>` and `<link>` carries an `integrity="sha384-..."` and `crossorigin`. The packager added them. If your page had an inline script, the build would have stopped and told you which one.
:::

`pnpm apps:build` changed a tracked file, `server/src/apps/catalog.json`. For an app you are only trying out, put it back when you are done with `git checkout server/src/apps/catalog.json`.

## 5. Run it in pqp, locally

Start the database and tell the local server that apps exist.

```sh
cp .env.example .env
cp .env.example client/.env
docker compose up -d postgres
```

`.env.example` already turns on the dev auth bypass (`DEV_AUTH_BYPASS=true`, and `VITE_DEV_AUTH_BYPASS=true` in the client's copy). That signs every browser in as one shared "Dev User", so you need no Clerk keys, and it makes the server release apps of the `pqp` publisher on its **Sandbox** server when it boots. What is left is two lines in `.env`. Find the commented `# APPS=false` and make it:

```sh
APPS=true
```

and find the empty `APPS_ORIGIN=` and fill it in:

```sh
APPS_ORIGIN=http://localhost:5175
```

Edit the lines that are there. A second `APPS_ORIGIN=` added at the bottom is ignored, because the first one wins. `APPS=true` turns the apps platform on, and `APPS_ORIGIN` is where the bundles are served from, which is the next command.

Two terminals:

```sh
# terminal 1: serves dist-apps on http://localhost:5175 and rebuilds when you save
pnpm apps:dev

# terminal 2: the pqp client (5173) and server (3001)
pnpm dev
```

Keep the client on **port 5173**. The headers on a bundle only let `http://localhost:5173` (and pqp's own sites) put it in a frame, so a client that Vite moved to another port because 5173 was busy cannot show your app.

You can check that the bundle is served the way it will be in production:

```sh
curl -sI http://localhost:5175/tiny-eco/1.0.0/index.html
```

The answer carries the `content-security-policy` with `connect-src 'none'`, `cache-control` (off in dev, immutable in production), `access-control-allow-origin: *` and `referrer-policy: no-referrer`.

Then open `http://localhost:5173/app`, go into the **Sandbox** server and open `#general`. Next to the message box is an **Apps** button (a small grid). **Tiny Eco** is in the launcher beside Eco, Poll and Music. Pick it and press **Start**. A card lands in the conversation: "Dev User started an app, Tiny Eco, You are in", with **Leave** and **Back to the app**.

::: warning What you will see today, and what comes next
The page that shows your app **inside the channel** (the session strip and the pane that mount the sandboxed frame) is in review in pull request [#1412](https://github.com/rafaelcg/pqp/pull/1412) and is not on `main` yet. Until it merges, step 5 ends at the card: the session starts and the seat is taken, but no frame appears. When you open `http://localhost:5175/tiny-eco/1.0.0/index.html` directly you get "Open Tiny Eco inside pqp.", which is the app correctly refusing to run outside a frame. Everything before this step (the manifest, the build, the catalog, the launcher, the headers) is real and works on `main`, and the Tiny Eco bundle from this page was also run inside a real sandboxed frame, under the production policy, by the repository's frame test harness (the real bridge host and SDK, with a stand-in session) while this page was written: it connected, listed two people, wrote the counter with `baseRev` and sent a ping. This warning is removed when #1412 merges.
:::

### Be two people

Once the pane is in, this is how you test a two-person app. The dev bypass signs every browser in as the same account, so two windows are one person and a two-person feature looks broken. To get a second, separate account, run this in the console of the second window **before** loading `/app`, then reload:

```js
localStorage.setItem("pqp:dev-user-suffix", "bob");
```

That window becomes `dev_user_bob`, with its own seat. Join the same session from both and watch the counter move in each. Two normal tabs of one browser profile share the suffix, so set it in one tab only.

### The edit loop

Save a file under `apps/tiny-eco/src/`, wait for `apps: rebuilt` in terminal 1, leave the session and join again. You can change the script and the page freely. A change to the **manifest** is different: the server loads the catalog once, at boot, and never changes a version it already has. After editing the manifest, run `pnpm apps:build` and restart `pnpm dev`; if you keep the same `version`, delete the old row first so the new manifest is loaded:

```sh
docker compose exec postgres psql -U pqp -d pqp -c "DELETE FROM apps WHERE id = 'tiny-eco'"
```

### If Tiny Eco is not in the launcher, or will not start

Each place an app may run is gated. With the platform off there is no **Apps** button at all; with it on, a tile that cannot start in this channel stays on screen with its reason written.

| What you see, or the reason | What it means locally |
|---|---|
| No **Apps** button next to the message box (`flag-off`) | `APPS=true` is not in `.env`, or the server was not restarted. |
| `no-origin` | `APPS_ORIGIN` is empty. Set it to `http://localhost:5175`. |
| `not-live`, `global-off`, `not-allowed-here` | The app is not released. On a dev box the server releases `pqp` apps on the Sandbox server at boot; restart `pnpm dev` after `pnpm apps:build`, and make sure you are in Sandbox. |
| `channel-type` | The channel is a type the manifest does not list. |

## 6. Where to go next

- Read [How an app works](/concepts/how-it-works) for the picture behind what you just built.
- Open [Eco, step by step](/examples/eco) for the same app with the details a real one needs: locales, a reconnecting state, an ending state, and tests.
- Look up any call in the [SDK reference](/sdk/).
- When you want others to use it, read [Publishing](/publishing/).
