# FAQ

## Building

### Can my app make network requests?

No. `connect-src 'none'` is part of the frame's content security policy, and the manifest has no knob for the network. There is no `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon`. Ship what you need in the bundle or as an [asset](/concepts/storage), and use the [shared state](/concepts/sessions#shared-state) and [events](/concepts/sessions#events) to move data between the people in a session.

### Can I use `localStorage`, cookies or IndexedDB?

No. The frame has an opaque origin, so each of them throws a `SecurityError`. Nothing outlives a session except the small `state.result` you may leave on the timeline card. See [What an app can keep](/concepts/storage).

### Can I use React, Vue, Svelte, or another framework?

The packager runs Vite with a **fixed configuration and no plugins**, and your own `vite.config` is not read. Plain TypeScript, JavaScript and CSS work, and so does anything esbuild compiles on its own. Frameworks that need a Vite plugin (Vue single-file components, Svelte) are not supported today. None of the first-party apps use a framework, and the bundle size matters because it is loaded cold into a frame. See [Build and package](/publishing/#what-the-packager-expects-of-your-app-folder).

### Why does `connect()` reject when I open my page in a browser?

Because it is not inside a pqp frame, and `connect()` rejects at once with `unavailable` when `window.parent === window`. That is by design. Show a message ("Open this inside pqp"), and use the local setup in [Getting started](/guide/getting-started#_5-run-it-in-pqp-locally) to run it for real.

### Why did my write fail with `stale-rev`?

You passed `baseRev` and somebody else wrote first. Read the state again and retry. If you are writing only your own key (a vote under your seat id), you do not need `baseRev`: merge patches to different keys never conflict. See [Sessions](/concepts/sessions#design-for-the-merge).

### Why does my state patch fail with `too-large`?

The cap is on the **merged** value, not on your patch. A small patch that pushes the whole state past `state.maxBytes` is refused. The ceiling is 16 384 bytes, and your manifest may set it lower.

### Why did my frame show up empty, or never connect?

Check, in order: the page's `<script>` is a module file in the bundle and not inline (the build would have failed); `connect()` is called, and its result is awaited; you are testing inside a pqp session rather than opening `index.html` directly. Then open the browser's developer console: a content security policy violation names what was blocked.

### Can I play audio, use the microphone, the camera or the clipboard?

Not through the platform today. The frame has `allow=""`, so no microphone, camera, clipboard or geolocation. Audio output has not been used by any first-party app yet, and `media-src` allows only `blob:`.

### How do I test with two people?

On a dev checkout the bypass signs every browser in as one account. Set `localStorage.setItem("pqp:dev-user-suffix", "bob")` in the console of the second window **before** loading `/app`, and reload. It becomes a separate user with its own seat. See [Getting started](/guide/getting-started#be-two-people).

### How many people can be in an app?

Up to 64 players and 200 spectators by the manifest's ceilings, set by `players` in your manifest. The shared state may be up to 16 KB and an event up to 1 KB, and each is limited per second.

### Do I have to support all three languages?

Yes, in the manifest: `pt-BR`, `en` and `es` are all required for every key the platform draws (name, description, presence line), because the launcher and the presence line are drawn in the viewer's language. Strings drawn **inside your frame** are yours: you may support as many or as few as you like, though the host's locale in `app.hello.locale` tells you which one to use.

## Publishing

### Can I publish my own app today?

Not through a portal. Apps are first-party, written in the pqp repository and merged by pull request, and third-party submission is planned, not built. If you build one, open an issue or a pull request and say what it is. See [The appstore](/publishing/appstore).

### Is `@pqp/app-sdk` on npm?

Not yet. It is prepared (a build, a tarball check, a release workflow) and waits for two decisions, the license and the npm scope. Inside the repository it is a workspace dependency. See [the SDK page](/sdk/).

### Why did the build tell me to "bump the version"?

You changed an app whose `(id, version)` is already on `main`. A released version never changes its bytes. Bump `version` in `manifest.source.json`. See [Versions and the catalog](/publishing/versions).

### Can an app charge people?

Nothing in the platform supports payment, and none is promised. That is one of the [open decisions](/publishing/appstore#open-decisions).

## People and privacy

### Can an app see who somebody is?

It sees a display name, an avatar and a random per-session seat id. It cannot see a user id, an email, a server or a channel. See [What an app never sees](/concepts/privacy).

### Is what people type in my app stored?

The shared state lives until the session ends and is then cleared, and ended sessions are deleted after 30 days. Events are never stored or logged. If people's own text or images appear in your app, declare it in `content`.

### Who is the "host"?

Two things share the word. **The host** in the protocol is the pqp page that holds your frame. **The session host** is the person who started the session and who may end it. See [How an app works](/concepts/how-it-works).
